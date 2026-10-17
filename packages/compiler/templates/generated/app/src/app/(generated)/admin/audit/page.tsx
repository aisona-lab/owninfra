import { notFound, redirect } from "next/navigation";
import { changes, formatInstant } from "@/lib/(generated)/format";
import { auditLog } from "@/lib/(generated)/repository";
import { currentUser } from "@/lib/(generated)/session";

export default async function AuditPage() {
  const user = await currentUser();
  if (!user) redirect("/api/auth/signin");
  const rows = await auditLog(user).catch(() => null);
  if (!rows) notFound();
  return (
    <main>
      <h1>Audit log</h1>
      <table className="rows">
        <thead>
          <tr>
            <th>When</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Entity</th>
            <th>Changes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const diff = changes(r.before, r.after);
            return (
              <tr key={String(r.id)}>
                <td data-label="When">{formatInstant(r.at)}</td>
                <td data-label="Actor">{String(r.actor)}</td>
                <td data-label="Action">{String(r.action)}</td>
                <td data-label="Entity">{String(r.entity)}</td>
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
