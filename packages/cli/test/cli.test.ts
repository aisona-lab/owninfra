import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.js";

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
  it.each([
    ["alias.yaml", "error version: Invalid input"],
    ["badref.yaml", "error entities[2].fields[5].to: unknown entity 'Supplier'"],
    ["deadend.yaml", "error entities[2].workflow.states: state 'stuck' has no outgoing transitions and is not final"],
    ["empty.yaml", "error (root): Expected object, received null"],
    ["list.yaml", "error (root): Expected object, received array"],
    ["malformed.yaml", "error (yaml): Flow sequence in block collection must be sufficiently indented and end with a ] at line 2, column 1:"],
    ["nodev.yaml", "error environments: a 'dev' environment is required"],
    ["permscalar.yaml", "error permissions.Vendor.manager: must be a list of actions (create, read, update, delete) or a map of action to rule"],
    ["types.yaml", "error roles: Expected array, received string"],
    ["unreach.yaml", "error entities[2].workflow.states: state 'archived' is unreachable from 'draft'"],
  ])("rejects %s", async (name, line) => {
    const r = await cli("validate", join(fixtures, name));
    expect(r.code).toBe(1);
    expect(r.err.split("\n").find((l) => l.startsWith("error "))).toBe(line);
  });

  it("covers every invalid fixture", () => {
    expect(readdirSync(fixtures).sort()).toEqual([
      "alias.yaml", "badref.yaml", "deadend.yaml", "empty.yaml", "list.yaml",
      "malformed.yaml", "nodev.yaml", "permscalar.yaml", "types.yaml", "unreach.yaml",
    ]);
  });

  it("rejects planned and unknown commands", async () => {
    expect((await cli("deploy", "--env", "dev")).code).toBe(2);
    expect((await cli("frobnicate")).code).toBe(1);
  });
});
