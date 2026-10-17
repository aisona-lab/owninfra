import { describe, expect, it } from "vitest";
import { canonicalDecimal } from "../src/decimal.js";

describe("canonicalDecimal", () => {
  it("treats Postgres-equal numerics as equal", () => {
    const one = canonicalDecimal(1);
    for (const v of ["1", "1.0", "1.00", "+1", "+1.0", "1e0", "10e-1", "0.1e1", "001.000", 1.0]) expect(canonicalDecimal(v)).toBe(one);
    for (const v of ["0", "-0", "0.00", "+0", -0, "0e5"]) expect(canonicalDecimal(v)).toBe("0");
    expect(canonicalDecimal("1.5")).not.toBe(canonicalDecimal("-1.5"));
    expect(canonicalDecimal("1.25")).not.toBe(canonicalDecimal("1.2"));
  });

  it("rounds half away from zero to the column scale, like numeric(p, s)", () => {
    expect(canonicalDecimal("0.995", 2)).toBe(canonicalDecimal("1", 2));
    expect(canonicalDecimal("-0.995", 2)).toBe(canonicalDecimal("-1", 2));
    expect(canonicalDecimal("1.004", 2)).toBe(canonicalDecimal("1", 2));
    expect(canonicalDecimal("1.005", 2)).toBe(canonicalDecimal("1.01", 2));
    expect(canonicalDecimal("0.004", 2)).toBe("0");
    expect(canonicalDecimal("1.9", 0)).toBe(canonicalDecimal(2, 0));
  });

  it("is exact where floats are not", () => {
    expect(canonicalDecimal("0.30000000000000000001")).not.toBe(canonicalDecimal("0.3"));
    expect(canonicalDecimal("12345678901234567890.12")).toBe(canonicalDecimal("1234567890123456789012e-2"));
  });

  it("rejects non-numbers", () => {
    for (const v of ["", ".", "1.2.3", "abc", "1e", "--1", NaN, Infinity, true, null]) expect(canonicalDecimal(v)).toBeNull();
  });
});
