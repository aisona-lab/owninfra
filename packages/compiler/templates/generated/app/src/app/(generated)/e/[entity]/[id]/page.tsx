import { notFound, redirect } from "next/navigation";
import { transitionAction } from "@/lib/(generated)/actions";
import { availableTransitions, entityByTable } from "@/lib/(generated)/guard";
import { get } from "@/lib/(generated)/repository";
import { currentUser } from "@/lib/(generated)/session";

export default async function DetailPage({ params }: { params: Promise<{ entity: string; id: string }> }) {
  const { entity: table, id } = await params;
  const entity = entityByTable(table);
  if (!entity) notFound();
  const user = await currentUser();
  if (!user) redirect("/api/auth/signin");
  const row = await get(user, table, id).catch(() => null);
  if (!row) notFound();
  return (
    <main>
      <h1>
        {entity.label}: {String(row[entity.display] ?? row.id)}
      </h1>
      <dl>
        {Object.entries(row).map(([k, v]) => (
          <div key={k}>
            <dt style={{ fontWeight: 600 }}>{k}</dt>
            <dd>{String(v ?? "")}</dd>
          </div>
        ))}
      </dl>
      {availableTransitions(user, entity, row).map((t) => (
        <form key={t.id} action={transitionAction.bind(null, table, id, t.id)}>
          {t.requireFields.map((f) => <input key={f} name={f} placeholder={f} required />)}
          <button type="submit">{t.id}</button>
        </form>
      ))}
    </main>
  );
}
