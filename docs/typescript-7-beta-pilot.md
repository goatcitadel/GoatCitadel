# TypeScript 7 Beta Pilot

This repo runs TypeScript 7 beta as an explicit side-by-side pilot.

TypeScript 6 remains the default workspace compiler and the `typescript` package that API consumers and TS-aware tooling import. The TS7 pilot is compiler-only and is intentionally isolated to root commands so it can be rolled back cleanly.

## Commands

- `pnpm ts7:typecheck`
  Runs the TS7 beta compiler in no-emit mode across the explicit workspace project groups:
  - `gateway`
  - `mission-control`
  - `mission-control-next`
- `pnpm ts7:build`
  Runs TS7 beta build mode for the same project groups. This validates TS project-reference builds only; it does not invoke Vite or other non-TS bundlers.
- `pnpm ts7:benchmark`
  Compares a representative TS6 command set against the TS7 pilot and writes benchmark artifacts under `artifacts/typescript/ts7-beta/`.

## What Stays on TypeScript 6

- Direct `typescript` API consumers, including:
  - `apps/gateway/src/services/capability-system-service.ts`
  - `scripts/coverage-collect.mjs`
- `typescript-eslint`
- `tsx`
- Existing package-local `tsc -b` scripts
- Existing verification and release lanes

## Benchmark Artifacts

`pnpm ts7:benchmark` writes:

- `artifacts/typescript/ts7-beta/summary.json`
- `artifacts/typescript/ts7-beta/summary.md`
- per-run logs in `artifacts/typescript/ts7-beta/logs/`

The benchmark currently measures:

- repo-wide typecheck
- gateway build
- Mission Control typecheck

Each TS6/TS7 command gets one warm-up run and three measured runs. The report records medians, delta percent, and speedup multiplier.

## Reading Results

- Treat TS7 results as experimental until the repo explicitly promotes TS7 beyond the pilot.
- A meaningful win is a consistent median reduction across measured runs, not a single fast outlier.
- If TS7 is faster but introduces compiler/config friction elsewhere, keep TS6 as the default and use the benchmark artifacts to decide when to revisit the migration.
