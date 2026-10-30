import { apiVersion, list, registry, type Row, type User } from "@/lib/owninfra";

export async function countMine(user: User): Promise<number> {
  const rows: Row[] = await list(user, registry.entities[0].table);
  return apiVersion === 1 ? rows.length : 0;
}
