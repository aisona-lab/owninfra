import type { Ir } from "@owninfra/compiler";
import { check, expectStatus, Failed, type User } from "./smoke-client.js";

type Entity = Ir["entities"][number];
type Column = Entity["columns"][number];
type Row = Record<string, unknown> & { id: string };
type Step = (name: string, fn: () => Promise<void>) => Promise<void>;
type Action = "create" | "read" | "update" | "delete";

/** Whether `email` may do `action` on a row of `entity` in `state` that `creator` made: the generated app's authorize(). */
function may(ir: Ir, email: string, entity: Entity, action: Action, row?: { creator: string; state: string | null }) {
  const roles = ir.seedUsers.find((u) => u.email === email)?.roles ?? [];
  return ir.policies.some(
    (p) =>
      p.entity === entity.entity &&
      p.action === action &&
      roles.includes(p.role) &&
      (p.scope === "all" || row?.creator === email) &&
      (!p.inStates || (row?.state != null && p.inStates.includes(row.state))),
  );
}

const classes = ["ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz", "0123456789"];

/** A value that matches `pattern`, made by changing one character of a seed value within its class (A-Z, a-z, 0-9). */
function matching(col: string, pattern: string, examples: string[], taken: Set<string>) {
  const re = new RegExp(pattern);
  for (const s of examples)
    for (let i = s.length - 1; i >= 0; i--)
      for (const c of classes.find((k) => k.includes(s[i]!)) ?? "")
        if (c !== s[i]) {
          const v = s.slice(0, i) + c + s.slice(i + 1);
          if (re.test(v) && !taken.has(v)) return v;
        }
  throw new Failed(`no value for '${col}' matches /${pattern}/; add a seed row with an example so smoke can derive one`);
}

/** The n-th smoke value for a column: seeds first, then a value built from the column's type and constraints. */
function value(ir: Ir, entity: Entity, c: Column, n: number): unknown {
  const seeds = (ir.seed.find((s) => s.table === entity.table)?.rows ?? []).map((r) => r[c.name]).filter((v) => v !== undefined && v !== null);
  const taken = new Set(seeds.map(String));
  const tag = `${n}${Date.now().toString(36)}`;
  if (c.input === "enum") return c.default ?? c.values![n % c.values!.length];
  if (c.input === "bool") return n % 2 === 0;
  if (c.input === "int" || c.input === "decimal") {
    const v = Math.min((c.min ?? 1) + n, c.max ?? Infinity);
    return c.input === "int" ? v : String(v);
  }
  if (c.input === "date") return `2030-01-${String(10 + n).padStart(2, "0")}`;
  if (c.input === "datetime") return `2030-01-${String(10 + n).padStart(2, "0")}T10:00:00.000Z`;
  if (c.input === "email") return `smoke-${tag}@example.com`;
  if (c.pattern) {
    for (let i = 0; i < n; i++) taken.add(matching(c.name, c.pattern, seeds.map(String), taken));
    return matching(c.name, c.pattern, seeds.map(String), taken);
  }
  const s = `Smoke ${c.label} ${tag}`;
  return (c.max ? s.slice(-c.max) : s).padEnd(c.min ?? 0, "x");
}

const same = (c: Column, a: unknown, b: unknown) =>
  c.input === "decimal" ? Number(a) === Number(b) : c.input === "datetime" ? Date.parse(String(a)) === Date.parse(String(b)) : a === b;

/**
 * Create, read, update and delete on every entity, as the seed users the blueprint's policies allow, with values
 * from its seeds and column types. Entities are visited so that a ref's target already has a row. A seed user who
 * may not create an entity must get 403.
 */
