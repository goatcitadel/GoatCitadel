# Task 9: Work tasks, runs, schedules and native operations

Source/unit closure on 2026-10-06; independent browser acceptance is pending. No commits, dependencies, real profiles, credentials, runtime data or primary-checkout changes were made by this sub-batch.

## Separable source slices

- Tasks/overview: `apps/mission-control-next/src/cockpit/areas/work/WorkBoard.tsx`, `WorkTaskDetail.tsx`, `WorkTaskCreate.tsx`, `TaskDetailsEditor.tsx`, `TaskStatusControl.tsx`, `TaskAssignmentControl.tsx`, `work-queries.ts`. Operator tasks and runtime runs have separate labeled lists, loaded-record search/type filters and a Done overview capped at 25 matching records per type. Ordinary detail/status/assignment saves retain the shared fresh preflight, revision, independent receipt and uncertain-outcome owner without a duplicate risk dialog. Initial or failed/cache-only reads do not authorize board controls. Explicit task-record durable/conversation links are used.
- Run/decision evidence: `WorkRunDetail.tsx`, `WorkWaitingDecisions.tsx`. Owner-recorded failure/recovery cause is visible, missing settled records are distinct, plan/tool/delegation evidence is collapsible, lineage/receipt is secondary, and approvals link into current Inbox review. The Work decision section uses explicit Gateway Inbox `source.runId` linkage, names its derived/incomplete/refetch boundaries, and never infers an operator decision from a generic waiting status.
- Schedules: `WorkSchedules.tsx`, `WorkScheduleEditor.tsx`, `WorkScheduleCreateForm.tsx`, `ScheduleAdvancedFields.tsx`, `schedule-cadence.ts`; shared `src/features/native-routes/ops/schedule-operation.ts`. Gateway-wide scope is visible. Cadence, browser display timezone versus unreported scheduler timezone, action/destination, failure/backoff/output, consequences and one-minute review lifetime are explained. Pause/resume/delete/run preserve preflight and settlement. Native create/edit supports description/end date/workdir/context source/action configuration; malformed configuration is blocked before dispatch, stale drafts remain intact, and edit receipts are independently read. Run now still has no atomic configuration-revision fence; acknowledgement is not proof of execution.
- Native Kanban/archive: `WorkKanban.tsx`, `WorkArchive.tsx`, shared `src/features/native-routes/ops/KanbanRoutePage.tsx`, `task-archive-operation.ts`. Task actions reuse existing bulk/revision/readback/conflict/selection owners and self-contained native CSS. Archive/restore use supported soft-delete/restore APIs, revision preflight, independent readback, shared cross-shell uncertain locks, bounded pages and default-workspace semantics. Runtime-owned lifecycle actions remain explicitly blocked in this limited port. Kanban remains experimental; no release promotion or complete-parity assertion.
- Automation/templates: `WorkAutomation.tsx`, shared automation/export API and `runtime-schedule-model.ts` diagnostics. Native draft preview plus Activepieces/n8n exports expose missing capabilities, limits/proof, failed/blocked validation and clipboard availability. Blocked templates are not copied. Late results after input/scope/navigation changes are withheld. Advisory preview is not represented as a persisted plan or an executed job. The actual receiving link opens `/work/schedules`; no invented `planId` Chat deep link.
- Navigation: `WorkArea.tsx`, `src/cockpit/app/cockpit-compatibility.ts` expose `/work/kanban`, `/work/archive`, `/work/automation`; explicit Classic fallbacks remain. A schedule `jobId` query selects its existing detail read; legacy full-control fallbacks remain until complete action/error/deep-link parity is independently proved.

## Commands and results

From `C:/Users/spurn/.codex/worktrees/cockpit-remediation/personal-ai`:

```powershell
& './node_modules/.bin/vitest.cmd' run --root apps/mission-control-next src/features/native-routes/ops/schedule-edit.test.ts
```

RED before edit support: 2 failed / 1 passed (edit incorrectly followed resume). GREEN after implementation: 3/3.

