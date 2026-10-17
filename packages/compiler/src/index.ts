import { validateBlueprintYaml, type Issue } from "@owninfra/blueprint-schema";
import { databaseUrl, emit, irHash, type FileSet } from "./emit.js";
import { lower, type Ir } from "./ir.js";

export { databaseUrl, emit, irHash, sha256, prettierVersion, type FileSet, type OutFile } from "./emit.js";
export { lower, type Ir } from "./ir.js";
export { write, lockFile, type Lock, type WriteReport } from "./write.js";

export type Compiled = { ok: true; ir: Ir; files: FileSet; irHash: string; warnings: Issue[] } | { ok: false; errors: Issue[]; warnings: Issue[] };

export async function compile(source: string): Promise<Compiled> {
  const r = validateBlueprintYaml(source);
  if (!r.ok) return r;
  const ir = lower(r.model);
  return { ok: true, ir, files: await emit(ir), irHash: irHash(ir), warnings: r.warnings };
}

export const devDatabaseUrl = (ir: Ir) => databaseUrl(ir);
