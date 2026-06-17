# TypeScript Revival Inventory

Last updated: 2026-06-17

This is a read-only inventory for a gradual TypeScript revival lane. It is not a refactor plan to land all at once. The goal is to make future changes boring, reviewable, observable, type-safe, and easy to roll back.

## Repository Summary

GoatCitadel is a pnpm TypeScript monorepo for a local-first AI operations console.

- Package manager: `pnpm@10.31.0`, declared in root `package.json`.
- Primary runtime: Node.js 22 in CI, with a Fastify Gateway under `apps/gateway`.
- Primary UI: Vite + React Mission Control shell under `apps/mission-control-next`.
- Desktop surfaces: Tauri-style Mission Control desktop package under `apps/mission-control-desktop`, plus native Windows project scripts outside the TypeScript workspace.
- Shared packages: contracts, storage, policy engine, memory, mesh, skills, orchestration, extensions SDK, Mission Control shared UI/API code, and threaded surface core.
- Validation library already present: `zod`.
- Source scale from `rg --files apps packages scripts -g '*.ts' -g '*.tsx'`: 2,211 TypeScript/TSX files.
- Test/spec scale from `rg --files ... -g '*.test.ts' -g '*.test.tsx' -g '*.spec.ts' -g '*.spec.tsx'`: 998 test/spec files.

Product ownership boundaries from `AGENTS.md` remain important:

- Gateway owns runtime APIs, orchestration, approvals, memory, integrations, audit, policy, realtime events, and persistence coordination.
- Mission Control is an API client and should not bypass Gateway-owned runtime state.
- Policy, approvals, path jails, tool grants, deny-wins behavior, and durable evidence must not be weakened by cleanup work.
- Code Mode must not be described as hostile-code sandboxing unless current proof supports that claim.

## Existing Commands Discovered

Root-level commands:

- `pnpm dev`
- `pnpm build`
- `pnpm test`
- `pnpm lint`
- `pnpm lint:fix`
- `pnpm format`
- `pnpm format:check`
- `pnpm typecheck`
- `pnpm docs:check`
- `pnpm smoke`
- `pnpm verify:fast`
- `pnpm verify:runtime:truth`
- `pnpm verify:durable:recovery`
- `pnpm verify:desktop`
- `pnpm verify:surface:regression`
- `pnpm verify:visual:regression`
- `pnpm coverage:collect`
- `pnpm coverage:gate`
- `pnpm coverage:gate:production`
- `pnpm ts7:typecheck`
- `pnpm ts7:build`
- `pnpm ts7:benchmark`

Important package commands:

- `@goatcitadel/gateway`: `dev`, `build`, `typecheck`, `test`, `test:coverage`, `smoke`, `doctor`, `admin`, `config:sync`
- `@goatcitadel/mission-control-next`: `dev`, `build`, `typecheck`, `test`, `perf:check`, route/style guard checks
- `@goatcitadel/storage`: `build`, `typecheck`, `test`, `test:postgres`, `test:coverage`
- Most packages expose `build`, `typecheck`, `test`, and `test:coverage`.

## TypeScript and Lint Configuration

Root `tsconfig.base.json` is already strict:

- `strict: true`
- `noUncheckedIndexedAccess: true`
- `noImplicitOverride: true`
- `verbatimModuleSyntax: true`
- `skipLibCheck: false` at the base level
- `composite: true`
- `declaration: true`

Package-specific notes:

- Browser-facing packages use `moduleResolution: Bundler`.
- `apps/mission-control-next`, `packages/mission-control-shared`, and `packages/threaded-surface-core` set `skipLibCheck: true`.
- Some tests are excluded from package typecheck configs, so test-only unsafe typing is not always covered by the package build.
- The repo has an experimental TypeScript 7 beta pilot workflow and scripts.

Root ESLint is flat config with:

- `@eslint/js` recommended rules.
- `typescript-eslint` recommended rules.
- Prettier compatibility.
- React Hooks rules scoped to Mission Control packages.
- `@typescript-eslint/no-explicit-any` as a warning for production TS/TSX, disabled for tests.
- `max-lines` warning at 1000 lines, disabled for tests.

