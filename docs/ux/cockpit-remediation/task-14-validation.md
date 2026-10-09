# Task 14 Projects validation — 2026-10-06

Source and focused tests are provisional. Root supplies actual API/browser acceptance after FULL source/output freeze; no full parity, retirement, release, installed-host, Ubuntu or live-provider proof is claimed.

## Changes and source owners

Native /chat/projects and /chat/projects/:projectId are lazy children of the existing Chat area. The shared compatibility resolver maps legacy Projects identifiers/query/hash to those destinations; explicit Classic remains. CockpitShell keeps retained conversation state but hides its Activity effects while Projects owns the view; CockpitApp never publishes a Projects page as a visible conversation. Conversation URL reconciliation cannot overwrite a Projects destination. An assignment target survives only same-conversation reconciliation.

The canonical scoped GET list (active/archived/all; no GET by ID) remains the detail authority. Create collects name, workspace path, description and color; update/archive/restore retain positive expectedRevision. Missing/foreign/archived/error/stale states are visible. Conflict refresh keeps local input and exposes current fields before the explicit Use current revision with my draft retry. Existing transient-draft and dirty-history owners protect leave/Back. List search/filter and native pin presentation are scoped by installation/caller/Citadel/workspace. Native pins use the existing pin owner with an optional isolated presentation scope; previous Classic pin keys remain intact.

Projects assignment opens the exact existing conversation, then uses useProjectSwitchReview plus the Task4 selection/leave transition and the original palette/controller persistence owner. Cancel makes no assignment; active caller/access/Gateway/context revisions are checked. No new assignment API owner was introduced.

The actual Classic ProjectAutomaticFanoutCard now shares useProjectFanout with the native ProjectFanout renderer. Expiry validates before ISO conversion. Scope/generation guards reject late reads/writes across project/caller/access/Gateway changes. Confirm rereads the project without cache and current grants before the single existing create call. Exact workspace/project, Chat-only, subagent_fanout-only, agent.fanout tool/capability patterns, protocol caution risk, positive activation limit and finite budget/expiry remain unchanged. New defaults: one hour, three activations, $0.75; 1 day/7 days remain choices and until-revoked explicitly remains unsupported by this server owner. The server stamps the caller. Revoke reads canonical grant history again; it does not prove child execution or completed child cancellation.

Native grant risk uses the shared Medium risk presentation; protocol caution is unchanged. Secondary identifiers/revisions follow TechnicalDetails. Readable target, workspace, workspace path, expiry, limits, conflict content, consequences and policy remain visible. Existing fonts/themes, responsive primitives and 44px coarse-pointer/focus rules remain unchanged.

Local-folder/GitHub import remains the existing CodeSourceChooser/useChatSessionControls capability. A reviewed Classic Chat continuation is exposed; project home/intake/artifacts retain a separate Classic Projects continuation. These are pending Task15 ports, not invented runtime restrictions. Hard-delete remains its existing API capability; no hard-delete action was added or conflated with archive, and the original ProjectsRoutePage has no hard-delete button to port.

Owned paths (no primary checkout edits):

