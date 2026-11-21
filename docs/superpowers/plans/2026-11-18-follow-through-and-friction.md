# Follow-through and friction implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Use superpowers:subagent-driven-development only if explicitly selected. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve F8 and the review's smoothness requirements: understand setup, request useful follow-through, review a lesson, recover an approval and continue work with minimal repetition.

**Architecture:** Add Gateway-authored readiness/continuation projections over existing owners. Extend cockpit Chat, Inbox and Work controls using shared clients/primitives. All actual actions remain with durable execution, approvals, Change Plans, grants, memory and capability owners.

**Tech stack:** TypeScript/Fastify, contracts/shared clients, React/TanStack Query, existing cockpit UI/accessibility primitives, Vitest, browser interaction proof and packaged Windows acceptance.

**Spec:** [Product review and seven smoothness requirements](../../review/2026-11-18-product-functionality-comparison.md), [master/global constraints](2026-11-18-functional-parity-and-smoothness.md), root `DESIGN.md`/`PRODUCT.md`, and the M/L interfaces referenced below.

## Global constraints

Inherit all master constraints. No new primary surface, client-side runtime authority, raw JSON main UI, blanket autonomy switch or permission bypass. Read current `DESIGN.md`/`PRODUCT.md` before implementation. Reuse current `ChatExpiredApprovalRecovery`, `ApprovalDecisionBar`, `use-chat-allowance-controls`, `WorkflowSkillCaptureControl`, memory proposal/detail components and Change Plan setup links. Extend those flows, do not create a competing approval controller.

This plan specifies interaction changes; it is not fresh rendered acceptance. Every task must render all states it changes. Verify light/dark, desktop/phone, keyboard focus, reduced motion, scrolling, transient states and action outcomes. Record unrenderable cases explicitly.

## Review focus

1. A workspace-scoped setup control would change an installation-wide flag: state the true scope and require the existing install-level Change Plan authority (U1).
2. A follow-up crosses quiet hours/DST or a notification retry has an unknown external outcome: retain the selected timezone and do not redeliver blindly (U2).
3. Expiry recovery/setup completion races with another tab, changed policy/grants, archived session or a dirty composer: preserve input, create only one valid continuation and show the exact next step (U3).
4. An approval succeeds but effect/indexing fails, or the panel is reopened: show saved/awaiting-apply/recall-ready/used truth separately, without a duplicate review or false success (U4).
5. Stream/reconnect/background work changes layout on a phone: retain draft, focus and reading position; stop is responsive and status announcements are bounded (U5).

## File structure

- `packages/contracts/src/assistant-readiness.ts` and `chat-continuation.ts` (new): versioned readiness/continuation projections.
- `apps/gateway/src/services/assistant-readiness-service.ts`, `chat-continuation-service.ts`, `follow-through-projection-service.ts` (new): compose owner truth, bind current scope and request existing governed operations.
- New thin session-bound routes in `apps/gateway/src/routes/chat.assistant-readiness.ts` and `chat.continuations.ts`; new projection route for follow-through in `chat.follow-through.ts`. Wire through current service/route composition and `app.ts`; no SQL in routes/UI.
- `packages/mission-control-shared/src/api/assistant-readiness.ts`, `chat-continuation.ts`, `follow-through.ts` (new): shared clients with existing auth/idempotency/error conventions.
- New focused cockpit components `ChatAssistantReadiness.tsx`, `ChatLearningReview.tsx`, `ChatLearningReceipt.tsx`, `ChatFollowThrough.tsx` in Chat; `WorkFollowThrough.tsx` in Work. Reuse existing inspector/dialog/section/status components. No new global toolbar or layout.
- Existing Chat transcript/composer/approval components and Library/Inbox memory/capability review are the integration points. New types/state mapping are shared with their existing owners.

## U1 — effective readiness and guided setup

**Coverage/dependency:** F8 and setup friction; after L1.

**Files:** create readiness contract/service/route/shared client and tests; modify `gateway-route-service-composition.ts`, `gateway-service.ts` for composition only, `ChatFeatureSettings.tsx`, existing settings feature-switch presentation, `LibraryMemoryWorkspace.tsx`, `LibraryMemoryProposals.tsx`, `SystemImprovement.tsx` and `SystemArea.tsx` only where relevant links/status need changing. Add `ChatAssistantReadiness.tsx`/`.test.tsx`.

**Interfaces:** `getAssistantReadiness(sessionId: string): Promise<AssistantReadinessResponse>` returns current workspace/session/config revision and `items: {id:'memory'|'skills'|'follow_up'|'scheduled_work'; state:'ready'|'disabled'|'blocked'|'unavailable'; scope:'session'|'workspace'|'installation'; reasons:string[]; nextAction?: {kind:'review_change_plan'|'open_owner'|'sign_in'; href:string; label:string}}[]`. L1's readiness is the learning source; existing schedule/commitment/grant owners supply follow-through truth. Caller payloads cannot set these fields.

