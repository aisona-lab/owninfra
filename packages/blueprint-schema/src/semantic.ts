import type { Blueprint } from "./schema.js";

export interface Issue {
  path: string;
  message: string;
}

export function checkSemantics(bp: Blueprint): { errors: Issue[]; warnings: Issue[] } {
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
      if (f.type === "enum" && f.default !== undefined && !f.values.includes(String(f.default)))
        errors.push({ path: `${p}.default`, message: `'${f.default}' is not one of the enum values` });
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