```powershell
& './node_modules/.bin/vitest.cmd' run --root apps/mission-control-next src/cockpit/areas/work src/features/native-routes/ops/KanbanRoutePage.test.tsx src/features/native-routes/ops/use-schedule-operations.test.tsx src/features/native-routes/ops/schedule-edit.test.ts src/features/native-routes/ops/task-archive-operation.test.ts src/features/native-routes/ops/task-detail-mutation.test.ts src/cockpit/app/cockpit-compatibility.test.ts
```

GREEN: 28 files / 234 tests. Includes actual callback/API boundaries for canonical fixtures, scoped revision saves, conflict/no-write, unmount/no-dispatch, uncertain locks, bulk actions, default-scope archive/restore, current schedule edit/readback, review Cancel/expiry and advanced create validation, both export callbacks, blocked/failed exports and late advisory results. Old duplicate-dialog expectations were updated to assert direct guarded saves. Later board search/type fixture addition and Done cap: targeted board test 2/2; final affected editor/schedule/task lane 5 files / 23 tests passed. New tests include `WorkAutomation.test.tsx`, `WorkScheduleEditor.test.tsx`, `WorkWaitingDecisions.test.tsx`, `schedule-edit.test.ts`, `task-archive-operation.test.ts`; existing task/schedule/Kanban owner regressions remain green.

```powershell
node scripts/run-with-worktree-output-lock.mjs --label=task9:typecheck -- pnpm --filter @goatcitadel/mission-control-next typecheck
```

GREEN after final source edits, including shared dependency builds. A transient use of a nonexistent agentic `sessionId` was caught and corrected to recorded `childSessionId`/`parentSessionId`; no guessed protocol field remains.

`pnpm --filter @goatcitadel/mission-control-next perf:check` BLOCKED at the unchanged `src/cockpit/areas/chat/ChatBlockers.tsx:109` refetch guard (`{recordQuery.isFetching`). Preserved for Tasks 13/17.

Individual `tokens:check`, `breakpoints:check`, `buttons:check`, `scroll-contracts:check`, `icons:check`, `contrast:check` passed. `typography:check` BLOCKED at unchanged `src/cockpit/styles/gateway-access.css:16`, `font-size: 1.75rem`; preserved for Tasks 12/17. `node scripts/check-mission-control-next-cockpit-classes.mjs`, `node scripts/check-mission-control-next-cockpit-copy.mjs`, `node scripts/check-mission-control-next-legacy-usage.mjs` passed. `node scripts/check-mission-control-next-budgets.mjs` passed against the already-existing bundle output; this is not fresh production-build proof. `git diff --check` passed.

## Ledger, self-review and acceptance gaps

All ten Task 9 rows WK-01–WK-10 and the owned `ops/schedules` / `ops/kanban` inventory entries are provisionally rechecked. Original 233 finding IDs/order/imported fields and earlier evidence are preserved. `parity_verified` remains false; route presence and imported API symbols are not parity certification.

Self-review checked: task/run identity and exact authored linkage; no waiting-status-to-approval inference; fresh-read admission; immutable reviewed revision and expiry; draft rebase is explicit; configured auth mode never authorizes edits; known/default workspace semantics; no raw browser filesystem/database authority; no secret persistence; Gateway-wide schedules; action acknowledgement versus execution truth; late results and uncertain-outcome locks; native self-contained styles; Classic fallbacks and experimental metadata retained.

Named remaining gates: root desktop/mobile/coarse-pointer/keyboard/history/deep-link browser proof; actual disposable Gateway/API receipts and negative action states; complete schedule review-queue and specialist legacy-control parity before fallback retirement; Task 16 list/performance work; Tasks 12/13/17 pre-existing design-guard blockers and broad release gates. Ubuntu, installed Windows host/installer, actual scheduled-job execution, external template native import and external execution were not run. No fresh production build, global release readiness or support expansion is claimed.

## Fix 1: independent review corrections

The three Important items in `task-9-review.md` are corrected against immutable `task-9-fix-1-before.json`:

