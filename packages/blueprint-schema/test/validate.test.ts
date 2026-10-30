import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { validateBlueprint, validateBlueprintYaml } from "../src/index.js";

const exampleSource = readFileSync(new URL("../../../examples/approvals/blueprint.yaml", import.meta.url), "utf8");
const example = () => parse(exampleSource);
const messages = (input: unknown) => {
  const r = validateBlueprint(input);
  return r.ok ? [] : r.errors.map((e) => `${e.path}: ${e.message}`);
};

describe("validateBlueprint", () => {
  it("accepts the approvals example and warns about v1 features", () => {
    const r = validateBlueprintYaml(exampleSource);
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.message)).toEqual(
      expect.arrayContaining([
        "'files' fields are v1 and ignored by the MVP",
        "field guards are v1 and ignored by the MVP",
        "only dev and prod are supported by the MVP",
      ]),
    );
  });

  it("reports YAML syntax errors", () => {
    const r = validateBlueprintYaml("app: [unclosed");
    expect(r.ok).toBe(false);
  });

  it("rejects unknown top-level keys and bad field types", () => {
    const bp = example();
    bp.extra = 1;
    bp.entities[0].fields[0].type = "uuid";
    const errs = messages(bp);
    expect(errs.some((e) => e.includes("extra"))).toBe(true);
    expect(errs.some((e) => e.startsWith("entities.0.fields.0"))).toBe(true);
  });

  it("requires a dev environment and valid account ids", () => {
    const bp = example();
    delete bp.environments.dev;
    bp.environments.prod.account = "123";
    const errs = messages(bp);
    expect(errs).toContain("environments: a 'dev' environment is required");
    expect(errs).toContain("environments.prod.account: must be a 12-digit AWS account id");
  });

  it.each([0, -1, 1.5])("rejects compute.max %s, naming the field and the allowed range", (max) => {
    const bp = example();
    bp.environments.dev.compute.max = max;
    expect(messages(bp)).toContain("environments.dev.compute.max: must be a whole number, 1 or more");
  });

  it("accepts compute.max 1", () => {
    const bp = example();
    bp.environments.dev.compute.max = 1;
    expect(messages(bp)).toEqual([]);
  });

  it("detects dangling refs, roles and states", () => {
    const bp = example();
    const pr = bp.entities[2];
    pr.fields.find((f: { name: string }) => f.name === "vendor").to = "Supplier";
    pr.workflow.transitions[0].roles = ["intern"];
    pr.workflow.transitions[1].to = "limbo";
    bp.permissions.Vendor.auditor = ["read"];
    expect(messages(bp)).toEqual(
      expect.arrayContaining([
        "entities[2].fields[5].to: unknown entity 'Supplier'",
        "entities[2].workflow.transitions[0].roles[0]: unknown role 'intern'",
        "entities[2].workflow.transitions[1].to: unknown state 'limbo'",
        "permissions.Vendor.auditor: unknown role 'auditor'",
      ]),
    );
  });

  it("detects unreachable states and transitions out of final states", () => {
    const bp = example();
    const wf = bp.entities[2].workflow;
    wf.states.push({ id: "archived" });
    wf.transitions.push({ id: "reopen", from: "rejected", to: "draft", roles: ["requester"] });
    expect(messages(bp)).toEqual([
      "entities[2].workflow.transitions[7].from: 'rejected' is final and cannot have outgoing transitions",
      "entities[2].workflow.states: state 'archived' is unreachable from 'draft'",
      "entities[2].workflow.states: state 'archived' has no outgoing transitions and is not final",
    ]);
  });

  it("requires ownership for 'own' rules and only_owner", () => {
    const bp = example();
    delete bp.entities[2].ownership;
    const errs = messages(bp);
    expect(errs).toContain("entities[2].workflow.transitions[0].only_owner: requires entity ownership");
    expect(errs).toContain("permissions.PurchaseRequest.requester.read: 'own' requires entity ownership");
  });

  it("checks require_fields, in_states, list fields and enum defaults", () => {
    const bp = example();
    const pr = bp.entities[2];
    pr.workflow.transitions[2].require_fields = ["reason"];
    pr.list.columns.push("total");
    pr.fields.find((f: { name: string }) => f.name === "currency").default = "GBP";
    bp.permissions.PurchaseRequest.requester.update.in_states = ["open"];
    expect(messages(bp)).toEqual(
      expect.arrayContaining([
        "entities[2].workflow.transitions[2].require_fields[0]: unknown field 'reason'",
        "entities[2].list.columns[7]: unknown field 'total'",
        "entities[2].fields[3].default: 'GBP' must be one of EUR, USD, CZK",
        "permissions.PurchaseRequest.requester.update.in_states: unknown state 'open'",
      ]),
    );
  });

  it("detects dead-end states", () => {
    const bp = example();
    const wf = bp.entities[2].workflow;
    wf.states.push({ id: "on_hold" });
    wf.transitions.push({ id: "hold", from: "submitted", to: "on_hold", roles: ["manager"] });
    expect(messages(bp)).toEqual(["entities[2].workflow.states: state 'on_hold' has no outgoing transitions and is not final"]);
  });

  it("explains malformed permission rules", () => {
    const bp = example();
    bp.permissions.Vendor.manager = "read";
    bp.permissions.PurchaseRequest.manager = { read: "everyone" };
    expect(messages(bp)).toEqual([
      "permissions.Vendor.manager: must be a list of actions (create, read, update, delete) or a map of action to rule",
      "permissions.PurchaseRequest.manager.read: must be true, false, 'all', 'own' or { own, in_states }",
    ]);
  });

  it("explains a missing or unsupported version", () => {
    const bp = example();
    bp.version = 0.2;
    expect(messages(bp)).toEqual(["version: must be 0.1"]);
    delete bp.version;
    expect(messages(bp)).toEqual(["version: Required"]);
  });

  it("flags duplicate names", () => {
    const bp = example();
    bp.roles.push({ id: "admin" });
    expect(messages(bp)).toContain("roles: duplicate 'admin'");
  });
});

describe("seed normalization", () => {
  const blanksFixture = () => parse(readFileSync(new URL("../../cli/test/fixtures/valid/seedblanks.yaml", import.meta.url), "utf8"));
  const vendors = (doc: unknown) => {
    const r = validateBlueprint(doc);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    return [...r.model.seed.rows].find(([e]) => e === "Vendor")![1];
  };

  it("omits blank optional values so column defaults apply", () => {
    const [a, b] = vendors(blanksFixture());
    expect(a).toEqual({ name: "A", tax_id: "T1" });
    expect(b).toEqual({ name: "B", tax_id: "T2", contact_email: "b@acme.example", since: "2026-12-31" });
  });

  it("keeps interior joiners byte for byte and trims only the ends", () => {
    const doc = blanksFixture();
    const names = ["👨‍👩‍👧", "می‌خواهم", "क्‍ष", "a\u2060b", "a\ufeffb"];
    doc.seed.Vendor = names.map((name, i) => ({ name: `\u200b ${name} \ufeff`, tax_id: `T${i}`, contact_email: "x@y.example\r\n" }));
    expect(vendors(doc).map((v) => [v.name, v.contact_email])).toEqual(names.map((n) => [n, "x@y.example"]));
  });

  it("rejects a zero-width-only required value", () => {
    const doc = blanksFixture();
    doc.seed.Vendor = [{ name: "\u200b", tax_id: "T1" }];
    expect(messages(doc)).toEqual(["seed.Vendor[0].name: is required"]);
  });
});
