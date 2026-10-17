import type { Blueprint as RawBlueprint, Field as RawField } from "./schema.js";
import { crudActions } from "./schema.js";
import { parseValue, uniqueKey, type Canonical, type FieldType } from "./codecs.js";
import { isSystemColumn, maxIdentifier, sqlIdentifierProblem, tableName } from "./naming.js";

export interface Issue {
  path: string;
  message: string;
}

function check(bp: RawBlueprint): { errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const roles = new Set(bp.roles.map((r) => r.id));
  const entities = new Map(bp.entities.map((e) => [e.name, e]));

  dupes(bp.roles.map((r) => r.id), "roles", errors);
  dupes(bp.entities.map((e) => e.name), "entities", errors);
  if (bp.roles.filter((r) => r.default).length > 1) errors.push({ path: "roles", message: "only one role may be default" });

  bp.entities.forEach((entity, ei) => {
    const base = `entities[${ei}]`;
    const fields = new Set(entity.fields.map((f) => f.name));
    dupes(entity.fields.map((f) => f.name), `${base}.fields`, errors);

    entity.fields.forEach((f, fi) => {
      const p = `${base}.fields[${fi}]`;
      if (f.type === "ref" && !entities.has(f.to)) errors.push({ path: `${p}.to`, message: `unknown entity '${f.to}'` });
      if (f.default !== undefined && f.type !== "files" && f.type !== "ref") {
        const d = parseValue(f, f.default);
        if (!d.ok) errors.push({ path: `${p}.default`, message: `'${f.default}' ${d.error}` });
      }
      if (f.type === "files") warnings.push({ path: p, message: "'files' fields are v1 and ignored by the MVP" });
      if (f.visible_when) warnings.push({ path: `${p}.visible_when`, message: "conditional visibility is v1 and ignored by the MVP" });
    });

    const known = new Set([...fields, "created_at", "updated_at", "created_by", ...(entity.workflow ? [entity.workflow.field] : [])]);
    if (entity.display && !fields.has(entity.display)) errors.push({ path: `${base}.display`, message: `unknown field '${entity.display}'` });
    const list = entity.list;
    if (list) {
      for (const key of ["columns", "filters", "search"] as const)
        list[key]?.forEach((name, i) => {
          if (!known.has(name)) errors.push({ path: `${base}.list.${key}[${i}]`, message: `unknown field '${name}'` });
        });
      if (list.default_sort && !known.has(list.default_sort.field))
        errors.push({ path: `${base}.list.default_sort.field`, message: `unknown field '${list.default_sort.field}'` });
    }

    const wf = entity.workflow;
    if (!wf) return;
    const wp = `${base}.workflow`;
    if (fields.has(wf.field)) errors.push({ path: `${wp}.field`, message: `'${wf.field}' clashes with a declared field` });
    const states = new Set(wf.states.map((s) => s.id));
    dupes(wf.states.map((s) => s.id), `${wp}.states`, errors);
    dupes(wf.transitions.map((t) => t.id), `${wp}.transitions`, errors);
    if (!states.has(wf.initial)) errors.push({ path: `${wp}.initial`, message: `unknown state '${wf.initial}'` });
    const finals = new Set(wf.states.filter((s) => s.final).map((s) => s.id));

    wf.transitions.forEach((t, ti) => {
      const tp = `${wp}.transitions[${ti}]`;
      for (const end of ["from", "to"] as const)
        if (!states.has(t[end])) errors.push({ path: `${tp}.${end}`, message: `unknown state '${t[end]}'` });
      if (finals.has(t.from)) errors.push({ path: `${tp}.from`, message: `'${t.from}' is final and cannot have outgoing transitions` });
      t.roles.forEach((r, ri) => {
        if (!roles.has(r)) errors.push({ path: `${tp}.roles[${ri}]`, message: `unknown role '${r}'` });
      });
      t.require_fields?.forEach((name, i) => {
        if (!fields.has(name)) errors.push({ path: `${tp}.require_fields[${i}]`, message: `unknown field '${name}'` });
      });
      if (t.only_owner && !entity.ownership) errors.push({ path: `${tp}.only_owner`, message: "requires entity ownership" });
      if (t.when) warnings.push({ path: `${tp}.when`, message: "field guards are v1 and ignored by the MVP" });
    });

    const reachable = new Set([wf.initial]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const t of wf.transitions)
        if (reachable.has(t.from) && !reachable.has(t.to)) {
          reachable.add(t.to);
          grew = true;
        }
    }
    for (const s of states)
      if (!reachable.has(s)) errors.push({ path: `${wp}.states`, message: `state '${s}' is unreachable from '${wf.initial}'` });
    for (const s of wf.states)
      if (!s.final && !wf.transitions.some((t) => t.from === s.id))
        errors.push({ path: `${wp}.states`, message: `state '${s.id}' has no outgoing transitions and is not final` });
    if (wf.notify) warnings.push({ path: `${wp}.notify`, message: "notifications are v1 and ignored by the MVP" });
  });

  for (const [entityName, byRole] of Object.entries(bp.permissions)) {
    const entity = entities.get(entityName);
    const pp = `permissions.${entityName}`;
    if (!entity) {
      errors.push({ path: pp, message: `unknown entity '${entityName}'` });
      continue;
    }
    const states = new Set(entity.workflow?.states.map((s) => s.id) ?? []);
    for (const [role, rule] of Object.entries(byRole)) {
      if (!roles.has(role)) errors.push({ path: `${pp}.${role}`, message: `unknown role '${role}'` });
      if (Array.isArray(rule)) continue;
      for (const [action, r] of Object.entries(rule)) {
        const usesOwn = r === "own" || (typeof r === "object" && r.own);
        if (usesOwn && !entity.ownership)
          errors.push({ path: `${pp}.${role}.${action}`, message: "'own' requires entity ownership" });
        if (typeof r === "object")
          r.in_states?.forEach((s) => {
            if (!states.has(s)) errors.push({ path: `${pp}.${role}.${action}.in_states`, message: `unknown state '${s}'` });
          });
      }
    }
  }

  bp.pages?.forEach((p, i) => {
    if (!entities.has(p.entity)) errors.push({ path: `pages[${i}].entity`, message: `unknown entity '${p.entity}'` });
  });
  if (bp.auth.federation) warnings.push({ path: "auth.federation", message: "SSO federation is v1 and ignored by the MVP" });
  for (const name of Object.keys(bp.environments))
    if (name !== "dev" && name !== "prod") warnings.push({ path: `environments.${name}`, message: "only dev and prod are supported by the MVP" });

  return { errors, warnings };
}

