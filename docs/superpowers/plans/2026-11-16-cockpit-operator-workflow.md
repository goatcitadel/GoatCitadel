# Cockpit Operator Workflow Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for native execution or superpowers:subagent-driven-development if the operator selects delegation. Check off each step after verification.

**Goal:** Help a Cockpit operator start useful work in Chat, make an informed approval decision, and find the recorded result.

**Architecture:** Keep Chat and Inbox on the same Gateway approval and settlement records. Improve the existing Cockpit renderers and links, then address the empty workspace and turn inspector in separate changes.

**Tech stack:** React, TypeScript, TanStack Query, Vitest, existing Cockpit browser verification.

**Requirements:** The November 16 product review walked through empty Chat, a seeded reply, its inspector, Inbox, and a pending memory write. This plan captures the resulting requirements and assumes the in-conversation concept (Option 2) as the first prototype. Inbox remains the cross-conversation queue. The mock is a layout reference. Actual copy, risk and status follow the Gateway record.

## Global constraints

- The audit ran on the local worktree. Source reconciliation used the local `origin/main` ref at `78b1140d8bcec57aa7d7257ee01eeab69f98f3a6`. Refresh and pin the execution baseline in an isolated worktree. Preserve the existing dirty checkout and confirm any changes since that reference.
- Read `DESIGN.md`, `PRODUCT.md`, `docs/CANONICAL_RUNTIME_STATE_MODEL.md`, and `apps/mission-control-next/AGENTS.md` before implementation. Paths starting with `chat/` or `inbox/` below are relative to `apps/mission-control-next/src/cockpit/areas/`.
- Reuse existing approval guards, redaction, identity-scoped records, dispatch and outcome readers. The Gateway owns risk, scope, approvals, retries, execution and durable evidence. Keep unknown and partial results visible. Preserve specialist review and risk-specific confirmation.
- Use a scratch fixture profile and synthetic data for browser proof, including the happy path. Use existing tokens, focus patterns, and responsive shell primitives. No provider credentials or external sends are needed.
- Deliver tasks 1–3 as the first reviewable slice. Tasks 4 and 5 can ship separately after their checks. Defer new navigation, provider work, and connector expansion.

## Review focus

| Case | Expected behavior | Task |
|---|---|---|
| Two requests of the same kind, one with incomplete evidence | Distinguish each request using its safe subject when available. Give the incomplete request a clear review path. | 1 |
| An in-chat approval references a destination outside the conversation scope | Show the recorded destination separately from who asked. Honor specialized risk controls and redaction. | 2 |
| A decision succeeds but execution fails, stalls or is unknown | Display the decision and effect separately, including on reload or when returning from Inbox. | 3 |
| An empty view results from filtering or a partial read | Preserve search, archive, error and loading states. Show first-conversation guidance only for a confirmed empty workspace view. | 4 |
| Inspection opens after switching workspace, conversation, or branch | Show evidence only for the requested visible turn. Stale or unavailable evidence must remain explicit. | 5 |

## Baseline and overlap

- [ ] Record the target SHA and capture the current supported Cockpit flow at 1280px. Include the two pending memory requests, Chat review, decision readback and result, empty workspace with ready and missing models, and evidence opened from a reply.
- [ ] Confirm that existing inline approval and settlement behavior still works before changing it. The reconciled source already has `ChatApprovalRenderer`, `ApprovalSettlement`, the “Start your first conversation” heading, starter draft actions, and keyboard navigation for inspector tabs. Preserve any baseline behavior that already meets the checks below.

### Task 1 — Make Inbox rows easy to triage

**Files:** `inbox/InboxItemCard.tsx`, `inbox/inbox-presentation.ts`, `inbox/InboxRowDecision.tsx`, `inbox/InboxItemCard.test.tsx`. Consult `packages/contracts/src/operator-inbox.ts` for fields already projected by the Gateway.

