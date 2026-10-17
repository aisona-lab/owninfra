import { body, handle } from "@/lib/(generated)/http";
import { get, remove, update } from "@/lib/(generated)/repository";

type Ctx = { params: Promise<{ entity: string; id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { entity, id } = await ctx.params;
  return handle((user) => get(user, entity, id));
}

export async function PATCH(req: Request, ctx: Ctx) {
  const { entity, id } = await ctx.params;
  return handle(async (user) => update(user, entity, id, await body(req)));
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { entity, id } = await ctx.params;
  return handle((user) => remove(user, entity, id));
}
