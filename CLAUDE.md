# pieces-dev

pnpm monorepo for PiecesOS developer tools.

## Packages

- `packages/core` — shared PiecesOS client, event builder, port discovery
- `packages/ltm-injector` — VS Code extension for IDE workstream event capture
- `packages/gap-reconstruct` — CLI tool to backfill LTM gaps from multiple sources

## Commands

- `pnpm install` — install all dependencies
- `pnpm build` — build all packages
- `pnpm test` — run all tests
- `pnpm lint` — check formatting and lint rules
- `pnpm format` — auto-fix formatting

## Conventions

- TypeScript strict mode, ESM only
- Node 22+ (built-in fetch, no polyfills)
- Biome for formatting (not Prettier)
- Vitest for testing
- No `any` — use `unknown` + narrowing
- No barrel files except package entry points
