/** One signed-in user of the app under test: a cookie jar over fetch, through the local auth stub's credentials provider. */
export type Session = { email: string; roles: string[] };
export type Response = { status: number; body: unknown };
export type User = { session: Session; call(method: string, path: string, body?: unknown): Promise<Response> };

export class Failed extends Error {}

export function check(ok: boolean, detail: string): asserts ok {
  if (!ok) throw new Failed(detail);
}

export function expectStatus(r: Response, status: number, what: string) {
  check(r.status === status, `${what}: expected ${status}, got ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body as Record<string, unknown>;
}

export async function signIn(base: string, email: string): Promise<User> {
  const jar = new Map<string, string>();
  const send = async (method: string, path: string, init: { body?: string; type?: string } = {}) => {
    const headers: Record<string, string> = { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") };
    if (init.type) headers["content-type"] = init.type;
    const res = await fetch(base + path, { method, headers, body: init.body, redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(";")[0]!;
      jar.set(pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1));
    }
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // not JSON: keep the text
    }
    return { status: res.status, body };
  };
  const { csrfToken } = (await send("GET", "/api/auth/csrf")).body as { csrfToken: string };
  await send("POST", "/api/auth/callback/credentials", { type: "application/x-www-form-urlencoded", body: new URLSearchParams({ csrfToken, email, callbackUrl: base }).toString() });
  const s = (await send("GET", "/api/auth/session")).body as { user?: { email?: string }; roles?: string[] } | null;
  check(s?.user?.email === email, `sign-in as ${email} gave no session: ${JSON.stringify(s)}`);
  return {
    session: { email, roles: s.roles ?? [] },
    call: (method, path, body) => send(method, path, body === undefined ? {} : { type: "application/json", body: JSON.stringify(body) }),
  };
}