export async function crud(ir: Ir, as: (email: string) => User, step: Step, note: (line: string) => void) {
  const emails = ir.seedUsers.map((u) => u.email);
  const done = new Set<string>();
  const order: Entity[] = [];
  while (order.length < ir.entities.length) {
    const next = ir.entities.find((e) => !done.has(e.table) && e.columns.every((c) => !c.ref || c.ref === e.table || done.has(c.ref)));
    if (!next) throw new Failed(`refs form a cycle: ${ir.entities.filter((e) => !done.has(e.table)).map((e) => e.table).join(", ")}`);
    order.push(next);
    done.add(next.table);
  }
  for (const entity of order) {
    const path = `/api/e/${entity.table}`;
    const state = entity.workflow?.initial ?? null;
    const transitionOnly = new Set(entity.workflow?.transitions.flatMap((t) => t.requireFields) ?? []);
    const settable = entity.columns.filter((c) => c.name !== entity.workflow?.field && !transitionOnly.has(c.name));
    const creator = emails.find((e) => may(ir, e, entity, "create"));
    if (!creator) {
      note(`note: crud ${entity.table}: no seed user may create it`);
      const reader = emails.find((e) => may(ir, e, entity, "read"));
      if (reader) await step(`crud ${entity.table}: list as ${reader}`, async () => void expectStatus(await as(reader).call("GET", path), 200, `list ${entity.table}`));
      continue;
    }
    const refs = new Map<string, string>();
    const body = async (n: number) => {
      const b: Record<string, unknown> = {};
      for (const c of settable.filter((c) => c.required || c.input === "ref")) {
        if (c.input !== "ref") b[c.name] = value(ir, entity, c, n);
        else if (c.required) {
          if (!refs.has(c.ref!)) {
            const target = ir.entities.find((e) => e.table === c.ref)!;
            const reader = emails.find((e) => may(ir, e, target, "read"));
            check(!!reader, `no seed user may read ${c.ref}, so '${c.name}' cannot be filled`);
            const rows = expectStatus(await as(reader).call("GET", `/api/e/${c.ref}`), 200, `list ${c.ref} as ${reader}`) as unknown as Row[];
            check(rows.length > 0, `${c.ref} has no row for '${c.name}' to point at`);
            refs.set(c.ref!, rows[0]!.id);
          }
          b[c.name] = refs.get(c.ref!);
        }
      }
      return b;
    };
    let row: Row = { id: "" };
    let sent: Record<string, unknown> = {};
    await step(`crud ${entity.table}: create as ${creator}`, async () => {
      sent = await body(1);
      row = expectStatus(await as(creator).call("POST", path, sent), 201, `create ${entity.table}`) as Row;
      if (state) check(row[entity.workflow!.field] === state, `a new row should be '${state}', got '${String(row[entity.workflow!.field])}'`);
    });
    const outsider = emails.find((e) => !may(ir, e, entity, "create"));
    if (outsider)
      await step(`crud ${entity.table}: 403 create as ${outsider}`, async () => {
        expectStatus(await as(outsider).call("POST", path, sent), 403, `create ${entity.table} as ${outsider}`);
      });
    const who = (action: Action) => [creator, ...emails].find((e) => may(ir, e, entity, action, { creator, state }));
    const reader = who("read");
    if (reader)
      await step(`crud ${entity.table}: read as ${reader}`, async () => {
        const got = expectStatus(await as(reader).call("GET", `${path}/${row.id}`), 200, `read ${entity.table}`);
        for (const c of settable) if (c.name in sent && c.input !== "ref") check(same(c, got[c.name], sent[c.name]), `'${c.name}' reads back as ${JSON.stringify(got[c.name])}, sent ${JSON.stringify(sent[c.name])}`);
        const list = expectStatus(await as(reader).call("GET", path), 200, `list ${entity.table}`) as unknown as Row[];
        check(list.some((r) => r.id === row.id), "the new row is missing from the list");
      });
    const editor = who("update");
    const field = settable.find((c) => ["string", "text"].includes(c.input)) ?? settable.find((c) => !["ref", "enum"].includes(c.input));
    if (editor && reader && field)
      await step(`crud ${entity.table}: update '${field.name}' as ${editor}`, async () => {
        const v = value(ir, entity, field, 2);
        const r = expectStatus(await as(editor).call("PATCH", `${path}/${row.id}`, { [field.name]: v }), 200, `update ${entity.table}`);
        check(same(field, r[field.name], v), `update returned ${JSON.stringify(r[field.name])}, sent ${JSON.stringify(v)}`);
        const got = expectStatus(await as(reader).call("GET", `${path}/${row.id}`), 200, `read ${entity.table} after update`);
        check(same(field, got[field.name], v), `'${field.name}' reads back as ${JSON.stringify(got[field.name])} after update, sent ${JSON.stringify(v)}`);
      });
    const deleter = who("delete");
    if (deleter && reader)
      await step(`crud ${entity.table}: delete as ${deleter}`, async () => {
        const doomed = expectStatus(await as(creator).call("POST", path, await body(3)), 201, `create a row to delete`) as Row;
        expectStatus(await as(deleter).call("DELETE", `${path}/${doomed.id}`), 204, `delete ${entity.table}`);
        expectStatus(await as(reader).call("GET", `${path}/${doomed.id}`), 404, `read ${entity.table} after delete`);
      });
    if (!deleter && reader === creator)
      await step(`crud ${entity.table}: 403 delete as ${creator}`, async () => {
        expectStatus(await as(creator).call("DELETE", `${path}/${row.id}`), 403, `delete ${entity.table} as ${creator}`);
      });
    const skipped = (["read", "update", "delete"] as const).filter((a) => !who(a));
    if (skipped.length) note(`note: crud ${entity.table}: no seed user may ${skipped.join(" or ")} a new row`);
  }
}
