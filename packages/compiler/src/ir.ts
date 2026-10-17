import type { CrudAction, Entity, Field, Model } from "@owninfra/blueprint-schema";

export type Column = {
  name: string;
  label: string;
  input: "string" | "text" | "email" | "int" | "decimal" | "bool" | "date" | "datetime" | "enum" | "ref";
  sql: string;
  required: boolean;
  unique: boolean;
  ref: string | null;
  values: string[] | null;
  default: string | number | boolean | null;
  min: number | null;
  max: number | null;
  pattern: string | null;
  precision: number | null;
  scale: number | null;
};

export type IrTransition = {
  id: string;
  from: string;
  to: string;
  roles: string[];
  ownerOnly: boolean;
  forbidCreator: boolean;
  requireFields: string[];
  forbiddenFor: string[];
};

export type IrEntity = {
  entity: string;
  table: string;
  label: string;
  display: string;
  owned: boolean;
  columns: Column[];
  workflow: { field: string; initial: string; states: { id: string; label: string; final: boolean }[]; transitions: IrTransition[] } | null;
};

export type Policy = { entity: string; role: string; action: CrudAction; scope: "all" | "own"; inStates: string[] | null };

export type Ir = {
  app: { name: string; title: string };
  roles: string[];
  entities: IrEntity[];
  policies: Policy[];
  seed: { table: string; rows: Record<string, unknown>[] }[];
  seedUsers: { email: string; roles: string[] }[];
  audit: { enabled: boolean };
};

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (xs: Iterable<string>) => [...xs].sort(byCodeUnit);
const sortBy = <T>(xs: T[], key: (x: T) => string) => xs.sort((a, b) => byCodeUnit(key(a), key(b)));

function column(f: Field, tables: ReadonlyMap<string, string>): Column {
  const base = { name: f.name, label: f.label, required: f.required, unique: false, ref: null, values: null, default: null, min: null, max: null, pattern: null, precision: null, scale: null };
  if (f.kind === "enum") return { ...base, input: "enum", sql: "text", values: [...f.values], default: f.default ?? null };
  if (f.kind === "ref") return { ...base, input: "ref", sql: "uuid", ref: tables.get(f.target)! };
  const c = f.constraints;
  const sql = {
    string: c.max !== undefined ? `varchar(${c.max})` : "text",
    text: "text",
    email: "text",
    int: "integer",
    decimal: c.precision !== undefined ? `numeric(${c.precision}, ${c.scale ?? 0})` : "numeric",
    bool: "boolean",
    date: "date",
    datetime: "timestamptz",
  }[f.type];
  return {
    ...base,
    input: f.type,
    sql,
    unique: f.unique,
    default: c.default ?? null,
    min: c.min ?? null,
    max: c.max ?? null,
    pattern: c.pattern ?? null,
    precision: c.precision ?? null,
    scale: c.scale ?? null,
  };
}

function lowerEntity(e: Entity, roles: string[], tables: ReadonlyMap<string, string>): IrEntity {
  const wf = e.workflow;
  return {
    entity: e.name,
    table: e.table,
    label: e.label,
    display: e.display,
    owned: e.ownership.kind === "created_by",
    columns: [...e.fields.values()].map((f) => column(f, tables)),
    workflow: wf
      ? {
          field: wf.field,
          initial: wf.initial,
          states: [...wf.states].map(([id, s]) => ({ id, label: s.label, final: s.final })),
          transitions: sortBy(
            [...wf.transitions.values()].map((t) => ({
              id: t.id,
              from: t.from,
              to: t.to,
              roles: sorted(t.roles),
              ownerOnly: t.ownerOnly,
              forbidCreator: wf.separationOfDuties && !t.ownerOnly,
              requireFields: [...t.requireFields],
              forbiddenFor: roles.filter((r) => !(t.roles as readonly string[]).includes(r)),
            })),
            (t) => t.id,
          ),
        }
      : null,
  };
}

export function lower(model: Model): Ir {
  const roles = sorted(model.roles.keys());
  const tables = new Map([...model.entities.values()].map((e) => [e.name as string, e.table as string]));
  const policies: Policy[] = [];
  for (const [entity, byRole] of model.permissions)
    for (const [role, grants] of byRole)
      for (const [action, g] of Object.entries(grants) as [CrudAction, (typeof grants)[CrudAction]][])
        if (g.kind !== "deny") policies.push({ entity, role, action, scope: g.kind, inStates: g.inStates ? [...g.inStates] : null });
  return {
    app: { name: model.app.name, title: model.app.title },
    roles,
    entities: sortBy([...model.entities.values()].map((e) => lowerEntity(e, roles, tables)), (e) => e.entity),
    policies: policies.sort((a, b) => byCodeUnit(`${a.entity}\0${a.role}\0${a.action}`, `${b.entity}\0${b.role}\0${b.action}`)),
    seed: sortBy(
      [...model.seed.rows].map(([entity, rows]) => ({ table: tables.get(entity)!, rows: rows.map((r) => Object.fromEntries(sorted(Object.keys(r)).map((k) => [k, r[k]]))) })),
      (s) => s.table,
    ),
    seedUsers: sortBy(
      model.seed.users.map((u) => ({ email: u.email, roles: sorted(u.roles) })),
      (u) => u.email,
    ),
    audit: { enabled: model.audit.enabled },
  };
}