- [ ] Write tests `memory_disabled_has_exact_scoped_setup_action`, `missing_owner_is_unavailable_not_zero`, `installation_flag_requires_install_scope` and `foreign_session_readiness_is_not_found`. Render a plain disabled-state sentence and one setup action; hide irrelevant empty filters/duplicate off notices. No flags change merely by viewing readiness.
- [ ] Run `pnpm --filter @goatcitadel/gateway exec vitest run src/services/assistant-readiness-service.test.ts src/routes/chat.assistant-readiness.test.ts` and the new frontend tests red first.
- [ ] Implement effective readiness: flags, master switch, session preference, provider/connector setup, grant/profile and budget all contribute. Link to the exact safe next action, not a generic Advanced settings instruction. Setup uses existing Change Plans with only dependencies required for the selected outcome; show installation-wide effects before review.
- [ ] Surface compact contextual readiness inside Chat when relevant, and reuse it in Library/Settings. Preserve user preferences on upgrade. Keep experimental Improvement labeled; make its supported review destination reachable from learning receipts/readiness rather than implying activation happens on its advisory page.
- [ ] Run green API/shared-client/component tests. Render first-use, disabled, ready, denied, expired-sign-in, partial/unavailable and connection-error states at 1280×800 and 390×844 in both themes. Completing setup must show the backend's effective result, not just flip a switch optimistically.

## U2 — predictable follow-through

**Coverage/dependency:** F8, notifications and proactive control; after U1/M7.

**Files:** create follow-through contract/projection/route/client/components and tests plus `apps/gateway/src/services/follow-through-event-wake-service.ts`/`.test.ts`; extend `gateway/commitment-classifier-service.ts`, `gateway/commitment-sweep-service.ts`, `chat-proactive-service.ts`, `heartbeat-occurrence-service.ts`, `gateway/cron-automation-service.ts`, current hook/event producers and their typed contracts for demonstrated gaps; integrate with existing Chat/Work route controls. Reuse persisted cron/commitment/occurrence records.

**Interfaces:** `listFollowThrough(sessionId: string): Promise<{items:FollowThroughItem[]}>` where an item has canonical `{kind:'schedule'|'commitment'|'heartbeat'|'proactive'; ownerId:string}`, purpose, selected timezone, next check, last actual outcome, delivery target, active permission/budget summary and typed owner actions. It is a projection, not a second job table. `requestFollowThroughAction({owner, action, expectedRevision})` dispatches to the existing owner; setup/grant mutations retain their ordinary Change Plan or approval flow. `wakeFollowThroughJob({jobId, expectedRevision, eventId, eventType, workspaceId, sourceConnectionId, payloadHash}): Promise<{runId?:string; disposition:'queued'|'duplicate'|'blocked'}>` accepts server-authored events only.

- [ ] Write tests for one-shot, recurring and event-triggered jobs; one useful commitment follow-up; no update when nothing changed; selected-zone DST gap/fold; quiet hours deferral; repeat/changed-event dedupe; cancel during approval wait; and restart after an ambiguous external-send boundary. Assert one canonical occurrence and at most one confirmed delivery, or an explicit unknown outcome with no automatic resend.
- [ ] Run red projection/classifier/sweep tests and add the missing acceptance cases to `src/commitment-scheduled-turns.test.ts` plus current scheduled/heartbeat integration tests.
- [ ] Implement one outcome-oriented Chat flow: purpose/trigger, schedule/timezone or event condition, delivery destination, exact allowed actions and cost cap, then the existing governed confirmation. Preserve explicit reminders' selected timing; inferred suggestions are not commitments until accepted. Do not auto-enroll every idle session in self-wake work.
- [ ] Use current durable owners to pause/resume/cancel/run-now. Add a typed event-to-existing-job adapter for the selected verified hook/connector event where no such link exists: validate source/workspace and job revision, dedupe `(jobId,eventId)`, and enqueue through the same cron/durable authority as a scheduled occurrence. Event payload is untrusted data, never new instructions/grants. Reconcile cadence identities, cooldown and quiet/no-change outcomes. Group duplicate notifications and publish one actionable failure/required-decision notice with its canonical owner link; delivery must not depend solely on retained realtime events.
- [ ] Reuse OpenClaw's scoped intention/expiry/rearm behavior where it fits existing commitments; do not port another scheduler. Run green tests plus durable recovery, runtime truth and `pnpm verify:channels:parity` for any channel-facing changes.
- [ ] Render setup, upcoming, quiet/no-change, waiting-on-you, delivery-failed, unknown, paused/cancelled and recovered states. A user must be able to answer what runs, when, why, where it reports and how to stop it without opening raw technical details.

