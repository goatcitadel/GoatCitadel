# Verification Runner Speed Audit - 2026-06-24

Status: review and repair plan. This document audits why GoatCitadel's
verification runner feels slow, especially `pnpm verify:fast`, and gives a safe
implementation plan for reducing wall-clock time without weakening release
proof.

## Executive Summary

The verification runner is slow mostly because the fast lane is a serial list
of heavyweight `pnpm` commands, not because `scripts/verification/run.mjs` has
large hidden overhead. Recent passing fast-lane artifacts average **219.3s**.
The average scenario cost is:

| Scenario group | Average wall time | Share of fast lane | Main cause |
|---|---:|---:|---|
| `fast.test` | 125.7s | 57.3% | Root workspace tests run with `--workspace-concurrency=1`; gateway and storage dominate. |
| `fast.smoke` | 40.8s | 18.6% | Full gateway smoke startup plus duplicated extensions SDK build. |
| `fast.typecheck` | 16.4s | 7.5% | Root serial typecheck and repeated `mission-control-next` dependency builds. |
| `fast.build` | 18.0s | 8.2% | Full root build after typecheck and tests have already built/compiled parts of the repo. |
| Extensions SDK build/package | 14.5s | 6.6% | SDK build is run directly, again for package verification, again before gateway tests, and again before smoke. |
| Cheap checks | 3.9s | 1.8% | Skills, repo hygiene, storage migration parity, docs. |

The fastest safe win is not blind parallelism. The safe win is to split the
monolithic fast lane into dependency-aware stages, remove repeated builds, and
run independent test groups in bounded parallel while preserving the same
proof surface.

## Evidence Reviewed

| Evidence | Finding |
|---|---|
| `scripts/verification/lib/scenarios.mjs:96` | `FAST_LANE_COMMANDS` defines ten independent shell commands. |
| `scripts/verification/lib/scenarios.mjs:280` | `runFastLane` executes those commands in a `for` loop with `await`, so all fast scenarios are serial. |
| `scripts/verification/lib/scenarios.mjs:112` | `fast.test` runs `pnpm -r --workspace-concurrency=1 test`, serializing all workspace tests. |
| `package.json:119` | Root `typecheck` also forces `--workspace-concurrency=1`. |
| `package.json:70` | `verify:extensions:package` runs `pnpm --filter @goatcitadel/extensions-sdk build` even though `fast.extensions-sdk-build` already ran. |
| `apps/gateway/package.json:48` | Gateway `pretest` rebuilds `@goatcitadel/extensions-sdk`. |
| `apps/gateway/package.json:54` | Gateway `presmoke` rebuilds `@goatcitadel/extensions-sdk` again. |
| `apps/mission-control-next/package.json:7` | `build:deps` rebuilds `mission-control-shared` and `threaded-surface-core`. |
| `apps/mission-control-next/package.json:10` and `:18` | `mission-control-next` runs `build:deps` during both build and typecheck. |
| `scripts/verification/lib/scenarios.mjs:356` | Fast-lane commands receive separate per-scenario temp/cache roots; useful for isolation, but it prevents sharing command-local cache state. |
| `scripts/verification/lib/runtime.mjs:15` | Runtime scenarios copy config/skills/workspaces into temp roots; this is correct for isolation but should be avoided for pure compile/test scenarios. |

## Recent Timing Data

These timings came from local verification manifests already present under
`artifacts/verification`. They show the cost shape is consistent across green
runs.

| Run | Status | Total | Test | Smoke | Typecheck | Build | SDK build | SDK package |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `2026-06-18T23-45-10-524Z-fast-36ee517a` | passed | 196.9s | 110.2s | 40.5s | 11.9s | 16.7s | 6.3s | 7.0s |
| `2026-06-19T03-15-34-739Z-fast-471d1139` | passed | 234.9s | 143.4s | 42.0s | 12.6s | 18.4s | 6.9s | 7.4s |
| `2026-06-19T03-24-25-970Z-fast-0595063c` | passed | 255.2s | 157.2s | 42.8s | 15.0s | 18.7s | 8.0s | 7.8s |
| `2026-06-24T23-36-04-575Z-fast-b9719d7d` | passed | 189.1s | 100.7s | 39.8s | 14.5s | 17.1s | 7.3s | 6.6s |
| `2026-06-24T23-53-45-685Z-fast-d6bff4f0` | passed | 225.6s | 116.7s | 39.9s | 32.7s | 18.1s | 6.9s | 7.7s |
| `2026-06-24T23-59-12-121Z-fast-ed40a000` | passed | 218.2s | 128.5s | 40.0s | 13.7s | 18.9s | 6.7s | 7.3s |
| `2026-06-25T00-04-11-153Z-fast-5c622a48` | passed | 215.4s | 123.1s | 40.6s | 14.3s | 18.5s | 7.8s | 7.7s |

