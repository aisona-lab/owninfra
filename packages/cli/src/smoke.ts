import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stack } from "aws-cdk-lib";
import { validateBlueprintYaml } from "@owninfra/blueprint-schema";
import { devDatabaseUrl, throwawayDatabase } from "@owninfra/compiler";
import { appStack, idleCostFindings, newApp, type Template } from "@owninfra/constructs";
import type { Io } from "./index.js";
import { generatedProject } from "./project.js";
import { approvals } from "./smoke-approvals.js";
import { check, Failed, signIn, type User } from "./smoke-client.js";

/** The ARNs local-data-api is started with (any account-000000000000 values work; it does not call AWS). */
const emulatorArns = {
  DATABASE_CLUSTER_ARN: "arn:aws:rds:eu-north-1:000000000000:cluster:local",
  DATABASE_SECRET_ARN: "arn:aws:secretsmanager:eu-north-1:000000000000:secret:local",
};

const option = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

/** Runs a command to completion and keeps its output, so a failure can show the tail. */
function capture(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<{ code: number; output: string }> {
  return new Promise((done) => {
    const p = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    p.stdout.on("data", (d) => (output += d));
    p.stderr.on("data", (d) => (output += d));
    p.on("exit", (code) => done({ code: code ?? 1, output }));
    p.on("error", (e) => done({ code: 127, output: String(e) }));
  });
}

const tail = (output: string, lines = 15) => output.trim().split("\n").slice(-lines).join("\n");

/** Synthesizes one environment's stack with cdk-nag on (a finding throws), then runs the idle-cost guard on the template. */
export function checkInfra(blueprint: string, envName: "dev" | "prod", extend?: (stack: Stack) => void) {
  const v = validateBlueprintYaml(blueprint);
  check(v.ok, "the blueprint does not validate");
  const app = newApp(mkdtempSync(join(tmpdir(), "owninfra-smoke-")));
  const stack = appStack(app, v.model, envName);
  extend?.(stack);
  let template: Template;
  try {
    template = app.synth().getStackArtifact(stack.artifactId).template as Template;
  } catch (e) {
    throw new Failed(`synth or cdk-nag: ${(e as Error).message.split("\n").slice(0, 8).join("\n")}`);
  }
  const idle = idleCostFindings(template);
  check(idle.length === 0, `idle-cost guard: ${idle.join("; ")}`);
}

/**
 * Boots the generated app the way `dev` does, then drives it over HTTP: sign-in per seed role, the workflow,
 * the 403/409/422 cases and the audit log. Every step prints ok or FAIL; the first failure stops the run, names
 * the step and exits 1.
 */
export async function smoke(args: string[], io: Io, dir = process.cwd()): Promise<number> {
  const port = option(args, "--port") ?? "3000";
  const endpoint = option(args, "--data-api");
  const base = `http://127.0.0.1:${port}`;
  const app = join(dir, "app");
  let current = "start";
  let passed = 0;
  let server: ChildProcess | undefined;
  let serverLog = "";
  const step = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
    current = name;
    const started = Date.now();
    const v = await fn();
    passed++;
    io.out(`ok   ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    return v;
  };
  try {
    const project = await step("compile: blueprint and generated app agree", async () => {
      const r = await generatedProject(dir, io);
      if (!r) throw new Failed("see the errors above");
      return r;
    });
    const url = await step("database", async () => {
      const own = process.env.DATABASE_URL;
      if (own) {
        throwawayDatabase(own, "owninfra smoke", io.out);
        return own;
      }
      const up = await capture("docker", ["compose", "up", "-d", "--wait", "postgres"], { cwd: dir });
      check(up.code === 0, `'docker compose up' failed. Start Docker, or set DATABASE_URL to a Postgres database whose name ends in _builder.\n${tail(up.output)}`);
      return devDatabaseUrl(project.ir);
    });
    if (!existsSync(join(app, "node_modules")))
      await step("install", async () => {
        const r = await capture("npm", ["install", "--no-audit", "--no-fund"], { cwd: app });
        check(r.code === 0, tail(r.output));
      });
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: url, NEXT_TELEMETRY_DISABLED: "1" };
    await step("migrate and seed (dev-db --reset)", async () => {
      const r = await capture("node", ["scripts/dev-db.mjs", "--reset"], { cwd: app, env });
      check(r.code === 0, `dev-db exited ${r.code}\n${tail(r.output)}`);
    });
    await step("next build refuses OWNINFRA_AUTH_STUB=1", async () => {
      const r = await capture("npx", ["next", "build"], { cwd: app, env: { ...env, OWNINFRA_AUTH_STUB: "1" } });
      check(r.code !== 0, "next build succeeded with the auth stub enabled");
      check(r.output.includes("OWNINFRA_AUTH_STUB"), `next build failed, but not because of the stub:\n${tail(r.output)}`);
    });
    const blueprint = readFileSync(join(dir, "blueprint.yaml"), "utf8");
    const v = validateBlueprintYaml(blueprint);
    for (const envName of ["dev", "prod"] as const)
      if (v.ok && v.model.environments[envName]) await step(`infra ${envName}: synth, cdk-nag, idle cost`, () => checkInfra(blueprint, envName));

    const appEnv: NodeJS.ProcessEnv = { ...env, OWNINFRA_AUTH_STUB: "1" };
    if (endpoint) Object.assign(appEnv, emulatorArns, { DATA_API_ENDPOINT: endpoint, DATABASE_NAME: new URL(url).pathname.slice(1) });
    await step(`boot: next dev on ${base} over ${endpoint ? `the Data API (${endpoint})` : "TCP"}`, async () => {
      server = spawn("npx", ["next", "dev", "--port", port, "--hostname", "127.0.0.1"], { cwd: app, env: appEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      server.stdout!.on("data", (d) => (serverLog += d));
      server.stderr!.on("data", (d) => (serverLog += d));
      for (const until = Date.now() + 180_000; Date.now() < until; await new Promise((r) => setTimeout(r, 1000))) {
        check(server.exitCode === null, `next dev exited ${server.exitCode}\n${tail(serverLog)}`);
        if ((await fetch(`${base}/api/auth/csrf`).catch(() => null))?.status === 200) return;
      }
      throw new Failed(`no answer from ${base} after 180 s\n${tail(serverLog)}`);
    });

    const scenario = project.ir.app.name === approvals.app ? approvals : undefined;
    const users = scenario?.users ?? Object.fromEntries(project.ir.seedUsers.map((u) => [u.email, u.roles]));
    const signedIn = new Map<string, User>();
    for (const [email, roles] of Object.entries(users))
      await step(`sign in as ${email} (${roles.join(", ")})`, async () => {
        const u = await signIn(base, email);
        check(JSON.stringify([...u.session.roles].sort()) === JSON.stringify([...roles].sort()), `expected roles [${roles.join(", ")}], got [${u.session.roles.join(", ")}]`);
        signedIn.set(email, u);
      });
    if (scenario) await scenario.run((email) => signedIn.get(email)!, step);
    else io.out(`note: no scripted scenario for '${project.ir.app.name}'; ran the generic steps only`);
    io.out(`smoke: passed ${passed} steps`);
    return 0;
  } catch (e) {
    if (!(e instanceof Failed) && server) io.err(tail(serverLog));
    io.err(`FAIL ${current}: ${e instanceof Error ? e.message : String(e)}`);
    io.err(`smoke: failed at '${current}'`);
    return 1;
  } finally {
    if (server?.pid && server.exitCode === null) process.kill(-server.pid, "SIGTERM");
  }
}
