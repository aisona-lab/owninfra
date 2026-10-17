# 0001: Compiler architecture

Status: proposed. Covers MVP week 1 (`init`, `generate`, `dev` for the approvals example). Deploy, the harness beyond L0, and the agent are out of scope here except where they constrain the shapes below.

## Context

`validate` today parses YAML into a Zod-inferred `Blueprint` and runs semantic checks on that same loose type. Every later stage would have to re-check what validation already proved: that a `ref` points at a real entity, that a transition's states exist, that `own` is only used with ownership. This note fixes the shapes and stages before any generator code is written.

## Data shapes

There are three layers. Each is produced by exactly one function and never mutated afterwards.

1. **`RawBlueprint`** is the Zod output. It mirrors the YAML, including v1 fields. Only `blueprint-schema` sees it.
2. **`Model`** is the domain model. `parse(raw): Result<Model, Issue[]>` is the only way to build one, so holding a `Model` means L0 passed.
3. **`Ir`** is the target-shaped description of what to emit. `lower(model): Ir` is total. It cannot fail, because every failure mode was rejected in step 2.

### Model

Identifiers are branded strings: `RoleId`, `EntityName`, `FieldName`, `StateId`, `TransitionId`, `EnvName`. Brands are minted only inside `parse`.

References are resolved, not repeated as strings:

```ts
type Field =
  | { kind: "scalar"; name: FieldName; type: ScalarType; required: boolean; unique: boolean; constraints: ScalarConstraints }
  | { kind: "enum"; name: FieldName; values: NonEmpty<string>; default?: string; required: boolean }
  | { kind: "ref"; name: FieldName; target: EntityName; required: boolean };

type Entity = {
  name: EntityName;
  label: string;
  fields: ReadonlyMap<FieldName, Field>;
  display: FieldName;
  ownership: Ownership;
  workflow?: Workflow;
};

type Ownership = { kind: "none" } | { kind: "created_by" };

type Workflow = {
  field: FieldName;
  initial: StateId;
  states: ReadonlyMap<StateId, { label: string; final: boolean }>;
  transitions: ReadonlyMap<TransitionId, Transition>;
  separationOfDuties: boolean;
};

type Transition = {
  from: StateId;
  to: StateId;
  roles: NonEmpty<RoleId>;
  ownerOnly: boolean;
  requireFields: readonly FieldName[];
};
```

Permissions are normalized into one shape per (entity, role, action), so emitters never handle the YAML's three spellings (`[read]`, `read: own`, `update: { own, in_states }`):

```ts
type Grant =
  | { kind: "deny" }
  | { kind: "all"; inStates?: NonEmpty<StateId> }
  | { kind: "own"; inStates?: NonEmpty<StateId> };

type Permissions = ReadonlyMap<EntityName, ReadonlyMap<RoleId, Record<CrudAction, Grant>>>;
```

`own` exists only on entities whose `ownership.kind` is `created_by`, and `inStates` exists only on entities with a workflow. `parse` enforces both, the types document them, and the emitters do not re-check them.

v1 fields (`files`, `when`, `notify`, `federation`, `staging`) never enter the `Model`. `parse` drops them and returns a warning, so no emitter can half-support them by accident.

Environments are `{ dev: Env; prod?: Env }` in the MVP. A missing `dev` cannot be represented.

### IR

The IR is the model rearranged into what each emitter consumes. It holds no new decisions, only derived facts:

- `tables`: Postgres table name, columns with SQL types, nullability, unique and foreign-key constraints, the workflow `status` column with a check constraint over the state ids, and the system columns (`id`, `created_at`, `updated_at`, `created_by`).
- `policies`: a flat, sorted list of `{ entity, role, action, scope, inStates }` rows. The generated permission guard and its unit tests are emitted from this one list.
- `transitions`: a flat list with a precomputed `forbiddenFor` role set per transition, so smoke and unit tests for negative RBAC (the 403 case) come from data and are not hand-written.
- `routes` and `pages`: list, detail, create and edit per entity, plus the "my pending items" inbox and the admin audit view.
- `audit`: enabled flag and the `audit_events` table definition.

Every collection in the IR is an array sorted by a stable key. No `Map` iteration order and no object key order is relied on during emission.

## Compiler stages

```
YAML text
  -> parseYaml        (yaml)                    boundary: syntax errors
  -> RawBlueprint     (Zod)                     boundary: shape errors
  -> Model            (parse: semantic checks)  boundary: domain errors, v1 warnings
  -> Ir               (lower, total)
  -> FileSet          (emit, pure)
  -> disk             (write, the only IO)
```

`emit(ir): FileSet` returns `ReadonlyArray<{ path: string; contents: string; zone: "managed" | "user" }>`, sorted by path. It is a pure function with no clock, no randomness, no environment and no filesystem reads. Templates are bundled as code, not read at runtime.

