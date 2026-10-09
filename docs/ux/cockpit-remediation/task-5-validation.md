# Task 5 validation: access, release visibility and honest status

Task5 and review fix3 are implemented and source-frozen, pending independent review. Baseline `30958cdbcfe2a8dc3234929fbee6bdf4b2248b15`; worktree `C:/Users/spurn/.codex/worktrees/cockpit-remediation/personal-ai`. Earlier Tasks1–4 source/ledger rows preserved. No commits, staging, dependency additions, user-profile writes or process changes. Output ownership released to controller.

## Traceable sub-batches and source owners

- **Disabled-feature wire contract:** `packages/contracts/src/errors.ts` adds `FeatureDisabledError` / `FEATURE_DISABLED`, HTTP409 with `details.flag`. `apps/gateway/src/services/gateway-service.ts` retains the existing feature gate and unchanged GoatError error handler; `coverage-exercise.ts` expects the new code. Shared `packages/mission-control-shared/src/api/describe-api-error.ts` supports new409 and older flagged `STATE_CONFLICT`, preserving generic conflicts and authoritative401/403. Tests: contracts `errors.test.ts`; Gateway `gateway-service.feature-flags.test.ts`, `_error-handler.test.ts`; shared `describe-api-error.test.ts`.
- **Access/release/status projection:** `SystemDashboards.tsx` requires successful authorized data fetched after the current mount, excludes cached skipped/pending/fetching/placeholder/error states and stops permanent-denial polling. `CockpitBoardEditor.tsx` keeps drafts and disables review/save during access loss. Shared/native error presenters and existing shells suppress identical Retry for401/403/disabled features; attachment owner uses shared guidance without inferring caller identity from configured auth mode. `settings-index.ts`, `SettingsArea.tsx`, `SettingsSectionTabs.tsx`, `CommandPalette.tsx`, `LibraryArea.tsx` reuse route-model metadata: hidden direct access retained, hidden discovery excluded, Personality exception labeled Experimental, unknown destinations unavailable. Classic fallback access remains. Health separates problems/missing proof/available checks; integration list/detail separate configured status from unverified connectivity and actual diagnostics; run errors render on their scoped page; backup and worker/runtime handoffs describe real owners.
- **NV-04 fix1:** `apps/mission-control-next/src/cockpit/app/use-health-digest.ts` uses existing `recordView` freshness/timestamps. Earlier summary stays visible during checking and failed refresh, with Last checked evidence, explicit Stale state and neutral tone. A retry from stale shows Checking even while the previous query error is retained. Successful recovery clears stale status. No second cache or runtime truth owner.

## Exact validation commands and results

All commands ran from the worktree root; actual exit codes checked.

| Command | Result |
|---|---|
| `& './node_modules/.bin/vitest.cmd' run --root packages/contracts src/errors.test.ts` | exit0,23 tests |
| `& './node_modules/.bin/vitest.cmd' run --root packages/mission-control-shared src/api/describe-api-error.test.ts` | exit0,6 tests |
| `& './node_modules/.bin/vitest.cmd' run --root packages/threaded-surface-core src/chat/useExternalSourceAttachments.test.tsx` | exit0,18 tests |
| `& './node_modules/.bin/vitest.cmd' run --root apps/gateway src/routes/ops-boards.test.ts src/routes/_error-handler.test.ts src/services/gateway-service.feature-flags.test.ts` | exit0,24 tests; existing intentional durable-drift warning |
| `pnpm --filter @goatcitadel/mission-control-next test` | pre-fix1 snapshot exit0,456 files /3942 tests; existing localhost8787 ECONNREFUSED diagnostics |
| `& './node_modules/.bin/vitest.cmd' run --root apps/mission-control-next src/cockpit/areas/system/SystemDashboards.test.tsx src/cockpit/data/record-view.test.ts` | exit0,12 tests;125sec fake-time denial polling check |
| `& './node_modules/.bin/vitest.cmd' run --root apps/mission-control-next src/cockpit/app/use-health-digest.test.tsx src/cockpit/data/record-view.test.ts src/cockpit/areas/system/health-overview.test.ts src/cockpit/app/CockpitShell.test.tsx` | final fix1 exit0,4 files /37 tests, no warnings |
| `node scripts/run-with-worktree-output-lock.mjs --label=task5-contracts -- pnpm --filter @goatcitadel/contracts typecheck` | exit0 |
| `node scripts/run-with-worktree-output-lock.mjs --label=task5-shared -- pnpm --filter @goatcitadel/mission-control-shared typecheck` | exit0 |
| `node scripts/run-with-worktree-output-lock.mjs --label=task5-gateway -- pnpm --filter @goatcitadel/gateway typecheck` | exit0; existing nested lock-aware wrapper |
| `node scripts/run-with-worktree-output-lock.mjs --label=task5-fix1-final -- pnpm --filter @goatcitadel/mission-control-next typecheck` | exit0, dependency builds included |
| `pnpm --filter @goatcitadel/mission-control-next perf:check` | exit0 after fix1; source checks plus existing-dist budget checks |
| `git diff --check` | exit0 |

