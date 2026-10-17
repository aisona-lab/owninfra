import { describe, expect, it } from "vitest";
import { parseValue, type FieldSpec } from "../src/codecs.js";

describe("required text codecs", () => {
  it.each(["string", "text", "email"] as const)("%s rejects blank and whitespace-only values when required", (type) => {
    const field: FieldSpec = { name: "f", type, required: true };
    for (const raw of ["", " ", "   ", "\t\n"]) expect(parseValue(field, raw)).toEqual({ ok: false, error: "is required" });
  });

  it.each(["string", "text"] as const)("%s keeps blank values when optional", (type) => {
    expect(parseValue({ name: "f", type }, "   ")).toEqual({ ok: true, value: "   " });
  });

  it("keeps surrounding whitespace on non-blank required values", () => {
    expect(parseValue({ name: "f", type: "string", required: true }, " a ")).toEqual({ ok: true, value: " a " });
  });
});