- apps/mission-control-next/src/cockpit/app/CockpitApp.tsx
- apps/mission-control-next/src/cockpit/app/CockpitShell.test.tsx
- apps/mission-control-next/src/cockpit/app/CockpitShell.tsx
- apps/mission-control-next/src/cockpit/areas/chat/ChatArea.route-sync.test.tsx
- apps/mission-control-next/src/cockpit/areas/chat/ChatArea.tsx
- apps/mission-control-next/src/features/native-routes/projects/ProjectAutomaticFanoutCard.tsx
- apps/mission-control-next/src/cockpit/app/CockpitApp.presence.test.tsx
- apps/mission-control-next/src/cockpit/app/cockpit-compatibility.test.ts
- apps/mission-control-next/src/cockpit/app/cockpit-compatibility.ts
- apps/mission-control-next/src/cockpit/areas/chat/ChatTextComposer.project-review.test.tsx
- apps/mission-control-next/src/features/threaded-surface/useProjectSwitchReview.ts
- apps/mission-control-next/src/cockpit/areas/chat/ChatProjects.test.tsx
- apps/mission-control-next/src/cockpit/areas/chat/ChatProjects.tsx
- apps/mission-control-next/src/cockpit/areas/chat/ProjectAssignmentReview.tsx
- apps/mission-control-next/src/cockpit/areas/chat/ProjectDetail.tsx
- apps/mission-control-next/src/cockpit/areas/chat/ProjectEditor.tsx
- apps/mission-control-next/src/cockpit/areas/chat/ProjectFanout.test.tsx
- apps/mission-control-next/src/cockpit/areas/chat/ProjectFanout.tsx
- apps/mission-control-next/src/features/native-routes/projects/use-project-access.ts
- apps/mission-control-next/src/features/native-routes/projects/use-project-fanout.ts
- apps/mission-control-next/src/cockpit/app/area-loaders.ts
- apps/mission-control-next/src/features/native-routes/projects/ProjectAutomaticFanoutCard.test.tsx
- apps/mission-control-next/src/features/native-routes/projects/ProjectsRoutePage.tsx
- apps/mission-control-next/src/features/native-routes/projects/use-project-pin-archive.ts
- apps/mission-control-next/src/cockpit/areas/chat/use-chat-owner-navigation.ts
- docs/ux/cockpit-remediation/remediation-ledger.json
- docs/ux/cockpit-remediation/classic-parity-inventory.json
- docs/ux/cockpit-remediation/task-14-validation.md

## Validation commands and results

- PASS, 12 app test files / 149 tests:

```powershell
& '.\node_modules\.bin\vitest.cmd' run --root apps/mission-control-next src/cockpit/areas/chat/ChatProjects.test.tsx src/cockpit/areas/chat/ProjectFanout.test.tsx src/features/native-routes/projects/ProjectAutomaticFanoutCard.test.tsx src/features/native-routes/projects/ProjectsRoutePage.test.tsx src/cockpit/app/CockpitApp.presence.test.tsx src/cockpit/app/CockpitShell.test.tsx src/cockpit/app/cockpit-compatibility.test.ts src/cockpit/areas/chat/ChatTextComposer.project-review.test.tsx src/cockpit/areas/chat/ChatArea.route-sync.test.tsx src/cockpit/areas/chat/ChatArea.held-back.test.tsx src/cockpit/areas/chat/ChatArea.visible-session.test.tsx src/cockpit/app/use-cockpit-scroll.test.tsx
```

