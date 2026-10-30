# 0001: Compiler architecture

Status: implemented in #3 and #4, and amended to match the merged code. Covers MVP week 1 (`init`, `generate`, `dev` for the approvals example). Deploy, the harness beyond L0, and the agent are out of scope here except where they constrain the shapes below.

## Context

Before week 1, `validate` parsed YAML into a Zod-inferred `Blueprint` and ran semantic checks on that same loose type. Every later stage would have to re-check what validation already proved: that a `ref` points at a real entity, that a transition's states exist, that `own` is only used with ownership. This note fixed the shapes and stages before any generator code was written.

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
  | { kind: "scalar"; name: FieldName; label: string; type: ScalarType; required: boolean; unique: boolean; constraints: ScalarConstraints }
  | { kind: "enum"; name: FieldName; label: string; values: NonEmpty<string>; default?: string; required: boolean }
  | { kind: "ref"; name: FieldName; label: string; target: EntityName; required: boolean };

type Entity = {
  name: EntityName;
  table: TableName;
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

- `entities`: per entity, the Postgres table name, display field, ownership flag, columns (SQL type, nullability, unique, foreign-key target, enum values, default and checks) and the workflow (states, transitions). The system columns (`id`, `created_at`, `updated_at`, `created_by`) and the workflow column's check constraint are added by the SQL emitter, not stored in the IR.
- `policies`: a flat, sorted list of `{ entity, role, action, scope, inStates }` rows. `registry.ts` carries this one list into the app, where the guard and its tests read it.
- Transitions: each workflow's list, sorted by id, with a precomputed `forbiddenFor` role set and a `forbidCreator` flag (separation of duties), so the generated app's negative RBAC tests (the 403 case, `guard.test.ts`) iterate data and are not hand-written.
- `seed` and `seedUsers`: seed rows per table, and the seed users for the auth stub.
- `audit`: the enabled flag. The `audit_events` table comes from the SQL and Drizzle emitters.

There are no routes or pages in the IR. Every entity is served by the dynamic `/e/[entity]` and `/e/[entity]/[id]` routes, which read `registry.ts`.

Every collection in the IR is an array. No `Map` iteration order and no object key order is relied on during emission.

### Which orders carry meaning

Some YAML orders are the author's intent and are preserved. The rest are sorted.

| Order | Meaning | Treatment |
| --- | --- | --- |
| Fields within an entity | Form order, list column fallback, SQL column order | Preserved |
| `list.columns` | Column order in the list view | Validated only; `list` is not carried into the `Model` yet |
| Workflow states | Display order of states, order of the SQL check constraint values | Preserved |
| Enum values | Option order in forms, SQL check order | Preserved |
| Entities | None | Sorted by name |
| Roles | None | Sorted by id |
| Transitions | None | Sorted by id |
| Permission keys (entity, role, action) | None | Sorted |
| Seed rows | Insert order (stable ids are not derived from it) | Preserved |
| Seed users | None | Sorted by email |

The order-independence test shuffles only the "None" rows. A shuffle of a preserved order is expected to change the output, and a separate test asserts that it does for fields.

Sorting compares strings by UTF-16 code unit (`a < b`), never `localeCompare`, so the result does not depend on the host locale or ICU version. `validateBlueprint` NFC-normalizes every string and key before Zod sees it, so visually identical input produces identical bytes. The repository and the generated app carry a `.gitattributes` with `* text=auto eol=lf`, and `emit` writes only `\n`.

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

`emit(ir): Promise<FileSet>` returns `ReadonlyArray<{ path: string; contents: string; zone: "generated" | "user" }>`, sorted by path. It is async only because Prettier's `format` is. It is a pure function with no clock, no randomness, no environment and no filesystem reads. Templates are bundled as code (`static-templates.ts`, written at build time), not read at runtime.

`write(fileSet, outDir)` is the only side effect. See Zones and the manifest below. Running `generate` twice with the same blueprint changes nothing on disk.

`checkSemantics` was replaced by `parse`. `validate` is `parseYaml -> Zod -> parse` and prints the same issues. The existing fixture table keeps guarding the messages.

## Template strategy

Most of the app is static template files, copied verbatim. Six files are computed from the IR by tagged-template functions in `emit.ts`: `docker-compose.yml`, `.gitattributes`, `app/drizzle/0000_init.sql`, `app/drizzle/seed.json`, `src/lib/(generated)/schema.ts` and `src/lib/(generated)/registry.ts`. The static code reads the blueprint at runtime through `registry.ts`. There is no string-template engine.

- **Next.js** (App Router, `output: "standalone"`). The generated routes live under `app/src/app/(generated)/` and `app/src/app/api/(generated)/`: one dynamic list page and one detail page serve every entity (`/e/[entity]`, `/e/[entity]/[id]`), plus the inbox and the admin audit view. Server actions and API routes go through the repository functions, which call one guard, `authorize(user, entity, action, row)` (and `readScope` for lists), reading `policies` from `registry.ts`.
- **Drizzle.** `src/lib/(generated)/schema.ts` comes from `entities`. Migrations are generated SQL files with deterministic names (`0000_init.sql`), not `drizzle-kit generate` output, so the compiler stays pure and offline. Later blueprint changes produce new numbered migrations by diffing two IRs. That diffing is v1.
- **Workflow.** Transitions live in `registry.ts`; there is no `workflows.ts`. `decideTransition` in `guard.ts` checks role, owner and separation of duties, plus required fields, and `transition(user, table, id, transitionId, input)` in `repository.ts` applies it inside one database transaction that also writes the audit event. The `transitionAction` server action and the transitions API route both call it.
- **Audit log.** Every mutation goes through one `withAudit` helper that writes `{ actor, entity, entityId, action, before, after, at }` in the same transaction. There is no trigger-based auditing, so the actor is always the authenticated user.
- **Formatting.** Generated TS is printed with Prettier as part of `emit`. Prettier is called with an explicit options object and `config: false` semantics (no `resolveConfig`, no `.prettierrc`, no `.editorconfig` lookup), so a config file in the user's tree cannot change the bytes. The exact Prettier version is a pinned (non-range) dependency of the compiler and is recorded in `owninfra.lock.json`. A Prettier upgrade is its own PR that bumps the pin and runs `pnpm goldens:update`, so the diff reviews as pure formatting.

Templates live in `packages/compiler/templates/`, split into `generated/` and `user/` zones. `tsc` type-checks them inside the generated app (the CI `generated-app` job) against `src/lib/(generated)/types.ts`, not against the IR.

## Determinism and golden tests

- **Golden test.** `generate examples/approvals/blueprint.yaml` into a temp dir and compare every file byte for byte with `packages/compiler/test/golden/approvals/`. `pnpm goldens:update` rewrites the goldens, and the diff is reviewed in the PR.
- **Repeatability test.** Run `emit(lower(parse(...)))` twice in one process and once in a fresh process, and assert identical `FileSet` hashes.
- **Order independence test.** Shuffle the orders that carry no meaning (entities, roles, transitions, permission keys) and assert the same output hash. Shuffling fields must change the hash.
- **Compile test (L1).** CI runs `tsc --noEmit`, ESLint and the generated Vitest suite inside the generated app.
- Generated files carry no timestamps or tool versions. The owninfra version appears once, in `owninfra.lock.json`, so a version bump is one visible diff line.


## Naming

All naming decisions live in `parse`, so `lower` stays total and emitters never rename.

- Table names are the snake_case plural of the entity (`PurchaseRequest` becomes `purchase_requests`, `Category` becomes `categories`). Column names are the field names, which the schema already restricts to lowercase snake case.
- Kebab-case ids (`my-requests`) are allowed for roles, states and pages but are rejected for field names, because they become SQL columns and TS properties.
- A table or column name that is a Postgres reserved word (`user`, `order`, `group`, `select` and the rest of the reserved list) is rejected with a message naming the word. Plurals are checked too (`users` is fine, `User` alone never becomes a table name).
- A table name plus the longest derived constraint name (`<table>_<column>_fkey`, `<table>_<column>_key`) must fit in Postgres's 63-byte identifier limit, or `parse` rejects it.
- Field names that clash with system columns (`id`, `created_at`, `updated_at`, `created_by`) are rejected.
- Table names starting with `pg_`, and the owninfra tables `audit_events` and `owninfra_meta`, are rejected.

Each rule has a fixture in `packages/cli/test/fixtures/invalid/` and a row in the fixture table.

## Zones and the manifest

Every path in the output has exactly one zone.

- **generated**: owned by `owninfra`. Everything inside an `app/src/**/(generated)/` folder, everything under `app/drizzle/`, and an explicit allowlist in `zones.ts`: `docker-compose.yml`, `.gitattributes`, the app's config files, `auth.ts`, `layout.tsx`, the Auth.js route, `next-auth.d.ts` and `src/lib/owninfra/index.ts`. Each text file starts with a do-not-edit header naming `owninfra generate` (JSON files, which cannot carry a comment, are listed in the manifest instead).
- **user**: owned by the developer. `app/src/custom/**`, `app/src/app/(custom)/**` and `blueprint.yaml`. A user path is never generated, even when it contains a `(generated)` folder. `generate` creates a user file only when it is absent and never overwrites or deletes one.

`emit` asserts that every file sits in its own zone, that no path is emitted twice, and that no two routes resolve to the same URL. These are compiler bugs, never silent overwrites. User pages live under `app/src/app/(custom)/`, a separate route group; `emit` reserves the generated URL prefixes (`/e`, `/inbox`, `/admin/audit`, `/api/e`, `/api/audit`, `/api/auth`) and rejects a user route under one of them.

`owninfra.lock.json` holds the owninfra version, the Prettier version, the IR hash, and a manifest of `{ path: sha256 }` for every generated file. `write` refuses any lock entry or output path outside the generated zone, or one that resolves elsewhere through a symlink or a case mismatch, and then reconciles against the manifest:

1. For each generated file already on disk, compare its hash with the manifest. A mismatch means it was hand-edited since the last generate, and `generate` refuses with the list of edited files unless `--force` is passed.
2. Write each file through a temp path and rename, skipping files whose bytes are already identical.
3. Delete orphans, meaning files listed in the previous manifest but absent from the new file set, if their hash still matches (an edited orphan is the same refusal as step 1).
4. Write the new manifest last.

A crash at any point leaves files whose hashes either match the old manifest or the new file set, so the next run converges. A dirty git tree is only a warning, and so is a stray file in a `(generated)` folder that owninfra did not write.

## User code API

User code imports only from `app/src/lib/owninfra`, a versioned surface (`export const apiVersion = 1`) that exposes the session helpers (`currentUser`, `requireUser`), the repository functions (`list`, `get`, `create`, `update`, `remove`, `transition`, `inbox`; the writes are audited, all are guarded), `HttpError`, the `registry` and the generated types. The raw database client lives in `(generated)/db.ts`, and the generated ESLint config has a `no-restricted-imports` rule that blocks `(generated)` modules, `postgres` and `drizzle-orm` from `src/custom/**` and `src/app/(custom)/**`. `generate` writes a sample user file, `src/custom/example.ts`, that uses the public API, and the CI `generated-app` job runs `tsc` over the generated app, so a breaking change to the API fails CI.

## Dev database drift

`dev` stores the hash of the IR it applied in a one-row `owninfra_meta` table. On start, if the stored hash differs from the current IR's, `dev` refuses with a message that names the change ("the blueprint changed since this database was created; run `owninfra dev --reset` to drop and recreate it") and does not touch the database. `--reset` drops and recreates the schema, migrates and seeds. With a matching hash, migrate and seed are no-ops, so `dev` can be restarted at will. Diffing IRs into incremental migrations is v1.

## Running the approvals example locally

owninfra is not on npm yet, so run the CLI from a clone (`alias owninfra="node $PWD/packages/cli/dist/bin.js"` after `pnpm install && pnpm build`):

```
owninfra init --example approvals   # copies examples/approvals/blueprint.yaml into ./approvals (or a dir you pass)
cd approvals
owninfra generate                   # writes app/, docker-compose.yml, owninfra.lock.json
owninfra dev                        # docker compose up postgres, migrate, seed, next dev
```

- **Database.** `docker-compose.yml` runs Postgres 16. `dev` waits for health, applies the generated migrations, and loads the seed rows (the departments). `seed.users` are not inserted: they are compiled into `registry.ts` for the auth stub.
- **Auth stub.** The stub is always emitted, so the output of `generate` never depends on `NODE_ENV` or any other environment. It is gated at runtime: Auth.js uses a credentials provider over `seed.users` only when `OWNINFRA_AUTH_STUB=1`, signing in as a seeded user with no password. Roles come from `seed.users[].roles`, the same claim shape Cognito groups will produce. Otherwise Auth.js uses the Cognito OIDC provider. `next.config` throws during `next build` when `OWNINFRA_AUTH_STUB` is set, and the auth module throws at startup when the stub is set and `NODE_ENV === "production"`, so a production artifact cannot carry an enabled stub.
- **Workflow.** You can walk the full approvals flow by switching users: requester creates and submits, manager approves, finance approves and marks paid. Trying `manager_approve` as the requester returns 403 from the same guard that production uses.
- **Audit log.** Every step above appears in the admin audit view, with before and after values.

No AWS account is needed for any of this.

## Decisions and tradeoffs

- **Hand-written migrations over drizzle-kit.** This keeps `emit` pure and offline. The cost is owning a small SQL emitter.
- **Static templates plus a generated registry over Handlebars or EJS.** Templates are ordinary TypeScript that `tsc` checks in the generated app. The cost is that the IR reaches the app as data (`registry.ts`), so a template that disagrees with the IR fails in the generated app's typecheck and tests, not in the compiler's.
- **One audit helper over database triggers.** The actor is known, and the behavior is testable in unit tests. The cost is that a raw SQL write bypasses auditing, so the generated app exposes no raw SQL path.
- **Dropping v1 fields at `parse`.** No partial support can leak in. The cost is that users see warnings for fields they wrote.

## Resolved questions

- Dirty git tree: a warning, not a refusal. The refusal is for hand-edited generated files (see the manifest), overridable with `--force`.
- Prettier upgrades: the version stays pinned, and an upgrade is a dedicated PR that regenerates the goldens with `pnpm goldens:update`.

## Week 1 plan

Done in #3 and #4.

1. `Model` and `parse`, replacing `checkSemantics`, with the existing tests passing unchanged.
2. `Ir` and `lower`, with unit tests on `policies` and `transitions` for the approvals example.
3. `emit` for Drizzle schema and migrations, plus the golden test.
4. Next.js templates, auth stub and audit helper. Golden test updated, generated app passes `tsc`, lint and tests in CI.
5. `init`, `generate` and `dev`. Manual end-to-end walk of the approvals flow, recorded in the PR.