`write(fileSet, outDir)` is the only side effect. It overwrites `managed` files and creates `user` files only if they are absent. That makes `generate` idempotent: running it twice with the same blueprint changes nothing on disk, and it never touches `src/custom/**`.

The current `checkSemantics` is replaced by `parse`. `validate` becomes `parseYaml -> Zod -> parse` and prints the same issues. The existing fixture table keeps guarding the messages.

## Template strategy

Templates are TypeScript functions from an IR slice to a string, using tagged template literals. There is no string-template engine.

- **Next.js** (App Router, `output: "standalone"`). The generated routes live under `app/src/app/(generated)/`. Each entity gets list, detail and form pages, built from a small set of shared components that are copied once into `src/lib/(generated)/ui`. Server actions call one guard, `authorize(user, entity, action, row)`, generated from `policies`.
- **Drizzle.** `src/lib/(generated)/schema.ts` comes from `tables`. Migrations are generated SQL files with deterministic names (`0000_init.sql`), not `drizzle-kit generate` output, so the compiler stays pure and offline. Later blueprint changes produce new numbered migrations by diffing two IRs. That diffing is v1.
- **Workflow.** `src/lib/(generated)/workflows.ts` holds a transition table per entity. One server action, `transition(entity, id, transitionId)`, checks role, owner and separation of duties, plus required fields, inside one database transaction that also writes the audit event.
- **Audit log.** Every mutation goes through one `withAudit` helper that writes `{ actor, entity, entityId, action, before, after, at }` in the same transaction. There is no trigger-based auditing, so the actor is always the authenticated user.
- **Formatting.** Generated TS is printed with a pinned Prettier version as part of `emit`, so output is stable and readable without a post-processing step.

Templates live in `packages/templates`. The compiler imports them as plain functions, so `tsc` type-checks templates against the IR.

## Determinism and golden tests

- **Golden test.** `generate examples/approvals/blueprint.yaml` into a temp dir and compare every file byte for byte with `packages/compiler/test/golden/approvals/`. A `--update` script rewrites the goldens, and the diff is reviewed in the PR.
- **Repeatability test.** Run `emit(lower(parse(...)))` twice in one process and once in a fresh process, and assert identical `FileSet` hashes.
- **Order independence test.** Shuffle the order of entities, roles, fields and permission keys in the YAML, and assert the same output hash. This catches any reliance on input order.
- **Compile test (L1).** CI runs `tsc --noEmit`, ESLint and the generated Vitest suite inside the generated app.
- Generated files carry no timestamps or tool versions. The owninfra version appears once, in `owninfra.lock.json`, so a version bump is one visible diff line.

## Running the approvals example locally

```
npx owninfra init --example approvals   # copies examples/approvals/blueprint.yaml into ./approvals
cd approvals
npx owninfra generate                   # writes app/, docker-compose.yml, owninfra.lock.json
npx owninfra dev                        # docker compose up postgres, migrate, seed, next dev
```

- **Database.** `docker-compose.yml` runs Postgres 16. `dev` waits for health, applies the generated migrations, and loads `seed` (departments plus `seed.users` when `seed_users: true`).
- **Auth stub.** In production, Auth.js uses the Cognito OIDC provider. In `dev`, Auth.js uses a credentials provider that lists the seeded users and signs in as one with no password. Roles come from `seed.users[].roles`, the same claim shape that Cognito groups will produce. The stub provider is only emitted when `NODE_ENV !== "production"`, and the production build fails if it is configured.
- **Workflow.** You can walk the full approvals flow by switching users: requester creates and submits, manager approves, finance approves and marks paid. Trying `manager_approve` as the requester returns 403 from the same guard that production uses.
- **Audit log.** Every step above appears in the admin audit view, with before and after values.

No AWS account is needed for any of this.

## Decisions and tradeoffs

- **Hand-written migrations over drizzle-kit.** This keeps `emit` pure and offline. The cost is owning a small SQL emitter.
- **Tagged-template functions over Handlebars or EJS.** Templates are type-checked against the IR. The cost is that templates read as code, not markup.
- **One audit helper over database triggers.** The actor is known, and the behavior is testable in unit tests. The cost is that a raw SQL write bypasses auditing, so the generated app exposes no raw SQL path.
- **Dropping v1 fields at `parse`.** No partial support can leak in. The cost is that users see warnings for fields they wrote.

## Open questions

- Whether `generate` should refuse to run on a dirty git tree. The default is a warning.
- The Prettier version pin and how it is upgraded without breaking every golden at once.

## Week 1 plan

1. `Model` and `parse`, replacing `checkSemantics`, with the existing tests passing unchanged.
2. `Ir` and `lower`, with unit tests on `policies` and `transitions` for the approvals example.
3. `emit` for Drizzle schema and migrations, plus the golden test.
4. Next.js templates, auth stub and audit helper. Golden test updated, generated app passes `tsc`, lint and tests in CI.
5. `init`, `generate` and `dev`. Manual end-to-end walk of the approvals flow, recorded in the PR.
