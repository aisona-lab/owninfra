import { describe, expect, it } from "vitest";
import { throwawayDatabase } from "../src/throwaway-db.js";

const url = (name: string) => `postgres://u:p@127.0.0.1:5432/${name}`;

describe("throwawayDatabase", () => {
  it.each(["owninfra_builder", "owninfra_verifier", "repo_builder"])("accepts %s and prints its name", (name) => {
    const lines: string[] = [];
    expect(throwawayDatabase(url(name), "repository.pg.test.ts", (l) => lines.push(l))).toBe(name);
    expect(lines).toEqual([`repository.pg.test.ts resets the public schema of database '${name}'`]);
  });

  it.each(["owninfra", "owninfra_prod", "spend_approvals", "builder", "owninfra_builder_old"])("refuses %s and still prints its name", (name) => {
    const lines: string[] = [];
    expect(() => throwawayDatabase(url(name), "repository.pg.test.ts", (l) => lines.push(l))).toThrow(`refusing to reset '${name}'`);
    expect(lines).toHaveLength(1);
  });
});