## Current Health Snapshot

Commands were run from `main` on branch `codex/typescript-revival-inventory`.

### Passing

- `pnpm typecheck`
  - Passed across 14 workspace projects.
- `pnpm -r --workspace-concurrency=1 build`
  - Passed across 14 workspace projects.
  - Vite emitted browser-compatibility warnings for `node:crypto` imports from `packages/contracts/dist/citadel-vault.js`, but the build completed.

### Failing On Current Main

- `pnpm lint --max-warnings 0`
  - Failed in `apps/gateway/src/services/provider-secret-persistence.ts:63`.
  - Error: `preserve-caught-error` reports that a thrown symptom error does not attach the caught cause.

- `pnpm docs:check`
  - Failed governance doc validation due release-surface route drift.
  - Missing canonical routes include `/library/citadel`, `/library/citadel-overview`, `/library/citadel-wards`, `/library/citadel-council`, `/library/citadel-blueprint`, and `/library/citadel-vault`.
  - Route totals in `docs/1_0_RELEASE_EVIDENCE.md` and `README.md` expect 44/39 while validation expects 50/45.
  - `scripts/verification/lib/release-surface-manifest.mjs` is missing the same canonical routes.

- `pnpm -r --workspace-concurrency=1 test`
  - Stopped at `@goatcitadel/contracts`.
  - `apps/mission-control-desktop` passed: 1 file, 17 tests.
  - `@goatcitadel/contracts` failed 2 tests:
    - `provider-templates.test.ts`: expected 21 built-in provider profiles, received 20.
    - `follow-on-parity.alignment.test.ts`: actual recommended order includes `GC-P2-13` not present in `FOLLOW_ON_PARITY_RECOMMENDED_ORDER`.

## Existing CI

Key workflows:

- `.github/workflows/code-quality.yml`
  - Runs `pnpm lint --max-warnings 0`, `pnpm typecheck`, and Mission Control CSS guards.
- `.github/workflows/verification-fast.yml`
  - Runs lint, Playwright Chromium install, docs checks, fast verification, real Postgres storage tests, production coverage gate, and artifact redaction.
- `.github/workflows/verification-docs-check.yml`
  - Runs `pnpm docs:check`.
- `.github/workflows/typescript-7-beta-pilot.yml`
  - Runs experimental TypeScript 7 benchmark on TS/config changes.
- Additional verification workflows cover release proof, A2A, Code Mode, API compatibility, backup roundtrip, catalog parity, durable recovery, operator proof, soak, surface regression, truth lanes, and visual regression.

Current implication: several CI lanes are likely blocked by existing lint, docs, and contracts-test drift before any deeper cleanup starts.

## Major Entry Points

Gateway and runtime:

- `apps/gateway/src/app.ts`
- `apps/gateway/src/routes/**`
- `apps/gateway/src/services/**`
- `apps/gateway/src/dev-supervisor.ts`
- `apps/gateway/src/admin-cli.ts`
- `apps/gateway/src/doctor/cli.ts`
- `apps/gateway/src/tui/main.ts`
- `apps/gateway/src/smoke.ts`

Mission Control:

- `apps/mission-control-next/src/app/MissionControlNextApp.tsx`
- `apps/mission-control-next/src/features/**`
- `packages/mission-control-shared/src/api/**`
- `packages/mission-control-shared/src/components/**`
- `packages/mission-control-shared/src/hooks/**`
- `packages/threaded-surface-core/src/**`

Core packages:

- `packages/contracts/src/**`
- `packages/storage/src/**`
- `packages/policy-engine/src/**`
- `packages/extensions-sdk/src/**`
- `packages/memory-core/src/**`
- `packages/mesh-core/src/**`
- `packages/orchestration/src/**`
- `packages/skills/src/**`

Release and verification:

- `scripts/verification/**`
- `.github/workflows/**`
- `scripts/packaging/**`
- root `bin/goatcitadel.mjs`

## Highest-Risk Areas

### Current health blockers

These should be fixed before deeper refactors:

- Lint failure in provider secret persistence error wrapping.
- Docs/release surface route drift.
- Contracts test drift around provider profile count and follow-on parity order.

