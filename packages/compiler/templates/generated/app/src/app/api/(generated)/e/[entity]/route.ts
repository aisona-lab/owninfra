import { body, handle } from "@/lib/(generated)/http";
import { create, list } from "@/lib/(generated)/repository";

type Ctx = { params: Promise<{ entity: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { entity } = await ctx.params;
  return handle((user) => list(user, entity));
}

export async function POST(req: Request, ctx: Ctx) {
  const { entity } = await ctx.params;
  return handle(async (user) => create(user, entity, await body(req)), 201);
}
