import type { Field as RawField } from "./schema.js";

export type FieldType = RawField["type"];
export type Canonical = string | number | boolean | null;
export type Parsed = { ok: true; value: Canonical } | { ok: false; error: string };
type FieldOf<T extends FieldType> = RawField & { type: T };
type Codec<T extends FieldType> = (field: FieldOf<T>, raw: unknown) => Parsed;

const ok = (value: Canonical): Parsed => ({ ok: true, value });
const fail = (error: string): Parsed => ({ ok: false, error });

export const int32 = { min: -2147483648, max: 2147483647 } as const;
const maxDecimalDigits = 1000;

function bounds(f: { min?: number; max?: number }, n: number): Parsed | null {
  if (f.min !== undefined && n < f.min) return fail(`must be at least ${f.min}`);
  if (f.max !== undefined && n > f.max) return fail(`must be at most ${f.max}`);
  return null;
}

function text(f: { max?: number; pattern?: string }, raw: unknown, extra?: (s: string) => string | null): Parsed {
  if (typeof raw !== "string") return fail("must be a string");
  if (raw.includes("\u0000")) return fail("must not contain NUL characters");
  if (f.max !== undefined && [...raw].length > f.max) return fail(`must be at most ${f.max} characters`);
  if (f.pattern !== undefined && !new RegExp(f.pattern).test(raw)) return fail(`must match ${f.pattern}`);
  const e = extra?.(raw);
  return e ? fail(e) : ok(raw);
}

const decimalSyntax = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

function decimalDigits(raw: unknown): { negative: boolean; int: string; frac: string } | null {
  const s = typeof raw === "number" ? (Number.isFinite(raw) ? String(raw) : "") : typeof raw === "string" ? raw.trim() : "";
  const m = decimalSyntax.exec(s);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) return null;
  const exp = Number(m[4] ?? 0);
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > maxDecimalDigits) return null;
  let int = m[2];
  let frac = m[3] ?? "";
  if (exp > 0) {
    const f = frac.padEnd(exp, "0");
    int += f.slice(0, exp);
    frac = f.slice(exp);
  } else if (exp < 0) {
    const i = int.padStart(-exp, "0");
    frac = i.slice(i.length + exp) + frac;
    int = i.slice(0, i.length + exp);
  }
  int = int.replace(/^0+/, "");
  if (int.length + frac.length > maxDecimalDigits) return null;
  return { negative: m[1] === "-", int, frac };
}

function roundToScale(d: { negative: boolean; int: string; frac: string }, scale: number) {
  if (d.frac.length <= scale) return { ...d, frac: d.frac.padEnd(scale, "0") };
  const kept = d.int + d.frac.slice(0, scale);
  const up = Number(d.frac[scale]) >= 5;
  const n = (BigInt(kept || "0") + (up ? 1n : 0n)).toString().padStart(scale + 1, "0");
  return { negative: d.negative, int: n.slice(0, n.length - scale).replace(/^0+/, ""), frac: n.slice(n.length - scale) };
}

function plain(d: { negative: boolean; int: string; frac: string }): string {
  const s = (d.int || "0") + (d.frac ? `.${d.frac}` : "");
  return d.negative && /[1-9]/.test(s) ? `-${s}` : s;
}

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const datetimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:\d{2})$/;

function validCalendarDate(y: number, m: number, d: number): boolean {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return y >= 1 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export const codecs: { [T in FieldType]: Codec<T> } = {
  string: (f, raw) => text(f, raw),
  text: (f, raw) => text(f, raw),
  email: (f, raw) => text(f, raw, (s) => (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? null : "must be an email address")),
  bool: (_f, raw) => (typeof raw === "boolean" ? ok(raw) : fail("must be a boolean")),
  int: (f, raw) => {
    if (typeof raw !== "number" || !Number.isInteger(raw)) return fail("must be an integer");
    if (raw < int32.min || raw > int32.max) return fail(`must be between ${int32.min} and ${int32.max} (Postgres integer)`);
    return bounds(f, raw) ?? ok(raw === 0 ? 0 : raw);
  },
  decimal: (f, raw) => {
    if (typeof raw !== "number" && typeof raw !== "string") return fail("must be a number");
    const d = decimalDigits(raw);
    if (!d) return fail("must be a number");
    const scale = f.scale ?? (f.precision !== undefined ? 0 : undefined);
    const r = scale === undefined ? { ...d, frac: d.frac.replace(/0+$/, "") } : roundToScale(d, scale);
    if (f.precision !== undefined && r.int.length > f.precision - (scale ?? 0))
      return fail(`does not fit numeric(${f.precision}, ${scale ?? 0}): at most ${f.precision - (scale ?? 0)} digits before the decimal point`);
    const value = plain(r);
    return bounds(f, Number(value)) ?? ok(value);
  },
  date: (_f, raw) => {
    const m = typeof raw === "string" ? datePattern.exec(raw) : null;
    if (!m) return fail("must be a date (YYYY-MM-DD)");
    return validCalendarDate(+m[1], +m[2], +m[3]) ? ok(raw as string) : fail(`'${String(raw)}' is not a calendar date`);
  },
  datetime: (_f, raw) => {
    const m = typeof raw === "string" ? datetimePattern.exec(raw) : null;
    if (!m) return fail("must be an ISO 8601 date-time with a time zone (Z or ±hh:mm); a date alone is ambiguous");
    const [hh, mi, ss] = [+m[4], +m[5], +(m[6] ?? 0)];
    if (!validCalendarDate(+m[1], +m[2], +m[3]) || hh > 23 || mi > 59 || ss > 59) return fail(`'${String(raw)}' is not a valid date-time`);
    if (m[8] !== "Z" && (+m[8].slice(1, 3) > 15 || +m[8].slice(4) > 59)) return fail(`'${m[8]}' is not a valid time zone offset`);
    if ((m[7] ?? "").length > 3) return fail("supports at most millisecond precision");
    const t = new Date(raw as string);
    return Number.isNaN(t.getTime()) ? fail(`'${String(raw)}' is not a valid date-time`) : ok(t.toISOString());
  },
  enum: (f, raw) => (typeof raw === "string" && f.values.includes(raw) ? ok(raw) : fail(`must be one of ${f.values.join(", ")}`)),
  ref: (f) => fail(`seed rows cannot set ref field '${f.name}' (to ${f.to}): seeded rows get generated ids, so references between seeds are not supported yet`),
  files: () => fail("files cannot be seeded"),
};

export function parseValue(field: RawField, raw: unknown): Parsed {
  if (raw === null) return field.required ? fail("is required and cannot be null") : ok(null);
  return (codecs[field.type] as (f: RawField, r: unknown) => Parsed)(field, raw);
}

export const uniqueKey = (value: Canonical) => `${typeof value}:${String(value)}`;
