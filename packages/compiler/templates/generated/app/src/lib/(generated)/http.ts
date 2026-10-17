import { HttpError } from "./errors";
import { requireUser } from "./session";
import type { User } from "./types";

export async function handle(fn: (user: User) => Promise<unknown>, status = 200): Promise<Response> {
  try {
    const body = await fn(await requireUser());
    return body === undefined ? new Response(null, { status: 204 }) : Response.json(body, { status });
  } catch (e) {
    if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function body(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "body must be a JSON object");
  return parsed as Record<string, unknown>;
}