function dupes(values: string[], path: string, errors: Issue[]) {
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) errors.push({ path, message: `duplicate '${v}'` });
    seen.add(v);
  }
}

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };
export type RoleId = Brand<string, "RoleId">;
export type EntityName = Brand<string, "EntityName">;
export type FieldName = Brand<string, "FieldName">;
export type StateId = Brand<string, "StateId">;
export type TransitionId = Brand<string, "TransitionId">;
export type NonEmpty<T> = readonly [T, ...T[]];
export type CrudAction = (typeof crudActions)[number];

export type ScalarType = "string" | "text" | "int" | "decimal" | "bool" | "date" | "datetime" | "email";
export type ScalarConstraints = {
  min?: number;
  max?: number;
  pattern?: string;
  precision?: number;
  scale?: number;
  default?: string | number | boolean;
};

export type Field =
  | { kind: "scalar"; name: FieldName; label: string; type: ScalarType; required: boolean; unique: boolean; constraints: ScalarConstraints }
  | { kind: "enum"; name: FieldName; label: string; values: NonEmpty<string>; default?: string; required: boolean }
  | { kind: "ref"; name: FieldName; label: string; target: EntityName; required: boolean };

export type Ownership = { kind: "none" } | { kind: "created_by" };

export type Transition = {
  id: TransitionId;
  from: StateId;
  to: StateId;
  roles: NonEmpty<RoleId>;
  ownerOnly: boolean;
  requireFields: readonly FieldName[];
};

