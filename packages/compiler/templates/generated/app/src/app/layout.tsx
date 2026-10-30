import type { ReactNode } from "react";
import { registry } from "@/lib/(generated)/registry";
import { currentUser } from "@/lib/(generated)/session";

export const metadata = { title: registry.app.title };
export const viewport = { width: "device-width", initialScale: 1 };

const css = `
*{box-sizing:border-box}
body{font-family:system-ui,sans-serif;margin:0 auto;max-width:960px;padding:16px;overflow-wrap:anywhere}
main,nav,form,.fields,.field,.details div,.details dt,.details dd{min-width:0}
h1{overflow-wrap:anywhere}
nav{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;border-bottom:1px solid #ddd;padding-bottom:8px}
nav .links{display:flex;flex-wrap:wrap;gap:8px 12px}
nav .menu{display:none}
nav .menu>summary{cursor:pointer}
nav .user{margin-left:auto}
table.rows{border-collapse:collapse;width:100%;table-layout:fixed}
table.rows th,table.rows td{text-align:left;padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top;overflow-wrap:anywhere;word-break:break-word}
pre.json{white-space:pre-wrap;word-break:break-all;margin:4px 0;font-size:12px}
.form{display:grid;gap:8px;max-width:480px;margin-top:24px}
.fields{display:grid;gap:12px}
.field{display:grid;gap:4px}
.field input:not([type=checkbox]),.field select,.field textarea{width:100%;padding:6px;font:inherit}
.req{color:#b00020;margin-left:2px;text-decoration:none}
.error{color:#b00020;font-size:14px}
[aria-invalid=true]{border:2px solid #b00020}
.details div{display:grid;grid-template-columns:minmax(120px,30%) 1fr;gap:8px;padding:4px 0;border-bottom:1px solid #f2f2f2}
.details dt{font-weight:600}.details dd{margin:0;overflow-wrap:anywhere}
nav a,nav .user{overflow-wrap:anywhere}
.transitions{display:flex;flex-wrap:wrap;gap:16px}
@media (max-width:640px){
  nav>.links{display:none}
  nav .menu{display:block}
  nav .menu .links{flex-direction:column;padding:8px 0}
  nav .user{margin-left:0;width:100%}
  table.rows,table.rows tbody,table.rows tr,table.rows td{display:block;width:100%}
  table.rows thead{display:none}
  table.rows tr{border-bottom:1px solid #ddd;padding:6px 0}
  table.rows td{border:0;padding:2px 0}
  table.rows td::before{content:attr(data-label) ": ";font-weight:600}
  .details div{grid-template-columns:1fr;gap:0}
}
`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  const links = (
    <div className="links">
      {registry.entities.map((e) => (
        <a key={e.table} href={"/e/" + e.table}>
          {e.label}
        </a>
      ))}
      <a href="/inbox">Inbox</a>
      {user?.roles.includes("admin") ? <a href="/admin/audit">Audit</a> : null}
    </div>
  );
  return (
    <html lang="en">
      <body>
        <style>{css}</style>
        <nav>
          <a href="/">{registry.app.title}</a>
          {links}
          <details className="menu">
            <summary>Menu</summary>
            {links}
          </details>
          <span className="user">
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
