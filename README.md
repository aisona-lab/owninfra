# owninfra

From a prompt or a `blueprint.yaml` to an internal tool running in **your own AWS account**, with the infra and the app verified.

> **Status: pre-alpha, local only.** This version does **not** deploy to AWS, and nothing in it makes AWS calls. It validates a blueprint, generates and runs the approvals example on your machine, and synthesizes (but does not deploy) its CDK stack.

## Goal

Take an engineer from a prompt or a `blueprint.yaml` to an internal tool deployed in their own AWS account (corporate login, RBAC, a database, dev/prod environments) in under an hour, with a verification report showing the app and the infra meet an explicit standard.

*The agent proposes, the compiler decides.* AI only writes the blueprint. Infrastructure comes from deterministic, tested templates (AWS CDK in TypeScript: a Lambda function URL, Aurora Serverless v2 PostgreSQL behind the Data API, and Cognito; see [Infrastructure](#infrastructure-synth-only)), and nothing counts as done until it passes a layered verification harness. The harness is planned; today only its first level, L0 (`validate`), exists.

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
npx owninfra init --example approvals && cd approvals && npx owninfra deploy --env dev   # deploy: not available in this version
```

**`deploy` is not available in this version.** `owninfra deploy` (like `plan`, `verify` and `destroy`) only prints `not implemented yet` and exits with code 2. The CLI package is marked private, so `npx owninfra` from npm does not work either.

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

## What works today

- **`validate` (L0)**: schema and semantic checks on a blueprint (see [Blueprint](#blueprint)).
- **`init`, `generate` and `dev` for the approvals example**: a Next.js app with Postgres, run locally (see [Quickstart](#quickstart)).
- **CDK synth of the approvals stack**, with no AWS account or credentials (see [Infrastructure](#infrastructure-synth-only)).
- **Two database drivers in the generated app**: postgres.js over TCP locally, and the RDS Data API when `DATABASE_CLUSTER_ARN` is set. They return the same values for the same SQL (64-bit ids come back as strings on both), and the repository test suite runs against both, using the [local-data-api](https://github.com/koxudaxi/local-data-api) emulator in front of the same Postgres.
- **Aurora resume handling** in the Data API driver (see [Generated app behavior](#generated-app-behavior)).

## Infrastructure (synth only)

`packages/constructs` holds one CDK stack, synthesized for the approvals example's `dev` environment with `pnpm --filter @owninfra/constructs synth` (after `pnpm build`). Nothing is deployed and the CLI has no synth command. The function's code is a CloudFormation parameter, so no app bundle is built for Lambda yet. The stack contains:

- **Compute:** a Lambda function (Node.js 24) behind a public function URL. Its reserved concurrency is the environment's `compute.max`, or 5 when the environment has no `compute` block. `validate` rejects a `compute.max` that is not a whole number of 1 or more. The other `compute` keys, and the blueprint's `infra` block (`compute: fargate`, `cloudfront_vpc_origin`, alarms), are not used by the stack.
- **Database:** Aurora Serverless v2 PostgreSQL 16 with min 0 ACU, max 2 ACU and auto-pause after 5 minutes, storage encryption, and the Data API enabled. It sits in isolated subnets: the VPC has no NAT gateway, internet gateway or interface endpoints. The function is not in the VPC and reaches the database only through the Data API. Deletion protection follows `environments.<env>.database.deletion_protection`.
- **Auth:** a Cognito user pool with no self sign-up, one group per blueprint role, MFA from `auth.mfa` (TOTP only), and an OAuth client with a generated secret. The client secret is not in the template, the function's env or the outputs: the app reads the client id and secret from Cognito at runtime, and derives its Auth.js secret from it.
- **cdk-nag:** the AwsSolutions checks run on every synth, and an unacknowledged error-level finding fails synthesis (a test proves it). The only acknowledgements are conditional: `RDS10` while deletion protection is off, `COG2` while `auth.mfa` is not `required`, and `SMG4` while the database secret has no rotation schedule. Each one disappears when its condition does, and each has a written reason.
- **Idle-cost guard:** a test fails if the template contains anything that bills by the hour while idle (NAT gateway, Elastic IP, internet gateway, EC2 instance, ECS service, interface endpoint, provisioned DB instance, Lambda provisioned concurrency) or if Aurora's min capacity is not 0 or auto-pause is not set.

## Generated app behavior

- **Input values.** Seeds, forms and the JSON API all go through one codec per field type (`packages/blueprint-schema/src/codecs.ts`, shipped unchanged to `app/src/lib/(generated)/codecs.ts`). Before any type check, a string value is normalized. `\r\n` becomes `\n`. Whitespace and zero-width characters (U+200B to U+200D, U+2060, U+FEFF) are removed only at the ends of a value, never inside it, so emoji ZWJ sequences, ZWNJ and Devanagari conjuncts are stored byte for byte. For `text` fields, only leading and trailing blank lines are dropped, so the first line keeps its indentation. All other types are trimmed at both ends. If a value is empty once all of those characters are removed, a required field fails with `is required`. On create, a blank optional field is treated as absent: the column default applies if there is one, and otherwise the value is stored as `NULL`. In a PATCH or a transition, a blank optional field is cleared to `NULL`. An explicit JSON `null` is stored as `NULL`. Form `datetime` inputs have no zone and are read as UTC. Times are displayed in UTC.
- **Transition-only fields.** A field listed in any transition's `require_fields` can be written only by a transition. PATCH returns 422 for it. A transition must receive every one of its `require_fields`, non-blank, in the same request; values already stored never count.
- **Create forms** show only the fields that can be set at create. A field that a transition requires (such as `rejection_reason`) is set by that transition, unless the field is itself required. The API rejects such a field on create with 422.
- **Validation errors** come back as 422 with `{ "error": "...", "fields": { "<field>": "<message>" } }`. Forms show each message next to its field.
- **Transitions:** `POST /api/e/<table>/<id>/transitions/<transition>` checks the request in this order:
  1. The transition exists on the entity. If not: 404 `unknown transition`, with or without a body.
  2. The row exists and is readable. If not: 404 `not found`.
  3. The body is valid JSON (400) and sets only the transition's `require_fields` (422).
  4. State, role and separation-of-duties rules (409, 403 or 422).
- **Aurora resume (Data API driver).** A call made while Aurora resumes from auto-pause is retried within a 20-second budget. If the database still isn't up, the API returns 503 with `Retry-After: 5` and "The app is starting up. Try again in a few seconds.", and pages show an error page with a "Try again" button. The SDK never retries on its own, and a commit that gets no answer is never retried: the API returns 503 saying the change may or may not have been saved. These faults are injected around the emulator's client in tests, since the emulator can't produce them.

## Repo layout

```
owninfra/
├── README.md
├── LICENSE                 # Apache-2.0
├── CONTRIBUTING.md
├── SECURITY.md             # planned
├── docs/
│   └── architecture/       # 0001-compiler.md
├── packages/
│   ├── cli/                # validate, init, generate, dev (plan, verify, deploy, destroy: not implemented)
│   ├── blueprint-schema/   # Zod + JSON Schema, semantic validator
│   ├── compiler/           # blueprint -> IR -> files (deterministic, no LLM), with the Next.js app templates
│   ├── constructs/         # CDK stack for the approvals example (synth only; L3 constructs planned)
│   ├── agent/              # planned: prompt -> blueprint with a repair loop, BYO model
│   ├── mcp-server/         # planned (v1): CLI as MCP tools
│   └── harness/            # planned: L0-L5 runners and reporters
├── examples/
│   └── approvals/          # it-asset-inventory and incident-tracker planned
├── evals/                  # planned: datasets, versioned results
└── .github/workflows/
    └── ci.yml              # check, infra and generated-app jobs (below)
```

## CI

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`, with no AWS credentials:

- **check:** build, lint, typecheck, unit tests, `validate` on the example, and the generated-app goldens.
- **infra:** with `contents: read` only, the construct tests (template snapshot, same bytes on a second synth, no account or context lookups, cdk-nag, idle-cost guard), then `cdk synth` and a byte compare of the template against the snapshot.
- **generated-app:** Postgres 17 and the local Data API emulator as services; the repository suite on both drivers; then `init`, `generate`, the generated app's typecheck, lint and tests, a check that a second `generate` writes nothing, `dev --db-only` twice, browser width and API checks against `next dev`, and `next build`, which must fail with `OWNINFRA_AUTH_STUB=1`.

## Roadmap: paused

Work beyond this version is paused. There are no dates and no commitments. Planned, not scheduled: `deploy` and `destroy`, the agent (`packages/agent`), the harness beyond L0 (`packages/harness`), evals (`evals/`) and the MCP server (`packages/mcp-server`).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