- `WorkBoard.tsx` and `WorkArea.tasks.test.tsx`: each source independently reports `Tasks loading` / `Tasks unavailable`, `Runs loading` / `Runs unavailable`; cached counts carry `(stale)` after failure and `(checking)` during a read. No numeric zero is fabricated from a missing source. A successful task read continues to authorize New task even if the independent run read fails; failed/loading task access disables creation, including an already-open form.
- `WorkSchedules.tsx` and `WorkSchedules.test.tsx`: subscribes to the existing Cockpit route/history owner. The actual in-app Review button navigates to `jobId`; same-mounted query changes and actual Back/Forward select the addressed record. History is in the operation lifetime binding; old reviews/callbacks are invalidated. Existing per-record schedule drafts survive traversal.
- `WorkTaskCreate.tsx`, shared `use-task-create.ts` and `WorkTaskCreate.test.tsx`: native `Create task` submits directly through the existing normalization, synchronous generation consumption, shared admission, independent record-read/receipt and uncertain-outcome owner. No duplicate Review/Confirm UI. Legacy owner behavior and all input/workspace/Citadel ABA, off-view acknowledgement, failed-refresh and unknown-result safeguards remain covered.

Named integration follow-up from root: Gateway `services/gateway/cron-automation-service.ts:1775` discards config for task/basic actions and canonicalizes description/end dates. `ScheduleAdvancedFields.tsx`, `WorkScheduleEditor.tsx` and `schedule-operation.ts` now block unsupported nonempty config before dispatch, validate exact supported watchdog shape, canonicalize the end timestamp and accept the Gateway's undefined cleared-description receipt. Existing no_agent/agent_turn config is accepted only unchanged; no Gateway policy or release support was widened. Positive fixtures now use watchdog `{watchdog:{checkId:"runtime_health",severityThreshold:"warning",notifyHomeChannel:false}}`; earlier arbitrary task config fixture was corrected. Actual scheduled execution and external/native import remain unverified.

RED/GREEN commands:

```powershell
& './node_modules/.bin/vitest.cmd' run --root apps/mission-control-next src/cockpit/areas/work/WorkArea.tasks.test.tsx src/cockpit/areas/work/WorkSchedules.test.tsx src/cockpit/areas/work/WorkTaskCreate.test.tsx
# RED: 17 failed / 16 passed; GREEN: 3 files / 33 tests.
& './node_modules/.bin/vitest.cmd' run --root apps/mission-control-next src/cockpit/areas/work/ScheduleAdvancedFields.test.ts src/features/native-routes/ops/schedule-edit.test.ts
# RED: 3 failed / 3 passed for unsupported config, timestamp and cleared-description normalization.
& './node_modules/.bin/vitest.cmd' run --root apps/mission-control-next src/cockpit/areas/work/ScheduleAdvancedFields.test.ts src/features/native-routes/ops/schedule-edit.test.ts src/cockpit/areas/work/WorkScheduleEditor.test.tsx src/cockpit/areas/work/WorkSchedules.test.tsx
# GREEN: 4 files / 20 tests.
```

Affected integration lane: `vitest run --root apps/mission-control-next` with `WorkArea.tasks.test.tsx`, `WorkSchedules.test.tsx`, `WorkTaskCreate.test.tsx`, `ScheduleAdvancedFields.test.ts`, `WorkScheduleEditor.test.tsx`, `schedule-edit.test.ts`, `task-create-mutation.test.ts`, `WorkAutomation.test.tsx`, `task-archive-operation.test.ts`: 9 files / 61 passed, one bad assertion that a failed run source must disable unrelated task creation. Corrected assertion; targeted `WorkArea.tasks.test.tsx` then passed 8/8. No broader green suite repeated.

`node scripts/run-with-worktree-output-lock.mjs --label=task9-fix1:typecheck -- pnpm --filter @goatcitadel/mission-control-next typecheck` passed after final semantic/format edits. `git diff --check` passed. Earlier Task 7 design-guard blockers remain with Tasks 12/13; no unrelated repair or new green global claim.

