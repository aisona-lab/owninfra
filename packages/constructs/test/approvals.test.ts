import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, type Stack } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { describe, expect, it } from "vitest";
import { validateBlueprintYaml } from "@owninfra/blueprint-schema";
import { appStack, autoPause, defaultConcurrency, newApp, projectTag, unrotatedSecretReason } from "../src/index.js";

const blueprint = readFileSync(new URL("../../../examples/approvals/blueprint.yaml", import.meta.url), "utf8");

function parse(yaml: string) {
  const r = validateBlueprintYaml(yaml);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.model;
}

type Resource = { Type: string; Properties?: Record<string, unknown> & { Tags?: unknown; UserPoolTags?: unknown } };
type Template = { Resources: Record<string, Resource>; Outputs?: Record<string, { Value: unknown }> };

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

/**
 * Every AwsSolutions acknowledgement in the stack, read after synthesis so aspect-added ones are included.
 * CDK stores them as `Annotation::AwsSolutions-…`; its own built-in `CloudFormation-Validate::…` acknowledgements are left out.
 */
const acks = (stack: Stack) =>
  stack.node
    .findAll()
    .flatMap((c) => c.node.metadata.filter((m) => m.type === "aws:cdk:acknowledged-rules").map((m) => ({ path: c.node.path, rules: m.data as Record<string, string> })))
    .flatMap(({ path, rules }) => Object.entries(rules).map(([id, reason]) => ({ path, id: id.replace(/^Annotation::/, ""), reason })))
    .filter((a) => a.id.startsWith("AwsSolutions-"));
const ackIds = (stack: Stack) => acks(stack).map((a) => a.id);

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

describe("cdk-nag acknowledgements", () => {
  const rds10Dev =
    "The blueprint sets environments.dev.database.deletion_protection to false: this dev cluster has DeletionProtection off, so deleting the stack deletes it. Its DeletionPolicy is Snapshot (the CDK default; the blueprint's removal_policy is not wired yet), so CloudFormation takes a final snapshot first.";
  const cog2Optional =
    "The blueprint sets auth.mfa to optional, so MfaConfiguration is OPTIONAL: users can enroll TOTP but are not made to. auth.mfa: required sets it to ON and removes this acknowledgement.";

  it("pins every acknowledgement and its reason for the example blueprint's dev stack", () => {
    expect(acks(synth().stack)).toEqual([
      { path: "spend-approvals-dev/Db", id: "AwsSolutions-RDS10", reason: rds10Dev },
      { path: "spend-approvals-dev/Db/Secret/Resource", id: "AwsSolutions-SMG4", reason: unrotatedSecretReason },
      { path: "spend-approvals-dev/Users", id: "AwsSolutions-COG2", reason: cog2Optional },
    ]);
  });

  it("RDS10: prod (deletion_protection: true) has protection on and no acknowledgement", () => {
    const { stack, template } = synth({ envName: "prod" });
    expect(one(template, "AWS::RDS::DBCluster").DeletionProtection).toBe(true);
    expect(ackIds(stack)).not.toContain("AwsSolutions-RDS10");
  });

  it("RDS10: dev's reason matches dev's config, and flipping it to true drops the acknowledgement", () => {
    const dev = synth();
    expect(one(dev.template, "AWS::RDS::DBCluster").DeletionProtection).toBe(false);
    expect(dev.template.Resources["Db5D02A0A9"]).toMatchObject({ DeletionPolicy: "Snapshot" });
    expect(acks(dev.stack).find((a) => a.id === "AwsSolutions-RDS10")?.reason).toBe(rds10Dev);
    const flipped = synth({ yaml: blueprint.replace("deletion_protection: false", "deletion_protection: true") });
    expect(ackIds(flipped.stack)).not.toContain("AwsSolutions-RDS10");
    expect(acks(dev.stack).map((a) => a.reason).join(" ")).not.toMatch(/owninfra destroy/);
  });

  it("SMG4: acknowledged only while the secret has no rotation schedule", () => {
    expect(ofType(synth().template, "AWS::SecretsManager::RotationSchedule")).toEqual([]);
    const rotated = synth({
      extend: (s) =>
        new secretsmanager.CfnRotationSchedule(s, "Rotation", {
          secretId: (s.node.findChild("Db") as rds.DatabaseCluster).secret!.secretArn,
          rotationLambdaArn: "arn:aws:lambda:eu-north-1:111111111111:function:rotate",
          rotationRules: { automaticallyAfterDays: 30 },
        }),
    });
    expect(ackIds(rotated.stack)).not.toContain("AwsSolutions-SMG4");
  });

  it.each([
    { mfa: "required", reason: undefined },
    { mfa: "optional", reason: cog2Optional },
    { mfa: "off", reason: "The blueprint sets auth.mfa to off, so MfaConfiguration is OFF. auth.mfa: required sets it to ON and removes this acknowledgement." },
    {
      mfa: undefined,
      reason:
        "The blueprint leaves auth.mfa unset and the schema has no default, so MfaConfiguration is OFF (Cognito's default). auth.mfa: required sets it to ON and removes this acknowledgement.",
    },
  ])("COG2 with auth.mfa $mfa: acknowledged only when MFA is not required", ({ mfa, reason }) => {
    const { stack } = synth({ yaml: withMfa(mfa) });
    expect(acks(stack).find((a) => a.id === "AwsSolutions-COG2")?.reason).toBe(reason);
  });
});

