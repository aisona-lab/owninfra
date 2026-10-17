import { parseValue, trimEnds, type FieldSpec } from "./codecs";
import { createColumns } from "./guard";
import type { Column, EntityDef } from "./types";

export type FieldErrors = Record<string, string>;
export type Coerced = { ok: true; values: Record<string, unknown> } | { ok: false; errors: FieldErrors };

export const fieldSpec = (c: Column): FieldSpec => ({
  name: c.name,
  type: c.input,
  required: c.required,
  min: c.min,
  max: c.max,
  pattern: c.pattern,
  precision: c.precision,
  scale: c.scale,
  values: c.values,
});

export function coerce(entity: EntityDef, input: Record<string, unknown>, mode: "create" | "update"): Coerced {
  const columns = mode === "create" ? createColumns(entity) : entity.columns;
  const settable = new Map(columns.map((c) => [c.name, c]));
  const known = new Set(entity.columns.map((c) => c.name));
  const errors: FieldErrors = {};
  for (const k of Object.keys(input)) if (!settable.has(k)) errors[k] = known.has(k) ? "cannot be set when creating" : "unknown field";
  const values: Record<string, unknown> = {};
  for (const c of columns) {
    if (input[c.name] === undefined) {
      if (mode === "create" && c.required && c.default === null) errors[c.name] = "is required";
      continue;
    }
    const r = parseValue(fieldSpec(c), input[c.name]);
    if (!r.ok) errors[c.name] = r.error;
    else if (r.value !== undefined) values[c.name] = r.value;
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, values };
}

export const describeErrors = (errors: FieldErrors) =>
  Object.entries(errors)
    .map(([k, m]) => `${k} ${m}`)
    .join("; ");

const localDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

export function fromForm(columns: readonly Column[], form: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of columns) {
    const v = form.get(c.name);
    if (c.input === "bool") {
      out[c.name] = v === "on" || v === "true";
      continue;
    }
    if (typeof v !== "string") continue;
    const s = trimEnds(v);
    if (c.input === "int" && /^[+-]?\d+$/.test(s)) out[c.name] = Number(s);
    else if (c.input === "datetime" && localDateTime.test(s)) out[c.name] = `${s}Z`;
    else out[c.name] = v;
  }
  return out;
}
