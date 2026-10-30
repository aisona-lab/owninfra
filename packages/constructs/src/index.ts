import { App, Aws, Duration, Stack, Tags } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import type { Model } from "@owninfra/blueprint-schema";
import type { Construct } from "constructs";

export const projectTag = { key: "Project", value: "owninfra" } as const;

export function appStack(scope: Construct, model: Model, envName: "dev" | "prod"): Stack {
  const env = model.environments[envName];
  if (!env) throw new Error(`blueprint has no '${envName}' environment`);
  const stack = new Stack(scope, `${model.app.name}-${envName}`, { env: { region: env.region } });
  Tags.of(stack).add(projectTag.key, projectTag.value);

  const vpc = new ec2.Vpc(stack, "Vpc", {
    natGateways: 1,
    subnetConfiguration: [
      { name: "public", subnetType: ec2.SubnetType.PUBLIC },
      { name: "app", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      { name: "db", subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    ],
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
  });

  const userPool = new cognito.UserPool(stack, "Users", {
    selfSignUpEnabled: false,
    signInAliases: { email: true },
    mfa: cognito.Mfa.OPTIONAL,
    mfaSecondFactor: { otp: true, sms: false },
  });
  for (const role of model.roles.keys()) new cognito.CfnUserPoolGroup(stack, `Role-${role}`, { userPoolId: userPool.userPoolId, groupName: role });
  userPool.addDomain("Domain", { cognitoDomain: { domainPrefix: `${model.app.name}-${envName}-${Aws.ACCOUNT_ID}` } });

  const logGroup = new logs.LogGroup(stack, "AppLogs", { retention: logs.RetentionDays.ONE_MONTH });

  const fn = new lambda.Function(stack, "App", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromCfnParameters(),
    memorySize: 1024,
    timeout: Duration.seconds(30),
    vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    logGroup,
    environment: {
      NODE_ENV: "production",
      DATABASE_SECRET_ARN: db.secret!.secretArn,
      AUTH_COGNITO_ISSUER: `https://cognito-idp.${env.region}.amazonaws.com/${userPool.userPoolId}`,
    },
  });
  db.secret!.grantRead(fn);
  db.connections.allowDefaultPortFrom(fn);
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
  return new App({ outdir, analyticsReporting: false, postCliContext: { "aws:cdk:enable-path-metadata": false } });
}
