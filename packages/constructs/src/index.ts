import { App, Aws, Duration, Stack, Tags, Validations } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import { AwsSolutionsChecks } from "cdk-nag";
import type { Model } from "@owninfra/blueprint-schema";
import type { Construct } from "constructs";

export const projectTag = { key: "Project", value: "owninfra" } as const;

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

  const db = new rds.DatabaseCluster(stack, "Db", {
    engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_16_11 }),
    writer: rds.ClusterInstance.serverlessV2("Writer"),
    serverlessV2MinCapacity: 0,
    serverlessV2MaxCapacity: 2,
    vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    defaultDatabaseName: model.app.name.replaceAll("-", "_"),
    storageEncrypted: true,
    enableDataApi: true,
    iamAuthentication: true,
  });
  Validations.of(db).acknowledge({
    id: "AwsSolutions-RDS10",
    reason: "Dev database: `owninfra destroy` must be able to delete it. The cluster keeps the default SNAPSHOT removal policy, so a final snapshot survives a destroy.",
  });
  Validations.of(db.node.findChild("Secret")).acknowledge({
    id: "AwsSolutions-SMG4",
    reason: "Rotation needs a rotation Lambda inside the VPC that can reach Secrets Manager, which from the isolated database subnets means NAT or an interface endpoint, both billed hourly. The app reads the secret through the Data API on each call, so rotation is safe to add once the stack has such a path.",
  });

  const userPool = new cognito.UserPool(stack, "Users", {
    selfSignUpEnabled: false,
    signInAliases: { email: true },
    mfa: cognito.Mfa.OPTIONAL,
    mfaSecondFactor: { otp: true, sms: false },
    passwordPolicy: { minLength: 12, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: true },
    featurePlan: cognito.FeaturePlan.PLUS,
  });
  Validations.of(userPool).acknowledge({
    id: "AwsSolutions-COG2",
    reason: "The approvals blueprint sets auth.mfa to optional: users can enroll TOTP, and requiring it is a blueprint decision, not an infra default.",
  });
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
    role,
    logGroup,
    environment: {
      NODE_ENV: "production",
      DATABASE_CLUSTER_ARN: db.clusterArn,
      DATABASE_SECRET_ARN: db.secret!.secretArn,
      AUTH_COGNITO_ISSUER: `https://cognito-idp.${env.region}.amazonaws.com/${userPool.userPoolId}`,
    },
  });
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["rds-data:ExecuteStatement", "rds-data:BeginTransaction", "rds-data:CommitTransaction", "rds-data:RollbackTransaction"],
      resources: [db.clusterArn],
    }),
  );
  fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["secretsmanager:GetSecretValue"], resources: [db.secret!.secretArn] }));
  const url = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

  userPool.addClient("Web", {
    generateSecret: true,
    oAuth: {
      flows: { authorizationCodeGrant: true },
      scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
      callbackUrls: [`${url.url}api/auth/callback/cognito`],
    },
  });

  return stack;
}

export function newApp(outdir?: string): App {
  const app = new App({ outdir, analyticsReporting: false, postCliContext: { "aws:cdk:enable-path-metadata": false } });
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  return app;
}
