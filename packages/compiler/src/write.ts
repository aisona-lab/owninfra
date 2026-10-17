import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isGeneratedPath } from "./zones.js";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { prettierVersion, sha256, type FileSet } from "./emit.js";

export const lockFile = "owninfra.lock.json";

export type Lock = { owninfra: string; prettier: string; irHash: string; files: Record<string, string> };

export type WriteReport =
  | { ok: true; written: string[]; unchanged: number; created: string[]; deleted: string[]; forced: string[]; stray: string[] }
  | { ok: false; edited: string[] }
  | { ok: false; badLock: string };

export function lockPathProblem(dir: string, path: string): string | undefined {
  if (isAbsolute(path) || normalize(path) !== path || !isGeneratedPath(path)) return `'${path}' is not a generated path`;
  const root = realpathSync.native(dir);
  const abs = join(dir, path);
  let p = abs;
  while (!existsSync(p)) p = dirname(p);
  const real = realpathSync.native(p);
  const expected = join(root, relative(dir, p));
  if (real !== expected) return `'${path}' resolves to ${real}, outside the generated zone (case or symlink mismatch)`;
  if (p === abs && statSync(abs).isDirectory()) return `'${path}' is a directory, not a generated file`;
  return undefined;
}

function strayFiles(dir: string, known: Set<string>): string[] {
  const out: string[] = [];
  const walk = (rel: string, inZone: boolean) => {
    const abs = join(dir, rel);
    if (!existsSync(abs)) return;
    for (const d of readdirSync(abs, { withFileTypes: true })) {
      const child = rel ? `${rel}/${d.name}` : d.name;
      const zone = inZone || d.name === "(generated)";
      if (d.isDirectory()) walk(child, zone);
      else if (zone && !known.has(child)) out.push(child);
    }
  };
  walk("app/src", false);
  return out.sort();
}

export class LockError extends Error {}

export async function readLock(dir: string): Promise<Lock | null> {
  let text: string;
  try {
    text = await readFile(join(dir, lockFile), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  let lock: unknown;
  try {
    lock = JSON.parse(text);
  } catch (e) {
    throw new LockError(`${lockFile} is not valid JSON (${(e as Error).message}). Restore it from git, or delete it and rerun generate with --force.`);
  }
  const files = (lock as Lock | null)?.files;
  if (!lock || typeof lock !== "object" || typeof (lock as Lock).irHash !== "string" || !files || typeof files !== "object" || Object.values(files).some((h) => typeof h !== "string"))
    throw new LockError(`${lockFile} does not have the expected shape { owninfra, prettier, irHash, files }. Restore it from git, or delete it and rerun generate with --force.`);
  return lock as Lock;
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
  const generated = files.filter((f) => f.zone === "generated");
  const next = new Set(generated.map((f) => f.path));
  let previous: Record<string, string>;
  try {
    previous = (await readLock(dir))?.files ?? {};
  } catch (e) {
    if (e instanceof LockError) return { ok: false, badLock: e.message };
    throw e;
  }
  for (const p of generated.map((f) => f.path)) {
    const problem = lockPathProblem(dir, p);
    if (problem) return { ok: false, badLock: `refusing to write ${problem}` };
  }
  const orphans = Object.keys(previous).filter((p) => !next.has(p));
  for (const p of Object.keys(previous)) {
    const problem = lockPathProblem(dir, p);
    if (problem) return { ok: false, badLock: `${lockFile} lists ${problem}; refusing to touch it. Restore the lock from git.` };
  }

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
  return { ok: true, written, unchanged, created, deleted: orphans.sort(), forced: opts.force ? edited.sort() : [], stray: strayFiles(dir, next) };
}