describe("app function wiring", () => {
  const { raw, template } = synth();
  const idOf = (type: string) => Object.entries(template.Resources).find(([, r]) => r.Type === type)![0];
  const functionUrl = { "Fn::GetAtt": [idOf("AWS::Lambda::Url"), "FunctionUrl"] };

  it("keeps the Cognito client secret out of the template, the function env and the outputs", () => {
    expect(one(template, "AWS::Cognito::UserPoolClient").GenerateSecret).toBe(true);
    expect(raw).not.toMatch(/ClientSecret/);
    expect(JSON.stringify(one(template, "AWS::Lambda::Function").Environment)).not.toContain(idOf("AWS::Cognito::UserPoolClient"));
  });

  it("outputs the function URL, user pool id and client id, and nothing else", () => {
    expect(template.Outputs).toEqual({
      FunctionUrl: { Value: functionUrl },
      UserPoolId: { Value: { Ref: idOf("AWS::Cognito::UserPool") } },
      UserPoolClientId: { Value: { Ref: idOf("AWS::Cognito::UserPoolClient") } },
    });
  });

  it("registers the function URL as the client's only callback", () => {
    expect(one(template, "AWS::Cognito::UserPoolClient").CallbackURLs).toEqual([{ "Fn::Join": ["", [functionUrl, "api/auth/callback/cognito"]] }]);
  });

  it("gives the function what it needs to find its database and its Cognito client", () => {
    const vars = (one(template, "AWS::Lambda::Function").Environment as { Variables: Record<string, unknown> }).Variables;
    expect(vars).toMatchObject({ DATABASE_NAME: "spend_approvals", USER_POOL_ID: { Ref: idOf("AWS::Cognito::UserPool") }, USER_POOL_CLIENT_NAME: "web" });
    expect(Object.keys(vars).sort()).toEqual(["AUTH_COGNITO_ISSUER", "DATABASE_CLUSTER_ARN", "DATABASE_NAME", "DATABASE_SECRET_ARN", "NODE_ENV", "USER_POOL_CLIENT_NAME", "USER_POOL_ID"]);
    expect(one(template, "AWS::Cognito::UserPoolClient").ClientName).toBe("web");
  });

  it("lets the function read its user pool's clients and nothing else in Cognito", () => {
    const statements = ofType(template, "AWS::IAM::Policy").flatMap((p) => (p.Properties!.PolicyDocument as { Statement: { Action: unknown; Resource: unknown }[] }).Statement);
    expect(statements.filter((st) => JSON.stringify(st.Action).includes("cognito-idp"))).toEqual([
      expect.objectContaining({ Action: ["cognito-idp:ListUserPoolClients", "cognito-idp:DescribeUserPoolClient"], Resource: { "Fn::GetAtt": [idOf("AWS::Cognito::UserPool"), "Arn"] } }),
    ]);
  });
});

describe("the public URL's concurrency cap follows the blueprint", () => {
  const reserved = (t: Template) => one(t, "AWS::Lambda::Function").ReservedConcurrentExecutions;

  it("is compute.max: 2 for dev and 4 for prod", () => {
    expect(blueprint).toMatch(/dev:[\s\S]*?max: 2 }[\s\S]*prod:[\s\S]*?max: 4 }/);
    expect(reserved(synth().template)).toBe(2);
    expect(reserved(synth({ envName: "prod" }).template)).toBe(4);
  });

  it(`defaults to ${defaultConcurrency} when the environment has no compute block`, () => {
    const yaml = blueprint.replace("    compute: { cpu: 512, memory: 1024, desired: 1, max: 2 }\n", "");
    expect(yaml).not.toBe(blueprint);
    expect(reserved(synth({ yaml }).template)).toBe(defaultConcurrency);
  });
});