Separate formatting-only slice: `WorkArchive.tsx`, `WorkAutomation.tsx`, `WorkScheduleEditor.tsx` formatted to normal 100-column JSX with the installed formatter. Frozen `task-9-fix-1-format-before.json` and `task-9-fix-1-format.patch` separate this from semantic corrections. TypeScript-emitted JavaScript is identical before/after after normalizing adjacent JSX text string chunks; no handlers, conditions, strings or action policy changed in this slice.

All owned rows remain provisional. Root's initial disposable pass and failed helper attempts are controller evidence, not proof claimed by this agent. Final root native browser/API acceptance, complete specialist parity, platform/global gates and fallback retirement remain pending.

## Fix 2: strict watchdog types and observed schedule copy/receipt behavior

Read all of `task-9-fix-1-review.md`; the original three Important findings are closed in source, and its new strict-type Important finding is corrected. `ScheduleAdvancedFields.tsx` now requires actual string enum values, exact membership, and the existing canonical-shape/boolean checks. Array/object/number/boolean/null fixtures exercise both fields; actual native create/edit callbacks prove malformed inputs send no POST or PATCH. Supported canonical watchdog behavior remains available, with unchanged Gateway policy.

Root reported actual `task-9-browser-work-fix-1` proof of overview/search/types/direct edit/stale draft/pause review cancellation and canonical pause/stale preflight. The later DELETE visually succeeded but its receipt disappeared on the operation's own navigation. That controller-owned evidence motivated a narrow `WorkSchedules.tsx` correction: a confirmed receipt survives one exact origin/history/workspace-bound selection destination. Old reviews still clear and the operation generation/history/uncertain fences are unchanged. Unrelated navigation or workspace changes clear obsolete notice/review state. Native callback tests use the existing `commitCockpitNavigation` transport through a navigation-owner fixture, asserting actual jobId URL changes after DELETE/create plus retained receipt text; DELETE receipt then clears on unrelated navigation. This does not replace root's full dirty-leave/browser gate.

`schedule-cadence.ts` reads only an explicit suffix after the five cron fields, validates that zone with the same Intl check used by the Gateway parser, and renders daily/hourly cadence with that zone. `WorkSchedules.tsx` list/detail/action reviews and `WorkScheduleEditor.tsx` edit review show explicit valid UTC/IANA zones. Unsuffixed or unrecognized expressions remain timezone-not-reported; no internal default is advertised and no Gateway parsing or action policy changes.

```powershell
& './node_modules/.bin/vitest.cmd' run --root apps/mission-control-next src/cockpit/areas/work/ScheduleAdvancedFields.test.ts src/cockpit/areas/work/schedule-cadence.test.ts src/cockpit/areas/work/WorkSchedules.test.tsx
# RED: 7 failed / 20 passed. GREEN after the focused correction: 3 files / 27 tests.
& './node_modules/.bin/vitest.cmd' run --root apps/mission-control-next src/cockpit/areas/work/ScheduleAdvancedFields.test.ts src/cockpit/areas/work/schedule-cadence.test.ts src/cockpit/areas/work/WorkSchedules.test.tsx src/cockpit/areas/work/WorkScheduleEditor.test.tsx
# GREEN: 4 files / 40 tests, including additional no-POST/PATCH and rendered-zone fixtures.
node scripts/run-with-worktree-output-lock.mjs --label=task9-fix2:typecheck -- pnpm --filter @goatcitadel/mission-control-next typecheck
# PASS, exit 0.
git diff --check
# PASS, exit 0.
```

No broader green suite, new formatting churn, browser scripts, installed-host/Ubuntu/global release lanes or unrelated guard-owner edits were performed by this fix. Root still owns actual native browser/API acceptance and screenshot proof; the observed controller run is attributed above, not claimed as agent-executed proof. Full specialist schedule parity, external templates/native import/execution, platform/global release gates and Classic retirement remain pending. Only additive rechecks to affected owned schedule rows/inventory are written; all 233 row IDs/order/prior fields/evidence remain intact.

## Fix 3: authorized history-return reads and accessible modal feedback

Two actual root browser observations drove this fix: returning to cached B via history left `Review schedule changes` disabled until native Refresh; invalid configuration/stale preflight messages were in the aria-hidden background while the real shared Dialog stayed open. Root's work pass and screenshots are controller evidence, not browser proof executed by this agent.

