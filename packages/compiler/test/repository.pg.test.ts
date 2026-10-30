// Runs the golden app's repository against both of its database drivers: postgres.js over TCP, and the RDS Data
// API driver talking to local-data-api (an emulator in front of the same Postgres). Faults the emulator can't
// produce (Aurora resuming, slow responses, the 1 MiB result cap) are injected around its client.
import { readFileSync } from "node:fs";
import { RDSDataClient } from "@aws-sdk/client-rds-data";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { throwawayDatabase } from "./throwaway-db.js";

const url = process.env.REPO_TEST_DATABASE_URL;
const endpoint = process.env.DATA_API_ENDPOINT;
if (!url || !endpoint)
  throw new Error("repository.pg.test.ts needs REPO_TEST_DATABASE_URL (a throwaway database whose name ends in _builder or _verifier) and DATA_API_ENDPOINT (local-data-api in front of it)");
const database = throwawayDatabase(url);

const resourceArn = process.env.DATA_API_RESOURCE_ARN ?? "arn:aws:rds:eu-north-1:000000000000:cluster:local";
const secretArn = process.env.DATA_API_SECRET_ARN ?? "arn:aws:secretsmanager:eu-north-1:000000000000:secret:local";
const app = new URL("golden/approvals/app/", import.meta.url);
const lib = (f: string) => new URL(`src/lib/(generated)/${f}`, app).href;

type Param = string | number | boolean | null;
type DbRow = Record<string, unknown>;
type Db = { driver: string; query(text: string, params?: readonly Param[]): Promise<DbRow[]>; begin<T>(fn: (tx: Db) => Promise<T>): Promise<T> };
type Send = (command: { constructor: { name: string }; input: Record<string, unknown> }, options?: { abortSignal?: AbortSignal }) => Promise<unknown>;

// The repository reads its Db from this global (db.ts caches it there), so it is set before db.ts is first imported.
let current: Db;
const forward = (): Db => ({
  get driver() {
    return current.driver;
  },
  query: (text, params) => current.query(text, params),
  begin: (fn) => current.begin(fn),
});
(globalThis as { owninfraDb?: Db }).owninfraDb = forward();

const { fromEnv } = (await import(lib("db.ts"))) as { fromEnv: (env: Record<string, string>) => Db };
const { dataApi } = (await import(lib("data-api.ts"))) as { dataApi: (o: object) => Db };
const repo = await import(lib("repository.ts"));
const { HttpError, Unavailable, startingUp, unknownOutcome } = await import(lib("errors.ts"));

const admin = postgres(url, { onnotice: () => {}, max: 1 });
const emulator = new RDSDataClient({ endpoint, region: "eu-north-1", maxAttempts: 1, credentials: { accessKeyId: "local", secretAccessKey: "local" } });

/** Wraps the emulator client so a test can see every call and change what one does. */
function faulty(hook?: (name: string, input: Record<string, unknown>, send: () => Promise<unknown>, signal?: AbortSignal) => Promise<unknown>) {
  const calls: string[] = [];
  const client = {
    send: ((command, options) => {
      const name = command.constructor.name.replace(/Command$/, "");
      calls.push(name);
      const send = () => (emulator.send as unknown as Send)(command, options);
      return hook ? hook(name, command.input, send, options?.abortSignal) : send();
    }) as Send,
  };
  return { client, calls };
}

const viaDataApi = (client: object = emulator, budgetMs?: number): Db => dataApi({ resourceArn, secretArn, database, client, budgetMs });
const viaTcp = fromEnv({ DATABASE_URL: url });
const drivers: Record<string, () => Db> = { postgres: () => viaTcp, "data-api": () => viaDataApi() };

/** Resolves after ms, or rejects like the SDK does when the signal aborts first. */
function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(Object.assign(new Error("Request aborted"), { name: "AbortError" }));
    });
  });
}

const resumingError = () =>
  Object.assign(new Error("A request was cancelled because the Aurora Serverless DB instance was paused."), { name: "DatabaseResumingException" });

