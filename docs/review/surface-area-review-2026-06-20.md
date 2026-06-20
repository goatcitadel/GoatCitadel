# Repository Surface Area Review - 2026-06-20

This note captures a static review of GoatCitadel's repo surface area, with emphasis on files and checks that are larger or broader than they need to be for day-to-day development. It is intended as a review artifact for prioritizing follow-up work, not as release proof.

## Executive Summary

The repo's largest maintainability cost is not a single bad file or check. It is the combination of very large runtime/UI modules, broad custom file walkers, generated coverage-style tests living beside hand-authored tests, and CI lanes where "fast" now means "large release-adjacent verification bundle."

The highest-value next move is to slim PR-time validation routing before doing large code extractions. That gives the team faster feedback and clearer proof boundaries while preserving the existing full release lanes.

## Recommended Remediation Order

1. Fix validation routing first. This reduces feedback time for every later cleanup and makes it easier to prove smaller extraction PRs.
2. Add one shared repo-scan helper. This prevents more broad walkers from drifting apart while CI is being split.
3. Extract the largest runtime/UI files in behavior-preserving slices. Do not combine these extractions with product behavior changes.
4. Introduce narrower contract entrypoints and migrate browser code gradually.
5. Move generated coverage-style tests and large asset/proof paths into explicit ownership lanes.

The main guardrail: do not weaken release proof to make PRs faster. Keep broad release lanes, but stop running all of them for every small change.

## Findings

### 1. `verify:fast` is not really fast anymore