Surgical sources: `WorkSchedules.tsx` scopes the selected detail read key to the existing history lifetime, overrides the 30-second global freshness default with `staleTime: 0`, and forwards the query AbortSignal. A selection/history return therefore performs one authorized read, rather than admitting an older cached entry. Same-record placeholder data may remain visible while checking, but `isFetchedAfterMount`, `isFetching`, `isPlaceholderData`, error and shared uncertain-lock guards continue to block actions. No refetch effect or duplicate bootstrap was added. Confirmation still performs the existing separate mutation preflight/readback.

`WorkScheduleEditor.tsx` now places validation, definite preflight failures and uncertain-outcome alerts inside the live review portal; progress is a status there. Background-only alerts are shown after the modal closes. `WorkSchedules.tsx` likewise places action-review failure/progress feedback inside its live portal. An uncertain action keeps the review open, disables confirmation and offers the existing close/Keep schedule path; closing does not release the shared uncertain retry lock. Draft, revision, scope/history lifetime, approval and Gateway authority remain unchanged.

New `WorkSchedules.portal.test.tsx` uses a real QueryClient with `staleTime: 30_000`, actual Cockpit history transitions and the actual shared Radix Dialog portal. Its dependency-free `getByRole` query explicitly excludes `[aria-hidden="true"]` and hidden ancestors; testing-library is not installed and no dependency was added. No Dialog mock or text query through the hidden background is used. It asserts one GET for initial A/B and a new GET on each return, with controls blocked until a deferred B read completes; it then opens the real B review. Seven real-portal cases cover validation/no PATCH, stale/unavailable/uncertain editor outcomes, and stale/unavailable/uncertain pause outcomes, including disabled confirmation after uncertain writes.

```powershell
& './node_modules/.bin/vitest.cmd' run --root apps/mission-control-next src/cockpit/areas/work/WorkSchedules.portal.test.tsx
# RED: all 8 failed on frozen fix-2 source. GREEN: all 8 passed after the correction.
& './node_modules/.bin/vitest.cmd' run --root apps/mission-control-next src/cockpit/areas/work/WorkSchedules.portal.test.tsx src/cockpit/areas/work/WorkSchedules.test.tsx src/cockpit/areas/work/WorkScheduleEditor.test.tsx src/features/native-routes/ops/use-schedule-operations.test.tsx
# Affected lane: 51 passed, 1 old assertion expected the uncertain dialog to close automatically.
& './node_modules/.bin/vitest.cmd' run --root apps/mission-control-next src/cockpit/areas/work/WorkSchedules.test.tsx -t 'locks further actions after an unconfirmed mutation outcome'
# Corrected regression requires accessible in-dialog alert/disabled Confirm, then Keep schedule and all actions still locked: 1 passed, 19 skipped.
node scripts/run-with-worktree-output-lock.mjs --label=task9-fix3:typecheck -- pnpm --filter @goatcitadel/mission-control-next typecheck
# PASS, exit 0.
git diff --check
# PASS, exit 0.
```

No broad green suite, unrelated formatting, root QA script, process stack, profile/credential/runtime mutation, dependency addition or earlier Task 7 guard repair was performed. Per-history read entries use the existing QueryClient lifetime/GC; this is an admission correction, not performance or full-parity certification. All 233 prior row fields/IDs/order/evidence are preserved through additive affected owned schedule rechecks. Root still owns actual native dirty-leave/history/mobile/API acceptance. Earlier Tasks 12/13 guard carries, specialist schedule parity, external imports/execution, installed Windows/Ubuntu/global gates and Classic retirement remain open.

## Fix 4: persistent review feedback and canonical run approval association

Disposition: DONE_WITH_CONCERNS. Narrow source/test corrections complete; root owns fresh actual native acceptance. Source and output are frozen and released after this report and final checks. No staging, commits, new dependencies, subagents, primary-checkout edits, user-data changes, credentials or runtime mutations. No servers or database processes were started.

## Architectural findings and corrections

