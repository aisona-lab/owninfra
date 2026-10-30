import postgres from "postgres";
import { dataApi } from "./data-api";

export type Param = string | number | boolean | null;
export type DbRow = Record<string, unknown>;

/**
 * The repository talks to Postgres only through this. Locally it is postgres.js over TCP; in Lambda
 * (DATABASE_CLUSTER_ARN set) it is the RDS Data API. Both return the same JS values for the same SQL.
 */
export type Db = {
  driver: "postgres" | "data-api";
  query(text: string, params?: readonly Param[]): Promise<DbRow[]>;
  begin<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
};

/** A page of results was too big for the driver to return (the Data API caps a result at 1 MiB). Retry with fewer rows. */
export class ResponseTooLarge extends Error {}

const noNesting = () => {
  throw new Error("nested transactions are not supported");
};

export function tcp(sql: postgres.Sql | postgres.TransactionSql): Db {
  return {
    driver: "postgres",
    query: async (text, params = []) => [...(await sql.unsafe(text, params as Param[]))],
    begin: "begin" in sql ? (fn) => sql.begin((tx) => fn(tcp(tx))) as ReturnType<typeof fn> : noNesting,
  };
}

export function fromEnv(env: NodeJS.ProcessEnv): Db {
  if (env.DATABASE_CLUSTER_ARN)
    return dataApi({ resourceArn: env.DATABASE_CLUSTER_ARN, secretArn: env.DATABASE_SECRET_ARN ?? "", database: env.DATABASE_NAME ?? "" });
  return tcp(
    postgres(env.DATABASE_URL ?? "postgres://owninfra:owninfra@localhost:5432/owninfra", {
      max: 5,
      types: { date: { to: 1082, from: [1082], serialize: (v: string) => v, parse: (v: string) => v } },
    }),
  );
}

const cache = globalThis as unknown as { owninfraDb?: Db };

export const db = (cache.owninfraDb ??= fromEnv(process.env));