Pre-fix1 focused frontend14 files /78 tests also passed; exact full command and file list remain in the scratch report. Full frontend was not repeated for the narrow digest fix; actual hook, shared record owner, health classification and rendered shell regressions cover it. No new production build was executed by this implementer; perf budget output is existing-dist proof only.

RED: missing FeatureDisabledError/classification; pending/skipped board controls enabled; hidden settings discoverable; missing health-state helper and unverified integration display; fix1 digest remained ready during a held background read instead of checking. GREEN above proves implemented behavior. The missing-logger handler harness correction and mistaken Vault hidden expectation (current metadata says ship) are not product RED. Fix1 initial test emitted act warnings; notification settling was corrected and final37tests had clean output.

## Attributed controller browser evidence

This implementer did not execute browser proof. Root supplied and visually inspected results on its disposable auth-none testbench:

- `browser-proof/task-5-board-access-after.json/.png`: held read pending disabled; final403 disabled; Try again absent;1GET after2.2sec; conditional anonymous/operator guidance and Review Gateway access.
- `task-5-health-after-{desktop,phone}.json/.png`:1440x900 dark /390x844 light; Some checks cannot be verified yet; separate named evidence gaps; unknown Runtime service retained; neutral No backup yet with truthful CLI/explicit-schedule guidance. No false attention/healthy claim, errors or overflow.
- `task-5-integrations-after.json/.png`:1440light; native Add and manage integrations and matching empty guidance;0errors/overflow.
- `task-5-experimental-native-after.json/.png`:1440light; Personality Experimental navigation and surface caveat, existing readonly catalog/diagnostics;0errors/overflow.
- `task-5-hidden-native-after.json/.png`:390dark; valid hidden workspace-capabilities direct route, explicit Direct URL only/not certified release; absent normal navigation;0errors/overflow.
- `task-5-release-palette-after.json/.png`: hidden workspace/citadel capability searches yield0options; personalities yields Settings · Personalities · Experimental;0pageerrors.

All paths above are under `.superpowers/sdd/2026-10-05-cockpit-remediation/`. Singular `/settings/personality` was an invalid harness URL, not a product defect. `/ops/workers` correctly remains explicit Classic fallback; native port Task15. The running Gateway was compiled at Task2; browser evidence against it does not independently prove the changed Gateway wire code. Fix1 whole-loader rejection proof bypassed caught production API failures and is superseded by fix2 actual-loader/API tests and attributed browser faults below.

## Ledger and remaining boundaries

Owned IDs ST-10, SY-02, NV-04, N-04, N-05, N-06, N-11, N-12 retain original imported fields and every unrelated row. NV-04 initial pending/error behavior was already implemented; its retained-record freshness gap is now fixed in the existing owner. SY-02 no-backup classification was already neutral; existing tests and root fresh runtime retain that proof. Its backup-home default and age-versus-invalid-time wording remain Task11 follow-ups. N-06 backup creation/progress/receipt/restore belongs Task11 and therefore remains partial despite corrected handoffs.

Task7/16 own server caller identity/caller-scoped caches. Failed health sources use existing installation/workspace/access-revision query records; shared scope handoffs including ABA revalidate once. No configured-mode identity inference or secret query keys were added. Task16 must retain equivalent current board access proof before optimizing reads. Task12 owns richer integration diagnostics/setup and untouched ChatArea runtime callback. Task15 owns native worker/runtime ports. Independent review, Ubuntu-rendered baselines, installed Windows host, live token/basic/loopback/device expiry, authorized positive board profile, real external/provider diagnostics and disposable restore roundtrip remain open. No backend policy/auth/path/activation/persistence boundary changed.

## Review fix2: actual source failures and scope revalidation

The earlier fix1 whole-loader rejection test did not exercise caught production API failures. Fix2 updates existing system-health-sources/source/query owners: safe error category/retryability, retained last-known observations with original observation times, explicit neutral Stale presentation, and independent readable-source refresh. Denied sources skip unchanged polling while readable sources continue. Existing client-core custody emits a non-secret access revision; shared QueryClient WeakMap metadata advances on installation/workspace/access handoffs including A→B→A. Sidebar/mobile share one four-read digest bootstrap; disabled consumers do not advance scope. No raw credentials/hashes, second runtime truth owner, inferred caller identity, or backend authorization change.

Product RED: actual source regression initially failed3 of6 tests (no retained observations/retryability and repeated denied worker reads). Later expectation/type corrections were harness work. Final API-level tests cover success→transport rejection→recovery, original observation times, readable-source independence, nested channel denial, 401/403 fake-time suppression, custody changes between mounts, and shared-consumer ABA revalidation without duplicate bootstrap.

