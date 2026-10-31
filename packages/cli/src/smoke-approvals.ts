import { check, expectStatus, type User } from "./smoke-client.js";

type Step = (name: string, fn: () => Promise<void>) => Promise<void>;
type Row = { id: string; status?: string; title?: string };

/** The approvals example's scripted run. The roles are fixed here, so a broken seed role in the blueprint fails sign-in. */
export const approvals = {
  app: "spend-approvals",
  users: {
    "admin@acme.example": ["admin"],
    "finance@acme.example": ["finance"],
    "lead@acme.example": ["manager", "requester"],
    "manager@acme.example": ["manager"],
    "requester@acme.example": ["requester"],
  } as Record<string, string[]>,

  async run(as: (email: string) => User, step: Step) {
    const [admin, finance, manager, requester] = ["admin", "finance", "manager", "requester"].map((n) => as(`${n}@acme.example`));
    const pr = "/api/e/purchase_requests";
    const move = (u: User, id: string, t: string, body?: unknown) => u.call("POST", `${pr}/${id}/transitions/${t}`, body);
    let department = "";
    let vendor = "";
    let first: Row = { id: "" };
    let second: Row = { id: "" };

    await step("create: finance adds a vendor, requester a purchase request", async () => {
      const depts = expectStatus(await requester.call("GET", "/api/e/departments"), 200, "list departments") as unknown as Row[];
      check(depts.length > 0, "the seed has no departments");
      department = depts[0]!.id;
      vendor = (expectStatus(await finance.call("POST", "/api/e/vendors", { name: "Smoke Vendor", tax_id: `SMOKE-${Date.now()}` }), 201, "create vendor") as unknown as Row).id;
      first = expectStatus(await requester.call("POST", pr, { title: "Smoke laptops", amount: "1234.50", department, vendor, justification: "smoke" }), 201, "create request") as unknown as Row;
      check(first.status === "draft", `a new request should be draft, got ${first.status}`);
    });
    await step("edit: requester renames the draft", async () => {
      const r = expectStatus(await requester.call("PATCH", `${pr}/${first.id}`, { title: "Smoke laptops (edited)" }), 200, "edit request");
      check(r.title === "Smoke laptops (edited)", `edit did not stick: ${String(r.title)}`);
    });
    await step("422: create without a title", async () => {
      const r = expectStatus(await requester.call("POST", pr, { title: " ", amount: "1", department, vendor, justification: "j" }), 422, "create without title");
      check((r.fields as Record<string, string> | undefined)?.title === "is required", `422 should name the title: ${JSON.stringify(r)}`);
    });
    await step("409: manager approves a draft", async () => {
      expectStatus(await move(manager, first.id, "manager_approve"), 409, "manager_approve on a draft");
    });
    await step("submit: requester submits the draft", async () => {
      check((expectStatus(await move(requester, first.id, "submit"), 200, "submit") as Row).status === "submitted", "submit did not reach submitted");
    });
    await step("403: requester tries manager_approve", async () => {
      expectStatus(await move(requester, first.id, "manager_approve"), 403, "requester manager_approve");
    });
    await step("approve: manager approves, finance approves", async () => {
      check((expectStatus(await move(manager, first.id, "manager_approve"), 200, "manager_approve") as Row).status === "manager_approved", "not manager_approved");
      check((expectStatus(await move(finance, first.id, "finance_approve"), 200, "finance_approve") as Row).status === "approved", "not approved");
    });
    await step("403: requester cannot read the audit log", async () => {
      expectStatus(await requester.call("GET", "/api/audit"), 403, "requester reads the audit log");
    });
    await step("reject: a rejection needs its reason (422), then rejects", async () => {
      second = expectStatus(await requester.call("POST", pr, { title: "Smoke chairs", amount: "99.90", department, vendor, justification: "smoke" }), 201, "create second request") as unknown as Row;
      expectStatus(await move(requester, second.id, "submit"), 200, "submit second");
      expectStatus(await move(manager, second.id, "manager_reject"), 422, "manager_reject without rejection_reason");
      const r = expectStatus(await move(manager, second.id, "manager_reject", { rejection_reason: "over budget" }), 200, "manager_reject");
      check(r.status === "rejected" && r.rejection_reason === "over budget", `not rejected with its reason: ${JSON.stringify(r)}`);
    });
    await step("audit log: admin sees every change, newest first", async () => {
      const log = expectStatus(await admin.call("GET", "/api/audit"), 200, "admin reads the audit log") as unknown as { entity_id: string; action: string; actor: string }[];
      const of = (id: string) => log.filter((e) => e.entity_id === id).map((e) => `${e.action} by ${e.actor}`);
      const want1 = ["transition:finance_approve by finance@acme.example", "transition:manager_approve by manager@acme.example", "transition:submit by requester@acme.example", "update by requester@acme.example", "create by requester@acme.example"];
      const want2 = ["transition:manager_reject by manager@acme.example", "transition:submit by requester@acme.example", "create by requester@acme.example"];
      check(JSON.stringify(of(first.id)) === JSON.stringify(want1), `first request's audit: ${JSON.stringify(of(first.id))}`);
      check(JSON.stringify(of(second.id)) === JSON.stringify(want2), `second request's audit: ${JSON.stringify(of(second.id))}`);
    });
  },
};
