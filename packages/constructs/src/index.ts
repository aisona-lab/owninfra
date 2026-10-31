import { App, Aspects, Aws, CfnOutput, Duration, type IAspect, Stack, Tags, Validations } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { AwsSolutionsChecks } from "cdk-nag";
import type { Model } from "@owninfra/blueprint-schema";
import type { Construct, IConstruct } from "constructs";

export const projectTag = { key: "Project", value: "owninfra" } as const;

/** Aurora Serverless v2 pauses at 0 ACU after this long with no connections. Set explicitly (it equals the AWS default) so a test can pin it. */
export const autoPause = Duration.minutes(5);

/**
 * The blueprint's auth.mfa drives the user pool. The second factor is TOTP only, which needs no SMS role.
 * The schema declares no default for auth.mfa, so unset gets Cognito's own default: OFF.
 */
export function userPoolMfa(mfa: Model["auth"]["mfa"]): Pick<cognito.UserPoolProps, "mfa" | "mfaSecondFactor"> {
  if (mfa === "required") return { mfa: cognito.Mfa.REQUIRED, mfaSecondFactor: { otp: true, sms: false } };
  if (mfa === "optional") return { mfa: cognito.Mfa.OPTIONAL, mfaSecondFactor: { otp: true, sms: false } };
  return { mfa: cognito.Mfa.OFF };
}

function unprotectedReason(envName: string, value: boolean | undefined): string {
  const setting = `environments.${envName}.database.deletion_protection`;
  const why =
    value === false
      ? `The blueprint sets ${setting} to false`
      : `The blueprint leaves ${setting} unset and the schema has no default, so the stack uses CloudFormation's default`;
  return `${why}: this ${envName} cluster has DeletionProtection off, so deleting the stack deletes it. Its DeletionPolicy is Snapshot (the CDK default; the blueprint's removal_policy is not wired yet), so CloudFormation takes a final snapshot first.`;
}

function mfaNotRequiredReason(mfa: Model["auth"]["mfa"]): string {
  if (mfa === "optional")
    return "The blueprint sets auth.mfa to optional, so MfaConfiguration is OPTIONAL: users can enroll TOTP but are not made to. auth.mfa: required sets it to ON and removes this acknowledgement.";
  if (mfa === "off") return "The blueprint sets auth.mfa to off, so MfaConfiguration is OFF. auth.mfa: required sets it to ON and removes this acknowledgement.";
  return "The blueprint leaves auth.mfa unset and the schema has no default, so MfaConfiguration is OFF (Cognito's default). auth.mfa: required sets it to ON and removes this acknowledgement.";
}

/** Lambda instances the public URL may run at once when the blueprint sets no compute.max: enough for a few users, small enough to bound cost and load on a 2 ACU database. */
export const defaultConcurrency = 5;
const clientName = "web";

export const unrotatedSecretReason =
  "No rotation schedule. Rotating this CDK-generated secret needs a rotation Lambda that reaches both the database and Secrets Manager; the cluster is in isolated subnets with no NAT or Secrets Manager interface endpoint (both bill hourly), so such a Lambda has no path. RDS-managed master password rotation (ManageMasterUserPassword) needs no Lambda, but the AWS docs do not say whether the Data API accepts an RDS-managed secret (unconfirmed), and the deployed app reaches the database only through the Data API with this secret, so the secret has not been switched.";

/** Acknowledges AwsSolutions-SMG4 only on secrets that no rotation schedule targets, so adding rotation removes the acknowledgement. */
class AcknowledgeUnrotatedSecrets implements IAspect {
  visit(node: IConstruct): void {
    if (!(node instanceof secretsmanager.CfnSecret)) return;
    const stack = Stack.of(node);
    const refOf = (v: unknown) => (stack.resolve(v) as { Ref?: string } | undefined)?.Ref;
    const all = stack.node.findAll();
    const ids = new Set([refOf(node.ref)]);
    for (const c of all) if (c instanceof secretsmanager.CfnSecretTargetAttachment && ids.has(refOf(c.secretId))) ids.add(refOf(c.ref));
    if (all.some((c) => c instanceof secretsmanager.CfnRotationSchedule && ids.has(refOf(c.secretId)))) return;
    Validations.of(node).acknowledge({ id: "AwsSolutions-SMG4", reason: unrotatedSecretReason });
  }
}