export type Workflow = {
  field: FieldName;
  initial: StateId;
  states: ReadonlyMap<StateId, { label: string; final: boolean }>;
  transitions: ReadonlyMap<TransitionId, Transition>;
  separationOfDuties: boolean;
};

export type TableName = Brand<string, "TableName">;

export type Entity = {
  name: EntityName;
  table: TableName;
  label: string;
  fields: ReadonlyMap<FieldName, Field>;
  display: FieldName;
  ownership: Ownership;
  workflow?: Workflow;
};

export type Grant =
  | { kind: "deny" }
  | { kind: "all"; inStates?: NonEmpty<StateId> }
  | { kind: "own"; inStates?: NonEmpty<StateId> };

export type Permissions = ReadonlyMap<EntityName, ReadonlyMap<RoleId, Record<CrudAction, Grant>>>;

export type SeedUser = { email: string; roles: NonEmpty<RoleId> };

export type Env = { account: string; region: string; seedUsers: boolean };

export type Model = {
  app: { name: string; title: string; locale: string };
  roles: ReadonlyMap<RoleId, { description: string; isDefault: boolean }>;
  entities: ReadonlyMap<EntityName, Entity>;
  permissions: Permissions;
  audit: { enabled: boolean };
  seed: { rows: ReadonlyMap<EntityName, readonly Readonly<Record<string, unknown>>[]>; users: readonly SeedUser[] };
  environments: { dev: Env; prod?: Env };
};

export type ParseResult =
  | { ok: true; model: Model; warnings: Issue[] }
  | { ok: false; errors: Issue[]; warnings: Issue[] };

export function parse(raw: RawBlueprint): ParseResult {
  const { errors, warnings } = check(raw);
  const seedRows = checkSeed(raw, errors);
  checkNames(raw, errors);
  if (errors.length) return { ok: false, errors, warnings };
  return { ok: true, model: build(raw, seedRows), warnings };
}

const systemTables = new Set(["audit_events", "owninfra_meta"]);

function checkNames(bp: RawBlueprint, errors: Issue[]) {
  const owners = new Map<string, string>();
  bp.entities.forEach((e, ei) => {
    const path = `entities[${ei}].name`;
    const table = tableName(e.name, e.table);
    const tpath = e.table ? `entities[${ei}].table` : path;
    const tableProblem = sqlIdentifierProblem(table);
    if (tableProblem)
      errors.push({ path: tpath, message: `table name ${tableProblem}${e.table && tableProblem.includes("longer than") ? "; shorten the table name" : ""}` });
    if (systemTables.has(table)) errors.push({ path: tpath, message: `entity '${e.name}' maps to table '${table}', which is reserved for owninfra` });
    const clash = owners.get(table);
    if (clash && clash !== e.name) errors.push({ path, message: `entities '${clash}' and '${e.name}' both map to table '${table}'` });
    owners.set(table, e.name);
    const columns = [...e.fields.filter((f) => f.type !== "files").map((f) => f.name), ...(e.workflow ? [e.workflow.field] : [])];
    const tooLong: string[] = [];
    columns.forEach((c) => {
      const fi = e.fields.findIndex((f) => f.name === c);
      const cpath = fi < 0 ? `entities[${ei}].workflow.field` : `entities[${ei}].fields[${fi}].name`;
      if (isSystemColumn(c)) errors.push({ path: cpath, message: `'${c}' is a system column` });
      const problem = sqlIdentifierProblem(c);
      if (problem) errors.push({ path: cpath, message: `column name ${problem}` });
      else if (!tableProblem && Buffer.byteLength(`${table}_${c}_fkey`) > maxIdentifier) {
        if (Buffer.byteLength(c) > Buffer.byteLength(table))
          errors.push({ path: cpath, message: `column name '${c}' makes the constraint name '${table}_${c}_fkey' longer than ${maxIdentifier} bytes; shorten the field name` });
        else tooLong.push(c);
      }
    });
    if (tooLong.length)
      errors.push({
        path: tpath,
        message: `table name '${table}' is too long for Postgres constraint names on ${tooLong.map((c) => `'${c}'`).join(", ")} (limit ${maxIdentifier} bytes for '<table>_<column>_fkey'); ${e.table ? "shorten the table name" : "shorten the entity name"}`,
      });
  });
}

