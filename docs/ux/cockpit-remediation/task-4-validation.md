# Task 4 validation: composer wrapping and project reassignment

Source and focused tests are provisional pending independent review and the controller's final browser pass. No commit, staging, publication, dependency addition or primary-profile mutation was performed.

## Implementation

- `apps/mission-control-next/src/cockpit/areas/chat/ChatComposerControls.tsx` removes desktop nowrap/horizontal scrolling. Phone Options and its existing 44px Review control remain.
- `apps/mission-control-next/src/features/threaded-surface/useProjectSwitchReview.ts` extracts Classic's project candidate review into a shared presentation owner. Classic `ThreadedComposer.tsx` and Cockpit `ChatTextComposer.tsx` render their native dialogs; `ChatComposerPalette.tsx` routes selection through the review.
- `packages/threaded-surface-core/src/chat/MissionControlActiveSessionSurface.tsx` and `controller/createChatActiveSessionPresentation.ts` expose authorized canonical session/project revision, workspace/path and mutation state for review.
- Native confirmation uses existing `cockpit/areas/chat/use-chat-owner-navigation.ts` selection review. Current installation, Citadel/workspace, session/project revisions, draft/attachments, destination catalog, composition and busy state are rechecked. Cancellation dispatches no palette assignment callback. Changed or unavailable context fails closed; confirmation is consumed once.
- Persistence remains `useChatComposerPaletteActions.ts` → `useChatSessionControls.ts` → existing Gateway assignment API, with expected revision/conflict refresh. The existing assignment owner now suppresses response refresh that could reselect a conversation after scope/selection changes.
- Review warns of the Gateway's actual workbench file/worktree/diff/output/validation reset (`apps/gateway/src/services/chat-session-service.ts:resetWorkbenchForProjectChange`), while turns, draft and attachments remain.

## Executed verification

From repository root:

```powershell
& './node_modules/.bin/vitest.cmd' run --root apps/mission-control-next src/cockpit/areas/chat/ChatTextComposer.project-review.test.tsx src/cockpit/areas/chat/ChatTextComposer.test.tsx src/cockpit/areas/chat/ChatComposerControls.test.tsx src/features/threaded-surface/ThreadedComposer.test.tsx src/features/threaded-surface/ThreadedComposer.steering.test.tsx
& './node_modules/.bin/vitest.cmd' run --root packages/threaded-surface-core src/chat/useChatSessionControls.test.tsx
node scripts/run-with-worktree-output-lock.mjs --label=task-4-typecheck -- pnpm --filter @goatcitadel/mission-control-next typecheck
git diff --check
```

Results: frontend 5 files / 114 tests passed; after the Citadel identity fix, project-review file 22 tests and shared assignment owner 9 tests passed; guarded frontend typecheck (including dependency builds) passed; diff check passed. The new project-review test invokes actual palette and session-control hooks with the assignment API boundary mocked, covering Cancel/no API or URL mutation, current conversation/revision, changed scope/session/project/revisions/draft/attachments/catalog, delayed/cancelled leave review, Citadel ABA, active stream/composition, duplicate confirmation and late response after selecting another conversation or changing Citadel identity away and back. Existing owner test confirms 409 refresh without replay and retained callback rejection after identity ABA. No full frontend rerun was needed.

## Evidence boundaries

Owned ledger rows: CH-04 and N-08. Their imported fields and all other rows are preserved; implementation status remains pending independent verification.

The controller reported final browser proof on its disposable testbench: desktop 1440x900 dark, phone 390x844 light Options, and real 639.2 CSSpx/DPR1.25 all show Review unclipped without body overflow/page errors; phone Review remains 44px. Root also exercised actual destination review, Cancel with no assignment API or changed canonical source project, and confirmation with exactly one POST plus fresh canonical GET proving destination assignment. Evidence is attributed to the controller in `.superpowers/sdd/2026-10-05-cockpit-remediation/browser-proof/task-4-project-flow.json` and `task-4-final-{desktop,phone,fractional}.json/.png`. This implementer did not execute those browser checks. Independent review remains open. Ubuntu, installed Windows host and external/provider profiles were not validated. The existing 639px JS / 640px CSS responsive boundary is a Task 6 follow-up, unchanged here. Native metadata project selector review is Task 14, outside this palette scope.

Self-review raised a Citadel-only late-response gap, then resolved it using the existing owner scope ref plus `viewIdentity` generation (actual `useChatSessionComposition.ts` maps activeCitadelId). Old callbacks and responses fail the captured token check even after an ABA switch; persistence already completed is preserved.

## Fix round 1: selection during the sidebar read

Independent review identified a second asynchronous interval: assignment could succeed, start a sidebar read, then restore its earlier conversation when that read settled after a newer local selection. `packages/threaded-surface-core/src/chat/useChatSessionControls.ts` now requests the existing `preserveSelection: true` option for success and fallback conflict refresh. Its supplied aggregate conflict refresh receives that same option through the existing `controller/useChatSessionComposition.ts` owner. Other aggregate callers retain their existing defaults; canonical data refresh, expected revision, conflict error handling and scope/ABA guards remain.

`packages/threaded-surface-core/src/chat/useChatSessionData.test.tsx` now composes actual session controls with the actual data owner and delays the API sidebar read after successful assignment or a 409 conflict, changes local selection, then resolves the read. Both regressions failed before the fix with expected `session-2`, received `session-1`; after the fix the fresh assignment record updates while `session-2` remains selected. `useChatSessionControls.test.tsx` additionally checks option forwarding to the supplied aggregate owner. Native project-review tests preserve all earlier behaviors.

Executed commands:

```powershell
& './node_modules/.bin/vitest.cmd' run --root packages/threaded-surface-core src/chat/useChatSessionData.test.tsx src/chat/useChatSessionControls.test.tsx
& './node_modules/.bin/vitest.cmd' run --root apps/mission-control-next src/cockpit/areas/chat/ChatTextComposer.project-review.test.tsx
node scripts/run-with-worktree-output-lock.mjs --label=task-4-fix-1-typecheck -- pnpm --filter @goatcitadel/mission-control-next typecheck
git diff --check
```

Results: shared 2 files/42 tests passed; native 1 file/22 tests passed; guarded frontend/dependency typecheck passed; diff check passed. Final output was clean. The first all-file attempt placed the new tests before a cache-sensitive bootstrap assertion, causing a test-only catalog-cache ordering failure; moving the new tests after existing cases restored its original setup assumptions without changing runtime data/cache behavior.

Additional controller browser proof is attributed at `.superpowers/sdd/2026-10-05-cockpit-remediation/browser-proof/task-4-project-draft-flow.json`: a second idle fixture retained identical unsent draft text after Cancel (0 assignment POSTs, canonical source) and confirmation (1 POST, fresh canonical destination), with no page errors. No installed-host, Ubuntu or external-profile proof was added; independent fix review remains pending.
