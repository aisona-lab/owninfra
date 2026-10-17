import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.js";
import { generate } from "../src/project.js";

const example = fileURLToPath(new URL("../../../examples/approvals/blueprint.yaml", import.meta.url));

async function cli(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("cli", () => {
  it("prints usage", async () => {
    const r = await cli("--help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("validate [file]");
  });

  it("validates the example blueprint", async () => {
    const r = await cli("validate", example);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${example}: valid`);
    expect(r.err).toContain("warning");
  });

  it("fails on an invalid blueprint", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "owninfra-")), "blueprint.yaml");
    writeFileSync(file, "version: 0.2\n");
    const r = await cli("validate", file);
    expect(r.code).toBe(1);
    expect(r.err).toContain("error version");
  });

  it("fails on a missing file", async () => {
    const r = await cli("validate", "/nonexistent/blueprint.yaml");
    expect(r.code).toBe(1);
    expect(r.err).toBe("Cannot read /nonexistent/blueprint.yaml: ENOENT");
  });

  it("reports when the path is a directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "owninfra-"));
    const r = await cli("validate", dir);
    expect(r.code).toBe(1);
    expect(r.err).toBe(`Cannot read ${dir}: EISDIR`);
  });

  it("reports dead-end workflow states", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "owninfra-")), "blueprint.yaml");
    writeFileSync(file, readFileSync(example, "utf8").replace("final: true }\n        - { id: paid", "}\n        - { id: paid"));
    const r = await cli("validate", file);
    expect(r.code).toBe(1);
    expect(r.err).toContain("state 'rejected' has no outgoing transitions and is not final");
  });

  const fixtures = fileURLToPath(new URL("fixtures/invalid/", import.meta.url));
  const expectedFirstError: Record<string, string> = {
    "alias.yaml": "error version: Required",
    "badref.yaml": "error entities[2].fields[5].to: unknown entity 'Supplier'",
    "deadend.yaml": "error entities[2].workflow.states: state 'stuck' has no outgoing transitions and is not final",
    "empty.yaml": "error (root): Expected object, received null",
    "list.yaml": "error (root): Expected object, received array",
    "malformed.yaml": "error (yaml): Flow sequence in block collection must be sufficiently indented and end with a ] at line 2, column 1:",
    "nodev.yaml": "error environments: a 'dev' environment is required",
    "permscalar.yaml": "error permissions.Vendor.manager: must be a list of actions (create, read, update, delete) or a map of action to rule",
    "types.yaml": "error roles: Expected array, received string",
    "reserved.yaml": "error entities[2].fields[6].name: column name 'order' is a reserved word in Postgres",
    "kebabfield.yaml": "error entities[2].fields[6].name: column name 'needed-by' must be lowercase snake_case to be a SQL identifier",
    "systemcol.yaml": "error entities[2].fields[6].name: 'created_by' is a system column",
    "longname.yaml": "error entities[2].name: table name 'purchase_request_for_extremely_long_departmental_procurement_workflows' is longer than 63 bytes",
    "unreach.yaml": "error entities[2].workflow.states: state 'archived' is unreachable from 'draft'",
  };

  it.each(Object.entries(expectedFirstError))("rejects %s", async (name, line) => {
    const r = await cli("validate", join(fixtures, name));
    expect(r.code).toBe(1);
    expect(r.err.split("\n").find((l) => l.startsWith("error "))).toBe(line);
  });

  it("covers every invalid fixture", () => {
    expect(readdirSync(fixtures).sort()).toEqual(Object.keys(expectedFirstError).sort());
  });

  it("init copies the example and is idempotent", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "owninfra-")), "approvals");
    expect((await cli("init", "--example", "approvals", dir)).code).toBe(0);
    expect(readFileSync(join(dir, "blueprint.yaml"), "utf8")).toBe(readFileSync(example, "utf8"));
    expect(await cli("init", "--example", "approvals", dir)).toMatchObject({ code: 0, out: `${join(dir, "blueprint.yaml")} already matches the 'approvals' example` });
    writeFileSync(join(dir, "blueprint.yaml"), "mine\n");
    expect((await cli("init", "--example", "approvals", dir)).code).toBe(1);
    expect(readFileSync(join(dir, "blueprint.yaml"), "utf8")).toBe("mine\n");
    expect((await cli("init", "--example", "nope", dir)).code).toBe(1);
  });

  it("generate refuses a hand-edited generated file and --force overrides it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "owninfra-"));
    writeFileSync(join(dir, "blueprint.yaml"), readFileSync(example, "utf8"));
    const gen = async (...a: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await generate(a, { out: (l) => out.push(l), err: (l) => err.push(l) }, dir);
      return { code, out: out.join("\n"), err: err.join("\n") };
    };
    expect((await gen()).code).toBe(0);
    expect((await gen()).out).toMatch(/^generate: 0 written, \d+ unchanged, 0 user files created, 0 deleted$/);
    writeFileSync(join(dir, "docker-compose.yml"), "edited\n");
    const refused = await gen();
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("docker-compose.yml");
    expect((await gen("--force")).code).toBe(0);
    expect(readFileSync(join(dir, "docker-compose.yml"), "utf8")).toContain("postgres:16");
  });

  it("rejects planned and unknown commands", async () => {
    expect((await cli("deploy", "--env", "dev")).code).toBe(2);
    expect((await cli("frobnicate")).code).toBe(1);
  });
});