- [ ] Add an Inbox row regression with two caution-level memory writes. Assert the supplied safe subjects distinguish the rows and an incomplete request exposes “Review request” as its primary action. Cover a fully described safe request and an install-wide request alongside it.
- [ ] Run `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/cockpit/areas/inbox/InboxItemCard.test.tsx`. Confirm the new assertions fail on the baseline where behavior is missing.
- [ ] Update `inboxItemTitle(item: OperatorInboxItem): string` and the card to make the existing server-authored, display-safe subject visible in the heading or directly below it. Use a generic heading when no safe subject is available. Keep risk and expiry near the action. Promote “Review request” for incomplete summaries, specialist review or outcomes that need a closer look. Keep source context and any distinct owner link available from review. Keep quick decisions only when the same risk, ownership, and evidence controls allow them and the row gives readers enough context. Reuse the existing owner-record query and decision bar. If the projection cannot convey safe subject or review eligibility, prefer the review action. Propose a contract change separately only if the fixture demonstrates it is needed.
- [ ] Rerun the row test and `InboxArea.test.tsx`. Verify the queue retains a separate Updates section, existing counts and navigation, and selection and focus continue to work.

### Task 2 — Put the exact request next to the decision

**Files:** `inbox/ApprovalReviewSummaryContent.tsx`, `inbox/ApprovalDecisionPreview.tsx`, `inbox/InboxApprovalDetail.tsx`, and `chat/ChatApprovalRenderer.tsx` only where needed to surface the existing review content. Extend `inbox/ApprovalReviewSummary.test.tsx`, `inbox/InboxApprovalDetail.test.tsx`, and `chat/ChatApprovalRenderer.test.tsx`.

- [ ] Add regressions for a redacted memory preview requested from a conversation, an unavailable summary with an available action preview, and a high-risk request that enters the existing confirmation. Assert exact allowed preview content is present before the decision controls, and that the requesting conversation and storage destination have distinct labels. Run these three test files with the app’s `exec vitest run` command and confirm the uncovered cases fail.
- [ ] Keep the `ApprovalReviewSummaryContent` interface (`approval`, `evidence`, `workspaceId`, `showExpiry`). Lead with the action and target, the allowed content preview, scope, and consequence. For memory writes, use “Save this preference to memory?” when the recorded request identifies a preference. Show the exact **redacted** content or label the preview unavailable or truncated. Use the existing bounded preview or scroll treatment for long content. Put repeated metadata and audit details in their existing disclosure. Keep source links and specialized review available. Ensure both surfaces preserve the same decision semantics. In Chat, place the review by the originating request and make a pending decision apparent even if the last reply completed.
- [ ] Rerun the three tests and `inbox/ApprovalDecisionBar.test.tsx`. In a browser, confirm Tab reaches the request and decision in order and that closing the Inbox inspector restores focus to the originating row. Check a long target and long preview at desktop and narrow widths.

### Task 3 — Show the action’s outcome after a decision

**Files:** `inbox/ApprovalSettlement.tsx`, `inbox/approval-settlement.ts`, `inbox/approval-follow-on.ts`, `chat/ChatToolApprovalLine.tsx`, and existing `ApprovalSettlement`, `LinkedApproval.settlement`, and `ChatTurnApprovalHistory` tests.

- [ ] Trace the same approval from Chat and Inbox into its existing decision and follow-on readbacks. Add or extend a regression for “Approved” with a running or unknown effect. Assert no “Saved” or “Verified” state appears until the owner supplies supporting evidence. Include a failed or denied case and an unlinked approval with its own follow-on effects.
- [ ] Run the focused settlement and history tests. Reuse the existing separation between decision, linked run, and recorded effect. Adjust presentation and existing owner links only where the fixture shows a gap. Link to the original conversation or recorded run when available. Distinguish “Couldn't verify outcome” from an explicitly recorded failure.
- [ ] Rerun focused tests. In the isolated browser, resolve one harmless synthetic request, verify the cross-surface readback, reload while the effect is pending, and capture the recorded terminal outcome. Run `pnpm verify:durable:recovery` if Gateway continuation or its contract changes. Presentation alone uses the surface and browser proof below.