| Final fix2 command | Result |
|---|---|
| `& './node_modules/.bin/vitest.cmd' run --root packages/mission-control-shared src/api/client-core.test.ts src/api/describe-api-error.test.ts` | exit0,2 files /26 tests |
| `& './node_modules/.bin/vitest.cmd' run --root apps/mission-control-next src/cockpit/areas/system/HealthOverview.access.test.tsx src/cockpit/app/use-health-digest.test.tsx src/cockpit/areas/system/system-health-sources.test.ts src/cockpit/areas/system/system-health.test.ts src/cockpit/app/CockpitShell.test.tsx` | exit0,5 files /39 tests |
| `node scripts/run-with-worktree-output-lock.mjs --label=task5-fix2-shared-final -- pnpm --filter @goatcitadel/mission-control-shared typecheck` | exit0 |
| `node scripts/run-with-worktree-output-lock.mjs --label=task5-fix2-final -- pnpm --filter @goatcitadel/mission-control-next typecheck` | exit0, dependency builds included |
| `pnpm --filter @goatcitadel/mission-control-next perf:check` | exit0,302 cockpit files /1212 breakpoint files; existing-dist budget only |
| `git diff --check` | exit0 |

Final tests had no warnings. No entire-suite repeat or new production build for this narrow owner correction; full frontend remains pre-fix1 snapshot. Root browser fault baselines task-5-health-transport-record.json and task-5-health-denial-record.json reproduced the review findings. Root final-source reruns at06:04:39UTC passed: task-5-health-transport-fixed.json/.png shows Stale and per-source prior observation times explicitly retained/not current; task-5-health-denial-fixed.json/.png shows denied NPU2→2 while readable sources2→3 over125seconds,0pageerrors. All under the existing browser-proof directory. These are explicit injected browser faults on a disposable testbench, not backend permission/caller proof. Root noted minor deferred-note double punctuation as Task6 presentation follow-up. Source/test/docs/ledger ownership released after this amendment.
## Review fix3: mixed current evidence and partial custody mutations

Two new Important findings in fix2 are corrected. The system-health wrapper now preserves waiting/failed status derived from current sources, attaching the stale-source caveat and original prior observation time separately; only non-actionable claims dependent on missing evidence become neutral Stale. Actual two-channel loader regression reads both successfully, then reads one current ready:false and retains the other after transport rejection; Channels remains Needs review/waiting with both current failure detail and stale caveat.

Canonical client-core persistence, clearing and storage-mode mutation now notify access revision in finally after all attempted mutations settle. A later storage failure therefore cannot leave changed effective custody behind an unchanged revision. The original storage error reaches the caller. Tests inject later local-storage failures after session update/removal, verify one revision/notification and observe the changed custody inside the callback without printing credentials. No auth/policy or caller identity inference changes.

RED commands: `& './node_modules/.bin/vitest.cmd' run --root packages/mission-control-shared src/api/client-core.test.ts` (2 new regression failures,20 existing passed) and `& './node_modules/.bin/vitest.cmd' run --root apps/mission-control-next src/cockpit/areas/system/system-health-sources.test.ts` (1 mixed-channel failure,7 existing passed). Earlier incomplete summary fixture and listener cleanup failures were harness corrections, not additional product RED.

Final GREEN commands:

- `& './node_modules/.bin/vitest.cmd' run --root packages/mission-control-shared src/api/client-core.test.ts src/api/describe-api-error.test.ts`: exit0,2 files/28 tests.
- `& './node_modules/.bin/vitest.cmd' run --root apps/mission-control-next src/cockpit/areas/system/system-health-sources.test.ts src/cockpit/areas/system/system-health.test.ts src/cockpit/areas/system/HealthOverview.access.test.tsx src/cockpit/app/use-health-digest.test.tsx`: exit0,4 files/19 tests.
- `node scripts/run-with-worktree-output-lock.mjs --label=task5-fix3-shared -- pnpm --filter @goatcitadel/mission-control-shared typecheck`: exit0.
- `node scripts/run-with-worktree-output-lock.mjs --label=task5-fix3-frontend -- pnpm --filter @goatcitadel/mission-control-next typecheck`: exit0, dependency builds included.
- `git diff --check`: exit0.

No new test warnings. Source guards did not change; no perf or whole-suite repeat. Prior browser results remain attributed fix2 evidence; no new mixed-channel browser proof claimed. Final bounded self-review checked current-source derivation remains separate from retained-observation formatting and notifications occur after storage operations, including error paths. Scope/cache metadata unchanged. Source/test/docs/ledger and output ownership released; no commits/process changes. Existing platform/live evidence and named cross-task qualifications remain.