/** Each Data API response over limit bytes fails the way the real service does. */
const sizeCapped = (limit: number) =>
  faulty(async (name, _input, send) => {
    const out = (await send()) as { records?: unknown[] };
    if (name === "ExecuteStatement" && JSON.stringify(out.records ?? []).length > limit)
      throw Object.assign(new Error("Database response exceeded size limit"), { name: "BadRequestException" });
    return out;
  });

const users = {
  admin: { email: "admin@acme.example", roles: ["admin"] },
  requester: { email: "requester@acme.example", roles: ["requester"] },
  manager: { email: "manager@acme.example", roles: ["manager"] },
  finance: { email: "finance@acme.example", roles: ["finance"] },
};

const count = async (table: string, where = "true") => Number((await admin.unsafe(`select count(*)::int as n from "${table}" where ${where}`))[0].n);

async function reset() {
  await admin.unsafe("drop schema public cascade; create schema public;");
  await admin.unsafe(readFileSync(new URL("drizzle/0000_init.sql", app), "utf8"));
}

let seq = 0;
const department = (over: Record<string, unknown> = {}) => {
  seq++;
  return repo.create(users.admin, "departments", { name: `Dept ${seq}`, code: `D${"ABCDEFGHIJKLMNOPQRSTUVWXYZ"[seq % 26]}${"ABCDEFGHIJKLMNOPQRSTUVWXYZ"[Math.floor(seq / 26) % 26]}`, manager_email: "manager@acme.example", ...over });
};
const vendor = () => repo.create(users.admin, "vendors", { name: `Vendor ${++seq}`, tax_id: `T${seq}` });

const exotic = {
  emoji: "Coffee ☕ for the team 🎉👩🏽‍💻",
  arabic: "طلب شراء للقسم",
  hebrew: "בקשת רכש למחלקה",
  hindi: "विभाग के लिए खरीद अनुरोध",
  czech: "Příliš žluťoučký kůň úpěl ďábelské ódy",
};

beforeAll(reset);
afterAll(async () => {
  await admin.end();
  emulator.destroy();
});