- PASS, existing Gateway fan-out restrictions: 1 file / 8 tests. Command: `& '.\node_modules\.bin\vitest.cmd' run --root apps/gateway src/services/autonomous-activation-grant-service.test.ts`.
- PASS, shared scoped project API and revision serialization: 1 file / 18 tests. Command: `& '.\node_modules\.bin\vitest.cmd' run --root packages/mission-control-shared src/api/chat.test.ts`.
- PASS, output-lock wrapper and app/shared/core typechecks: `node scripts/run-with-worktree-output-lock.mjs --label=task14-final-typecheck -- pnpm --filter @goatcitadel/mission-control-next typecheck`.
- PASS, strict lint of nine new source/test files: `pnpm exec eslint apps/mission-control-next/src/cockpit/areas/chat/ChatProjects.test.tsx apps/mission-control-next/src/cockpit/areas/chat/ChatProjects.tsx apps/mission-control-next/src/cockpit/areas/chat/ProjectAssignmentReview.tsx apps/mission-control-next/src/cockpit/areas/chat/ProjectDetail.tsx apps/mission-control-next/src/cockpit/areas/chat/ProjectEditor.tsx apps/mission-control-next/src/cockpit/areas/chat/ProjectFanout.test.tsx apps/mission-control-next/src/cockpit/areas/chat/ProjectFanout.tsx apps/mission-control-next/src/features/native-routes/projects/use-project-access.ts apps/mission-control-next/src/features/native-routes/projects/use-project-fanout.ts --max-warnings=0`.
- PASS, individual design guards: `node scripts/check-mission-control-next-legacy-usage.mjs`, `node scripts/check-mission-control-next-token-drift.mjs`, `node scripts/check-mission-control-next-typography.mjs`, `node scripts/check-mission-control-next-breakpoints.mjs`, `node scripts/check-mission-control-next-buttons.mjs`, `node scripts/check-mission-control-next-scroll-contracts.mjs`, `node scripts/check-mission-control-next-icon-sizing.mjs`, `node scripts/check-mission-control-next-contrast.mjs`. Both retained theme token pairs pass contrast checks; this is not browser visual proof.
- PASS, `git diff --check`.
- BLOCKED after passing Cockpit class/copy checks: `pnpm --filter @goatcitadel/mission-control-next perf:check` by earlier WorkBoard.tsx:136 tasks/runs refetch branch. The Task16 owner retains this blocker; no budget/guard was relaxed.
- BLOCKED, 7/8 checks pass: `pnpm verify:design:quality` by earlier __testbench__/ui/testbench.css raw-color count132 versus allowed92. No token budget changes were made.

Earlier failed checks were repaired: missing record citadelId references now use the active scoped input; the presence fixture now supplies route.rest; shared fan-out uses stable owner callbacks; disclosure tests distinguish visible context from technical details. The final results above supersede those implementation iterations.

## Preservation and self-review

The immutable task-14-before.json contains 501 pre-existing dirty paths. The final ignored task-14-preservation.json compares every snapshot byte against the worktree and permits only the declared Task14 owner paths, records the unchanged snapshot hash, and verifies all original ledger/inventory fields and array order/evidence prefixes. The 233 findings and 148 inventory rows remain. No finding is owned by Task14; ledger metadata is additive. Only projects/root and projects/detail receive additive inventory annotations/evidence, with parity_verified still false.

Self-review checked public API signatures, original Classic actions, current actor/access identity, no-store project preflight, one-click consumption, finite expiry validation, late async guards, draft and conflict preservation, hidden Chat effects/presence, assignment-query lifetime, and Task6 risk/disclosure controls. Root actual acceptance remains required. Native list reads are bounded at300 projects and200 recent conversations, explicitly labeled; older conversation assignment remains available through Chat history. Classic source and rollback were retained.

No dependency, Gateway policy, runtime data/config/profile/secret, OS custody, root QA helper, stage/commit/push/merge, external GitHub import, or child-agent operation was performed. No runtime/server was started. Final ownership hashes and lock/process status are in the ignored task-14-preservation.json and task-14-report.md.

## Fix round 1 — T14-R1 and T14-R2, 2026-10-06

Source and test corrections only; root actual post-fix phone geometry, supported-alias browser journeys and scoped independent re-review remain required. Prior red artifacts are retained and not relabeled. No root helper/runtime was edited or launched here.

- T14-R1: isCockpitConversationLocation in cockpit-compatibility.ts resolves the live pathname/query/hash through existing compatibility and route owners. use-chat-owner-navigation.ts uses this predicate instead of the raw /chat-only check. Supported / and /chat/ admit conversation requests/publication; resolved Projects, Classic and missing destinations do not. Existing history/generation/canonical-evidence guards and same-conversation assignment query lifetime are unchanged.
- T14-R2: ProjectEditor uses a width-bounded zero-minimum single-column grid, full-value wrapping, and a wrapping maximum-width rebase control. Shared Callout only adds min-width/maximum-width and flex-child shrink/wrap constraints. No content is hidden or truncated to meet geometry. Existing Field/Button, draft values, revision guards and conflict reconciliation remain.
- New ChatArea.alias-navigation.test.tsx tests actual request plus canonical selection publication from both aliases, then actual useManualChatSessionCreation create/status/readback/selection through the publication owner from both aliases. It also checks all three legacy/native Projects entry shapes cannot be overwritten by retained selection.
- Strengthened ChatProjects.test.tsx sends a long unbroken canonical path and full error through the actual revision-conflict UI, checks complete values survive and the original draft/path persist, then exercises the explicit current-revision retry. Happy DOM tests do not establish actual pixel bounds.
- Shared Callout consumer coverage: LibraryNoteEditor.test.tsx, WorkScheduleEditor.test.tsx and HealthOverview.access.test.tsx retain their actual semantic/actions/access assertions. No blanket consumer restyle or new policy was introduced.

