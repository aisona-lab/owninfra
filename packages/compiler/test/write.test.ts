import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, write, type FileSet } from "../src/index.js";

const source = readFileSync(new URL("../../../examples/approvals/blueprint.yaml", import.meta.url), "utf8");
const meta = { owninfra: "0.0.0", irHash: "test" };

async function files(): Promise<FileSet> {
  const r = await compile(source);
  if (!r.ok) throw new Error();
  return r.files;
}

const guard = "app/src/lib/(generated)/guard.ts";
const user = "app/src/custom/example.ts";

describe("write", () => {
  it("converges: a second run writes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "owninfra-w-"));
    const fs = await files();
    const first = await write(fs, dir, meta, { force: false });
    const second = await write(fs, dir, meta, { force: false });
    expect(first).toMatchObject({ ok: true, unchanged: 0 });
    expect(second).toMatchObject({ ok: true, written: [], created: [], deleted: [], unchanged: fs.filter((f) => f.zone === "generated").length });
  });

  it("refuses to overwrite a hand-edited generated file unless forced", async () => {
    const dir = mkdtempSync(join(tmpdir(), "owninfra-w-"));
    const fs = await files();
    await write(fs, dir, meta, { force: false });
    writeFileSync(join(dir, guard), "edited\n");
    expect(await write(fs, dir, meta, { force: false })).toEqual({ ok: false, edited: [guard] });
    expect(readFileSync(join(dir, guard), "utf8")).toBe("edited\n");
    expect(await write(fs, dir, meta, { force: true })).toMatchObject({ ok: true, written: [guard], forced: [guard] });
    expect(readFileSync(join(dir, guard), "utf8")).toBe(fs.find((f) => f.path === guard)!.contents);
  });

  it("never overwrites user files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "owninfra-w-"));
    const fs = await files();
    await write(fs, dir, meta, { force: false });
    writeFileSync(join(dir, user), "mine\n");
    await write(fs, dir, meta, { force: true });
    expect(readFileSync(join(dir, user), "utf8")).toBe("mine\n");
  });

  it("deletes orphaned generated files but refuses when the orphan was edited", async () => {
    const dir = mkdtempSync(join(tmpdir(), "owninfra-w-"));
    const fs = await files();
    await write(fs, dir, meta, { force: false });
    const fewer = fs.filter((f) => f.path !== guard);
    expect(await write(fewer, dir, meta, { force: false })).toMatchObject({ ok: true, deleted: [guard] });
    expect(existsSync(join(dir, guard))).toBe(false);

    await write(fs, dir, meta, { force: false });
    writeFileSync(join(dir, guard), "edited\n");
    expect(await write(fewer, dir, meta, { force: false })).toEqual({ ok: false, edited: [guard] });
  });

  it("recovers when a previous run crashed before writing the lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "owninfra-w-"));
    const fs = await files();
    for (const f of fs.slice(0, 5)) {
      const p = join(dir, f.path);
      (await import("node:fs")).mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, f.contents);
    }
    expect(await write(fs, dir, meta, { force: false })).toMatchObject({ ok: true });
  });

  it("records the prettier version and a hash per generated file in the lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "owninfra-w-"));
    const fs = await files();
    await write(fs, dir, meta, { force: false });
    const lock = JSON.parse(readFileSync(join(dir, "owninfra.lock.json"), "utf8"));
    expect(lock.prettier).toBe("3.9.10");
    expect(Object.keys(lock.files).sort()).toEqual(fs.filter((f) => f.zone === "generated").map((f) => f.path).sort());
  });
});

