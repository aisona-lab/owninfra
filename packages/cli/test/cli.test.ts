import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

  const badDir = "/workspace/verify/bad";
  const repros = existsSync(badDir) ? readdirSync(badDir).filter((f) => f.endsWith(".yaml")) : [];
  it.skipIf(!repros.length).each(repros)("rejects verifier repro %s", async (name) => {
    expect((await cli("validate", join(badDir, name))).code).not.toBe(0);
  });

  it("rejects planned and unknown commands", async () => {
    expect((await cli("deploy", "--env", "dev")).code).toBe(2);
    expect((await cli("frobnicate")).code).toBe(1);
  });
});