Owned fix paths:

- apps/mission-control-next/src/cockpit/app/cockpit-compatibility.ts
- apps/mission-control-next/src/cockpit/areas/chat/use-chat-owner-navigation.ts
- apps/mission-control-next/src/cockpit/areas/chat/ProjectEditor.tsx
- apps/mission-control-next/src/cockpit/ui/Callout.tsx
- apps/mission-control-next/src/cockpit/areas/chat/ChatArea.alias-navigation.test.tsx
- apps/mission-control-next/src/cockpit/areas/chat/ChatProjects.test.tsx
- docs/ux/cockpit-remediation/task-14-validation.md
- docs/ux/cockpit-remediation/remediation-ledger.json
- docs/ux/cockpit-remediation/classic-parity-inventory.json

Commands/results (all completed, real exit code0):

```powershell
& '.\node_modules\.bin\vitest.cmd' run --root apps/mission-control-next src/cockpit/areas/chat/ChatArea.alias-navigation.test.tsx src/cockpit/areas/chat/ChatProjects.test.tsx src/cockpit/areas/chat/ProjectFanout.test.tsx src/features/native-routes/projects/ProjectAutomaticFanoutCard.test.tsx src/features/native-routes/projects/ProjectsRoutePage.test.tsx src/cockpit/app/CockpitApp.presence.test.tsx src/cockpit/app/CockpitShell.test.tsx src/cockpit/app/cockpit-compatibility.test.ts src/cockpit/areas/chat/ChatTextComposer.project-review.test.tsx src/cockpit/areas/chat/ChatArea.route-sync.test.tsx src/cockpit/areas/chat/ChatArea.held-back.test.tsx src/cockpit/areas/chat/ChatArea.visible-session.test.tsx src/cockpit/app/use-cockpit-scroll.test.tsx src/cockpit/areas/library/LibraryNoteEditor.test.tsx src/cockpit/areas/work/WorkScheduleEditor.test.tsx src/cockpit/areas/system/HealthOverview.access.test.tsx
# 16 files / 171 tests passed
node scripts/run-with-worktree-output-lock.mjs --label=task14-fix1-typecheck -- pnpm --filter @goatcitadel/mission-control-next typecheck
pnpm exec eslint apps/mission-control-next/src/cockpit/app/cockpit-compatibility.ts apps/mission-control-next/src/cockpit/areas/chat/use-chat-owner-navigation.ts apps/mission-control-next/src/cockpit/areas/chat/ProjectEditor.tsx apps/mission-control-next/src/cockpit/ui/Callout.tsx apps/mission-control-next/src/cockpit/areas/chat/ChatArea.alias-navigation.test.tsx apps/mission-control-next/src/cockpit/areas/chat/ChatProjects.test.tsx --max-warnings=0
```

