import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { prettierVersion, sha256, type FileSet } from "./emit.js";

export const lockFile = "owninfra.lock.json";

export type Lock = { owninfra: string; prettier: string; irHash: string; files: Record<string, string> };

export type WriteReport =
  | { ok: true; written: string[]; unchanged: number; created: string[]; deleted: string[]; forced: string[] }
  | { ok: false; edited: string[] };

async function readLock(dir: string): Promise<Lock | null> {
  try {
    return JSON.parse(await readFile(join(dir, lockFile), "utf8")) as Lock;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

async function current(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

async function atomicWrite(path: string, contents: string) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.owninfra-tmp`;
  await writeFile(tmp, contents);
  await rename(tmp, path);
}

export async function write(files: FileSet, dir: string, meta: { owninfra: string; irHash: string }, opts: { force: boolean }): Promise<WriteReport> {
  const previous = (await readLock(dir))?.files ?? {};
  const generated = files.filter((f) => f.zone === "generated");
  const next = new Set(generated.map((f) => f.path));
  const orphans = Object.keys(previous).filter((p) => !next.has(p));

  const edited: string[] = [];
  for (const path of [...generated.map((f) => f.path), ...orphans]) {
    const onDisk = await current(join(dir, path));
    if (onDisk === null) continue;
    const want = generated.find((f) => f.path === path)?.contents;
    if (onDisk === want) continue;
    if (previous[path] !== sha256(onDisk)) edited.push(path);
  }
  if (edited.length && !opts.force) return { ok: false, edited: edited.sort() };

  const written: string[] = [];
  let unchanged = 0;
  for (const f of generated) {
    if ((await current(join(dir, f.path))) === f.contents) unchanged++;
    else {
      await atomicWrite(join(dir, f.path), f.contents);
      written.push(f.path);
    }
  }
  const created: string[] = [];
  for (const f of files.filter((x) => x.zone === "user"))
    if (!existsSync(join(dir, f.path))) {
      await atomicWrite(join(dir, f.path), f.contents);
      created.push(f.path);
    }
  for (const p of orphans) await rm(join(dir, p), { force: true });

  const lock: Lock = {
    owninfra: meta.owninfra,
    prettier: prettierVersion,
    irHash: meta.irHash,
    files: Object.fromEntries(generated.map((f) => [f.path, sha256(f.contents)])),
  };
  const lockText = JSON.stringify(lock, null, 2) + "\n";
  if ((await current(join(dir, lockFile))) !== lockText) await atomicWrite(join(dir, lockFile), lockText);
  return { ok: true, written, unchanged, created, deleted: orphans.sort(), forced: opts.force ? edited.sort() : [] };
}