function checkSeed(bp: RawBlueprint, errors: Issue[]): Map<string, Record<string, Canonical>[]> {
  const canonical = new Map<string, Record<string, Canonical>[]>();
  const roles = new Set(bp.roles.map((r) => r.id));
  for (const [key, rows] of Object.entries(bp.seed ?? {})) {
    if (key === "users") {
      rows.forEach((u, i) => {
        if (typeof u.email !== "string") errors.push({ path: `seed.users[${i}].email`, message: "must be a string" });
        const rs = u.roles;
        if (!Array.isArray(rs) || rs.length === 0) errors.push({ path: `seed.users[${i}].roles`, message: "must be a non-empty list of roles" });
        else rs.forEach((r, ri) => {
          if (!roles.has(String(r))) errors.push({ path: `seed.users[${i}].roles[${ri}]`, message: `unknown role '${String(r)}'` });
        });
      });
      continue;
    }
    const entity = bp.entities.find((e) => e.name === key);
    if (!entity) {
      errors.push({ path: `seed.${key}`, message: `unknown entity '${key}'` });
      continue;
    }
    const fields = new Map(entity.fields.map((f) => [f.name, f]));
    const parsed = rows.map((row, i) => {
      const out: Record<string, Canonical> = {};
      for (const f of entity.fields)
        if (f.required && f.default === undefined && f.type !== "files" && row[f.name] === undefined)
          errors.push({ path: `seed.${key}[${i}]`, message: `missing required field '${f.name}'` });
      for (const [k, raw] of Object.entries(row)) {
        const f = fields.get(k);
        if (!f) {
          errors.push({ path: `seed.${key}[${i}].${k}`, message: `unknown field '${k}'` });
          continue;
        }
        if (f.type === "ref") {
          errors.push({
            path: `seed.${key}[${i}].${k}`,
            message: `seed rows cannot set ref field '${k}' (to ${f.to}): seeded rows get generated ids, so references between seeds are not supported yet`,
          });
          continue;
        }
        const r = parseValue(f, raw);
        if (!r.ok) errors.push({ path: `seed.${key}[${i}].${k}`, message: r.error });
        else if (r.value !== undefined) out[k] = r.value;
      }
      return out;
    });
    for (const f of entity.fields.filter((x) => x.unique)) {
      const def = f.default === undefined ? null : parseValue(f, f.default);
      const seen = new Map<string, number>();
      parsed.forEach((row, i) => {
        const fromDefault = !(f.name in row);
        const value = fromDefault ? (def?.ok ? def.value : null) : f.name in row ? row[f.name] : null;
        if (value === null || value === undefined) return;
        const k = uniqueKey(value);
        const first = seen.get(k);
        const shown = typeof value === "string" ? `'${value}'` : String(value);
        if (first !== undefined)
          errors.push({
            path: `seed.${key}[${i}].${f.name}`,
            message: `duplicate value ${shown}${fromDefault ? " (from the field default)" : ""} in unique field '${f.name}' (same as seed.${key}[${first}])`,
          });
        else seen.set(k, i);
      });
    }
    canonical.set(key, parsed);
  }
  return canonical;
}

const nonEmpty = <T>(xs: readonly T[]): NonEmpty<T> => xs as unknown as NonEmpty<T>;