export function appStack(scope: Construct, model: Model, envName: "dev" | "prod"): Stack {
  const env = model.environments[envName];
  if (!env) throw new Error(`blueprint has no '${envName}' environment`);
  const stack = new Stack(scope, `${model.app.name}-${envName}`, { env: { region: env.region } });
  Tags.of(stack).add(projectTag.key, projectTag.value);

  const vpc = new ec2.Vpc(stack, "Vpc", {
    subnetConfiguration: [{ name: "db", subnetType: ec2.SubnetType.PRIVATE_ISOLATED }],
    flowLogs: {
      all: { destination: ec2.FlowLogDestination.toCloudWatchLogs(new logs.LogGroup(stack, "FlowLogs", { retention: logs.RetentionDays.ONE_MONTH })) },
    },
  });

  const databaseName = model.app.name.replaceAll("-", "_");
  const db = new rds.DatabaseCluster(stack, "Db", {
    engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_16_11 }),
    writer: rds.ClusterInstance.serverlessV2("Writer"),
    serverlessV2MinCapacity: 0,
    serverlessV2AutoPauseDuration: autoPause,
    serverlessV2MaxCapacity: 2,
    vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    defaultDatabaseName: databaseName,
    storageEncrypted: true,
    enableDataApi: true,
    iamAuthentication: true,
    deletionProtection: env.deletionProtection ?? false,
  });
  if (!(env.deletionProtection ?? false)) Validations.of(db).acknowledge({ id: "AwsSolutions-RDS10", reason: unprotectedReason(envName, env.deletionProtection) });
  Aspects.of(stack).add(new AcknowledgeUnrotatedSecrets());

  const userPool = new cognito.UserPool(stack, "Users", {
    selfSignUpEnabled: false,
    signInAliases: { email: true },
    ...userPoolMfa(model.auth.mfa),
    passwordPolicy: { minLength: 12, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: true },
    featurePlan: cognito.FeaturePlan.PLUS,
  });
  if (model.auth.mfa !== "required") Validations.of(userPool).acknowledge({ id: "AwsSolutions-COG2", reason: mfaNotRequiredReason(model.auth.mfa) });
  for (const role of model.roles.keys()) new cognito.CfnUserPoolGroup(stack, `Role-${role}`, { userPoolId: userPool.userPoolId, groupName: role });
  userPool.addDomain("Domain", { cognitoDomain: { domainPrefix: `${model.app.name}-${envName}-${Aws.ACCOUNT_ID}` } });

  const logGroup = new logs.LogGroup(stack, "AppLogs", { retention: logs.RetentionDays.ONE_MONTH });
  const role = new iam.Role(stack, "AppRole", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") });
  role.addToPolicy(new iam.PolicyStatement({ actions: ["logs:CreateLogStream", "logs:PutLogEvents"], resources: [logGroup.logGroupArn] }));

  const fn = new lambda.Function(stack, "App", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromCfnParameters(),
    memorySize: 1024,
    timeout: Duration.seconds(30),
    reservedConcurrentExecutions: env.maxInstances ?? defaultConcurrency,
    role,
    logGroup,
    environment: {
      NODE_ENV: "production",
      DATABASE_CLUSTER_ARN: db.clusterArn,
      DATABASE_SECRET_ARN: db.secret!.secretArn,
      DATABASE_NAME: databaseName,
      AUTH_COGNITO_ISSUER: `https://cognito-idp.${env.region}.amazonaws.com/${userPool.userPoolId}`,
      USER_POOL_ID: userPool.userPoolId,
      USER_POOL_CLIENT_NAME: clientName,
    },
  });
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["rds-data:ExecuteStatement", "rds-data:BeginTransaction", "rds-data:CommitTransaction", "rds-data:RollbackTransaction"],
      resources: [db.clusterArn],
    }),
  );
  fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["secretsmanager:GetSecretValue"], resources: [db.secret!.secretArn] }));
  // The client's callback URL needs the function URL, so the function can't also take the client id (or secret) as env:
  // that is a cycle. The app reads both from Cognito at startup instead; Cognito scopes these actions to the pool.
  fn.addToRolePolicy(
    new iam.PolicyStatement({ actions: ["cognito-idp:ListUserPoolClients", "cognito-idp:DescribeUserPoolClient"], resources: [userPool.userPoolArn] }),
  );
  const url = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

  const client = userPool.addClient("Web", {
    userPoolClientName: clientName,
    generateSecret: true,
    oAuth: {
      flows: { authorizationCodeGrant: true },
      scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
      callbackUrls: [`${url.url}api/auth/callback/cognito`],
    },
  });

  new CfnOutput(stack, "FunctionUrl", { value: url.url });
  new CfnOutput(stack, "UserPoolId", { value: userPool.userPoolId });
  new CfnOutput(stack, "UserPoolClientId", { value: client.userPoolClientId });
  return stack;
}

/** A synthesized CloudFormation template, as far as the idle-cost guard reads it. */
export type Template = { Resources: Record<string, { Type: string; Properties?: Record<string, unknown> }> };

/** Everything that would bill by the hour while the dev stack sits idle. Checks the template itself, not the snapshot. */
export function idleCostFindings(t: Template): string[] {
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

export function newApp(outdir?: string): App {
  const app = new App({ outdir, analyticsReporting: false, postCliContext: { "aws:cdk:enable-path-metadata": false } });
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  return app;
}
