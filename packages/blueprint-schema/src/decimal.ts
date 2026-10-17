const pattern = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

export type Decimal = { negative: boolean; digits: string; exponent: number };

export function parseDecimal(v: unknown): Decimal | null {
  const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : typeof v === "string" ? v.trim() : "";
  const m = pattern.exec(s);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) return null;
  const int = m[2];
  const frac = m[3] ?? "";
  const raw = (int + frac).replace(/^0+/, "");
  const exponent = Number(m[4] ?? 0) - frac.length;
  if (raw === "") return { negative: false, digits: "0", exponent: 0 };
  const trimmed = raw.replace(/0+$/, "");
  return { negative: m[1] === "-", digits: trimmed, exponent: exponent + (raw.length - trimmed.length) };
}

function roundHalfAwayFromZero(d: Decimal, scale: number): Decimal {
  if (-d.exponent <= scale) return d;
  const drop = -d.exponent - scale;
  if (drop > d.digits.length) return { negative: false, digits: "0", exponent: 0 };
  const keep = d.digits.slice(0, d.digits.length - drop) || "0";
  const up = Number(d.digits[d.digits.length - drop]) >= 5;
  const n = (BigInt(keep) + (up ? 1n : 0n)).toString();
  return parseDecimal(`${d.negative ? "-" : ""}${n}e${-scale}`)!;
}

export function canonicalDecimal(v: unknown, scale?: number): string | null {
  let d = parseDecimal(v);
  if (!d) return null;
  if (scale !== undefined) d = roundHalfAwayFromZero(d, scale);
  if (d.digits === "0") return "0";
  return `${d.negative ? "-" : ""}${d.digits}e${d.exponent}`;
}