The prior real browser schedule conflict briefly appeared then disappeared after canonical same-record revalidation. The root-owned diagnostic stopped the run journey at its API assertion: actual Chat/fs.read admission had a pending canonical approval whose linkage.runId identified the admitted waiting run, while trace approval evidence was not_available/empty. This report does not claim an executed UI failure for that run. Diagnostic trace-linkage.json also records a different linkage.durableRunId; the two identities must remain distinct.

Schedule source: useScheduleOperations now accepts a separate optional feedback identity, defaulting to its existing mutation identity for other consumers. WorkSchedules supplies a stable review feedback identity that excludes selected revision, while keeping revision/history/workspace/installation/generation in mutation admission. Explicit invalidation still clears feedback. The action Dialog displays the captured reviewed configuration rather than silently replacing it with refreshed configuration. A different current revision produces an accessible persistent changed-during-review alert and disables the obsolete Confirm and Pause instead buttons. Existing preflight, expiry checks, fresh reads, installation checks, uncertain retry locks and receipts remain authoritative. Keep schedule closes the review without mutation and explicit re-review captures current settings.

Run source: dashboard-route-service.ts discovers reverse canonical associations through the existing async approval repository listPage owner, scoped by the existing runWorkspaceId helper. Up to five pages of 200 workspace approvals are read, including resolved/expired records for history. Only explicit linkage.runId or linkage.durableRunId equality attaches a record; same session alone never does. Known workspace/session mismatches are rejected. Missing or contradictory workspace scope performs no broadened scan. Missing scope, failed lifecycle/discovery reads, missing explicit IDs, repeated cursors and remaining pagination are unknown, retaining any known items. This bounded discovery can omit older records beyond the ceiling; it explicitly does not certify complete coverage in that case. No schema, SQL, dependencies, browser approval scan, execution authorization, approval resolution or durable-resume behavior changes. Existing trace redaction still projects the assembled response. WorkRunDetail keeps record-specific native Inbox owner links visible even when other evidence is unknown; the partial-evidence explanation stays visible.

## Regression and validation evidence

Commands ran from C:/Users/spurn/.codex/worktrees/cockpit-remediation/personal-ai:

- & './node_modules/.bin/vitest.cmd' run --root apps/mission-control-next src/cockpit/areas/work/WorkSchedules.portal.test.tsx -t 'retains the reviewed snapshot': RED, accessible alert count 0 after settled refresh. GREEN after correction; strengthened before-confirmation and after-rejected-preflight variants: 2 passed, 8 skipped. Uses the actual QueryClient and shared Radix portal, excludes aria-hidden background, waits for invalidation, canonical query settlement and a later task, checks retained original snapshot, blocked confirmation, no pause write, dismissal and explicit current re-review.
- & './node_modules/.bin/vitest.cmd' run --root apps/gateway src/services/dashboard-route-service.test.ts -t canonical: RED, four new canonical linkage/partial-discovery assertions failed against the frozen source (one existing matching test passed). Both actual linkage directions and failed/truncated coverage reproduced.
- & './node_modules/.bin/vitest.cmd' run --root apps/gateway src/services/dashboard-route-service.test.ts: GREEN, 22 passed after implementation and extra pagination/resolved-history/missing-or-contradictory-scope regressions. Then an additional lifecycle-unavailable case was added and the focused '-t canonical approval discovery' lane passed 3 with 20 skipped (23 cases total). Earlier legacy fixtures lacking workspace now correctly expect unknown coverage; their known evidence remains present.
- & './node_modules/.bin/vitest.cmd' run --root apps/mission-control-next src/cockpit/areas/work/WorkSchedules.portal.test.tsx src/cockpit/areas/work/WorkSchedules.test.tsx src/features/native-routes/ops/use-schedule-operations.test.tsx src/cockpit/areas/work/WorkRunDetail.test.tsx: GREEN, 48 passed. Added partial-native-owner rendering check subsequently: WorkRunDetail.test.tsx 3 passed. Added pre-confirmation refresh variant subsequently: portal focus 2 passed.
- node scripts/run-with-worktree-output-lock.mjs --label=task9-fix4:typecheck-gateway -- pnpm --filter @goatcitadel/gateway typecheck: PASS. Initial combined typecheck and first Gateway retry exposed TypeScript loop inference TS7022/TS7024; explicit ApprovalListResponse result annotation fixed it, final named command exit 0.
- node scripts/run-with-worktree-output-lock.mjs --label=task9-fix4:typecheck-ui -- pnpm --filter @goatcitadel/mission-control-next typecheck: PASS, exit 0. Runs the existing dependency build owner.
- pnpm verify:gateway:async-boundary: PASS, 16 scanner tests and 1126 production TypeScript files checked.
- git diff --check: PASS. Ledger/inventory mutation verifies JSON equality after removing only the new owned task_9_fix_4_recheck fields; all original 233 ledger rows/IDs/order/source fields/prior evidence retained.

