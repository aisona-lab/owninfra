import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseValue, type Canonical } from "../src/codecs.js";
import type { RawField } from "../src/index.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("codecs.pg.test.ts needs DATABASE_URL pointing at a Postgres you own");
const sql = postgres(url, { onnotice: () => {}, max: 1 });

type PgOutcome = "stored" | "error" | "changes" | "tz-dependent";
type Case = { raw: unknown; accept: boolean; canonical?: Canonical; pg: PgOutcome };
type Suite = { field: RawField; sqlType: string; cases: Case[] };

const f = (field: object) => ({ name: "v", ...field }) as RawField;
const yes = (raw: unknown, canonical: Canonical): Case => ({ raw, accept: true, canonical, pg: "stored" });
const no = (raw: unknown, pg: PgOutcome = "error"): Case => ({ raw, accept: false, pg });

const suites: Record<string, Suite> = {
  int: {
    field: f({ type: "int" }),
    sqlType: "integer",
    cases: [yes(2147483647, 2147483647), yes(-2147483648, -2147483648), yes(0, 0), no(2147483648), no(-2147483649), no(1.5), no("1", "stored")],
  },
  decimal: {
    field: f({ type: "decimal", precision: 4, scale: 2 }),
    sqlType: "numeric(4, 2)",
    cases: [
      yes("99.99", "99.99"),
      yes("99.994", "99.99"),
      yes("-99.994", "-99.99"),
      yes(1, "1.00"),
      yes("+1.0", "1.00"),
      yes("1e0", "1.00"),
      yes("0.995", "1.00"),
      yes("-0.004", "0.00"),
      yes(-0, "0.00"),
      no("99.995"),
      no("123.45"),
      no("1e400"),
      no("abc"),
    ],
  },
  decimalUnconstrained: {
    field: f({ type: "decimal" }),
    sqlType: "numeric",
    cases: [yes("1.50", "1.5"), yes("1e20", "100000000000000000000"), yes("-0.000", "0"), no("1.2.3")],
  },
  date: {
    field: f({ type: "date" }),
    sqlType: "date",
    cases: [
      yes("2024-02-29", "2024-02-29"),
      yes("2026-12-31", "2026-12-31"),
      yes("0001-01-01", "0001-01-01"),
      no("2026-02-30", "changes"),
      no("2025-02-29", "changes"),
      no("2026-13-01"),
      no("2026-01-01T00:00:00Z", "changes"),
      no("26-1-1"),
    ],
  },
  datetime: {
    field: f({ type: "datetime" }),
    sqlType: "timestamptz",
    cases: [
      yes("2026-01-01T00:00:00Z", "2026-01-01T00:00:00.000Z"),
      yes("2026-01-01T01:00:00+01:00", "2026-01-01T00:00:00.000Z"),
      yes("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
      yes("2026-03-29T01:30:00.5+01:00", "2026-03-29T00:30:00.500Z"),
      yes("2026-06-30T23:59:59-07:00", "2026-07-01T06:59:59.000Z"),
      no("2026-01-01", "tz-dependent"),
      no("2026-01-01T00:00:00", "tz-dependent"),
      no("2026-02-30T00:00:00Z", "changes"),
      no("2026-01-01T24:00:00Z", "changes"),
      no("2026-01-01T00:00:00.1234Z", "changes"),
    ],
  },
  string: {
    field: f({ type: "string", max: 3 }),
    sqlType: "varchar(3)",
    cases: [yes("abc", "abc"), yes("ééé", "ééé"), yes("CZ1", "CZ1"), no("abcd"), no("a\u0000"), no(12, "stored")],
  },
  text: { field: f({ type: "text" }), sqlType: "text", cases: [yes("long ".repeat(100), "long ".repeat(100)), no(true, "stored")] },
  email: { field: f({ type: "email" }), sqlType: "text", cases: [yes("a@b.cz", "a@b.cz"), no("not-an-email", "stored")] },
  bool: { field: f({ type: "bool" }), sqlType: "boolean", cases: [yes(true, true), yes(false, false), no("notbool", "changes"), no("true", "stored")] },
  enum: { field: f({ type: "enum", values: ["EUR", "USD"] }), sqlType: "text", cases: [yes("EUR", "EUR"), no("eur", "stored")] },
};

let probe = 0;
const asText = async (sqlType: string, value: unknown, tz = "UTC") => {
  const table = `codec_probe_${process.pid}_${probe++}`;
  await sql.unsafe(`create temp table ${table} (v ${sqlType})`);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe(`set local time zone '${tz}'`);
      const [row] = await tx`insert into ${tx(table)} (v) values (${value as postgres.SerializableParameter}) returning v, v::text as t`;
      return row as { v: unknown; t: string };
    });
  } finally {
    await sql.unsafe(`drop table ${table}`);
  }
};

const stored = async (sqlType: string, value: unknown) => {
  try {
    return { ok: true as const, ...(await asText(sqlType, value)) };
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
};

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await sql.end();
});

describe.each(Object.entries(suites))("%s codec against Postgres", (_name, { field, sqlType, cases }) => {
  it.each(cases.map((c) => [JSON.stringify(c.raw), c] as const))("%s", async (_label, c) => {
    const parsed = parseValue(field, c.raw);
    expect(parsed.ok).toBe(c.accept);
    if (parsed.ok) {
      expect(parsed.value).toEqual(c.canonical);
      const back = await stored(sqlType, parsed.value);
      expect(back).toMatchObject({ ok: true });
      if (!back.ok) return;
      const roundTrip = sqlType === "timestamptz" ? (back.v as Date).toISOString() : typeof parsed.value === "string" ? back.t : back.v;
      expect(roundTrip).toEqual(parsed.value);
      return;
    }
    const raw = await stored(sqlType, c.raw);
    if (c.pg === "error") expect(raw.ok).toBe(false);
    if (c.pg === "stored") expect(raw.ok).toBe(true);
    if (c.pg === "changes") {
      expect(raw.ok).toBe(true);
      if (raw.ok) expect(sqlType === "timestamptz" ? (raw.v as Date).toISOString() : raw.t).not.toBe(c.raw);
    }
    if (c.pg === "tz-dependent") {
      const at = (tz: string) =>
        sql.begin(async (tx) => {
          await tx.unsafe(`set local time zone '${tz}'`);
          const [r] = await tx.unsafe(`select ('${String(c.raw).replace(/'/g, "''")}')::timestamptz at time zone 'UTC' as v`);
          return String((r as { v: unknown }).v);
        });
      expect(await at("UTC")).not.toBe(await at("America/New_York"));
    }
  });
});
