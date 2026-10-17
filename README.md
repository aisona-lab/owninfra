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

# run the approvals example locally (no AWS account needed)
alias owninfra="node $PWD/packages/cli/dist/bin.js"
owninfra init --example approvals /tmp/approvals && cd /tmp/approvals
owninfra generate        # writes app/, docker-compose.yml and owninfra.lock.json
owninfra dev             # docker compose Postgres, migrate, seed, next dev on :3000
```

`dev` uses `docker compose` by default. Set `DATABASE_URL` to use a Postgres you run yourself. Sign in at `/api/auth/signin` as one of the seed users (`requester@acme.example`, `manager@acme.example`, `finance@acme.example`) with no password. This local stub is enabled by `OWNINFRA_AUTH_STUB=1`, which `dev` sets, and `next build` fails when it is set.

`generate` is idempotent. It records a hash of every generated file in `owninfra.lock.json` and refuses to overwrite a file you edited by hand (pass `--force` to discard the edit). Put your own code in `app/src/custom/` and import from `@/lib/owninfra`; `generate` never touches it. If the blueprint changes after the dev database was created, `dev` refuses until you run `owninfra dev --reset`, which drops and recreates it.

## Blueprint

[`examples/approvals/blueprint.yaml`](examples/approvals/blueprint.yaml) is a complete spend-approval tool: roles, entities, CRUD and ownership permissions, a workflow with role-gated transitions, and dev/prod environments. The schema is published as Zod and as [JSON Schema](packages/blueprint-schema/blueprint.schema.json) for editor autocompletion via `yaml-language-server`. Fields marked v1 are accepted and ignored with a warning.

`validate` runs harness level L0: schema checks plus semantic checks (references resolve, roles and states exist, no unreachable workflow states, no dead-end states (every non-final state needs an outgoing transition), `own` rules require ownership). It also checks names: table names are the snake_case plural of the entity, and table and column names must be valid Postgres identifiers that are not reserved words (`order`, `user`), not system columns (`id`, `created_at`, `updated_at`, `created_by`), and within the 63-byte limit.

`version` must be `0.1`. YAML reads the number `0.10` as `0.1`, so it is accepted, but the string `"0.10"` is rejected.

## Generated app behavior

- **Input values.** Seeds, forms and the JSON API all go through one codec per field type (`packages/blueprint-schema/src/codecs.ts`, shipped unchanged to `app/src/lib/(generated)/codecs.ts`). Form `datetime` inputs have no zone and are read as UTC. Times are displayed in UTC.
- **Create forms** show only the fields that can be set at create. A field that a transition requires (such as `rejection_reason`) is set by that transition, unless the field is itself required. The API rejects such a field on create with 422.
- **Validation errors** come back as 422 with `{ "error": "...", "fields": { "<field>": "<message>" } }`. Forms show each message next to its field.
- **Transitions:** `POST /api/e/<table>/<id>/transitions/<transition>` checks the request in this order:
  1. The transition exists on the entity. If not: 404 `unknown transition`, with or without a body.
  2. The row exists and is readable. If not: 404 `not found`.
  3. The body is valid JSON (400) and sets only the transition's `require_fields` (422).
  4. State, role and separation-of-duties rules (409, 403 or 422).

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
