import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, type Stack } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as rds from "aws-cdk-lib/aws-rds";
import { describe, expect, it } from "vitest";
import { validateBlueprintYaml } from "@owninfra/blueprint-schema";
import { appStack, autoPause, newApp, projectTag } from "../src/index.js";

const blueprint = readFileSync(new URL("../../../examples/approvals/blueprint.yaml", import.meta.url), "utf8");

function parse(yaml: string) {
  const r = validateBlueprintYaml(yaml);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.model;
}

type Resource = { Type: string; Properties?: Record<string, unknown> & { Tags?: unknown; UserPoolTags?: unknown } };
type Template = { Resources: Record<string, Resource> };

type SynthOptions = {
  yaml?: string;
  envName?: "dev" | "prod";
  extend?: (stack: Stack) => void;
  /** Synthesize without the app's validation plugins, to see what the idle-cost guard alone catches. */
  plain?: boolean;
};

function synth({ yaml = blueprint, envName = "dev", extend, plain = false }: SynthOptions = {}) {
  const outdir = mkdtempSync(join(tmpdir(), "owninfra-cdk-"));
  const app = plain ? new App({ outdir, analyticsReporting: false }) : newApp(outdir);
  const stack = appStack(app, parse(yaml), envName);
  extend?.(stack);
  const assembly = app.synth();
  const raw = readFileSync(join(outdir, stack.templateFile), "utf8");
  return { stack, assembly, raw, template: JSON.parse(raw) as Template };
}

const ofType = (t: Template, type: string) => Object.values(t.Resources).filter((r) => r.Type === type);
const one = (t: Template, type: string) => {
  const found = ofType(t, type);
  expect(found).toHaveLength(1);
  return found[0]!.Properties ?? {};
};

/** Everything that would bill by the hour while the dev stack sits idle. Checks the template itself, not the snapshot. */
function idleCostFindings(t: Template): string[] {
  const hourly = ["AWS::EC2::NatGateway", "AWS::EC2::EIP", "AWS::EC2::InternetGateway", "AWS::EC2::Instance", "AWS::ECS::Service"];
  const findings: string[] = [];
  for (const [id, r] of Object.entries(t.Resources)) {
    const p = r.Properties ?? {};
    if (hourly.includes(r.Type)) findings.push(`${id}: ${r.Type}`);
    if (r.Type === "AWS::EC2::VPCGatewayAttachment" && p.InternetGatewayId !== undefined) findings.push(`${id}: attaches an internet gateway`);
    if (r.Type === "AWS::EC2::VPCEndpoint" && p.VpcEndpointType === "Interface") findings.push(`${id}: interface VPC endpoint`);
    if (p.ProvisionedConcurrencyConfig !== undefined) findings.push(`${id}: Lambda provisioned concurrency`);
    if (r.Type === "AWS::RDS::DBInstance" && p.DBInstanceClass !== "db.serverless") findings.push(`${id}: provisioned DB instance ${String(p.DBInstanceClass)}`);
    if (r.Type === "AWS::RDS::DBCluster") {
      const scaling = p.ServerlessV2ScalingConfiguration as { MinCapacity?: unknown; SecondsUntilAutoPause?: unknown } | undefined;
      if (scaling?.MinCapacity !== 0) findings.push(`${id}: Aurora MinCapacity ${String(scaling?.MinCapacity)}, not 0`);
      if (scaling?.SecondsUntilAutoPause !== autoPause.toSeconds()) findings.push(`${id}: SecondsUntilAutoPause ${String(scaling?.SecondsUntilAutoPause)}, not ${autoPause.toSeconds()}`);
    }
  }
  return findings;
}

const untaggable = [
  "AWS::Cognito::UserPoolClient",
  "AWS::Cognito::UserPoolDomain",
  "AWS::Cognito::UserPoolGroup",
  "AWS::EC2::SubnetRouteTableAssociation",
  "AWS::IAM::Policy",
  "AWS::Lambda::Permission",
  "AWS::Lambda::Url",
  "AWS::SecretsManager::SecretTargetAttachment",
];

const hasProjectTag = (r: Resource) => {
  const tags = r.Properties?.Tags ?? r.Properties?.UserPoolTags;
  if (Array.isArray(tags)) return tags.some((t) => t.Key === projectTag.key && t.Value === projectTag.value);
  return (tags as Record<string, string> | undefined)?.[projectTag.key] === projectTag.value;
};

describe("approvals infrastructure", () => {
  const { stack, assembly, raw, template } = synth();

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
      synth({ extend: (s) => new iam.Role(s, "Admin", { assumedBy: new iam.AccountRootPrincipal(), inlinePolicies: { all: wildcard } }) }),
    ).toThrow(/AwsSolutions-IAM5\[Action::\*\]/);
  });
});

