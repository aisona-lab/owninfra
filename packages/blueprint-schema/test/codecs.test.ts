import { describe, expect, it } from "vitest";
import { codecs, parseValue, type FieldSpec, type FieldType } from "../src/codecs.js";

const types = Object.keys(codecs) as FieldType[];
const blanks = ["", " ", "\t\n", "\u200b", " \u200b\u200c\u200d\u2060\ufeff "];

describe("blank values, before any type check", () => {
  it.each(types)("%s: required blank is 'is required'", (type) => {
    const field: FieldSpec = { name: "f", type, required: true, values: ["A"] };
    for (const raw of [...blanks, null]) expect(parseValue(field, raw)).toEqual({ ok: false, error: "is required" });
  });

  it.each(types)("%s: optional blank becomes null", (type) => {
    const field: FieldSpec = { name: "f", type, values: ["A"] };
    for (const raw of [...blanks, null]) expect(parseValue(field, raw)).toEqual({ ok: true, value: null });
  });
});

describe("normalized non-blank values", () => {
  it("stores text without zero-width characters and surrounding whitespace", () => {
    expect(parseValue({ name: "f", type: "string", required: true }, " \u200ba\u200b b\ufeff ")).toEqual({ ok: true, value: "a b" });
  });

  it("parses typed values after normalizing", () => {
    expect(parseValue({ name: "f", type: "date" }, "\u200b2026-01-02 ")).toEqual({ ok: true, value: "2026-01-02" });
    expect(parseValue({ name: "f", type: "decimal", precision: 4, scale: 2 }, " 1.5\u2060")).toEqual({ ok: true, value: "1.50" });
    expect(parseValue({ name: "f", type: "email" }, " a@b.example\u200d")).toEqual({ ok: true, value: "a@b.example" });
  });

  it("applies max length to the normalized value", () => {
    expect(parseValue({ name: "f", type: "string", max: 3 }, "\u200b abc \u200b")).toEqual({ ok: true, value: "abc" });
  });
});
