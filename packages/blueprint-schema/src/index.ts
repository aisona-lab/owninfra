import { parse, YAMLParseError } from "yaml";
import { Blueprint } from "./schema.js";
import { checkSemantics, type Issue } from "./semantic.js";

export { Blueprint, Field } from "./schema.js";
export { checkSemantics, type Issue } from "./semantic.js";

export type ValidationResult =
  | { ok: true; blueprint: Blueprint; warnings: Issue[] }
  | { ok: false; errors: Issue[]; warnings: Issue[] };

export function validateBlueprint(input: unknown): ValidationResult {
  const parsed = Blueprint.safeParse(input);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((i) => ({ path: i.path.join(".") || "(root)", message: i.message }));
    return { ok: false, errors, warnings: [] };
  }
  const { errors, warnings } = checkSemantics(parsed.data);
  return errors.length ? { ok: false, errors, warnings } : { ok: true, blueprint: parsed.data, warnings };
}

export function validateBlueprintYaml(source: string): ValidationResult {
  let data: unknown;
  try {
    data = parse(source);
  } catch (e) {
    if (e instanceof YAMLParseError) return { ok: false, errors: [{ path: "(yaml)", message: e.message }], warnings: [] };
    throw e;
  }
  return validateBlueprint(data);
}
