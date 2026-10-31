import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { aws_ec2 as ec2, aws_iam as iam, type Stack } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.js";
import { checkInfra } from "../src/smoke.js";

const example = readFileSync(fileURLToPath(new URL("../../../examples/approvals/blueprint.yaml", import.meta.url)), "utf8");

async function cli(dir: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const code = await run(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    process.chdir(cwd);
  }
}

describe("smoke", () => {
  it("passes the infra checks on the example", () => {
    expect(() => checkInfra(example, "dev")).not.toThrow();
    expect(() => checkInfra(example, "prod")).not.toThrow();
  });

  it("fails the infra step on a cdk-nag finding", () => {
    const wildcard = (stack: Stack) =>
      new iam.Role(stack, "Injected", {
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        inlinePolicies: { all: new iam.PolicyDocument({ statements: [new iam.PolicyStatement({ actions: ["s3:*"], resources: ["*"] })] }) },
      });
    expect(() => checkInfra(example, "dev", wildcard)).toThrow(/synth or cdk-nag: .*AwsSolutions-IAM5/s);
  });

  it("fails the infra step on an idle cost", () => {
    const nat = (stack: Stack) =>
      new ec2.CfnNatGateway(stack, "Injected", { subnetId: "subnet-0", connectivityType: "private" });
    expect(() => checkInfra(example, "dev", nat)).toThrow(/idle-cost guard: .*NatGateway/);
  });

  it("names the failing step and exits 1", async () => {
    const r = await cli(mkdtempSync(join(tmpdir(), "owninfra-")), "smoke");
    expect(r.code).toBe(1);
    expect(r.err).toContain("smoke: failed at 'compile: blueprint and generated app agree'");
  });
});
