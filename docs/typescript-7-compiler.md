# TypeScript 7 Compiler

GoatCitadel uses the TypeScript 7.1 beta for workspace builds and Gateway Code Mode. The root TypeScript 6 API package still supports lint and verification tooling.

## Toolchain Layout

- `typescript-7` is pinned to `npm:typescript@7.1.0-beta` and provides the default `tsc` binary.
- `typescript` is pinned to `npm:@typescript/typescript6@6.0.2` so API consumers and TypeScript-aware tooling still resolve the stable TS6 API surface.
- `apps/gateway` declares the same beta as a production dependency. Code Mode uses its async API for source validation and isolated TypeScript emit.
- `pnpm ts7:toolchain` verifies that `tsc` resolves to TS7, `tsc6` resolves to TS6, and `import "typescript"` resolves to the TS6 API package.

## Commands

- `pnpm ts7:toolchain`
  Checks the compiler/API split described above.
- `pnpm ts7:typecheck`
  Runs the pinned TS7 compiler across the explicit workspace project groups:
  - `gateway`
  - `mission-control-next`
- `pnpm ts7:build`
  Runs the same TS7 project-reference graph as an explicit build validation lane.
- `pnpm ts7:benchmark`
  Compares TS6 compatibility compiler runs against TS7 compiler runs and writes benchmark artifacts under `artifacts/typescript/ts7/`.

`ts7:typecheck` and `ts7:build` both use `tsc -b` project-reference mode. Composite project references reject `--noEmit`, so these commands may refresh ignored `dist/` and `.tsbuildinfo` outputs.

The benchmark defaults to one warm-up run and one measured run per compiler variant so the CI lane stays bounded. Use `TS7_BENCHMARK_MEASURED_RUNS=3` for a deeper local comparison, or `TS7_BENCHMARK_WARMUP_RUNS=0` when you need a quick smoke-only timing check.

During `pnpm dev`, `GOATCITADEL_DEV_WORKSPACE_TSC_GRAPH=1` routes the bootstrap/reference build through the shared TS7 workspace graph runner. The older `GOATCITADEL_DEV_TS7=1` name is still accepted as a compatibility alias, but TS7 is already the default `tsc`.

## What Stays on the TS6 API

- Direct `typescript` API consumers, including:
  - `scripts/coverage-collect.mjs`
  - `scripts/verification/lib/architecture-metrics.mjs`
- `typescript-eslint`
- Other TypeScript-aware tools until they declare TS7 API support.

## Benchmark Artifacts

`pnpm ts7:benchmark` writes:

- `artifacts/typescript/ts7/summary.json`
- `artifacts/typescript/ts7/summary.md`
- per-run logs in `artifacts/typescript/ts7/logs/`

The benchmark currently measures:

- workspace compiler graph
- gateway build
- Mission Control typecheck

Each TS6/TS7 command gets one warm-up run and one measured run by default. The report records medians, delta percent, and speedup multiplier, and includes the configured warm-up/measured run counts.

## Reading Results

- Treat benchmark output as performance evidence, not as a replacement for required release verification lanes.
- A meaningful win is a consistent median reduction across measured runs, not a single fast outlier.
- Remove `@typescript/typescript6` after `typescript-eslint` and the remaining verification scripts work with the TS7 API.
