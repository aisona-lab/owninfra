import type { ReactNode } from "react";
import { registry } from "@/lib/(generated)/registry";
import { currentUser } from "@/lib/(generated)/session";

export const metadata = { title: registry.app.title };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  return (
    <html>
      <body style={{ fontFamily: "system-ui, sans-serif", margin: "0 auto", maxWidth: 960, padding: 16 }}>
        <nav style={{ display: "flex", gap: 12, borderBottom: "1px solid #ddd", paddingBottom: 8 }}>
          <a href="/">{registry.app.title}</a>
          {registry.entities.map((e) => (
            <a key={e.table} href={"/e/" + e.table}>
              {e.label}
            </a>
          ))}
          <a href="/inbox">Inbox</a>
          {user?.roles.includes("admin") ? <a href="/admin/audit">Audit</a> : null}
          <span style={{ marginLeft: "auto" }}>
            {user ? (
              <>
                {user.email} ({user.roles.join(", ")}) <a href="/api/auth/signout">Sign out</a>
              </>
            ) : (
              <a href="/api/auth/signin">Sign in</a>
            )}
          </span>
        </nav>
        {children}
      </body>
    </html>
  );
}
