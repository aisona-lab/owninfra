import { describe, expect, it } from "vitest";
import { fromEnv } from "./db";

describe("fromEnv", () => {
  it("uses the Data API when DATABASE_CLUSTER_ARN is set, as it is in Lambda", () => {
    const env = { DATABASE_CLUSTER_ARN: "arn:aws:rds:eu-north-1:000000000000:cluster:x", DATABASE_SECRET_ARN: "arn:s", DATABASE_NAME: "app" };
    expect(fromEnv(env).driver).toBe("data-api");
  });

  it("uses postgres.js over TCP otherwise, as in local dev", () => {
    expect(fromEnv({ DATABASE_URL: "postgres://u:p@localhost:5432/app" }).driver).toBe("postgres");
  });
});