## U3 — continue after setup, approval or expiry

**Coverage/dependency:** Setup/approval/grant friction; after U1/M7.

**Files:** add continuation contract/service/route/client and tests; extend `approval-resolution-effects-service.ts`, existing durable Chat resume/preflight owners, `external-side-effect-runner-service.ts` only if reconciliation needs a typed read; modify `ChatExpiredApprovalRecovery.tsx`, `ChatApprovalRenderer.tsx`, `inbox/ApprovalDecisionBar.tsx`, `inbox/use-chat-allowance-controls.tsx` and setup cards. Add `chat-continuation.integration.test.ts`.

**Interfaces:** `prepareChatContinuation({sessionId, sourceTurnId, reason:'setup_complete'|'approval_expired', expectedSourceHash}): Promise<PreparedChatContinuation>`. The server returns `{continuationId, status:'review_required'|'ready'|'blocked'|'unknown_effect', approvalId?, nextAction?}` from exact current owner truth. `resumeChatContinuation({continuationId, expectedRevision}): Promise<{runId,status}>` enters durable execution only after required fresh review/setup effect and current policy checks. IDs and actions are scoped to the current authenticated operator/session/workspace.

- [ ] Write tests `expired_review_reissues_without_retyping_or_rerunning_model_planning`, `viewing_a_card_does_not_reissue`, `new_policy_or_request_hash_blocks_recovery`, `dirty_draft_survives_workspace_switch`, `two_tabs_create_one_recovery` and `unknown_send_never_auto_retries`. Assert old expired approval never authorizes execution and one successful setup effect resumes the intended current durable step once.
- [ ] Run red continuation/API tests plus existing approval-lifecycle, approval-effect and ChatExpiredApprovalRecovery/component tests.
- [ ] Implement typed renewal for supported persisted operations only: require a known not-executed/pre-boundary outcome, exact source request/artifact hashes, fresh approval generation and current capability/profile/grant eligibility. If the owner cannot safely renew, retain the current Ask again draft recovery and explain why. Never reconstruct authority from assistant prose or bypass denial/unknown effects.
- [ ] Add “Set up and continue” when its exact scope is reviewed and “Review again” for safely renewable expired approvals. The explicit user choice records continuation intent; setup completion alone is not a broad tool grant. Keep required new review inline and do not rerun completed tools or the whole model plan to rediscover the same action.
- [ ] Show eligible grant durations/scopes at first review and reuse only a currently valid exact grant. Changed arguments, project/workspace, expiry or revocation force fresh review. Preserve composer contents, focus, pending draft and local reading position; never overwrite a dirty draft to restore a request.
- [ ] Run green auth/stale/idempotency/recovery tests, durable recovery, runtime truth, chat-evolution and the relevant auth lane. Render approve/deny/expire/changed-in-another-tab, typed-confirmation, sign-in-required, setup-failed and unknown-effect states in both themes/widths. Distinguish approved from successfully applied.

## U4 — inline learning decisions and use receipts

**Coverage/dependency:** F1/F5, review friction; after M4/L3/L4.

**Files:** create `ChatLearningReview.tsx`, `ChatLearningReceipt.tsx` and tests; extend `ChatTranscriptContent.tsx`, `LibraryMemoryProposals.tsx`, `InboxMemoryProposalDetail.tsx`, current shared memory/candidate clients and public review schemas for expected hashes/revisions as necessary. Reuse `WorkflowSkillCaptureControl.tsx` and current evaluation/Change Plan links.

**Interfaces:** consume canonical memory candidate/skill draft records and their revision/hash. Add Gateway projection `getTurnLearningReceipt(sessionId, turnId): Promise<{proposals:LearningProposalLink[]; applied:LearningAppliedLink[]; usedSources:LearningUseLink[]}>`; links identify canonical records and actual admitted context/instruction refs. `usedSources` comes from frozen manifests/skill admissions, never model-written claims or available catalog membership. Review calls include current expected source/version hash.

