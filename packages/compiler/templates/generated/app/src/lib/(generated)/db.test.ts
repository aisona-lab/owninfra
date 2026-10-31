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

  it("talks to the local emulator when DATA_API_ENDPOINT is set, and never in production", () => {
    const env = { DATABASE_CLUSTER_ARN: "arn:aws:rds:eu-north-1:000000000000:cluster:local", DATA_API_ENDPOINT: "http://127.0.0.1:3080" };
    expect(fromEnv(env).driver).toBe("data-api");
    expect(() => fromEnv({ ...env, NODE_ENV: "production" })).toThrow("must not be set in production");
  });
});