An initial test-writing helper failed because the Python Windows app alias was unavailable; it wrote nothing. The following pre-write test invocation skipped the not-yet-added case and is not RED/GREEN proof. Actual RED evidence above was obtained after apply_patch added the tests. No broad suite, installed/native runtime, provider or live-resume proof was claimed.

## Exact changed files

- apps/gateway/src/services/dashboard-route-service.ts
- apps/gateway/src/services/dashboard-route-service.test.ts
- apps/mission-control-next/src/features/native-routes/ops/use-schedule-operations.ts
- apps/mission-control-next/src/cockpit/areas/work/WorkSchedules.tsx
- apps/mission-control-next/src/cockpit/areas/work/WorkSchedules.portal.test.tsx
- apps/mission-control-next/src/cockpit/areas/work/WorkRunDetail.tsx
- apps/mission-control-next/src/cockpit/areas/work/WorkRunDetail.test.tsx
- docs/ux/cockpit-remediation/task-9-validation.md
- docs/ux/cockpit-remediation/remediation-ledger.json (WK-02, WK-04, WK-05, WK-06 additive evidence)
- docs/ux/cockpit-remediation/classic-parity-inventory.json (ops/schedules and ops/run-detail additive evidence)
- Ignored requested task-9-fix-4-report.md and task-9-report.md under .superpowers/sdd/2026-10-05-cockpit-remediation.

## Self-review and limits

Reviewed action snapshots never become live mutation authority; revision-sensitive generation and the server preflight still gate every write. Same-record refresh cannot silently substitute the reviewed target. Shared uncertain locks survive dismissal. Server association uses exact canonical relationships and leaves original runId/durableRunId values intact; no wait mapping becomes original ownership and no same-session loose join creates an approval. The known owner link survives partial evidence without claiming completeness. Existing task labels, board/archive/designer behavior, prior receipts and automatic history-return reads were not changed. No Tasks 12/13 perf/typography repair, unrelated output writer, root QA helper or evidence rewrite occurred.

Root still must execute actual admitted native Work-run-to-Inbox approval, original durable continuation, tool-once, assistant and back/history proof plus actual schedule refresh/accessibility/mobile acceptance. Unit/service fixtures and Happy DOM portals do not replace that runtime proof. Specialist schedule parity, external template/native import/execution, Ubuntu, installed Windows, global release gates and Classic retirement remain false/open. Classic fallback retained.

## Root native acceptance closure — 2026-10-06

**Bounded Task 9 source/local/native acceptance is recorded; full row, route and release parity remain unverified.** This docs-only closure inspected the root controller's saved evidence and source review. It executed no browser journey, tests, builds or runtime writes. The approved fix-4 review closes both reported source gaps with no new Critical/Important findings. Root's subsequent actual native journeys close the specific pending run-association and schedule-refresh gates stated in that review. Earlier reports remain historical; this section supersedes only their pending claims covered below.

Root summary: `.superpowers/sdd/2026-10-05-cockpit-remediation/task-9-browser-fix-4-summary.json` — passed, 26 behavior checks across 22 loaded Windows Chromium cases using disposable local profiles and a deterministic provider. All 22 case records report zero serious/critical axe findings, page errors, body overflow and coarse-target violations; applicable phone controls passed the 44px check. These are the loaded cases, not a complete viewport/history matrix. Root reports viewing representative current phone stale-review, creation, archive, designer, missing-record and actual-completion screenshots. Review: `.superpowers/sdd/2026-10-05-cockpit-remediation/task-9-fix-4-review.md`.