- Severity: Medium
- Evidence: [`package.json`](../../package.json#L71), [`scripts/verification/lib/scenarios.mjs`](../../scripts/verification/lib/scenarios.mjs#L96), [`.github/workflows/verification-fast.yml`](../../.github/workflows/verification-fast.yml#L61)

`verify:fast` routes into `scripts/verification/lib/scenarios.mjs`, where it runs skills catalog checks, repo hygiene, storage migration parity, extension build/package checks, root typecheck, root tests, gateway smoke, root build, and docs checks.

The CI workflow then also runs workflow linting, ESLint, docs checks, `verify:fast`, real Postgres tests, production coverage, and artifact redaction in the same job. This makes small PRs pay for a broad release-adjacent lane and duplicates `docs:check`.

Recommendation: split the current behavior into a genuinely bounded PR lane, for example `verify:pr:changed`, and a broader release lane, for example `verify:release:fast`. Keep full verification available, but stop making every PR path walk the same large surface.

Fix plan:

1. Rename the current broad lane in intent, even if the compatibility script name stays for a transition:
   - add `verify:release:fast` as the current broad release-adjacent lane
   - add `verify:pr:changed` for ordinary pull request feedback
   - keep `verify:fast` as an alias during migration, or retarget it only after branch protection is updated

2. Add a changed-file resolver under `scripts/verification/`:
   - read changed files with `git diff --name-only origin/main...HEAD` in CI and a safe local fallback
   - map changed paths to owners such as gateway, storage, contracts, Mission Control, docs, workflows, packages, and assets
   - emit the selected validation plan as JSON so reviewers can inspect why a lane ran

3. Stop duplicate docs execution:
   - either run `docs:check` directly in the workflow or run it inside the selected verification lane
   - do not run both for the same PR path

4. Keep broad validation for release and risky areas:
   - release proof and main-branch verification should still run full root build/test/typecheck, visual lanes, artifact redaction, and release proof lanes
   - PRs touching `package.json`, `pnpm-lock.yaml`, workspace config, CI, release scripts, auth, storage migrations, policy, or runtime orchestration should escalate to broader lanes

Acceptance criteria:

- docs-only PRs run docs/workflow checks but skip root build and root tests
- gateway-only PRs run gateway typecheck/tests and relevant shared package checks
- frontend-only PRs run Mission Control typecheck/tests plus CSS/design checks
- lockfile/workspace/CI/release changes still trigger broad verification
- the PR summary includes the selected lane plan as an uploaded artifact or console summary

Suggested validation:

- `pnpm verify:workflows`
- `pnpm docs:check`
- `pnpm verify:pr:changed --base origin/main --explain`
- `pnpm verify:release:fast`

### 2. Gateway service surface is concentrated in very large files

- Severity: Medium
- Evidence: [`apps/gateway/src/services/chat-agent-orchestrator.ts`](../../apps/gateway/src/services/chat-agent-orchestrator.ts), [`apps/gateway/src/services/gateway-service.ts`](../../apps/gateway/src/services/gateway-service.ts), [`apps/gateway/src/services/prompt-pack-service.ts`](../../apps/gateway/src/services/prompt-pack-service.ts), [`apps/gateway/src/services/improvement-service.ts`](../../apps/gateway/src/services/improvement-service.ts)

Largest source hotspots observed:

- `chat-agent-orchestrator.ts`: about 12,000 LOC
- `gateway-service.ts`: about 9,444 LOC
- `prompt-pack-service.ts`: about 9,291 LOC
- `improvement-service.ts`: about 5,737 LOC

These files are review, merge-conflict, lint/typecheck, and regression-risk magnets. They also make it hard to route targeted tests because many ownership boundaries collapse into one file.

Recommendation: extract by runtime responsibility rather than style. Good cut lines include orchestration dispatch, tool/result handling, prompt-pack scoring/execution, and route facades.

Fix plan:

1. Start with pure helper extraction, not behavior changes:
   - move type guards, normalization helpers, formatters, and decision helpers into adjacent files
   - keep public service method names and call signatures stable
   - add characterization tests before moving code where behavior is subtle

2. Split `chat-agent-orchestrator.ts` by runtime phase:
   - request preparation and context assembly
   - model invocation and streaming adapters
   - tool-call planning and dispatch
   - tool-result reconciliation
   - durable state updates and recovery handling
   - audit/trace emission

3. Split `gateway-service.ts` into route-facing facades:
   - route composition and request validation should stay near route/service boundaries
   - persistence-heavy work should move behind repository or domain services
   - orchestration calls should delegate to existing lifecycle/runtime services

4. Split `prompt-pack-service.ts` by prompt-pack lifecycle:
   - pack loading and normalization
   - test execution
   - scoring and latest assessment
   - report/export generation
   - grant/profile handling

5. Split `improvement-service.ts` by improvement flow:
   - candidate generation
   - scoring/classification
   - proposal lifecycle
   - activation/trust evidence

Acceptance criteria:

- first extraction PRs are behavior-preserving and mostly move code
- existing public service APIs remain stable
- each extracted module has focused tests or inherits existing characterization tests
- the largest files trend below roughly 3,000 to 4,000 LOC over multiple PRs
- targeted validation can be run by service owner instead of defaulting to root tests

Suggested validation:

- `pnpm --filter @goatcitadel/gateway typecheck`
- focused `vitest run` files for the touched service
- `pnpm verify:runtime:truth` for orchestration/runtime changes
- `pnpm verify:durable:recovery` when durable state or resume behavior moves

### 3. Mission Control settings is another monolith

- Severity: Medium
- Evidence: [`apps/mission-control-next/src/features/native-routes/SettingsNativePage.tsx`](../../apps/mission-control-next/src/features/native-routes/SettingsNativePage.tsx)

`SettingsNativePage.tsx` is about 9,797 LOC, with a large companion test file. That makes small settings changes expensive and brittle.

Recommendation: split settings by operator responsibility: providers, auth, runtime, integrations, channels, desktop/native, and diagnostics. Shared settings hooks can keep behavior centralized without requiring one giant component file.

Fix plan:

1. Keep `SettingsNativePage.tsx` as the route shell and move sections into `features/native-routes/settings/`:
   - provider/model settings
   - auth and gateway access settings
   - runtime/native desktop settings
   - integrations and channel settings
   - diagnostics and advanced controls

2. Extract shared state into route-owned hooks:
   - settings load/save state
   - dirty-state tracking
   - validation and pending request state
   - gateway error/status handling

3. Split tests to match the section ownership:
   - keep route smoke tests at the page level
   - move detailed form behavior tests beside each section
   - preserve accessibility and keyboard/focus coverage for dangerous actions

Acceptance criteria:

- `SettingsNativePage.tsx` becomes a route coordinator instead of the implementation of every settings panel
- each settings section can be changed and tested without reading the full route file
- UI copy and behavior stay consistent with existing Mission Control conventions
- no settings path writes directly to runtime state outside Gateway-owned APIs

Suggested validation:

- `pnpm --filter @goatcitadel/mission-control-next typecheck`
- focused Mission Control settings tests
- `pnpm verify:surface:regression` for visible route changes
- browser or screenshot proof for large UI movement

### 4. Repo checks use several broad custom walkers

- Severity: Medium
- Evidence: [`scripts/check-no-empty-catch.mjs`](../../scripts/check-no-empty-catch.mjs#L68), [`scripts/check-button-types.mjs`](../../scripts/check-button-types.mjs#L6), [`scripts/check-no-inline-sql.mjs`](../../scripts/check-no-inline-sql.mjs#L55), [`scripts/check-memory-ownership.mjs`](../../scripts/check-memory-ownership.mjs#L45), [`packages/skills/src/design-quality.ts`](../../packages/skills/src/design-quality.ts#L377)

Several checks implement their own recursive scanning or tracked-file scanning. Individually, these are reasonable. Together, they add repeated whole-tree or whole-services scan cost and increase the chance that new generated/cache/proof paths are accidentally included.

Recommendation: add a shared repo-scan helper with standard ignores and an optional changed-file mode. Then migrate the custom check scripts onto that helper.

Fix plan:

1. Add a small shared helper, for example `scripts/lib/repo-scan.mjs`:
   - `listTrackedFiles({ extensions, include, exclude })`
   - `walkSourceFiles({ roots, extensions, ignoreGenerated })`
   - `changedFiles({ baseRef, headRef })`
   - one central ignore list for `node_modules`, `dist`, `dist-node`, `coverage`, `.vite`, `.tmp`, artifacts, release outputs, visual baselines, and generated caches

2. Migrate check scripts one at a time:
   - start with read-only checks such as button type, memory ownership, inline SQL, and empty catch checks
   - keep existing default behavior equivalent
   - add a `--changed` or `--base` option for PR-time use

3. Add tests for the helper:
   - ignores nested generated directories
   - includes tracked source files
   - handles paths with spaces
   - handles deleted files in changed-file mode

Acceptance criteria:

- check scripts stop reimplementing their own walkers
- new generated/cache paths only need to be ignored in one place
- PR-time checks can operate on changed files where safe
- full-tree checks remain available for release or main-branch proof

Suggested validation:

- `node --test` for the new helper tests
- `pnpm docs:check`
- `pnpm verify:repo:hygiene`
- compare before/after check output on a clean tree

### 5. Generated coverage-style tests have become normal review surface

- Severity: Low/Medium
- Evidence: files matching `*.loop*.test.*`, `*.coverage.test.*`, and `*.tail*.test.*`

The review counted 162 generated or coverage-style test files, totaling about 47,711 LOC. This coverage is useful, but it creates noisy everyday review surface when mixed with focused, hand-authored tests.

Recommendation: move or label these as generated or coverage-lane-owned tests. Keep focused human-authored tests closer to the source modules so reviewers can tell intent from coverage mass.

Fix plan:

1. Define ownership conventions:
   - hand-authored behavior tests stay beside source
   - generated or coverage-expansion tests move under a predictable path such as `test/generated/` or keep a consistent suffix with an ownership manifest

2. Add a short manifest for generated tests:
   - generator or reason
   - owning package
   - validation lane
   - whether humans should edit it directly

3. Keep coverage gates, but keep review noise low:
   - exclude generated coverage tests from some changed-file heuristics unless their owner changes
   - keep them in full package tests and coverage gates

Acceptance criteria:

- reviewers can distinguish intentional behavior tests from coverage-mass tests
- generated tests still run in the lanes that need them
- changed-file validation does not over-trigger broad coverage lanes for unrelated PRs

Suggested validation:

- package tests for packages whose tests move
- `pnpm coverage:collect`
- `pnpm coverage:gate:production`

### 6. Contracts imports are too broad for frontend boundaries

- Severity: Low/Medium
- Evidence: [`packages/contracts/src/index.ts`](../../packages/contracts/src/index.ts), [`packages/contracts/package.json`](../../packages/contracts/package.json#L13)

The contracts root barrel exports 92 modules. Production frontend code has many imports from `@goatcitadel/contracts`. The Node-only vault subpath is separate, which is good, but the giant root barrel still makes browser/server boundaries and bundler warnings harder to reason about.

Recommendation: prefer domain subpaths such as `@goatcitadel/contracts/chat`, `@goatcitadel/contracts/mcp`, and `@goatcitadel/contracts/approvals` for frontend code. Keep the root barrel as a compatibility surface, but reduce new frontend use of it.

Fix plan:

1. Add package exports for browser-safe domain entrypoints:
   - `./chat`
   - `./approvals`
   - `./mcp`
   - `./runtime`
   - `./settings` or other domains that match actual import clusters

2. Keep Node-only exports explicit:
   - keep `./citadel-vault-node` as a separate Node-only subpath
   - do not re-export Node-only helpers from browser-facing subpaths

3. Migrate frontend imports gradually:
   - start with Mission Control files that import only types or small browser-safe helpers
   - avoid changing runtime behavior
   - use type-only imports wherever values are not needed

4. Add a lint or check guard after migration:
   - warn on new frontend imports from the root `@goatcitadel/contracts` barrel
   - allow existing root imports during a transition if needed

Acceptance criteria:

- Vite no longer has to consider Node-only contract modules for browser bundles
- frontend imports communicate their contract domain
- root barrel remains available for compatibility and server-side use
- no Node-only built-ins leak into Mission Control bundles

Suggested validation:

- `pnpm --filter @goatcitadel/contracts build`
- `pnpm --filter @goatcitadel/mission-control-next build`
- `pnpm --filter @goatcitadel/mission-control-next typecheck`
- check Vite warnings for `node:crypto` or other Node-only modules

### 7. Asset and proof surface is large but mostly legitimate

- Severity: Low
- Evidence: tracked binary-ish/public proof assets and visual baselines

The review counted 648 tracked binary-ish/public proof assets at about 102 MB. No tracked `node_modules`, `dist`, `.vite`, `coverage`, or `*.tsbuildinfo` files were found.

Recommendation: keep these asset/proof paths out of generic text, docs, lint, and repo-hygiene scans unless the check is intentionally asset-aware.

Fix plan:

1. Define path ownership:
   - visual baselines belong to visual regression lanes
   - public 3D/audio/image assets belong to asset integrity and UI build lanes
   - release proof images belong to release proof review lanes

2. Add scan-helper excludes for generic text checks:
   - visual baselines
   - large binary assets
   - release proof artifacts
   - generated local caches

3. Add targeted asset checks where useful:
   - manifest references resolve
   - assets required by the shipped surface exist
   - oversized new assets are flagged for review

Acceptance criteria:

- generic text/docs/lint checks do not spend time walking large proof or binary asset trees
- visual and asset-specific lanes still prove the files that matter
- new large assets require intentional review

Suggested validation:

- `pnpm verify:visual:regression` for baseline-sensitive changes
- Mission Control build for public asset references
- repo hygiene checks for tracked generated artifacts

## Suggested Next Work

1. Slim CI/check routing first:
   - add a shared repo-scan helper
   - add changed-file/package routing for PR-time checks
   - stop running `docs:check` both directly and inside `verify:fast`
   - make `verify:fast` genuinely bounded

2. Reduce the two biggest code-review hotspots:
   - split `chat-agent-orchestrator.ts` by orchestration/runtime responsibility
   - split `SettingsNativePage.tsx` by settings section ownership

3. Introduce contracts subpaths for browser-facing imports:
   - keep the existing root barrel for compatibility
   - gradually move frontend code to domain-specific contract entrypoints

## Validation

This was a static repository review. The findings were gathered with tracked file counts, source searches, script inspection, and workflow inspection. No full CI run was performed for this review note.