Average: **219.3s** total, **125.7s** in root tests, **40.8s** in smoke.

## Package-Level Timing Notes

From `fast.test.stdout.log` for
`artifacts/verification/2026-06-25T00-04-11-153Z-fast-5c622a48`:

| Package | Reported test duration | Notes |
|---|---:|---|
| `@goatcitadel/gateway` | 54.48s | Largest Vitest package; also runs gateway `pretest` first. |
| `@goatcitadel/storage` | 25.76s | Node SQLite test suite; many subtests are 200-400ms each. |
| `@goatcitadel/mission-control-next` | 11.62s | UI test set with import/setup cost. |
| `@goatcitadel/mission-control-shared` | 7.29s | Medium Vitest suite. |
| `@goatcitadel/policy-engine` | 4.33s | Medium Vitest suite. |
| `@goatcitadel/threaded-surface-core` | 2.82s | Medium-small Vitest suite. |
| Other package tests | <2s each | Not the speed problem. |

Because the root test command uses `--workspace-concurrency=1`, these durations
are additive. The current design makes the slowest package times block all
independent package work.

## Root Causes

### 1. Fast lane is a serial shell-command list

`runFastLane` loops over `FAST_LANE_COMMANDS` and awaits each scenario before
starting the next. That makes the fast lane almost exactly the sum of its
scenario durations. This is simple and stable, but it leaves no room for safe
parallelism among independent checks.

Impact: even cheap independent checks, docs checks, SDK package checks, and
some test groups cannot overlap with gateway/storage tests.

### 2. Root test command serializes all workspace packages

`fast.test` runs:

```bash
pnpm -r --workspace-concurrency=1 test
```

That was likely chosen for determinism, but it means a 54s gateway suite, a 26s
storage suite, a 12s UI suite, and several small suites run one after another.

Impact: `fast.test` is the largest blocker at 100-157s on recent green runs.

### 3. Extensions SDK is rebuilt repeatedly

The fast lane runs:

```bash
pnpm --filter @goatcitadel/extensions-sdk build
pnpm verify:extensions:package
```

Then gateway `pretest` and `presmoke` each run the same SDK build again.

Impact: the fast lane pays roughly four SDK-build starts. Recent direct
SDK build/package scenarios alone average 14.5s; gateway pretest/presmoke add
more hidden cost inside `fast.test` and `fast.smoke`.

### 4. Typecheck/build work overlaps

Root `typecheck` and root `build` both traverse most workspaces. In addition,
`mission-control-next` runs `build:deps` during both typecheck and build.

Impact: compile proof is correct, but it repeats dependency builds in a way the
runner does not model or reuse.

### 5. Fast smoke is full smoke, not a fast smoke slice

`fast.smoke` runs the root `smoke` command, which enters the gateway smoke
suite and exercises health, events, sessions, chat, prompt packs, tools,
native tools, approvals, agents, integrations, secrets, mesh, NPU, and
onboarding.

Impact: it is valuable release proof, but it costs about 40s and is always in
the fast lane. The runner has no cheaper first-pass smoke subset.

### 6. Failed runs keep paying for later heavyweight scenarios

The runner records scenario failures and continues. That is useful for full
evidence, but local repair loops often need first-failure feedback.

Impact: a typecheck failure can still be followed by root tests, smoke, build,
and docs unless the operator manually stops the run.

### 7. No performance budget or regression guard

The manifest records scenario durations, but there is no budget that flags
when `fast.test` grows from 100s to 150s, or when total fast time crosses an
agreed threshold.

Impact: the runner can drift slower without a red/yellow signal.

## Recommended Fix