describe("lock paths", () => {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  async function project() {
    const root = mkdtempSync(join(tmpdir(), "owninfra-l-"));
    const dir = join(root, "p");
    mkdirSync(dir);
    writeFileSync(join(root, "victim.txt"), "keep\n");
    const fs = await files();
    await write(fs, dir, meta, { force: false });
    const tamper = (path: string) => {
      const lock = JSON.parse(readFileSync(join(dir, "owninfra.lock.json"), "utf8"));
      lock.files[path] = sha("keep\n");
      writeFileSync(join(dir, "owninfra.lock.json"), JSON.stringify(lock));
    };
    return { root, dir, fs, tamper };
  }

  it.each(["../victim.txt", "app/../../victim.txt", "/tmp/victim.txt", "app/src/custom/example.ts", "blueprint.yaml"])("refuses lock entry %s and deletes nothing", async (entry) => {
    const { root, dir, fs, tamper } = await project();
    tamper(entry);
    const r = await write(fs, dir, meta, { force: true });
    expect(r).toMatchObject({ ok: false });
    expect("badLock" in r && r.badLock).toContain(`'${entry}'`);
    expect(readFileSync(join(root, "victim.txt"), "utf8")).toBe("keep\n");
    expect(existsSync(join(dir, "app/src/custom/example.ts"))).toBe(true);
  });

  it("cannot delete project files outside the generated zone even with matching hashes", async () => {
    const { dir, fs } = await project();
    const victims = [".git/HEAD", ".env", "README.md", "app/package-lock.json"];
    for (const v of victims) {
      mkdirSync(join(dir, v, ".."), { recursive: true });
      writeFileSync(join(dir, v), "keep\n");
    }
    for (const v of [...victims, "README.MD", "APP/drizzle/0000_init.sql", "app/Drizzle/0000_init.sql"]) {
      const lock = JSON.parse(readFileSync(join(dir, "owninfra.lock.json"), "utf8"));
      lock.files = { ...lock.files, [v]: sha("keep\n") };
      writeFileSync(join(dir, "owninfra.lock.json"), JSON.stringify(lock));
      const r = await write(fs, dir, meta, { force: true });
      expect(r).toEqual({ ok: false, badLock: `owninfra.lock.json lists '${v}' is not a generated path; refusing to touch it. Restore the lock from git.` });
      delete lock.files[v];
      writeFileSync(join(dir, "owninfra.lock.json"), JSON.stringify(lock));
    }
    for (const v of victims) expect(readFileSync(join(dir, v), "utf8")).toBe("keep\n");
  });

  it.each(["app/src/custom/(generated)/x.ts", "app/src/app/(custom)/(generated)/x.ts"])("cannot delete user file %s through a tampered lock", async (v) => {
    const { dir, fs } = await project();
    mkdirSync(join(dir, v, ".."), { recursive: true });
    writeFileSync(join(dir, v), "keep\n");
    const lock = JSON.parse(readFileSync(join(dir, "owninfra.lock.json"), "utf8"));
    lock.files[v] = sha("keep\n");
    writeFileSync(join(dir, "owninfra.lock.json"), JSON.stringify(lock));
    expect(await write(fs, dir, meta, { force: true })).toEqual({ ok: false, badLock: `owninfra.lock.json lists '${v}' is not a generated path; refusing to touch it. Restore the lock from git.` });
    expect(readFileSync(join(dir, v), "utf8")).toBe("keep\n");
    lock.files = Object.fromEntries(Object.entries(lock.files).filter(([k]) => k !== v));
    writeFileSync(join(dir, "owninfra.lock.json"), JSON.stringify(lock));
    expect(await write(fs, dir, meta, { force: false })).toMatchObject({ ok: true, stray: [] });
  });

  it("explains a lock entry that is a directory", async () => {
    const { dir, fs, tamper } = await project();
    mkdirSync(join(dir, "app/drizzle/old"));
    tamper("app/drizzle/old");
    expect(await write(fs, dir, meta, { force: true })).toEqual({
      ok: false,
      badLock: "owninfra.lock.json lists 'app/drizzle/old' is a directory, not a generated file; refusing to touch it. Restore the lock from git.",
    });
    expect(existsSync(join(dir, "app/drizzle/old"))).toBe(true);
  });

  it("refuses a lock entry that reaches outside through a symlinked folder", async () => {
    const { root, dir, fs, tamper } = await project();
    symlinkSync(root, join(dir, "app/drizzle/link"));
    tamper("app/drizzle/link/victim.txt");
    const r = await write(fs, dir, meta, { force: true });
    expect("badLock" in r && r.badLock).toContain("outside the generated zone");
    expect(readFileSync(join(root, "victim.txt"), "utf8")).toBe("keep\n");
  });

  it("refuses to write a generated file through a symlinked folder", async () => {
    const { root, dir, fs } = await project();
    const target = join(dir, "app/drizzle");
    (await import("node:fs")).rmSync(target, { recursive: true });
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), target);
    const r = await write(fs, dir, meta, { force: true });
    expect(r).toMatchObject({ ok: false });
    expect(existsSync(join(root, "elsewhere/0000_init.sql"))).toBe(false);
  });

  it("reports a corrupt or wrongly shaped lock", async () => {
    const { dir, fs } = await project();
    writeFileSync(join(dir, "owninfra.lock.json"), "{");
    expect(await write(fs, dir, meta, { force: true })).toMatchObject({ ok: false, badLock: expect.stringMatching(/^owninfra\.lock\.json is not valid JSON/) });
    writeFileSync(join(dir, "owninfra.lock.json"), "[]");
    expect(await write(fs, dir, meta, { force: true })).toMatchObject({ ok: false, badLock: expect.stringMatching(/does not have the expected shape/) });
  });
});

describe("emitted files", () => {
  it("put the do-not-edit header on every generated source file", async () => {
    const missing = (await files())
      .filter((f) => f.zone === "generated" && /\.(ts|tsx|mts|mjs|sql|yml)$/.test(f.path))
      .filter((f) => !f.contents.includes("Generated by owninfra generate. Do not edit"))
      .map((f) => f.path);
    expect(missing).toEqual([]);
  });

  it("emit the auth stub regardless of NODE_ENV", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const prod = await files();
      process.env.NODE_ENV = "development";
      expect((await files()).map((f) => f.contents)).toEqual(prod.map((f) => f.contents));
      expect(prod.find((f) => f.path === "app/src/auth.ts")!.contents).toContain("Credentials(");
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
