import { registry } from "./registry";
import type { CrudAction, EntityDef, Row, Transition, User } from "./types";

export function entityByTable(table: string): EntityDef | undefined {
  return registry.entities.find((e) => e.table === table);
}

const policiesFor = (user: User, entity: EntityDef, action: CrudAction) =>
  registry.policies.filter((p) => p.entity === entity.entity && p.action === action && user.roles.includes(p.role));

export function readScope(user: User, entity: EntityDef): "all" | "own" | null {
  const ps = policiesFor(user, entity, "read");
  if (ps.some((p) => p.scope === "all")) return "all";
  return ps.length ? "own" : null;
}

export function authorize(user: User, entity: EntityDef, action: CrudAction, row?: Row): boolean {
  const status = entity.workflow && row ? String(row[entity.workflow.field]) : null;
  return policiesFor(user, entity, action).some(
    (p) => (p.scope === "all" || row?.created_by === user.email) && (!p.inStates || (status !== null && p.inStates.includes(status))),
  );
}

export type Decision = { ok: true; transition: Transition } | { ok: false; status: 403 | 404 | 409 | 422; reason: string };

export function decideTransition(user: User, entity: EntityDef, row: Row, transitionId: string, values: Record<string, unknown> = row): Decision {
  const t = entity.workflow?.transitions.find((x) => x.id === transitionId);
  if (!t || !entity.workflow) return { ok: false, status: 404, reason: `unknown transition '${transitionId}'` };
  if (!authorize(user, entity, "read", row)) return { ok: false, status: 404, reason: "not found" };
  const status = String(row[entity.workflow.field]);
  if (status !== t.from) return { ok: false, status: 409, reason: `'${transitionId}' needs state '${t.from}', row is '${status}'` };
  if (!t.roles.some((r) => user.roles.includes(r))) return { ok: false, status: 403, reason: `'${transitionId}' requires role ${t.roles.join(" or ")}` };
  if (t.ownerOnly && row.created_by !== user.email) return { ok: false, status: 403, reason: `only the owner can '${transitionId}'` };
  if (t.forbidCreator && row.created_by === user.email)
    return { ok: false, status: 403, reason: `separation of duties: the creator cannot '${transitionId}'` };
  const missing = t.requireFields.filter((f) => values[f] === null || values[f] === undefined || values[f] === "");
  if (missing.length) return { ok: false, status: 422, reason: `'${transitionId}' requires ${missing.join(", ")}` };
  return { ok: true, transition: t };
}

export function availableTransitions(user: User, entity: EntityDef, row: Row): Transition[] {
  return (entity.workflow?.transitions ?? []).filter((t) => {
    const d = decideTransition(user, entity, row, t.id, Object.fromEntries(t.requireFields.map((f) => [f, "x"])));
    return d.ok;
  });
}
