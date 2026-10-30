import { notFound, redirect } from "next/navigation";
import { createAction } from "@/lib/(generated)/actions";
import { authorize, entityByTable } from "@/lib/(generated)/guard";
import { list } from "@/lib/(generated)/repository";
import { currentUser } from "@/lib/(generated)/session";
import type { Column } from "@/lib/(generated)/types";

function Input({ c }: { c: Column }) {
  if (c.input === "bool") return <input type="checkbox" name={c.name} defaultChecked={c.default === true} />;
  if (c.input === "enum")
    return (
      <select name={c.name} defaultValue={c.default === null ? undefined : String(c.default)}>
        {c.values?.map((v) => <option key={v}>{v}</option>)}
      </select>
    );
  if (c.input === "text") return <textarea name={c.name} required={c.required} />;
  const type = { int: "number", decimal: "number", date: "date", datetime: "datetime-local", email: "email" }[c.input as string] ?? "text";
  return <input name={c.name} type={type} step={c.input === "decimal" ? "any" : undefined} required={c.required} placeholder={c.input === "ref" ? c.ref + " id" : undefined} />;
}

export default async function ListPage({ params }: { params: Promise<{ entity: string }> }) {
  const { entity: table } = await params;
  const entity = entityByTable(table);
  if (!entity) notFound();
  const user = await currentUser();
  if (!user) redirect("/api/auth/signin");
  const rows = await list(user, table).catch(() => []);
  const cols = entity.columns.slice(0, 5);
  return (
    <main>
      <h1>{entity.label}</h1>
      <table>
        <thead>
          <tr>
            {cols.map((c) => <th key={c.name}>{c.label}</th>)}
            {entity.workflow ? <th>{entity.workflow.field}</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              {cols.map((c, i) => (
                <td key={c.name}>{i === 0 ? <a href={"/e/" + table + "/" + r.id}>{String(r[c.name] ?? "")}</a> : String(r[c.name] ?? "")}</td>
              ))}
              {entity.workflow ? <td>{String(r[entity.workflow.field])}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
      {authorize(user, entity, "create") ? (
        <form action={createAction.bind(null, table)} style={{ display: "grid", gap: 8, maxWidth: 480, marginTop: 24 }}>
          <h2>New {entity.label}</h2>
          {entity.columns.map((c) => (
            <label key={c.name}>
              {c.label} <Input c={c} />
            </label>
          ))}
          <button type="submit">Create</button>
        </form>
      ) : null}
    </main>
  );
}
