import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const source = readFileSync(new URL("../../../examples/approvals/blueprint.yaml", import.meta.url), "utf8");
const goldenDir = fileURLToPath(new URL("golden/approvals/", import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));

describe("golden: approvals", async () => {
  const r = await compile(source);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  const files = r.files;

  if (process.env.UPDATE_GOLDENS) {
    rmSync(goldenDir, { recursive: true, force: true });
    for (const f of files) {
      mkdirSync(dirname(join(goldenDir, f.path)), { recursive: true });
      writeFileSync(join(goldenDir, f.path), f.contents);
    }
  }

  it("emits exactly the golden file list", () => {
    expect(files.map((f) => f.path)).toEqual(walk(goldenDir).map((p) => relative(goldenDir, p)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it.each(files.map((f) => [f.path, f] as const))("%s matches byte for byte", (_p, f) => {
    expect(f.contents).toBe(readFileSync(join(goldenDir, f.path), "utf8"));
  });
});

describe("shared codecs", () => {
  it("ships the blueprint-schema codec table to the app unchanged", async () => {
    const { staticTemplates } = await import("../src/static-templates.js");
    const shipped = staticTemplates.find((t) => t.path === "app/src/lib/(generated)/codecs.ts");
    expect(shipped?.contents).toBe(readFileSync(new URL("../../blueprint-schema/src/codecs.ts", import.meta.url), "utf8"));
  });

  it("emits codecs.ts as the header plus the source, byte for byte", async () => {
    const r = await compile(source);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const emitted = r.files.find((f) => f.path === "app/src/lib/(generated)/codecs.ts")!.contents;
    expect(emitted.slice(emitted.indexOf("\n") + 1)).toBe(readFileSync(new URL("../../blueprint-schema/src/codecs.ts", import.meta.url), "utf8"));
  });
});