- [ ] Write tests `one_visible_decision_applies_exact_reviewed_lesson`, `edited_candidate_requires_fresh_review`, `approval_without_effect_is_not_saved`, `saved_without_reader_readiness_is_not_used`, `only_admitted_sources_show_used` and `reopening_receipt_does_not_resubmit`. A safe/caution lesson presents its exact content and one applicable primary decision at review, without a second redundant confirmation dialog.
- [ ] Run red receipt/route/component tests alongside existing Library/Inbox proposal tests and explicit workflow-capture tests.
- [ ] Render compact inline proposals with source context, edit/reject and appropriate review action. Keep broader diagnostics and evidence collapsible. Skill draft editing/evaluation/activation follows existing owners; the review button never silently activates an unevaluated version.
- [ ] Display separate honest states: proposed, awaiting review, saved, recall ready, used in this turn, superseded/forgotten/revoked and failed/unknown apply. Provide exact next steps when unavailable. Invalidate/re-read canonical owners after events/decisions; cross-tab changes cannot settle an outdated card as success.
- [ ] Add a human-facing learning history using existing Journey/Library records with links from Chat. Show useful reuse and changed behavior, not a “getting smarter” score invented from counts. Do not add a new primary navigation area or a second memory browser.
- [ ] Run green contract/API/component and memory/skill trust lanes. Render empty, pending, stale, rejected, saved-but-not-ready, actually-used, revoked and partial-failure states with keyboard focus and preserved transcript position. Verify source provenance is inspectable without dominating the conversation.

## U5 — responsiveness and recovery acceptance

**Coverage/dependency:** Smoothness across all journeys; after L2/U2/U3/U4.

**Files:** extend `scripts/verification/lib/scenarios/cockpit-performance-proof.mjs`, `usability-lane.mjs`, their tests and relevant existing Chat stop/error/persistence/stream-reload proofs; extend `apps/mission-control-next/src/cockpit/areas/chat/use-transcript-position.ts`, composer/stream controller modules and API error handling only for measured failures. Add new representative journey cases to B0's harness.

**Interfaces:** consume existing provider/turn/usage timing plus explicit `client_submit`, `local_ack`, `first_visible_delta`, `approval_visible`, `effect_settled`, `foreground_queued` and `review_yielded` measurements. Store numeric timings and source/config identifiers in redacted verification artifacts, not private transcript text. UI state remains a projection of canonical turn/run/effect truth.

- [ ] Write harness tests that fail if operator approval wait is counted as model latency, a development-server cold compile is called production navigation latency, or a detached browser screenshot is accepted as successful interaction proof. Define a seeded runtime and viewport/theme/motion matrix.
- [ ] Measure B0 journeys on a production frontend with a matching backend/reference Windows machine. Initial product targets: input acknowledgement <100 ms, warm navigation p95 <300 ms excluding remote data wait, no duplicate exact-grant prompt, an available approval decision reachable in place, and foreground generation not queued behind background inference. These are proposed budgets; record actual baseline and machine/model before accepting a result.
- [ ] Fix measured bottlenecks only: avoid duplicate hot-path readiness/recall/provider work; use source/cache generations safely; lazy-load expert panels; bound virtualized lists/status announcements; retain drafts and streaming anchors. Provider/failure latency stays visible rather than disguised by a spinner.
- [ ] Exercise send, stream, stop, retry, reload mid-stream, provider error, connection loss, restart during approval, review completion, source correction and mobile keyboard/open-panel transitions. The newest-user-message/latest-response anchors, scroll position and focus must remain stable without clipped controls or text resizing/motion artifacts. Reduced motion must suppress decorative motion without hiding work status.
- [ ] Run existing `pnpm verify:cockpit:chat-stop`, `pnpm verify:cockpit:chat-error`, `pnpm verify:cockpit:chat-persistence`, `pnpm verify:cockpit:chat-stream-reload`, `pnpm verify:cockpit:chat-inline`, `pnpm verify:cockpit:performance`, `pnpm verify:usability:core`, accessibility and surface/visual regression lanes. Use named output locks and isolated runtime roots; do not replace another chat's server/process.
- [ ] Manually inspect and interact with every changed component/state at 1280×800 and 390×844 in light/dark, normal/reduced motion, keyboard-only navigation and phone keyboard conditions. Verify packaged Windows reconnect/restart as well as browser behavior. Preserve screenshots/video/interaction outcomes; report inaccessible states rather than claiming complete coverage.

## Subplan exit

- [ ] Demonstrate six complete journeys: first useful task, connector setup and continuation, preference save/correction/reuse, workflow-to-skill review/reuse, scheduled/event follow-through and expired-approval recovery.
- [ ] Report elapsed time, clicks, repeated prompts, required decisions, failure recovery, source correctness and cost for each. Necessary security decisions are counted and made clear, not optimized away.
- [ ] Every blocked action states why and provides its next safe action. No successful setup/review toast alone stands in for an applied runtime effect.
- [ ] Run API/client/component tests, `pnpm verify:surface:regression`, `pnpm verify:visual:regression`, `pnpm verify:accessibility:smoke`, `pnpm verify:cockpit:performance`, relevant durable/auth lanes and `pnpm docs:check`. Match source/backend versions; the earlier mixed-version review is not final acceptance.
- [ ] Feed results into B1 without tuning on held-out answers. Publish untested states, unknown usage and inconclusive competitor comparisons alongside successes.
