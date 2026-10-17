import { body, handle } from "@/lib/(generated)/http";
import { transition } from "@/lib/(generated)/repository";

type Ctx = { params: Promise<{ entity: string; id: string; transition: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const p = await ctx.params;
  return handle(async (user) => transition(user, p.entity, p.id, p.transition, await body(req)));
}
