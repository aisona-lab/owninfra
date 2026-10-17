import postgres from "postgres";

const url = process.env.DATABASE_URL ?? "postgres://owninfra:owninfra@localhost:5432/owninfra";
const cache = globalThis as unknown as { owninfraSql?: postgres.Sql };

export const sql = (cache.owninfraSql ??= postgres(url, { max: 5 }));
