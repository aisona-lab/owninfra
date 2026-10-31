import { notFound, redirect } from "next/navigation";
import { changes, formatInstant, formatValue } from "@/lib/(generated)/format";
import { registry } from "@/lib/(generated)/registry";
import { auditLog, refLabels, rowLabels } from "@/lib/(generated)/repository";
import { currentUser } from "@/lib/(generated)/session";
import type { EntityDef } from "@/lib/(generated)/types";
import { unlessUnavailable } from "@/lib/(generated)/errors";

type Labels = { rows: Record<string, string>; refs: Record<string, Record<string, string>> };

function shown(entity: EntityDef | undefined, labels: Labels | undefined, key: string, v: unknown): unknown {
  if (v === null || v === undefined || v === "") return "—";
  if (key === "created_at" || key === "updated_at") return formatInstant(v);
  const c = entity?.columns.find((x) => x.name === key);
  return c ? formatValue(c, v, labels?.refs[key]) : v;
}

export default async function AuditPage() {
  const user = await currentUser();
  if (!user) redirect("/api/auth/signin");
  const rows = await auditLog(user).catch(unlessUnavailable(null));
  if (!rows) notFound();
  const labels: Record<string, Labels> = Object.fromEntries(
    await Promise.all(registry.entities.map(async (e) => [e.entity, { rows: await rowLabels(user, e), refs: await refLabels(user, e) }] as const)),
  );
  return (
    <main>
      <h1>Audit log</h1>
      <table className="rows">
        <thead>
          <tr>
            <th>When</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Record</th>
            <th>Changes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const entity = registry.entities.find((e) => e.entity === r.entity);
            const l = labels[String(r.entity)];
            const diff = Object.fromEntries(Object.entries(changes(r.before, r.after))
                .filter(([k]) => k !== "id")
                .map(([k, [b, a]]) => [k, [shown(entity, l, k, b), shown(entity, l, k, a)]]));
            return (
              <tr key={String(r.id)}>
                <td data-label="When">{formatInstant(r.at)}</td>
                <td data-label="Actor">{String(r.actor)}</td>
                <td data-label="Action">{String(r.action)}</td>
                <td data-label="Record">
                  {entity?.label ?? String(r.entity)}: {l?.rows[String(r.entity_id)] ?? String(((r.after ?? r.before) as Record<string, unknown> | null)?.[entity?.display ?? "id"] ?? r.entity_id)}
                </td>
                <td data-label="Changes">
                  <details>
                    <summary>{Object.keys(diff).join(", ") || "no changes"}</summary>
                    <pre className="json">{JSON.stringify(diff)}</pre>
                  </details>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}