The following named checks each passed: `node scripts/check-mission-control-next-cockpit-classes.mjs`, `node scripts/check-mission-control-next-cockpit-copy.mjs`, `node scripts/check-mission-control-next-legacy-usage.mjs`, `node scripts/check-mission-control-next-token-drift.mjs`, `node scripts/check-mission-control-next-typography.mjs`, `node scripts/check-mission-control-next-breakpoints.mjs`, `node scripts/check-mission-control-next-buttons.mjs`, `node scripts/check-mission-control-next-scroll-contracts.mjs`, `node scripts/check-mission-control-next-icon-sizing.mjs`, `node scripts/check-mission-control-next-contrast.mjs`. `git diff --check` passed. Earlier WorkBoard refetch and Testbench color blockers were not changed or waived; no broader performance/visual/installed/Ubuntu gate is claimed.

Self-review re-read supported alias resolution and raw URL/history checks, confirmed the helper excludes Projects and explicit Classic, checked actual verified creation publication and unchanged assignment-target lifetime, then checked every intrinsic-width link from the editor grid through Callout flex content and the multiword rebase control. Root owns the actual390px right-edge measurements in both themes. Source corrections do not themselves certify those measurements.

Immutable task-14-fix-1-before.json captures515 paths. Fix1 preservation/hashes are recorded separately in task-14-fix-1-preservation.json and task-14-fix-1-owned-paths.json; original snapshot and prior reports remain intact. All233 finding rows and148 inventory rows preserve original fields/order/evidence; annotations are additive only. FULL SOURCE/OUTPUT release is recorded in task-14-fix-1-report.md after the final audit. No task runtime/server, children, Git operation, dependencies, real runtime/profile/config/secret/custody/OS or external side effect.

## Task14 fix2: parent grid track sizing (2026-10-06)

Root's fix1 container diagnostic remains historical RED: at 390px, ProjectDetail's 358px parent had a 386px implicit auto track and the complete editor reached x402. This round changes only ProjectDetail.tsx's immediate parent grid to grid-cols-1, the existing Tailwind minmax(0, 1fr) utility. The explicit zero minimum prevents child intrinsic width from expanding that track. Complete conflict values, draft/revision reconciliation, controls, and all shared styles remain unchanged. No overflow hiding or truncation was added. The existing long-path conflict test remains substantive semantic coverage; no test that merely asserts the class string was added. Root exclusively owns actual browser geometry, screenshots and scoped re-review.

Exact executed checks (all exit 0):

~~~powershell
& '.\node_modules\.bin\vitest.cmd' run --root apps/mission-control-next src/cockpit/areas/chat/ChatProjects.test.tsx src/cockpit/areas/chat/ProjectFanout.test.tsx src/cockpit/areas/chat/ChatTextComposer.project-review.test.tsx src/cockpit/app/CockpitShell.test.tsx
# 4 files / 61 tests passed, including retained long canonical conflict path/error, draft and explicit revision retry.
node scripts/run-with-worktree-output-lock.mjs --label=task14-fix2-typecheck -- pnpm --filter @goatcitadel/mission-control-next typecheck
& '.\node_modules\.bin\eslint.cmd' apps/mission-control-next/src/cockpit/areas/chat/ProjectDetail.tsx --max-warnings=0
node scripts/check-mission-control-next-cockpit-classes.mjs
node scripts/check-mission-control-next-token-drift.mjs
node scripts/check-mission-control-next-breakpoints.mjs
node scripts/check-mission-control-next-scroll-contracts.mjs
git diff --check
~~~

Self-review compared the measured ancestor chain against the actual ProjectDetail owner and confirmed the patch is one sizing utility; it does not alter event handlers, Gateway scopes, revisions, saved values, the editor's prior wrapping, or shared components. Only that source and this appended evidence document are owned. Fix2 metadata records immutable 516-path preservation, exact hashes and the unchanged 233/148 original rows/order/evidence. Earlier evidence is retained. Root's post-fix complete-container geometry and independent review remain pending; no full parity, installed/Ubuntu/provider/runtime or broader Task16 acceptance is claimed. No runtime/server, children, dependencies, Git state, root helper or real profile/data/custody/OS changes were made. FULL SOURCE/OUTPUT freeze is recorded after the final audit in task-14-fix-2-report.md.