describe("idle cost", () => {
  const { template } = synth();

  it("has nothing that bills by the hour while idle", () => {
    expect(idleCostFindings(template)).toEqual([]);
  });

  it("scales Aurora to 0 ACU and pauses it after an explicit delay", () => {
    expect(one(template, "AWS::RDS::DBCluster").ServerlessV2ScalingConfiguration).toEqual({ MinCapacity: 0, MaxCapacity: 2, SecondsUntilAutoPause: 300 });
    expect(ofType(template, "AWS::RDS::DBInstance").map((r) => r.Properties?.DBInstanceClass)).toEqual(["db.serverless"]);
  });

  const cluster = (s: Stack) => s.node.findChild("Db").node.defaultChild as rds.CfnDBCluster;
  const vpc = (s: Stack) => s.node.findChild("Vpc") as ec2.Vpc;
  const injections: [string, (s: Stack) => void, RegExp][] = [
    ["a NAT gateway", (s) => new ec2.CfnNatGateway(s, "Nat", { subnetId: vpc(s).isolatedSubnets[0]!.subnetId, connectivityType: "private" }), /AWS::EC2::NatGateway/],
    ["an Elastic IP", (s) => new ec2.CfnEIP(s, "Eip"), /AWS::EC2::EIP/],
    [
      "an internet gateway",
      (s) => new ec2.CfnVPCGatewayAttachment(s, "IgwAttach", { vpcId: vpc(s).vpcId, internetGatewayId: new ec2.CfnInternetGateway(s, "Igw").ref }),
      /AWS::EC2::InternetGateway[\s\S]*attaches an internet gateway|attaches an internet gateway[\s\S]*AWS::EC2::InternetGateway/,
    ],
    ["Aurora min capacity 0.5", (s) => cluster(s).addPropertyOverride("ServerlessV2ScalingConfiguration.MinCapacity", 0.5), /MinCapacity 0.5, not 0/],
    ["no auto-pause delay", (s) => cluster(s).addPropertyDeletionOverride("ServerlessV2ScalingConfiguration.SecondsUntilAutoPause"), /SecondsUntilAutoPause undefined/],
    ["an EC2 instance", (s) => new ec2.CfnInstance(s, "Box", { imageId: "ami-12345678", instanceType: "t4g.nano" }), /AWS::EC2::Instance/],
    [
      "a provisioned DB instance",
      (s) => new rds.CfnDBInstance(s, "Fixed", { dbClusterIdentifier: cluster(s).ref, dbInstanceClass: "db.t4g.medium", engine: "aurora-postgresql" }),
      /provisioned DB instance db.t4g.medium/,
    ],
    [
      "an interface VPC endpoint",
      (s) => vpc(s).addInterfaceEndpoint("Sm", { service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER, subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED } }),
      /interface VPC endpoint/,
    ],
    [
      "Lambda provisioned concurrency",
      (s) => new lambda.Alias(s, "Live", { aliasName: "live", version: (s.node.findChild("App") as lambda.Function).currentVersion, provisionedConcurrentExecutions: 1 }),
      /Lambda provisioned concurrency/,
    ],
  ];
  it.each(injections)("catches %s without relying on the snapshot", (_, inject, finding) => {
    expect(idleCostFindings(synth({ extend: inject, plain: true }).template).join("\n")).toMatch(finding);
  });
});

describe("database deletion protection follows the blueprint", () => {
  it("is off for dev, whose blueprint sets deletion_protection: false", () => {
    expect(blueprint).toMatch(/deletion_protection: false/);
    expect(one(synth().template, "AWS::RDS::DBCluster").DeletionProtection).toBe(false);
  });

  it("is on for prod, whose blueprint sets deletion_protection: true", () => {
    expect(one(synth({ envName: "prod" }).template, "AWS::RDS::DBCluster").DeletionProtection).toBe(true);
  });

  it("turns on for dev when its blueprint value flips to true", () => {
    const yaml = blueprint.replace("deletion_protection: false", "deletion_protection: true");
    expect(one(synth({ yaml }).template, "AWS::RDS::DBCluster").DeletionProtection).toBe(true);
  });
});

const withMfa = (mfa: string | undefined) => {
  const line = /^ {2}mfa: .*\n/m;
  expect(blueprint).toMatch(line);
  return blueprint.replace(line, mfa === undefined ? "" : `  mfa: ${mfa}\n`);
};

describe("user pool MFA follows auth.mfa", () => {
  const cases = [
    { mfa: "required", MfaConfiguration: "ON", EnabledMfas: ["SOFTWARE_TOKEN_MFA"] },
    { mfa: "optional", MfaConfiguration: "OPTIONAL", EnabledMfas: ["SOFTWARE_TOKEN_MFA"] },
    { mfa: "off", MfaConfiguration: "OFF", EnabledMfas: undefined },
    { mfa: undefined, MfaConfiguration: "OFF", EnabledMfas: undefined },
  ];
  const raws = new Map<string | undefined, string>();

  it.each(cases)("auth.mfa $mfa gives MfaConfiguration $MfaConfiguration", ({ mfa, MfaConfiguration, EnabledMfas }) => {
    const { template, raw } = synth({ yaml: withMfa(mfa) });
    raws.set(mfa, raw);
    const pool = one(template, "AWS::Cognito::UserPool");
    expect(pool.MfaConfiguration).toBe(MfaConfiguration);
    expect(pool.EnabledMfas).toEqual(EnabledMfas);
    expect(pool.SmsConfiguration).toBeUndefined();
    expect(ofType(template, "AWS::IAM::Role")).toHaveLength(ofType(synth().template, "AWS::IAM::Role").length);
  });

  it("gives different templates for required, optional and off, and unset matches off", () => {
    expect(new Set([raws.get("required"), raws.get("optional"), raws.get("off")]).size).toBe(3);
    expect(raws.get(undefined)).toBe(raws.get("off"));
  });
});
