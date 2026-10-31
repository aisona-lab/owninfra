import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, devDatabaseUrl, lockFile, LockError, readLock, write, type Lock } from "@owninfra/compiler";
import type { Io } from "./index.js";

const version = "0.0.0";
const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));

export async function init(args: string[], io: Io): Promise<number> {
  const i = args.indexOf("--example");
  const name = i >= 0 ? args[i + 1] : undefined;
  if (!name) {
    io.err("Usage: owninfra init --example <name> [dir]");
    return 1;
  }
  const source = join(examples, name, "blueprint.yaml");
  if (!existsSync(source)) {
    io.err(`Unknown example '${name}'`);
    return 1;
  }
  const dir = resolve(args.filter((_, j) => j !== i && j !== i + 1)[0] ?? name);
  const target = join(dir, "blueprint.yaml");
  const want = await readFile(source, "utf8");
  if (existsSync(target)) {
    if ((await readFile(target, "utf8")) === want) {
      io.out(`${target} already matches the '${name}' example`);
      return 0;
    }
    io.err(`${target} exists and differs from the '${name}' example; not overwriting it`);
    return 1;
  }
  await mkdir(dir, { recursive: true });
  await copyFile(source, target);
  io.out(`Created ${target}\nNext: cd ${dir} && owninfra generate && owninfra dev`);
  return 0;
}

async function compileHere(dir: string, io: Io) {
  const file = join(dir, "blueprint.yaml");
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (e) {
    io.err(`Cannot read ${file}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`);
    return null;
  }
  const r = await compile(source);
  r.warnings.forEach((w) => io.err(`warning ${w.path}: ${w.message}`));
  if (!r.ok) {
    r.errors.forEach((e) => io.err(`error ${e.path}: ${e.message}`));
    io.err(`${file}: ${r.errors.length} error(s)`);
    return null;
  }
  return r;
}

export async function generate(args: string[], io: Io, dir = process.cwd()): Promise<number> {
  const r = await compileHere(dir, io);
  if (!r) return 1;
  const git = spawnSync("git", ["status", "--porcelain", "--", "."], { cwd: dir, encoding: "utf8" });
  if (git.status === 0 && git.stdout.trim()) io.err("warning: the git tree has uncommitted changes");
  const report = await write(r.files, dir, { owninfra: version, irHash: r.irHash }, { force: args.includes("--force") });
  if (!report.ok && "badLock" in report) {
    io.err(`error: ${report.badLock}`);
    return 1;
  }
  if (!report.ok) {
    io.err("Refusing to overwrite generated files that were edited by hand since the last generate:");
    report.edited.forEach((p) => io.err(`  ${p}`));
    io.err("Move your change into app/src/custom/ or rerun with --force to discard it.");
    return 1;
  }
  report.stray.forEach((p) => io.err(`warning: ${p} is in a (generated) folder but owninfra did not generate it; move it to app/src/custom/`));
  report.forced.forEach((p) => io.err(`warning: overwrote hand-edited ${p} (--force)`));
  report.deleted.forEach((p) => io.out(`deleted ${p}`));
  io.out(`generate: ${report.written.length} written, ${report.unchanged} unchanged, ${report.created.length} user files created, ${report.deleted.length} deleted`);
  return 0;
}

function run(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<number> {
  return new Promise((done) => {
    const p = spawn(cmd, args, { ...opts, stdio: "inherit" });
    p.on("exit", (code) => done(code ?? 1));
    p.on("error", () => done(127));
  });
}

/** The compiled blueprint, if the generated app is up to date with it. */
export async function generatedProject(dir: string, io: Io) {
  const r = await compileHere(dir, io);
  if (!r) return null;
  let lock: Lock | null;
  try {
    lock = await readLock(dir);
  } catch (e) {
    if (!(e instanceof LockError)) throw e;
    io.err(`error: ${e.message}`);
    return null;
  }
  if (!lock) {
    io.err(`No ${lockFile} here. Run 'owninfra generate' first.`);
    return null;
  }
  if (lock.irHash !== r.irHash) {
    io.err("blueprint.yaml changed since the last generate. Run 'owninfra generate' first.");
    return null;
  }
  return r;
}

export async function dev(args: string[], io: Io, dir = process.cwd()): Promise<number> {
  const r = await generatedProject(dir, io);
  if (!r) return 1;
  const app = join(dir, "app");
  const env = { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? devDatabaseUrl(r.ir), OWNINFRA_AUTH_STUB: "1" };
  if (process.env.DATABASE_URL) io.out(`dev: using DATABASE_URL from the environment; skipping docker compose`);
  else if ((await run("docker", ["compose", "up", "-d", "--wait", "postgres"], { cwd: dir })) !== 0) {
    io.err("dev: 'docker compose up' failed. Start Docker, or set DATABASE_URL to a Postgres you run yourself.");
    return 1;
  }
  if (!existsSync(join(app, "node_modules")) && (await run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: app })) !== 0) return 1;
  const db = await run("node", ["scripts/dev-db.mjs", ...(args.includes("--reset") ? ["--reset"] : [])], { cwd: app, env });
  if (db !== 0) return db;
  if (args.includes("--db-only")) return 0;
  const port = args.includes("--port") ? args[args.indexOf("--port") + 1] : "3000";
  return run("npx", ["next", "dev", "--port", port], { cwd: app, env });
}
