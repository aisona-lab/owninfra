# owninfra

From a prompt or a `blueprint.yaml` to an internal tool running in **your own AWS account**, with the infra and the app verified.

> **Status: pre-alpha.** Only blueprint validation works today. Nothing here deploys anything yet.

## Goal

Take an engineer from a prompt or a `blueprint.yaml` to an internal tool deployed in their own AWS account (corporate login, RBAC, a database, dev/prod environments) in under an hour, with a verification report showing the app and the infra meet an explicit standard.

*The agent proposes, the compiler decides.* AI only writes the blueprint. Infrastructure comes from deterministic, tested templates (AWS CDK in TypeScript, ECS Fargate, RDS PostgreSQL, Cognito, CloudFront with a VPC origin), and nothing counts as done until it passes a layered verification harness (schema → types → cdk-nag/checkov → tests → deploy and smoke test → scoring).

## Non-goals

- Not a public SaaS generator: no multi-tenancy, payments, landing pages or B2C scale.
- Not a visual drag-and-drop builder or browser IDE. The interface is the CLI, YAML and your agent of choice.
- Not a hosted service. No control plane, no account with us, no telemetry by default.
- Not multi-cloud. AWS only.
- Never asks an LLM to write arbitrary infrastructure. IaC always comes from versioned constructs.
- One frontend stack: Next.js.
- Not a Retool replacement for non-developers.
- No Terraform output in the MVP or v1.

## Quickstart

Not available yet. The target is:

```sh
npx owninfra init --example approvals && cd approvals && npx owninfra deploy --env dev
```

What works today, from a clone:

```sh
pnpm install && pnpm build
node packages/cli/dist/bin.js validate examples/approvals/blueprint.yaml
```

## Blueprint

[`examples/approvals/blueprint.yaml`](examples/approvals/blueprint.yaml) is a complete spend-approval tool: roles, entities, CRUD and ownership permissions, a workflow with role-gated transitions, and dev/prod environments. The schema is published as Zod and as [JSON Schema](packages/blueprint-schema/blueprint.schema.json) for editor autocompletion via `yaml-language-server`. Fields marked v1 are accepted and ignored with a warning.

`validate` runs harness level L0: schema checks plus semantic checks (references resolve, roles and states exist, no unreachable workflow states, no dead-end states (every non-final state needs an outgoing transition), `own` rules require ownership).

## Repo layout

```
owninfra/
├── README.md
├── LICENSE                 # Apache-2.0
├── CONTRIBUTING.md
├── SECURITY.md             # planned
├── docs/                   # planned
│   └── adr/                # 0001-cdk-vs-terraform.md, 0002-fargate-vs-lambda.md, ...
├── packages/
│   ├── cli/                # init, plan, validate, generate, dev, verify, deploy, destroy
│   ├── blueprint-schema/   # Zod + JSON Schema, semantic validator
│   ├── compiler/           # planned: blueprint -> IR -> files (deterministic, no LLM)
│   ├── templates/          # planned: Next.js app templates (managed zones)
│   ├── constructs/         # planned: CDK L3 constructs (InternalApp, AppDatabase, AppAuth, AppObservability)
│   ├── agent/              # planned: prompt -> blueprint with a repair loop, BYO model
│   ├── mcp-server/         # planned (v1): CLI as MCP tools
│   └── harness/            # planned: L0-L5 runners and reporters
├── examples/
│   └── approvals/          # it-asset-inventory and incident-tracker planned
├── evals/                  # planned: datasets, versioned results
└── .github/workflows/
    └── ci.yml              # lint, typecheck, tests
```

## Roadmap

- **MVP:** blueprint v0 → IR → generated Next.js + Drizzle + CDK repo, `dev`/`deploy`/`destroy`, harness L0-L4, `plan` agent, three examples.
- **v1:** agent-written code in bounded `src/custom/**` slots, safe regeneration, SSO federation, multi-account pipeline, `import-db`, MCP server, agent scoring (L5).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
