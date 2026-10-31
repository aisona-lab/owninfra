import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateBlueprintYaml } from "@owninfra/blueprint-schema";
import { compile } from "@owninfra/compiler";
import { describe, expect, it } from "vitest";
import { checkInfra } from "../src/smoke.js";

const evalCase = (name: string) => readFileSync(fileURLToPath(new URL(`../../../evals/${name}/blueprint.yaml`, import.meta.url)), "utf8");

describe("eval cases", () => {
  it("l0-decimal-out-of-range fails L0 and names the field and the column's range", () => {
    const r = validateBlueprintYaml(evalCase("l0-decimal-out-of-range"));
    expect(r.ok ? [] : r.errors.map((e) => `${e.path}: ${e.message}`)).toEqual([
      "entities[1].fields[3].min: min 100 of 'cost' is outside what numeric(4, 2) can hold: -99.99 to 99.99",
    ]);
  });

  it("smoke-unreachable-ref passes L0, generate and the infra checks", async () => {
    const source = evalCase("smoke-unreachable-ref");
    expect(validateBlueprintYaml(source).ok).toBe(true);
    expect((await compile(source)).ok).toBe(true);
    expect(() => checkInfra(source, "dev")).not.toThrow();
    expect(() => checkInfra(source, "prod")).not.toThrow();
  });
});