describe.each(Object.keys(drivers))("repository over %s", (driver) => {
  beforeEach(async () => {
    current = drivers[driver]();
    await admin.unsafe("truncate audit_events, purchase_requests, departments, vendors");
  });

  it("selects the driver under test", () => expect(current.driver).toBe(driver));

  it("creates, reads, updates and deletes every example entity, each with its audit row in the same transaction", async () => {
    for (const make of [department, vendor]) {
      const row = await make();
      const table = row.code ? "departments" : "vendors";
      expect(await repo.get(users.admin, table, row.id)).toEqual(row);
      const updated = await repo.update(users.admin, table, row.id, { name: `${row.name} (renamed)` });
      expect(updated.name).toBe(`${row.name} (renamed)`);
      expect(Date.parse(updated.updated_at)).toBeGreaterThanOrEqual(Date.parse(row.updated_at));
      await repo.remove(users.admin, table, row.id);
      await expect(repo.get(users.admin, table, row.id)).rejects.toMatchObject({ status: 404 });
      const audit = await admin`select action, before, after from audit_events where entity_id = ${row.id} order by id`;
      expect(audit.map((a) => a.action)).toEqual(["create", "update", "delete"]);
      expect(audit[0].before).toBeNull();
      expect(audit[0].after).toEqual(row);
      expect(audit[2].after).toBeNull();
    }
    const [d, v] = [await department(), await vendor()];
    const pr = await repo.create(users.requester, "purchase_requests", { title: "Laptops", amount: "1234567890.12", department: d.id, vendor: v.id, justification: "x", needed_by: "2024-02-29" });
    expect(pr).toMatchObject({ amount: "1234567890.12", needed_by: "2024-02-29", status: "draft", currency: "EUR", description: null, created_by: users.requester.email });
    expect(await repo.list(users.requester, "purchase_requests")).toEqual([pr]);
    expect(await repo.list(users.manager, "purchase_requests")).toEqual([pr]);
    await repo.remove(users.requester, "purchase_requests", pr.id);
    expect(await count("purchase_requests")).toBe(0);
  });

  it("runs a workflow to its end, auditing each transition", async () => {
    const [d, v] = [await department(), await vendor()];
    const pr = await repo.create(users.requester, "purchase_requests", { title: "Chairs", amount: "99.90", department: d.id, vendor: v.id, justification: "x" });
    await expect(repo.transition(users.manager, "purchase_requests", pr.id, "manager_approve")).rejects.toMatchObject({ status: 409 });
    for (const [user, t, to] of [
      [users.requester, "submit", "submitted"],
      [users.manager, "manager_approve", "manager_approved"],
      [users.finance, "finance_approve", "approved"],
      [users.finance, "mark_paid", "paid"],
    ] as const)
      expect((await repo.transition(user, "purchase_requests", pr.id, t)).status).toBe(to);
    const audit = await admin`select action, before->>'status' as "from", after->>'status' as "to" from audit_events where entity_id = ${pr.id} order by id`;
    expect(audit.map((a) => `${a.action} ${a.from}->${a.to}`)).toEqual([
      "create null->draft",
      "transition:submit draft->submitted",
      "transition:manager_approve submitted->manager_approved",
      "transition:finance_approve manager_approved->approved",
      "transition:mark_paid approved->paid",
    ]);
  });

  it("leaves no partial write and no audit row when a transaction fails part-way", async () => {
    const real = current;
    current = {
      ...real,
      begin: (fn) =>
        real.begin((tx) =>
          fn({
            ...tx,
            query: async (text, params) => {
              if (text.startsWith("insert into audit_events")) throw new Error("injected failure after the row was written");
              return tx.query(text, params);
            },
          }),
        ),
    };
    await expect(department()).rejects.toThrow("injected failure");
    current = real;
    const d = await department();
    current = { ...real, begin: (fn) => real.begin((tx) => fn({ ...tx, query: (t, p) => (t.startsWith("insert into audit_events") ? Promise.reject(new Error("boom")) : tx.query(t, p)) })) };
    await expect(repo.update(users.admin, "departments", d.id, { name: "changed" })).rejects.toThrow("boom");
    current = real;
    expect(await count("departments")).toBe(1);
    expect((await repo.get(users.admin, "departments", d.id)).name).toBe(d.name);
    expect(await count("audit_events")).toBe(1);
  });

  it("round-trips decimals, dates, timestamps, null, and non-Latin text through the repository unchanged", async () => {
    const [d, v] = [await department({ name: exotic.czech }), await vendor()];
    for (const [k, text] of Object.entries(exotic)) {
      const pr = await repo.create(users.requester, "purchase_requests", { title: text, description: `${k}: ${text}`, amount: "0.01", department: d.id, vendor: v.id, justification: text, needed_by: "0001-01-01" });
      expect(await repo.get(users.requester, "purchase_requests", pr.id)).toEqual(pr);
      expect(pr).toMatchObject({ title: text, justification: text, amount: "0.01", needed_by: "0001-01-01", rejection_reason: null });
      const [a] = await admin`select after from audit_events where entity_id = ${pr.id}`;
      expect(a.after).toEqual(pr);
    }
    expect((await repo.get(users.admin, "departments", d.id)).name).toBe(exotic.czech);
  });

  it("returns every row of a list bigger than the Data API's 1 MiB response cap", async () => {
    const [d, v] = [await department(), await vendor()];
    const big = "ž".repeat(15_000); // 30 KB of UTF-8 per row, under the 64 KB row limit
    await admin.unsafe(
      `insert into purchase_requests (title, description, amount, department, vendor, justification, created_by)
       select 'Row ' || g, $1, 1, $2, $3, 'x', 'requester@acme.example' from generate_series(1, 60) g`,
      [big, d.id, v.id],
    );
    if (driver === "data-api") current = viaDataApi(sizeCapped(1024 * 1024).client);
    const rows = await repo.list(users.requester, "purchase_requests");
    expect(rows).toHaveLength(60);
    expect(new Set(rows.map((r: { id: string }) => r.id)).size).toBe(60);
    expect(rows.every((r: { description: string }) => r.description === big)).toBe(true);
  });
});

