import type { Column, EntityDef } from "./types";

export type Coerced = { ok: true; values: Record<string, unknown> } | { ok: false; errors: string[] };

const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function one(c: Column, raw: unknown): { value: unknown } | { error: string } {
  if (c.input === "bool") return { value: raw === true || raw === "true" || raw === "on" };
  const s = typeof raw === "string" ? raw.trim() : raw;
  if (s === "" || s === null || s === undefined) return c.required ? { error: `${c.name} is required` } : { value: null };
  switch (c.input) {
    case "int":
    case "decimal": {
      const n = Number(s);
      if (!Number.isFinite(n) || (c.input === "int" && !Number.isInteger(n))) return { error: `${c.name} must be a number` };
      if (c.min !== null && n < c.min) return { error: `${c.name} must be at least ${c.min}` };
      if (c.max !== null && n > c.max) return { error: `${c.name} must be at most ${c.max}` };
      return { value: c.input === "int" ? n : String(s) };
    }
    case "date":
      return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) ? { value: s } : { error: `${c.name} must be YYYY-MM-DD` };
    case "datetime":
      return typeof s === "string" && !Number.isNaN(Date.parse(s)) ? { value: new Date(s).toISOString() } : { error: `${c.name} must be a date-time` };
    case "enum":
      return c.values?.includes(String(s)) ? { value: String(s) } : { error: `${c.name} must be one of ${c.values?.join(", ")}` };
    case "ref":
      return typeof s === "string" && uuid.test(s) ? { value: s } : { error: `${c.name} must be an id` };
    default: {
      if (typeof s !== "string") return { error: `${c.name} must be text` };
      if (c.input === "email" && !email.test(s)) return { error: `${c.name} must be an email address` };
      if (c.max !== null && s.length > c.max) return { error: `${c.name} must be at most ${c.max} characters` };
      if (c.pattern !== null && !new RegExp(c.pattern).test(s)) return { error: `${c.name} must match ${c.pattern}` };
      return { value: s };
    }
  }
}

export function coerce(entity: EntityDef, input: Record<string, unknown>, mode: "create" | "update"): Coerced {
  const known = new Set(entity.columns.map((c) => c.name));
  const errors = Object.keys(input)
    .filter((k) => !known.has(k))
    .map((k) => `unknown field '${k}'`);
  const values: Record<string, unknown> = {};
  for (const c of entity.columns) {
    if (!(c.name in input)) {
      if (mode === "create" && c.required && c.default === null && c.input !== "bool") errors.push(`${c.name} is required`);
      continue;
    }
    const r = one(c, input[c.name]);
    if ("error" in r) errors.push(r.error);
    else values[c.name] = r.value;
  }
  return errors.length ? { ok: false, errors } : { ok: true, values };
}