Do not replace the current runner with broad unbounded concurrency. Preserve
the current proof lane and add an explicitly modeled fast-lane DAG with bounded
parallel groups, shared one-shot builds, and a fail-fast option.

### P0 - Add speed observability and budgets

Purpose: make speed measurable before changing execution order.

Implementation:

1. Add `scripts/verification/lib/perf-budget.mjs`.
2. Teach `finalizeRunContext` or `runFastLane` to write
   `perf/fast-lane-timing.json` with:
   - total duration
   - per-scenario duration
   - average from a checked-in baseline
   - budget status: `passed`, `warn`, or `failed`
3. Add a non-blocking default budget first:
   - `fast.total.warn`: 240s
   - `fast.total.fail`: 300s
   - `fast.test.warn`: 135s
   - `fast.smoke.warn`: 45s
4. Add `GOATCITADEL_VERIFY_PERF_BUDGET=strict` for CI promotion later.

Expected result: no runtime risk, immediate visibility, and a way to prevent
future slow drift.

### P1 - Remove repeated SDK builds

Purpose: keep SDK proof while avoiding four builds.

Implementation:

1. Add an environment flag recognized by gateway package scripts:

   ```bash
   GOATCITADEL_SKIP_EXTENSIONS_SDK_PREBUILD=1
   ```

2. Change gateway `pretest` and `presmoke` to skip SDK rebuild when that env
   var is set. Keep default local behavior unchanged.
3. In `runFastLane`, run `fast.extensions-sdk-build` once before gateway test
   and smoke scenarios.
4. Pass `GOATCITADEL_SKIP_EXTENSIONS_SDK_PREBUILD=1` to `fast.test` and
   `fast.smoke`.
5. Split `verify:extensions:package` into:
   - `verify:extensions:package:from-build`: verifies existing `dist`
   - current `verify:extensions:package`: keeps build + verify for standalone use
6. Make `fast.extensions-sdk-package` call the from-build variant after the
   one SDK build has succeeded.

Expected result: save about 10-20s in fast runs without dropping SDK package
proof.

### P2 - Split root tests into bounded parallel groups

Purpose: keep the same tests but stop making all packages wait for gateway and
storage.

Implementation:

1. Replace `fast.test` with explicit scenario groups:

   | Scenario | Command | Concurrency guidance |
   |---|---|---|
   | `fast.test.gateway` | `pnpm --filter @goatcitadel/gateway test` | single package; keep isolated |
   | `fast.test.storage` | `pnpm --filter @goatcitadel/storage test` | single package; keep isolated because SQLite-heavy |
   | `fast.test.ui` | `pnpm --filter @goatcitadel/mission-control-next test` | can run with libraries |
   | `fast.test.policy` | `pnpm --filter @goatcitadel/policy-engine test` | can run with libraries |
   | `fast.test.libraries` | contracts, SDK, memory, shared, orchestration, skills, gateway-core, mesh-core, threaded-surface-core | safe bounded parallel group |

2. Add a runner helper:

   ```js
   runScenarioGroup(context, { id, mode: "parallel", concurrency: 3 }, scenarios)
   ```

3. In local profile, run independent groups with concurrency 2-3.
4. Keep a `GOATCITADEL_VERIFY_SERIAL=1` escape hatch that preserves the current
   serial behavior for debugging.
5. Keep each package result as a separate scenario in the manifest so failure
   attribution improves.

Expected result: reduce `fast.test` from about 125s to roughly the max of
gateway/storage/UI plus overhead, likely 60-80s locally.

### P2 - Add local fail-fast mode

Purpose: shorten repair loops without reducing CI evidence by default.

Implementation:

1. Add CLI/env:

   ```bash
   node scripts/verification/run.mjs fast --fail-fast
   GOATCITADEL_VERIFY_FAIL_FAST=1 pnpm verify:fast
   ```

2. When enabled, stop the lane after any failed required scenario.
3. Still finalize manifest and summary.
4. Keep default CI behavior as collect-all unless the workflow opts in.

Expected result: failed local runs stop after the first real blocker instead
of paying for later heavyweight checks.

### P3 - Split fast smoke from full smoke

Purpose: keep smoke proof but avoid running the full gateway smoke suite on
every fast-loop invocation.