describe("drivers return identical values", () => {
  const sql = `select cast($1 as numeric) as n, cast($2 as date) as d, cast($3 as timestamptz) as ts, cast($4 as jsonb) as j, cast($5 as text) as nul,
    cast($6 as text) as empty, cast($7 as text) as t, cast($8 as integer) as i, cast($9 as boolean) as b, cast($10 as bigint) as big, now() is not null as live`;
  const params: Param[] = [
    "1234567890.123456789",
    "2024-02-29",
    "2026-03-29T01:30:00.5+01:00",
    JSON.stringify({ a: exotic.emoji, b: [1, null, 1.5], c: { [exotic.arabic]: exotic.hebrew }, d: null, e: "" }),
    null,
    "",
    Object.values(exotic).join(" | "),
    -2147483648,
    true,
    "9007199254740991",
  ];
  const plain = (rows: DbRow[]) => JSON.parse(JSON.stringify(rows));

  it("for numeric precision, timestamptz, json, null, empty string, and emoji, RTL, Indic and Czech text", async () => {
    const [viaTcp, viaApi] = [plain(await drivers.postgres().query(sql, params)), plain(await drivers["data-api"]().query(sql, params))];
    expect(viaTcp[0]).toMatchObject({ n: "1234567890.123456789", d: "2024-02-29", ts: "2026-03-29T00:30:00.500Z", nul: null, empty: "", t: params[6], i: -2147483648, b: true });
    expect(viaTcp[0].j).toEqual(JSON.parse(params[3] as string));
    expect(viaApi).toEqual(viaTcp);
  });

  it("for the audit log: its bigserial id is the same string on both, beyond 2^53 too", async () => {
    await admin.unsafe("truncate audit_events, purchase_requests, departments, vendors");
    current = viaTcp;
    await department();
    await admin.unsafe("select setval('audit_events_id_seq', 9007199254740992)");
    await department();
    const overTcp = await repo.auditLog(users.admin);
    current = viaDataApi();
    const overDataApi = await repo.auditLog(users.admin);
    expect(overDataApi).toEqual(overTcp);
    expect(overTcp).toHaveLength(2);
    expect(overTcp[0].id).toBe("9007199254740993");
    expect([...overTcp, ...overDataApi].map((r: { id: unknown }) => typeof r.id)).toEqual(["string", "string", "string", "string"]);
  });

  it("except bigint beyond 2^53, which the emulator returns as a JS number (a gap the repository avoids: its only bigint is audit_events.id)", async () => {
    const [[t], [a]] = [await drivers.postgres().query("select cast($1 as bigint) as v", ["9007199254740993"]), await drivers["data-api"]().query("select cast($1 as bigint) as v", ["9007199254740993"])];
    expect(t.v).toBe("9007199254740993");
    expect(a.v).not.toBe("9007199254740993");
  });
});

describe("Data API limits", () => {
  beforeEach(() => admin.unsafe("truncate audit_events, purchase_requests, departments, vendors"));

  it("halves the page until each page fits, and returns the same rows in the same order as TCP", async () => {
    current = viaTcp;
    for (let i = 0; i < 40; i++) await department();
    const expected = await repo.list(users.admin, "departments");
    const capped = sizeCapped(4_000);
    current = viaDataApi(capped.client);
    expect(await repo.list(users.admin, "departments")).toEqual(expected);
    expect(capped.calls.filter((c) => c === "RollbackTransaction").length).toBeGreaterThan(0);
  });

  it("fails loudly, never truncating, when a single row is over the cap", async () => {
    current = viaTcp;
    await department();
    current = viaDataApi(sizeCapped(100).client);
    await expect(repo.list(users.admin, "departments")).rejects.toThrow("exceeded size limit");
  });
});

