import { describe, expect, it } from "vitest";
import { codecs, parseValue, type FieldSpec, type FieldType } from "../src/codecs.js";

const types = Object.keys(codecs) as FieldType[];
const blanks = ["", " ", "\t\n", "\r\n", "\u200b", " \u200b\u200c\u200d\u2060\ufeff "];
const keep = ["👨‍👩‍👧", "می‌خواهم", "क्‍ष", "a\u2060b", "a\ufeffb"];

describe("blank values, before any type check", () => {
  it.each(types)("%s: required blank is 'is required'", (type) => {
    const field: FieldSpec = { name: "f", type, required: true, values: ["A"] };
    for (const raw of [...blanks, null]) expect(parseValue(field, raw)).toEqual({ ok: false, error: "is required" });
  });

  it.each(types)("%s: optional blank is absent", (type) => {
    const field: FieldSpec = { name: "f", type, values: ["A"] };
    for (const raw of blanks) expect(parseValue(field, raw)).toEqual({ ok: true, value: undefined });
  });

  it("explicit null on an optional field stays null", () => {
    expect(parseValue({ name: "f", type: "string" }, null)).toEqual({ ok: true, value: null });
  });
});

describe("end-only normalization", () => {
  it.each(["string", "text"] as const)("%s keeps interior joiners and word joiners byte for byte", (type) => {
    for (const v of keep) expect(parseValue({ name: "f", type }, v)).toEqual({ ok: true, value: v });
  });

  it("trims string and email values at both ends with the same character set", () => {
    expect(parseValue({ name: "f", type: "string" }, "\ufeff \u200b👨‍👩‍👧\u2060 \u200d")).toEqual({ ok: true, value: "👨‍👩‍👧" });
    expect(parseValue({ name: "f", type: "email" }, " \u200ba@b.example\u200d\n")).toEqual({ ok: true, value: "a@b.example" });
  });

  it("text keeps the first line's indentation and drops only leading and trailing blank lines", () => {
    expect(parseValue({ name: "f", type: "text" }, " \u200b\n\t\n    indented\n\n  body  \n \n\u200b")).toEqual({ ok: true, value: "    indented\n\n  body  " });
  });

  it("normalizes CRLF to LF", () => {
    expect(parseValue({ name: "f", type: "text" }, "a\r\nb\r\n")).toEqual({ ok: true, value: "a\nb" });
    expect(parseValue({ name: "f", type: "string" }, "a\r\nb")).toEqual({ ok: true, value: "a\nb" });
  });

  it("parses typed values after trimming the ends", () => {
    expect(parseValue({ name: "f", type: "date" }, "\u200b2026-01-02 ")).toEqual({ ok: true, value: "2026-01-02" });
    expect(parseValue({ name: "f", type: "decimal", precision: 4, scale: 2 }, " 1.5\u2060")).toEqual({ ok: true, value: "1.50" });
    expect(parseValue({ name: "f", type: "int" }, " 7 ")).toEqual({ ok: false, error: "must be an integer" });
  });

  it("applies max length to the trimmed value", () => {
    expect(parseValue({ name: "f", type: "string", max: 3 }, "\u200b abc \u200b")).toEqual({ ok: true, value: "abc" });
  });
});