### Task 4 — Improve the path to a first useful result

**Files:** `chat/ChatAreaChrome.tsx`, `chat/ChatArea.tsx`, `chat/ChatConversationStarters.tsx` and `chat/ChatConversationStarterChoices.tsx`. Extend `chat/ChatAreaChrome.test.tsx` and `chat/ChatConversationStarters.test.tsx`.

- [ ] Check ready, known missing-model, unknown readiness, filtered/archived, and failed-read cases. Assert only confirmed first-conversation states get first-conversation guidance, setup links use existing route behavior, and a starter fills a draft without sending. Run the focused tests before and after any changes.
- [ ] Keep the existing first-conversation heading and starter flow wherever they already pass. For a ready model, make “New conversation” the primary next action. For a known missing model, make the existing setup action the clear next step. Keep the composer path available when readiness is unknown and normal send guards still apply. Use the existing responsive conversation rail behavior and reduce empty-rail prominence only if the refreshed browser view still competes with the main action.
- [ ] Add one labeled, read-only example of request → review → recorded result, available without credentials. Use an existing safe demo entry if present and suitable. Otherwise show a short static example in first-run guidance. It must never create a conversation, send a prompt, or write memory when opened. Verify both the example and the normal path in the browser.

### Task 5 — Make turn evidence visible and usable at narrow widths

**Files:** `chat/ChatTurnReceipt.tsx`, `chat/ChatInspectorBody.tsx`, `chat/ChatInspectorTabStrip.tsx`, `chat/ChatInspectorTurnPanel.tsx`, `chat/chat-inspector-evidence.tsx`. Extend `chat/ChatTranscript.test.tsx`, `chat/ChatInspector.test.tsx`, and `chat/ChatInspectorTurnPanel.test.tsx`.

- [ ] Add or extend regressions for a visible “What ran” button, the matching turn opening in the Message panel, and a missing or out-of-scope turn. Opening a stale receipt must not silently substitute another turn’s evidence. Check missing usage separately from recorded zero, and preserve the plain receipt when no inspection handler exists.
- [ ] Keep `TurnReceipt({ turn, onInspectTurn })` and the existing selected-turn, workspace and branch checks. Put “What ran” in the visible button label, with model and timing secondary. Within the existing inspector, group tool and model activity under “What ran” and actual inputs under “What it used,” with links or controls to reach the selected turn’s available sources, files and artifacts. Preserve conversation-wide and run details. Keep first-level evidence controls visible by wrapping the tab strip at narrow widths. Keep roving focus and the existing tab identifiers.
- [ ] Run the focused receipt, transcript and inspector tests. In the browser, open evidence for a named turn, reach the last tab using the keyboard, and return to Chat. Check 1280px and a 390px viewport, plus 200% desktop zoom. Verify evidence panels scroll without hiding focus and the transcript and composer remain usable.

## Release checks

- [ ] Run the app’s targeted tests and `pnpm --filter @goatcitadel/mission-control-next typecheck`, followed by `pnpm verify:surface:regression` and `pnpm verify:visual:regression`. Inspect expected screenshot changes before updating baselines. Keep checks and evidence tied to the exact tested commit.
- [ ] Compare the baseline and prototype with five people who use AI for recurring work. Ask them to identify what the approval changes, explain its scope, and determine whether it ran. Pilot target is at least four completing unaided and nobody mistaking approval for completion. Record time to first useful result and whether people can find one source and one outcome. Use moderated notes or opt-in signals without collecting prompt or payload content.
- [ ] Run `git diff --check`. If implementation changes public claims or setup guidance, update the owning docs and run `pnpm docs:check`. Report checks that could not run and keep the demo result distinct from live-provider validation.