### Large modules with high cognitive load

Largest source modules by line count include:

- `apps/gateway/src/services/chat-agent-orchestrator.ts` - 11,957 lines.
- `apps/mission-control-next/src/features/native-routes/SettingsNativePage.tsx` - 9,681 lines.
- `apps/gateway/src/services/prompt-pack-service.ts` - 9,281 lines.
- `apps/gateway/src/services/gateway-service.ts` - 9,124 lines.
- `packages/storage/src/sqlite.ts` - 6,167 lines.
- `packages/policy-engine/src/tool-executor.ts` - 5,906 lines.
- `apps/gateway/src/services/improvement-service.ts` - 5,737 lines.
- `packages/threaded-surface-core/src/MissionThreadedControllerHost.tsx` - 3,609 lines.
- `apps/gateway/src/services/llm-service.ts` - 3,271 lines.
- `apps/gateway/src/services/memory-lifecycle-service.ts` - 3,206 lines.

These are not immediate refactor targets. They need characterization coverage first.

### Type debt patterns

Pattern counts across `apps`, `packages`, and `scripts` source files:

- `as any`: 712 matches.
- `as unknown as`: 872 matches.
- `@ts-ignore` / `@ts-expect-error`: 1 match.
- `JSON.parse`: 325 matches.
- `Record<string, any>`: 9 matches.
- `forEach(async ...)`: 0 matches.
- Broad risk-pattern file hits: 637 files.

Production clusters worth follow-up:

- Storage repositories: `packages/storage/src/code-mode-run-repo.ts`, `packages/storage/src/sqlite.ts`, `packages/storage/src/learned-memory-repo.ts`.
- Gateway route/service boundaries: route access, A2A, approvals, durable runs, runtime lifecycle hooks, capability packs.
- External parsing and API boundaries: `packages/policy-engine/src/tool-executor.ts`, `apps/gateway/src/services/capability-system-service.ts`, `apps/gateway/src/services/mcp-runtime.ts`, provider clients, TUI/API client code.
- Mission Control local/browser storage parsing: `packages/mission-control-shared/src/api/client.ts`, `packages/mission-control-shared/src/components/ResizablePaneLayout.tsx`, `packages/mission-control-shared/src/state/dev-diagnostics-store.ts`.

### Runtime validation and config boundaries

The repo already uses `zod`, so future runtime validation PRs should use existing patterns instead of adding a new dependency.

High-priority boundaries:

- Environment and config loading in `apps/gateway/src/config.ts`.
- Gateway API request parsing in `apps/gateway/src/routes/**`.
- External provider/API responses in provider clients and policy-engine tool executor.
- JSON files and manifest parsing in extensions, skills, prompt packs, release evidence, and config sync.
- Browser storage parsing in Mission Control shared state/hooks/components.
- Database JSON/blob fields in storage repositories.

### Async and side-effect risk

No `forEach(async ...)` hits were found, which is good.

Follow-up should still review:

- Unbounded `Promise.all()` in UI data loading, asset loading, tool execution, prompt-pack service, TUI, and route pages.
- Fire-and-forget `void` promises in UI and runtime flows.
- External API calls without consistent timeouts or structured error wrapping.
- Retry/backoff behavior in provider, channel, delivery, webhook, and durable-run flows.

### Boundary and coupling risk

Deep import scan found a few source-boundary bypasses:

- `apps/mission-control-next/src/features/threaded-surface/threaded-error-copy.ts` imports from `packages/threaded-surface-core/src/...`.
- Gateway tests import storage source internals.
- Some feature code reaches several directory levels for shared UI primitives.

These may be acceptable locally, but should be reviewed before boundary cleanup work.

## Proposed PR Sequence

### PR 0: TypeScript revival inventory

Purpose: add this inventory doc and establish a small-PR roadmap.

Scope:

- Documentation only.
- No runtime behavior changes.
- No dependency changes.
- No refactors.

### PR 1: Repair current health gates

Purpose: unblock confidence work by fixing existing main-branch validation drift.

Suggested slices:

1. Fix `preserve-caught-error` lint failure in `provider-secret-persistence.ts`.
2. Fix release-surface route manifest/docs drift.
3. Fix contracts test drift for provider profile count and follow-on parity order.