function build(bp: RawBlueprint, seedRows: ReadonlyMap<string, Record<string, Canonical>[]>): Model {
  const entities = new Map<EntityName, Entity>();
  for (const e of bp.entities) {
    const fields = new Map<FieldName, Field>();
    for (const f of e.fields) {
      const name = f.name as FieldName;
      const label = f.label ?? f.name;
      const required = f.required ?? false;
      if (f.type === "files") continue;
      if (f.type === "enum")
        fields.set(name, { kind: "enum", name, label, values: nonEmpty(f.values), default: f.default === undefined ? undefined : String(f.default), required });
      else if (f.type === "ref") fields.set(name, { kind: "ref", name, label, target: f.to as EntityName, required });
      else
        fields.set(name, {
          kind: "scalar",
          name,
          label,
          type: f.type,
          required,
          unique: f.unique ?? false,
          constraints: { min: f.min, max: f.max, pattern: f.pattern, precision: f.precision, scale: f.scale, default: f.default },
        });
    }
    const wf = e.workflow;
    const workflow: Workflow | undefined = wf && {
      field: wf.field as FieldName,
      initial: wf.initial as StateId,
      states: new Map(wf.states.map((s) => [s.id as StateId, { label: s.label ?? s.id, final: s.final ?? false }])),
      transitions: new Map(
        wf.transitions
          .filter((t) => !t.when)
          .map((t) => [
            t.id as TransitionId,
            {
              id: t.id as TransitionId,
              from: t.from as StateId,
              to: t.to as StateId,
              roles: nonEmpty(t.roles as RoleId[]),
              ownerOnly: t.only_owner ?? false,
              requireFields: (t.require_fields ?? []) as FieldName[],
            },
          ]),
      ),
      separationOfDuties: wf.separation_of_duties ?? false,
    };
    entities.set(e.name as EntityName, {
      name: e.name as EntityName,
      table: tableName(e.name, e.table) as TableName,
      label: e.label ?? e.name,
      fields,
      display: (e.display ?? e.fields[0].name) as FieldName,
      ownership: e.ownership ? { kind: "created_by" } : { kind: "none" },
      workflow,
    });
  }

  const permissions = new Map<EntityName, Map<RoleId, Record<CrudAction, Grant>>>();
  for (const [entityName, byRole] of Object.entries(bp.permissions)) {
    const roles = new Map<RoleId, Record<CrudAction, Grant>>();
    for (const [role, rule] of Object.entries(byRole)) {
      const grants = Object.fromEntries(crudActions.map((a) => [a, { kind: "deny" }])) as Record<CrudAction, Grant>;
      if (Array.isArray(rule)) for (const a of rule) grants[a] = { kind: "all" };
      else
        for (const a of crudActions) {
          const r = rule[a];
          if (r === undefined || r === false) continue;
          if (r === true || r === "all") grants[a] = { kind: "all" };
          else if (r === "own") grants[a] = { kind: "own" };
          else {
            const inStates = r.in_states?.length ? nonEmpty(r.in_states as StateId[]) : undefined;
            grants[a] = r.own ? { kind: "own", inStates } : { kind: "all", inStates };
          }
        }
      roles.set(role as RoleId, grants);
    }
    permissions.set(entityName as EntityName, roles);
  }

  const env = (name: string): Env | undefined => {
    const e = bp.environments[name];
    return e && { account: e.account, region: e.region, seedUsers: e.seed_users ?? false };
  };
  const users = bp.seed?.users ?? [];
  return {
    app: { name: bp.app.name, title: bp.app.title, locale: bp.app.locale ?? "en" },
    roles: new Map(bp.roles.map((r) => [r.id as RoleId, { description: r.description ?? "", isDefault: r.default ?? false }])),
    entities,
    permissions,
    audit: { enabled: bp.audit?.enabled ?? false },
    seed: {
      rows: new Map([...seedRows].map(([k, v]) => [k as EntityName, v])),
      users: users.map((u) => ({ email: String(u.email), roles: nonEmpty((u.roles as string[]).map((r) => r as RoleId)) })),
    },
    environments: { dev: env("dev") as Env, prod: env("prod") },
  };
}

type SameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const fieldTypesMatchCodecs: SameKeys<RawField["type"], FieldType> = true;
