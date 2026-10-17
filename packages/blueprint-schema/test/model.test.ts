import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { validateBlueprint, validateBlueprintYaml, type EntityName, type RoleId } from "../src/index.js";

const source = readFileSync(new URL("../../../examples/approvals/blueprint.yaml", import.meta.url), "utf8");

function model() {
  const r = validateBlueprintYaml(source);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.model;
}

describe("parse into Model", () => {
  it("normalizes the three permission spellings into one grant per action", () => {
    const pr = model().permissions.get("PurchaseRequest" as EntityName)!;
    expect(pr.get("requester" as RoleId)).toEqual({
      create: { kind: "all" },
      read: { kind: "own" },
      update: { kind: "own", inStates: ["draft"] },
      delete: { kind: "own", inStates: ["draft"] },
    });
    expect(pr.get("manager" as RoleId)!.update).toEqual({ kind: "deny" });
    expect(model().permissions.get("Department" as EntityName)!.get("admin" as RoleId)!.delete).toEqual({ kind: "all" });
  });

  it("drops v1 fields and guarded transitions from the model", () => {
    const e = model().entities.get("PurchaseRequest" as EntityName)!;
    expect([...e.fields.keys()]).not.toContain("attachments");
    expect([...e.workflow!.transitions.keys()]).not.toContain("auto_approve_small");
    expect(e.workflow!.separationOfDuties).toBe(true);
  });

  it("resolves refs and seed users", () => {
    const m = model();
    expect(m.entities.get("PurchaseRequest" as EntityName)!.fields.get("vendor" as never)).toMatchObject({ kind: "ref", target: "Vendor" });
    expect(m.seed.users.map((u) => u.email)).toContain("manager@acme.example");
  });

  it("rejects seed users with unknown roles and seed rows for unknown entities", () => {
    const bp = parse(source);
    bp.seed.users[0].roles = ["ghost"];
    bp.seed.Nope = [{}];
    const r = validateBlueprint(bp);
    expect(r.ok ? [] : r.errors.map((e) => `${e.path}: ${e.message}`)).toEqual([
      "seed.users[0].roles[0]: unknown role 'ghost'",
      "seed.Nope: unknown entity 'Nope'",
    ]);
  });
});

describe("naming", () => {
  it("derives snake_case plural table names", async () => {
    const { tableName } = await import("../src/index.js");
    expect(["PurchaseRequest", "Category", "Address", "Box", "Day", "HTTPLog"].map(tableName)).toEqual([
      "purchase_requests",
      "categories",
      "addresses",
      "boxes",
      "days",
      "http_logs",
    ]);
    expect(model().entities.get("PurchaseRequest" as EntityName)!.table).toBe("purchase_requests");
  });

  it("NFC-normalizes labels so composed and decomposed input match", () => {
    const decomposed = source.replace("Ingeniería", "Ingenieri\u0301a").replace('"Departamento"', '"Departamento\u0301"');
    const r = validateBlueprintYaml(decomposed);
    if (!r.ok) throw new Error("expected ok");
    expect(r.model.entities.get("Department" as EntityName)!.label).toBe("Departament\u00f3");
    expect(r.model.seed.rows.get("Department" as EntityName)![0].name).toBe("Ingenier\u00eda");
  });
});
