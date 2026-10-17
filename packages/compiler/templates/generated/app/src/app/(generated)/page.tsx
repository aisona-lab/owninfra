import { registry } from "@/lib/(generated)/registry";

export default function Home() {
  return (
    <main>
      <h1>{registry.app.title}</h1>
      <ul>
        {registry.entities.map((e) => (
          <li key={e.table}>
            <a href={"/e/" + e.table}>{e.label}</a>
          </li>
        ))}
      </ul>
    </main>
  );
}
