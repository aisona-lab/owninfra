import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, write, type FileSet } from "../src/index.js";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const blueprints = { approvals: read("../../../examples/approvals/blueprint.yaml"), assets: read("../../cli/test/fixtures/smoke/assets.yaml") };
const meta = { owninfra: "0.0.0", irHash: "test" };
const lockPath = "app/package-lock.json";

async function files(source: string): Promise<FileSet> {
  const r = await compile(source);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.files;
}
const file = (fs: FileSet, path: string) => fs.find((f) => f.path === path)!.contents;

describe("pinned dependencies", () => {
  it("every generate ships the same package-lock.json, byte for byte as npm wrote it", async () => {
    const runs = [await files(blueprints.approvals), await files(blueprints.approvals), await files(blueprints.assets)];
    const template = read("../templates/generated/app/package-lock.json");
    for (const fs of runs) expect(file(fs, lockPath)).toBe(template);
    expect(runs.find((fs) => fs.find((f) => f.path === lockPath)?.zone !== "generated")).toBeUndefined();
  });

  it("the lock pins exactly the dependencies package.json declares", async () => {
    const fs = await files(blueprints.approvals);
    const pkg = JSON.parse(file(fs, "app/package.json"));
    const root = JSON.parse(file(fs, lockPath)).packages[""];
    expect(root.dependencies).toEqual(pkg.dependencies);
    expect(root.devDependencies).toEqual(pkg.devDependencies);
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }))
      expect(JSON.parse(file(fs, lockPath)).packages[`node_modules/${name}`].version, name).toBe(version);
  });

  it("a hand-edited package-lock.json is refused like any generated file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "owninfra-deps-"));
    const fs = await files(blueprints.approvals);
    await write(fs, dir, meta, { force: false });
    const lock = JSON.parse(readFileSync(join(dir, lockPath), "utf8"));
    lock.packages["node_modules/next"].version = "16.0.0";
    writeFileSync(join(dir, lockPath), JSON.stringify(lock, null, 2) + "\n");
    expect(await write(fs, dir, meta, { force: false })).toEqual({ ok: false, edited: [lockPath] });
  });

  it("dependencies added under src/custom are the user's: generate leaves them and changes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "owninfra-deps-"));
    const fs = await files(blueprints.approvals);
    await write(fs, dir, meta, { force: false });
    const own = {
      "app/src/custom/package.json": '{ "private": true, "dependencies": { "picocolors": "1.1.1" } }\n',
      "app/src/custom/package-lock.json": '{ "lockfileVersion": 3 }\n',
      "app/src/custom/node_modules/picocolors/package.json": '{ "name": "picocolors", "version": "1.1.1" }\n',
    };
    for (const [p, c] of Object.entries(own)) {
      mkdirSync(join(dir, p, ".."), { recursive: true });
      writeFileSync(join(dir, p), c);
    }
    const r = await write(fs, dir, meta, { force: false });
    expect(r).toMatchObject({ ok: true, written: [], deleted: [], stray: [] });
    for (const [p, c] of Object.entries(own)) expect(readFileSync(join(dir, p), "utf8")).toBe(c);
    expect(readFileSync(join(dir, lockPath), "utf8")).toBe(file(fs, lockPath));
  });
});
