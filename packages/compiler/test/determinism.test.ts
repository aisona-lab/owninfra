import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { compile, sha256, type FileSet } from "../src/index.js";

const source = readFileSync(new URL("../../../examples/approvals/blueprint.yaml", import.meta.url), "utf8");
const hashOf = (files: FileSet) => sha256(files.map((f) => `${f.zone}\0${f.path}\0${f.contents}`).join("\0"));

async function hash(yaml: string) {
  const r = await compile(yaml);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return hashOf(r.files);
}

function seeded(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}
const shuffle = <T>(xs: T[], rnd: () => number) => xs.map((x) => [rnd(), x] as const).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
const shuffleKeys = (o: Record<string, unknown>, rnd: () => number) => Object.fromEntries(shuffle(Object.entries(o), rnd));

describe("determinism", () => {
  it("gives the same hash on repeated runs in one process", async () => {
    expect(await hash(source)).toBe(await hash(source));
  });

  it("gives the same hash in a fresh process", async () => {
    const dist = fileURLToPath(new URL("../dist/index.js", import.meta.url));
    const script = `import { compile, sha256 } from ${JSON.stringify(dist)}; import { readFileSync } from "node:fs";
      const r = await compile(readFileSync(0, "utf8"));
      console.log(sha256(r.files.map((f) => f.zone + "\\0" + f.path + "\\0" + f.contents).join("\\0")));`;
    const fresh = execFileSync(process.execPath, ["--input-type=module", "-e", script], { input: source, encoding: "utf8" }).trim();
    expect(fresh).toBe(await hash(source));
  });

  it.each([1, 2, 3, 4, 5])("ignores the order of entities, roles, transitions and permission keys (seed %i)", async (seed) => {
    const rnd = seeded(seed);
    const bp = parse(source);
    bp.entities = shuffle(bp.entities, rnd);
    bp.roles = shuffle(bp.roles, rnd);
    for (const e of bp.entities) if (e.workflow) e.workflow.transitions = shuffle(e.workflow.transitions, rnd);
    bp.permissions = shuffleKeys(bp.permissions, rnd);
    for (const k of Object.keys(bp.permissions)) {
      bp.permissions[k] = shuffleKeys(bp.permissions[k], rnd);
      for (const r of Object.keys(bp.permissions[k]))
        if (!Array.isArray(bp.permissions[k][r])) bp.permissions[k][r] = shuffleKeys(bp.permissions[k][r], rnd);
        else bp.permissions[k][r] = shuffle(bp.permissions[k][r], rnd);
    }
    bp.seed.users = shuffle(bp.seed.users, rnd);
    expect(await hash(stringify(bp))).toBe(await hash(source));
  });

  it("treats field order as meaningful", async () => {
    const bp = parse(source);
    bp.entities[0].fields.reverse();
    expect(await hash(stringify(bp))).not.toBe(await hash(source));
  });

  it("does not depend on line endings or Unicode normalization of the input", async () => {
    expect(await hash(source.replace(/\n/g, "\r\n"))).toBe(await hash(source));
    expect(await hash(source.replace("Ingeniería", "Ingenieri\u0301a"))).toBe(await hash(source));
  });

  it("writes only LF line endings", async () => {
    const r = await compile(source);
    if (!r.ok) throw new Error();
    expect(r.files.filter((f) => f.contents.includes("\r")).map((f) => f.path)).toEqual([]);
  });
});
