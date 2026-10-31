# Eval cases

Each folder holds one `blueprint.yaml` with a known defect and the level of the harness that must catch it. Earlier levels
must pass, so a case also shows that the level before it cannot see the defect.

| Case | Caught at | Passes before that | Expected failure |
|---|---|---|---|
| `l0-decimal-out-of-range` | L0 `validate` | (none) | `entities[1].fields[3].min: min 100 of 'cost' is outside what numeric(4, 2) can hold: -99.99 to 99.99` |
| `smoke-unreachable-ref` | `owninfra smoke` | validate, generate, app tsc/eslint/vitest, migrate and seed, synth with cdk-nag and the idle-cost guard, boot, sign-in | `smoke: failed at 'crud assets: create as keeper@example.com'`: `locations has no row for 'location' to point at` |

`packages/cli/test/evals.test.ts` checks the L0 message and that the smoke-only case passes validate, generate and the
infra checks. The CI `smoke` job runs `owninfra smoke` on `smoke-unreachable-ref` and requires that exact failed step.

## Why `smoke-unreachable-ref` fails only at smoke

Every Asset must point at a Location (`location: ref, required`). In this blueprint no role has `create` on Location
and the seed has no Location rows, so a running app can never hold a Location and so can never create an Asset. Each
rule is valid on its own: the ref resolves, the roles and permissions exist, the seed is well formed. L0 checks those
rules one at a time and does not ask whether the permissions and seeds together leave a way to obtain a row, and
nothing after L0 (generate, type checks, synth, cdk-nag) looks at data at all. `owninfra smoke` finds it because it
tries: it signs in as each seed user, finds no one who may create a Location, finds none to list, and cannot fill the
required ref when it creates an Asset. (L0 could learn this rule later; then the case moves to L0 and needs a successor.)

The cost case used to be the smoke-only example (a numeric(4, 2) column with min 100 failed at the first create with
422). L0 now rejects it, so it is recorded here as an L0 case.

## Accepted limits of the generic smoke level

- A field with a format rule (`pattern`) needs a seed row: smoke builds its value by changing one character of a seeded
  value, and fails with a request for a seed row when there is none.
- Update changes one text or number field per entity (the first string or text field, else another scalar); enums and
  refs are not updated.
- Workflow transitions are exercised only in the approvals scenario (`packages/cli/src/smoke-approvals.ts`); the generic
  level checks the initial state of a new row and state-limited update and delete rules, not transitions.