describe("Aurora resuming from auto-pause (Data API)", { timeout: 60_000 }, () => {
  beforeEach(() => admin.unsafe("truncate audit_events, purchase_requests, departments, vendors"));

  /** Every call made before the database is up waits for it, as the Data API does on a paused cluster. */
  function pausedFor(ms: number) {
    let upAt = Date.now() + ms;
    const f = faulty(async (_name, _input, send, signal) => {
      const left = upAt - Date.now();
      if (left > 0) await wait(left, signal);
      return send();
    });
    return { ...f, resume: () => (upAt = Date.now()) };
  }

  async function attempt(fn: () => Promise<unknown>) {
    const start = Date.now();
    const result = await fn().then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    return { ...result, ms: Date.now() - start };
  }

  it("a 5 s resume just makes the first request slower", async () => {
    const p = pausedFor(5_000);
    current = viaDataApi(p.client);
    const r = await attempt(() => department());
    expect(r.ok).toBe(true);
    expect(r.ms).toBeGreaterThanOrEqual(4_900);
    expect([await count("departments"), await count("audit_events")]).toEqual([1, 1]);
  });

  for (const ms of [25_000, 40_000])
    it(`a ${ms / 1000} s resume answers "starting up" within the Lambda timeout, writes nothing, and the retry writes once`, async () => {
      const p = pausedFor(ms);
      current = viaDataApi(p.client);
      const r = await attempt(() => department({ name: "Once", code: "ONCE" }));
      expect(r.ok).toBe(false);
      expect(r.e).toBeInstanceOf(Unavailable);
      expect(r.e).toMatchObject({ status: 503, message: startingUp, retryAfter: 5 });
      expect(r.ms).toBeLessThan(25_000);
      expect(await count("departments")).toBe(0);
      p.resume();
      await department({ name: "Once", code: "ONCE" });
      expect([await count("departments"), await count("audit_events")]).toEqual([1, 1]);
      const list = await attempt(() => repo.list(users.admin, "departments"));
      expect(list.ok).toBe(true);
    });

  it("retries DatabaseResumingException until the database is up", async () => {
    const upAt = Date.now() + 3_000;
    const f = faulty((_n, _i, send) => (Date.now() < upAt ? Promise.reject(resumingError()) : send()));
    current = viaDataApi(f.client);
    await department();
    expect(f.calls.filter((c) => c === "BeginTransaction").length).toBeGreaterThan(1);
    expect([await count("departments"), await count("audit_events")]).toEqual([1, 1]);
  });

  it("answers starting up when DatabaseResumingException outlasts the budget", async () => {
    const f = faulty(() => Promise.reject(resumingError()));
    current = viaDataApi(f.client, 3_000);
    await expect(department()).rejects.toMatchObject({ status: 503, message: startingUp });
    expect(await count("departments")).toBe(0);
  });

  it("never retries a commit whose answer is lost, and says the outcome is unknown", async () => {
    const f = faulty(async (name, _input, send, signal) => {
      const out = await send();
      if (name === "CommitTransaction") await wait(60_000, signal);
      return out;
    });
    current = viaDataApi(f.client, 1_000);
    await expect(department()).rejects.toMatchObject({ status: 503, message: unknownOutcome });
    expect(f.calls.filter((c) => c === "CommitTransaction")).toHaveLength(1);
    expect([await count("departments"), await count("audit_events")]).toEqual([1, 1]);
  });

  it("does not turn ordinary database errors into 503s", async () => {
    current = viaDataApi();
    await department({ name: "Dup", code: "DUP" });
    const r = await attempt(() => department({ name: "Dup", code: "DUP" }));
    expect(r.ok).toBe(false);
    expect(r.e).not.toBeInstanceOf(HttpError);
    expect([await count("departments"), await count("audit_events")]).toEqual([1, 1]);
  });
});