- **Work/schedules:** `.superpowers/sdd/2026-10-05-cockpit-remediation/browser-proof/task-9-browser-fix-4-work/browser-evidence.json`. Search/task-versus-run filter, ordinary edit exactly once and stale draft retention passed. The phone stale review was rejected by actual fresh mutation preflight with zero writes, then retained an accessible changed-during-review warning after canonical refresh and axe/layout settlement. Obsolete Confirm remained disabled; Keep schedule closed with zero writes. Pause/delete cancellation and exact canonical receipts/absence passed.
- **Navigation/creation:** `.superpowers/sdd/2026-10-05-cockpit-remediation/browser-proof/task-9-browser-fix-4-navigation/browser-evidence.json`. Same-mounted selection invalidates obsolete reviews; history return performs its fresh authorized GET automatically. Explicit saved timezone, malformed configuration zero writes, advanced edit Cancel zero/Save one with canonical settings, dirty Cancel/Keep draft zero writes, schedule creation one canonical record plus visible receipt, task creation exactly once and honest mixed-source counts passed.
- **Preserved advanced evidence:** `.superpowers/sdd/2026-10-05-cockpit-remediation/browser-proof/task-9-browser-fix-3-advanced/browser-evidence.json`. This is successful fix-3 native evidence retained because fix 4 did not change these owners. Actual failed bulk retained selection and canonical blocked records; distinct fresh records then completed with one bulk POST and two revisions. Archive/restore Cancel made zero writes; confirmed operations canonically soft-deleted then restored the records. Actual advisory designer preview and both JSON clipboard exports passed without Cron activation. It does not prove external import/execution or every specialist archive action.
- **Actual admitted run:** `.superpowers/sdd/2026-10-05-cockpit-remediation/browser-proof/task-9-browser-fix-4-final-2-run/run-evidence.json`. Public Chat/fs.read admission exposed the exact pending approval in native Work. The record-specific link opened Inbox; one Approve caused exactly one resolve, persisted approved state, completed the original durable run, executed the exact tool once and retained assistant evidence. Back displayed Done while canonical status was completed. A 503 trace failure showed unavailable evidence without forging execution; canonical completion, tool and assistant evidence remained unchanged afterward. Actual 404 missing run/task states settled clearly on phone. No manufactured continuation/resolved state substitutes for this journey.

Excluded helper attempts remain distinct from product regressions: unsupported annual cron input, an obsolete enabled-Save click, and hardcoded generic Chat-turn heading/Completed label assumptions were helper failures (the actual UI uses the admitted request and Done). They are not acceptance evidence. The real product failures corrected in fixes 1–4 remain documented as product defects; final passing evidence does not rewrite those earlier failures. The fix-3 advanced evidence above is deliberately preserved, not represented as a newly rerun fix-4 batch.

Ledger closure is additive and per criterion. All 233 original IDs/order/source fields, previous status fields and evidence remain unchanged. New owned-row acceptance records state both the covered behavior and remaining sub-batch gate: failed-run cause/recovery (WK-03), task-detail run/conversation linkage (WK-07), complete board waiting grouping (WK-06), full failure/secondary-evidence variants, large Done/history bounds and specialist action matrices are not blanket-certified. Inventory rechecks likewise cover only the verified native actions; parity_verified remains false and Classic fallback remains available.

Tasks 15–17, full historical/mobile matrices, specialist runtime/archive actions, external imports/execution, performance/load, Ubuntu, installed-host delivery, live providers, global release acceptance, complete parity and Classic retirement remain explicit open gates. Approval discovery bounds returned pages, not total repository rows scanned internally; no performance certification is inferred. Root reports all QA sessions 84846/28989/93778 cleaned and closed. Source/product code stayed frozen; this closure changed only task-9-validation.md, owned ledger/inventory evidence and the ignored task-9-report.md. Documentation/source/output are released after preservation checks.
