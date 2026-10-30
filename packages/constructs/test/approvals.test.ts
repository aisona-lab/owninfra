import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Stack } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { validateBlueprintYaml } from "@owninfra/blueprint-schema";
import { appStack, newApp, projectTag } from "../src/index.js";

const r = validateBlueprintYaml(readFileSync(new URL("../../../examples/approvals/blueprint.yaml", import.meta.url), "utf8"));
if (!r.ok) throw new Error(JSON.stringify(r.errors));
const model = r.model;

function synth(extend?: (stack: Stack) => void) {
  const outdir = mkdtempSync(join(tmpdir(), "owninfra-cdk-"));
  const app = newApp(outdir);
  const stack = appStack(app, model, "dev");
  extend?.(stack);
  const assembly = app.synth();
  return { stack, assembly, raw: readFileSync(join(outdir, stack.templateFile), "utf8") };
}

const untaggable = [
  "AWS::Cognito::UserPoolClient",
  "AWS::Cognito::UserPoolDomain",
  "AWS::Cognito::UserPoolGroup",
  "AWS::EC2::Route",
  "AWS::EC2::SecurityGroupIngress",
  "AWS::EC2::SubnetRouteTableAssociation",
  "AWS::EC2::VPCGatewayAttachment",
  "AWS::IAM::Policy",
  "AWS::Lambda::Permission",
  "AWS::Lambda::Url",
  "AWS::SecretsManager::SecretTargetAttachment",
];

type Resource = { Type: string; Properties?: { Tags?: unknown; UserPoolTags?: unknown } };
const hasProjectTag = (r: Resource) => {
  const tags = r.Properties?.Tags ?? r.Properties?.UserPoolTags;
  if (Array.isArray(tags)) return tags.some((t) => t.Key === projectTag.key && t.Value === projectTag.value);
  return (tags as Record<string, string> | undefined)?.[projectTag.key] === projectTag.value;
};

describe("approvals infrastructure", () => {
  const { stack, assembly, raw } = synth();
  const template = JSON.parse(raw) as { Resources: Record<string, Resource> };

  it("matches the template snapshot", async () => {
    await expect(raw).toMatchFileSnapshot("__snapshots__/spend-approvals-dev.template.json");
  });

  it("targets eu-north-1 without an account or context lookups", () => {
    expect(assembly.getStackArtifact(stack.artifactId).environment).toEqual({ account: "unknown-account", region: "eu-north-1", name: "aws://unknown-account/eu-north-1" });
    expect(assembly.manifest.missing).toBeUndefined();
  });

  it("tags every taggable resource with Project=owninfra", () => {
    const untagged = Object.values(template.Resources).filter((r) => !hasProjectTag(r)).map((r) => r.Type);
    expect([...new Set(untagged)].sort()).toEqual(untaggable);
  });

  it("synthesizes the same bytes twice", () => {
    expect(synth().raw).toBe(raw);
  });

  it("fails synthesis when a construct breaks an AwsSolutions rule", () => {
    const wildcard = new iam.PolicyDocument({ statements: [new iam.PolicyStatement({ actions: ["*"], resources: ["*"] })] });
    expect(() =>
      synth((s) => new iam.Role(s, "Admin", { assumedBy: new iam.AccountRootPrincipal(), inlinePolicies: { all: wildcard } })),
    ).toThrow(/AwsSolutions-IAM5\[Action::\*\]/);
  });
});