## Task14 fix3: native fan-out card bounds (2026-10-06)

Root's fix2 diagnostic confirms the complete editor now fits x16-374/358px, but records a distinct fan-out sibling overflow: its implicit 352px track exceeds 324px of card content, with the intrinsic Grant lifetime preset select and sibling controls extending to x385. This correction is local to ProjectFanout.tsx: card, draft, recorded-grant and review grids now have a zero-minimum single column; the preset select and editable inputs use full available width with zero-minimum/maximum-width bounds. Existing labels, complete saved values, disabled Until revoked explanation, one-hour/finite defaults, grant state, risk display, reviews and guarded hook remain unchanged. No shared styles, Classic component or grant logic were edited. No overflow hiding, truncation, style-only mirrored test or new dependency was added.

Exact executed commands (all exit 0):

~~~powershell
& '.\node_modules\.bin\vitest.cmd' run --root apps/mission-control-next src/cockpit/areas/chat/ProjectFanout.test.tsx src/features/native-routes/projects/ProjectAutomaticFanoutCard.test.tsx src/features/native-routes/projects/ProjectsRoutePage.test.tsx src/cockpit/areas/chat/ChatProjects.test.tsx
# 4 files / 32 tests passed: native review/defaults/cancel/limits/scope and Classic shared owner, plus retained Projects conflict/draft/revision flow.
node scripts/run-with-worktree-output-lock.mjs --label=task14-fix3-typecheck -- pnpm --filter @goatcitadel/mission-control-next typecheck
& '.\node_modules\.bin\eslint.cmd' apps/mission-control-next/src/cockpit/areas/chat/ProjectFanout.tsx --max-warnings=0
node scripts/check-mission-control-next-cockpit-classes.mjs
node scripts/check-mission-control-next-token-drift.mjs
node scripts/check-mission-control-next-breakpoints.mjs
node scripts/check-mission-control-next-scroll-contracts.mjs
git diff --check
~~~

Self-review traced the actual measured card -> draft grid -> Field block -> intrinsic select chain, checked the shared Field owner without changing it, and re-read the bounded local grids and controls. Source and semantic tests do not prove pixel geometry. Root exclusively owns post-freeze browser card/control/sibling bounds across four variants and scoped independent review. Earlier RED artifacts remain intact. No full-parity or broader Task16/installed/Ubuntu/provider/runtime gate is claimed. Exact immutable516 preservation and two owned hashes appear in task-14-fix-3-preservation.json; all prior validation text remains an exact byte prefix, 233/148 originals/order/evidence preserved, ledger/inventory untouched. No runtime/server, children, Git/state/dependency/root-helper/real profile/data/custody/OS or external effects. Final FULL SOURCE/OUTPUT freeze is recorded in task-14-fix-3-report.md.

## Task14 accepted native Projects slice (2026-10-06)

Root completed disposable Windows production-preview/public Gateway acceptance and exact factory cleanup. The accepted manifest at .superpowers/sdd/2026-10-05-cockpit-remediation/task-14-accepted-evidence.json records accepted=true, fullParityCertified=false, **25 behavior groups / 84 loaded audits across five helpers**. Root's accepted-evidence validator exited 0. This documentation closure reads that proof; it does not rerun runtime, builds or tests.

| Evidence | Groups | Audits | Provenance |
|---|---:|---:|---|
| .superpowers/sdd/2026-10-05-cockpit-remediation/browser-proof/task-14-fix-3-root-project-crud/project-crud-evidence.json | 5 | 16 | fresh_fix3 |
| .superpowers/sdd/2026-10-05-cockpit-remediation/browser-proof/task-14-fix-3-root-assignment-fanout/assignment-fanout-evidence.json | 7 | 16 | fresh_fix3 |
| .superpowers/sdd/2026-10-05-cockpit-remediation/browser-proof/task-14-fix-3-root-conflict-draft/conflict-draft-evidence.json | 5 | 12 | fresh_fix3 |
| .superpowers/sdd/2026-10-05-cockpit-remediation/browser-proof/task-14-fix-1-root-navigation-presence/navigation-presence-evidence.json | 5 | 16 | retained_fix1_unchanged_source |
| .superpowers/sdd/2026-10-05-cockpit-remediation/browser-proof/task-14-fix-1-root-chat-aliases/chat-aliases-evidence.json | 3 | 24 | retained_fix1_unchanged_source |

