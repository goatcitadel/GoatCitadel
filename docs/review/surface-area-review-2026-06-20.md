# Repository Surface Area Review - 2026-06-20

This note captures a static review of GoatCitadel's repo surface area, with emphasis on files and checks that are larger or broader than they need to be for day-to-day development. It is intended as a review artifact for prioritizing follow-up work, not as release proof.

## Executive Summary

The repo's largest maintainability cost is not a single bad file or check. It is the combination of very large runtime/UI modules, broad custom file walkers, generated coverage-style tests living beside hand-authored tests, and CI lanes where "fast" now means "large release-adjacent verification bundle."

The highest-value next move is to slim PR-time validation routing before doing large code extractions. That gives the team faster feedback and clearer proof boundaries while preserving the existing full release lanes.

## Findings

### 1. `verify:fast` is not really fast anymore

- Severity: Medium
- Evidence: [`package.json`](../../package.json#L71), [`scripts/verification/lib/scenarios.mjs`](../../scripts/verification/lib/scenarios.mjs#L96), [`.github/workflows/verification-fast.yml`](../../.github/workflows/verification-fast.yml#L61)

`verify:fast` routes into `scripts/verification/lib/scenarios.mjs`, where it runs skills catalog checks, repo hygiene, storage migration parity, extension build/package checks, root typecheck, root tests, gateway smoke, root build, and docs checks.

The CI workflow then also runs workflow linting, ESLint, docs checks, `verify:fast`, real Postgres tests, production coverage, and artifact redaction in the same job. This makes small PRs pay for a broad release-adjacent lane and duplicates `docs:check`.

Recommendation: split the current behavior into a genuinely bounded PR lane, for example `verify:pr:changed`, and a broader release lane, for example `verify:release:fast`. Keep full verification available, but stop making every PR path walk the same large surface.

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

### 3. Mission Control settings is another monolith

- Severity: Medium
- Evidence: [`apps/mission-control-next/src/features/native-routes/SettingsNativePage.tsx`](../../apps/mission-control-next/src/features/native-routes/SettingsNativePage.tsx)

`SettingsNativePage.tsx` is about 9,797 LOC, with a large companion test file. That makes small settings changes expensive and brittle.

Recommendation: split settings by operator responsibility: providers, auth, runtime, integrations, channels, desktop/native, and diagnostics. Shared settings hooks can keep behavior centralized without requiring one giant component file.

### 4. Repo checks use several broad custom walkers

- Severity: Medium
- Evidence: [`scripts/check-no-empty-catch.mjs`](../../scripts/check-no-empty-catch.mjs#L68), [`scripts/check-button-types.mjs`](../../scripts/check-button-types.mjs#L6), [`scripts/check-no-inline-sql.mjs`](../../scripts/check-no-inline-sql.mjs#L55), [`scripts/check-memory-ownership.mjs`](../../scripts/check-memory-ownership.mjs#L45), [`packages/skills/src/design-quality.ts`](../../packages/skills/src/design-quality.ts#L377)

Several checks implement their own recursive scanning or tracked-file scanning. Individually, these are reasonable. Together, they add repeated whole-tree or whole-services scan cost and increase the chance that new generated/cache/proof paths are accidentally included.

Recommendation: add a shared repo-scan helper with standard ignores and an optional changed-file mode. Then migrate the custom check scripts onto that helper.

### 5. Generated coverage-style tests have become normal review surface

- Severity: Low/Medium
- Evidence: files matching `*.loop*.test.*`, `*.coverage.test.*`, and `*.tail*.test.*`

The review counted 162 generated or coverage-style test files, totaling about 47,711 LOC. This coverage is useful, but it creates noisy everyday review surface when mixed with focused, hand-authored tests.

Recommendation: move or label these as generated or coverage-lane-owned tests. Keep focused human-authored tests closer to the source modules so reviewers can tell intent from coverage mass.

### 6. Contracts imports are too broad for frontend boundaries

- Severity: Low/Medium
- Evidence: [`packages/contracts/src/index.ts`](../../packages/contracts/src/index.ts), [`packages/contracts/package.json`](../../packages/contracts/package.json#L13)

The contracts root barrel exports 92 modules. Production frontend code has many imports from `@goatcitadel/contracts`. The Node-only vault subpath is separate, which is good, but the giant root barrel still makes browser/server boundaries and bundler warnings harder to reason about.

Recommendation: prefer domain subpaths such as `@goatcitadel/contracts/chat`, `@goatcitadel/contracts/mcp`, and `@goatcitadel/contracts/approvals` for frontend code. Keep the root barrel as a compatibility surface, but reduce new frontend use of it.

### 7. Asset and proof surface is large but mostly legitimate

- Severity: Low
- Evidence: tracked binary-ish/public proof assets and visual baselines

The review counted 648 tracked binary-ish/public proof assets at about 102 MB. No tracked `node_modules`, `dist`, `.vite`, `coverage`, or `*.tsbuildinfo` files were found.

Recommendation: keep these asset/proof paths out of generic text, docs, lint, and repo-hygiene scans unless the check is intentionally asset-aware.

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
