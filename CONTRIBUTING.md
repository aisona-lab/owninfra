# Contributing

Requirements: Node 20+ and pnpm 9.

```sh
pnpm install
pnpm build
pnpm lint
pnpm test
```

- Open an issue before large changes, especially anything that touches the blueprint schema.
- Every change ships with tests. Schema changes regenerate `packages/blueprint-schema/blueprint.schema.json` via `pnpm build` and must keep `examples/` valid.
- The compiler stays deterministic: no LLM calls outside `packages/agent`.
- Stack decisions are recorded as ADRs in `docs/adr/`.

By contributing you agree your work is licensed under Apache-2.0.