Fresh fix3 affected suite totals 17 groups/44 audits; retained fix1 navigation and real '/'/'/chat/' alias checks supply the other 8 groups/40 audits. Independent scoped reviews task-14-fix-1-review.md, task-14-fix-2-review.md and task-14-fix-3-review.md approve the respective source fixes with zero new scoped findings. Root subsequently inspected fresh phone light/dark grant-review and conflict screenshots and desktop screenshots.

At 390px in both phone themes, the complete editor spans x16-374 (358px) inside its 358px parent, whose scrollWidth is also358. The fan-out card is358px with clientWidth=scrollWidth=356; its content controls occupy x33-357/324px. Spilling sibling nodes are0. Projects/main client and scroll widths are390. These measurements check editor, owning column, sibling card/control bounds and tested ancestor scroll widths, beyond document-level overflow. Four desktop/phone/theme variants passed the affected semantic/geometry checks.

Historical evidence remains unchanged and is excluded from the accepted totals:
- task-14-root: Initial two root fixture errors; original phone clipping remains actual historical product evidence.
- task-14-conflict-layout-diagnostic: Original actual clipped controls; superseded only by separate fresh successful source and geometry checks.
- task-14-fix-1-root-assignment-fanout: Root exact text locator omitted the labelled callout prefix.
- task-14-fix-1-fanout-corrected-assignment-fanout: Root raw-caller assertion omitted canonical public secret redaction.
- task-14-fix-1-root-conflict-draft: Semantics and control bounds pass, but full parent/container geometry was not checked.
- task-14-fix-1-container-diagnostic: Actual residual parent auto-track overflow after fix1.
- task-14-fix-2-root-conflict-draft: Editor geometry corrected, but actual sibling fan-out panel overflow remains.
- task-14-fix-2-parent-sibling-diagnostic: Actual scoped diagnostic identifies intrinsic lifetime-selector/auto-grid overflow in the fan-out card.

Failed manifests retain their original failed results. Earlier fixture errors and actual product clipping are distinct; fresh successful evidence supersedes the actual defects without rewriting history.

Grant metadata proof compares the Gateway public secret projection, confirms replacement of a client-supplied grantor and actual scoped creation/revocation. It does not expose or prove exact stored-caller identity through the redacted response; authenticated server actor stamping is supported by current source. Grant records do not prove child dispatch, completed delegation or stopped children. No actual child-execution claim is made.

This accepts only the native Projects slice: metadata/list/detail/pin/create/edit/archive/restore, existing reviewed assignment, finite governed fan-out grants, drafts/conflicts and scoped navigation/presence. Working local-folder/GitHub imports, project home/intake/artifacts and remaining inventory actions continue to Task15 through explicit Classic continuations. No entire Projects row or global parity is certified, no ownership/import history is changed, and all existing parity flags remain false. Saved Classic preference and explicit query rollback remain. Ubuntu visual, installed-host, live-provider, real-repository/external GitHub, full PostgreSQL and Stable-cycle retirement gates remain open.

Docs-only closure owns exactly this append plus additive acceptance annotations in remediation-ledger.json and the two Projects rows in classic-parity-inventory.json. Original233/148 fields/statuses/criteria/order/evidence and earlier annotations remain intact. Coverage guard and git diff --check are the only executed validation lanes; exact before/after hashes and frozen product preservation are recorded in task-14-final-closure-report.md. FULL SOURCE/OUTPUT/DOCS release follows that audit.