Implementation:

1. Add a gateway smoke CLI profile:

   ```bash
   pnpm --filter @goatcitadel/gateway smoke --profile fast
   pnpm --filter @goatcitadel/gateway smoke --profile full
   ```

2. Put health, events, sessions, chat, prompt packs, tools, approvals, and
   secrets in `fast`.
3. Move mesh, NPU, integrations, onboarding, and long-tail expansion checks to
   `full`, `runtime-truth`, or named release lanes.
4. Keep `pnpm verify:fast` on the fast profile and make release-proof
   workflows run the full profile.

Expected result: reduce `fast.smoke` from about 40s to an estimated 15-25s
while preserving full smoke as release evidence.

### P3 - De-duplicate typecheck/build dependency work

Purpose: keep compile proof while avoiding repeated `build:deps`.

Implementation:

1. Add `mission-control-next` scripts:

   ```json
   "typecheck:no-build-deps": "tsc -b tsconfig.json tsconfig.node.json",
   "build:no-build-deps": "tsc -b tsconfig.json tsconfig.node.json && vite build"
   ```

2. In the fast runner, run shared/threaded builds once before the UI
   typecheck/build scenarios.
3. Keep current package scripts as standalone safe defaults.
4. Use runner-only from-build/no-build-deps variants after prerequisites are
   recorded in the manifest.

Expected result: save a few seconds and make compile dependencies explicit in
the manifest.

## Proposed Fast-Lane Shape

Target shape after P1-P3:

```text
stage 1: cheap guards in parallel
  - skills catalog
  - repo hygiene
  - storage migration parity
  - docs

stage 2: prerequisite builds in parallel
  - extensions SDK build
  - shared/threaded deps build

stage 3: tests in bounded parallel
  - gateway
  - storage
  - UI
  - policy
  - libraries

stage 4: package/build/smoke proof
  - extensions package from existing build
  - typecheck/build variants that reuse stage 2 outputs
  - fast smoke profile
```

Expected fast-lane target:

| Milestone | Expected total |
|---|---:|
| Current average | 219s |
| After P1 SDK de-dup | 200-205s |
| After P2 test grouping | 140-170s |
| After P3 smoke split and build de-dup | 110-140s |

Do not promise sub-60s fast verification without removing proof from the fast
lane. The current test and smoke surface is too large for that target on local
hardware.

## Acceptance Criteria

| Fix lane | Acceptance proof |
|---|---|
| P0 budgets | `pnpm verify:fast` writes timing budget data into the artifact and keeps the existing summary/JUnit output. |
| P1 SDK de-dup | Fast lane builds SDK once, gateway test/smoke skip redundant prebuilds, and standalone `pnpm --filter @goatcitadel/gateway test` still builds SDK by default. |
| P2 test grouping | Manifest shows separate package test scenarios; all existing package tests still run; `GOATCITADEL_VERIFY_SERIAL=1` matches old behavior. |
| P2 fail-fast | `--fail-fast` stops after first failed required scenario and still writes a valid failed manifest. |
| P3 smoke split | Fast smoke remains green; full smoke remains available and documented for release proof. |
| P3 compile de-dup | Shared/threaded builds are recorded once as prerequisites before no-build-deps UI compile/build variants run. |

## Risks And Guardrails

| Risk | Guardrail |
|---|---|
| Parallel tests reveal hidden shared temp/cache coupling | Keep storage and gateway isolated first; only parallelize libraries/UI with bounded concurrency. |
| Faster fast lane accidentally weakens release proof | Keep full smoke and current standalone scripts; only the runner uses prerequisite-aware variants. |
| Debugging gets harder with parallel output | Preserve per-scenario stdout/stderr logs and manifest records. |
| CI/local behavior diverges too much | Add explicit profile/env flags and keep serial escape hatch. |
| Build artifacts become stale | Make prerequisite stages required and manifest-visible before from-build variants execute. |

## Bottom Line

The verification runner is slow because the fast lane is actually a full serial
compile/test/smoke/build proof lane. The runner should become dependency-aware:
build shared prerequisites once, split root tests into manifest-visible package
scenarios, run safe groups in bounded parallel, add fail-fast for repair loops,
and keep full release proof available outside the local fast feedback path.