Keep these as separate PRs if any fix requires product judgment.

### PR 2: Confidence tests for one high-risk workflow

Purpose: add characterization coverage before refactoring.

Good first targets:

- Provider secret persistence failure behavior, if PR 1 touches it.
- Release surface route manifest validation.
- Contracts provider template behavior.
- A narrow Gateway route/service boundary with known JSON parsing.

### PR 3: Runtime validation at one boundary

Purpose: move uncertainty to an edge without changing core behavior.

Candidate: one JSON parse boundary that already expects a known contract and can use existing `zod` or local validators.

Rules:

- One boundary only.
- No new dependencies.
- Preserve existing accepted valid payloads.
- Add invalid-input tests.

### PR 4: Async correctness and failure clarity in one flow

Purpose: make one side-effecting flow clearer and safer.

Candidate areas:

- Provider client response/error wrapping.
- Channel/webhook delivery error handling.
- TUI API response parsing and error messages.
- Explicit handling for one intentional fire-and-forget path.

### PR 5: Type safety cleanup in one domain

Purpose: remove unsafe assertions in a contained area.

Candidate areas:

- Storage repository row mapping.
- Mission Control browser storage parsing.
- Gateway route access helpers.
- Extensions SDK manifest parsing.

### PR 6: Strictness or typed lint ratchet

Purpose: add one guardrail only after obvious current violations are handled.

Candidates to evaluate:

- `noFallthroughCasesInSwitch`.
- `exactOptionalPropertyTypes` in one package only, if feasible.
- One type-aware lint rule in a narrow config override, if noise is manageable.

Do not enable a rule that creates a large unrelated diff.

### PR 7: Boundary cleanup after tests exist

Purpose: reduce coupling without changing behavior.

Candidate:

- Replace one source deep import with an exported package surface.
- Separate one parser from one route handler.
- Extract one pure helper from a long module after tests exist.

### PR 8: Cognitive load reduction for one module

Purpose: make one large file easier to maintain.

Candidates:

- `SettingsNativePage.tsx`
- one small section of `prompt-pack-service.ts`
- one small section of `chat-agent-orchestrator.ts`
- one small section of `gateway-service.ts`

Rule: no broad rewrite; extract only after characterization tests.

### PR 9: Developer experience and CI cleanup

Purpose: make local and CI feedback more predictable.

Candidates:

- Document known verification lanes and current blockers.
- Add a focused smoke command if a repeated manual lane exists.
- Tighten CI only after current failures are fixed.

### PR 10: Config sanity

Purpose: validate and document configuration edges.

Candidate:

- Narrow environment/config validation in `apps/gateway/src/config.ts`, using existing validation patterns.

### PR 11: Security posture pass

Purpose: reduce one concrete security risk with tests.

Candidate:

- Redaction around one external side-effect path.
- Path traversal hardening for one file endpoint.
- Secret-safe error output for one provider/config path.

Before acting on GitHub security findings, follow `docs/security/findings-triage.md`.

### PR 12: Data and edge-case hardening

Purpose: handle messy real-world inputs in one area.

Candidate:

- Large file or malformed JSON handling.
- Pagination edge case.
- Database JSON/blob compatibility with old rows.

### PR 13: Lightweight reliability benchmarks

Purpose: broaden confidence beyond earlier latency PRs.

Candidate:

- Startup health smoke.
- Memory or CPU smoke for one large workflow.
- Query-count or cache-hit sanity check for one storage path.

## First PR To Implement

This document is the first PR: `PR 0: TypeScript revival inventory`.

Why this is safe:

- It is documentation only.
- It does not change runtime behavior, public APIs, database behavior, routes, CLI output, generated artifacts, or dependencies.
- It captures current validation failures instead of hiding them.
- It gives reviewers a concrete sequence of small future PRs.

Why this is valuable:

- It prevents the revival work from turning into one giant risky PR.
- It identifies current health blockers before refactors begin.
- It names the riskiest modules and boundaries so future work can start with tests.
- It aligns TypeScript safety work with existing repo conventions and validation lanes.
