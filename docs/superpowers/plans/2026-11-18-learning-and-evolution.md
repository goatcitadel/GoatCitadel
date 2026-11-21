# Learning and evolution implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Use superpowers:subagent-driven-development only if explicitly selected. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve F5/F9/F10 by turning useful completed work into reviewed, reusable lessons while keeping background cost, foreground responsiveness and improvement claims honest.

**Architecture:** Retain read-only model extraction, then submit immutable proposals through memory/capability owners. Existing durable execution processes learning jobs; explicit workflow capture remains authenticated and separate from system-origin proposals. Monitoring requires relevant observations rather than elapsed time.

**Tech stack:** Existing Gateway/durable services, contracts, storage repositories, LlmService utility routing, capability evaluation/Change Plans, Vitest and named verification lanes.

**Spec:** [Product review](../../review/2026-11-18-product-functionality-comparison.md), [master plan/global constraints](2026-11-18-functional-parity-and-smoothness.md), [memory interfaces](2026-11-18-memory-reliability.md). Cross-plan dependencies are binding.

## Global constraints

Inherit all master constraints. Background code cannot pretend to be the authenticated author accepted by `WorkflowSkillCaptureService.stage`. A model can propose a procedure, never authorize its activation. Preserve post-commit generation/admission/lease/stage guards and exact effect settlement. No provider call may occur inside a database transaction. Do not make the production-dark maintenance stage active by connecting the legacy direct artifact writer.

## Review focus

1. A feature is disabled after enqueue or the provider fails: zero unchecked dispatch and an explicit deferred/unavailable disposition (L1/L2).
2. Repeated/recovered parent effects produce one queue entry/candidate; coalescing retains all unprocessed source turns rather than just the latest answer (L2).
3. A foreground turn preempts local review after a provider accepted the request: reconcile usage and dispatch identity before any retry (L2).
4. A system-generated draft references stale, foreign, failed or uncertain source work: no operator-authority substitution or callable artifact (L3/L4).
5. A watch expires with zero/neutral/unrelated observations: insufficient evidence, not stability; current negative evidence still follows governed recovery (L5).

## File structure

- `packages/contracts/src/background-learning.ts` (new): readiness, queue metadata and draft-proposal contracts, shared with U1/U4.
- `apps/gateway/src/services/background-learning-readiness.ts` (new): effective destination/budget checks before model work.
- `packages/storage/src/background-learning-job-repo.ts` (new): durable pending/running job identity, immutable source-set references, usage settlement and successor/coalescing state.
- `apps/gateway/src/services/background-learning-queue-service.ts` (new): dispatch priority/idle decisions through existing durable execution, not a second agent scheduler.
- `apps/gateway/src/services/background-skill-draft-service.ts` (new): proposal-only adapter from canonical successful work to inactive candidate artifacts. Share pure validators/artifact primitives with explicit workflow capture.
- Existing `BackgroundReviewService`, `ChatPostCommitEffectService`, `MemoryMaintenanceService`, `SkillLearningService`, capability/evaluation/Change Plan owners and improvement watch owner retain their responsibilities.
- Register added repositories/exports in storage and existing async/PostgreSQL worker adapters. Use paired additive migrations; do not reserve migration IDs before execution.

## L1 — destination readiness before model work

**Coverage/dependency:** F10; after M1. Can ship before the rest of this subplan.

**Files:** create readiness/contracts modules and tests; modify `chat-post-commit-effect-service.ts`, `background-review-service.ts`, `gateway-service.ts` composition, `gateway/runtime-settings.ts`, `gateway/feature-flags.ts`, `config.ts` and settings schema/catalog tests when introducing the new independent skill-draft flag. Update shared settings types and dashboard schema in the same change.

**Interfaces:** `resolveBackgroundLearningReadiness({workspaceId, sessionId}): Promise<BackgroundLearningReadiness>` derives current source eligibility, memory proposal destination, skill draft destination, maintenance destination, provider readiness and configured budget. Each destination is `{state:'ready'|'disabled'|'blocked'|'unavailable', reasonCode?:string}`. `BackgroundLearningReadiness` includes `canExtractMemory`, `canDraftSkill`, `canEvaluateMaintenance`. No destination readiness implies write authority. Add `backgroundSkillDraftsV1Enabled` default **false**; preserve existing memory/autonomy settings.

- [ ] Write tests named `skips_all_model_calls_when_no_learning_destination_is_ready`, `does_not_advance_due_counter_while_disabled` and `rechecks_readiness_before_dispatch_after_config_change`. Assert `createChatCompletion.mock.calls.length === 0` with memory administration off and skill drafting off, and no fact/skill persistence. A storage failure is unavailable/retryable, never interpreted as feature enabled.
- [ ] Run `pnpm --filter @goatcitadel/gateway exec vitest run src/services/background-learning-readiness.test.ts src/services/chat-post-commit-effect-service.test.ts src/services/background-review-service.test.ts`; establish red behavior first.
- [ ] Add the readiness dependency before counter advancement/model extraction. Request only ready outputs: memory-only does not pay for a skill suggestion; skills-only does not extract profile facts. Persist a content-free skipped/deferred receipt with a reason. Never create fake counts or a success receipt for a skipped operation.
- [ ] Recheck current flags, model availability, budgets and source eligibility at each asynchronous boundary; keep authoritative accounting failures visible and retain retryable storage failure semantics.
- [ ] Run green tests, settings/feature schema tests, `pnpm verify:runtime:truth`, and docs checks. U1 consumes this same readiness contract; no separate frontend guesses from raw flags.

## L2 — durable foreground-first review queue

**Coverage/dependency:** F10; after L1.

**Files:** add queue service/job repository and `.test.ts`/`.postgres.test.ts`; modify `chat-post-commit-effect-service.ts`, `chat-post-commit-effect-receipt.ts`, `durable-execution-service.ts`, `gateway/chat-post-commit-runtime.ts`, current utility-model dispatch/accounting hooks, LlmService dispatch priority where needed, and storage/durable registration. Extend `durable-run-service.general-post-commit.integration.test.ts`.

**Interfaces:** `enqueueLearningReview({workspaceId, sessionId, parentRunId, sourceTurnId, sourceHash, effectExecutionId}): Promise<{jobId, disposition:'queued'|'deduplicated'|'disabled'}>` is called under the existing post-commit owner fence. Each source reference retains its own parent settlement and frozen eligibility. `processLearningReview(jobId, {signal}): Promise<LearningReviewOutcome>` runs as a registered durable workflow under proposal-only system authority. Job identity includes workspace/session/generation; a worker claims an immutable source-set revision before provider dispatch.

- [ ] Write deterministic-clock tests: duplicate effect settlement enqueues once; three pending turns coalesce without losing the first two; a fourth arriving during dispatch goes to a successor; restart retains pending work; source revocation/config changes stop dispatch. Include `foreground_preemption_does_not_retry_an_unknown_paid_dispatch` with settled/unknown usage receipts.
- [ ] Run the red queue/repository/post-commit tests. Add a shared-local-model fixture in which the foreground prompt is enqueued while review is generating.
- [ ] Persist queue jobs/source links transactionally with their post-commit stage receipt; source refs are never folded into the newest parent's operator authority. Merge only pending compatible jobs, up to 50 source turns; additional turns form successor work. Recheck each source's canonical scope/hash/current eligibility. A frozen running job cannot acquire new sources.
- [ ] Add foreground priority. For a shared managed local model require 15 seconds of foreground quiet before review; age 30 minutes becomes `delayed`, not permission to interrupt a live turn. Coalescing preserves original enqueue time. Cloud providers use the same admission/cost ceiling but may use existing independent capacity. No polling/model call occurs for an empty queue.
- [ ] On foreground arrival abort/yield owned review inference when supported, record actual/unknown usage, and resume with a new admitted dispatch only after reconciliation. Keep stable operation IDs, dispatch generations and parent lineage. Do not refund unknown cost, replay an unknown external effect or reuse an aborted tool-capable agent.
- [ ] Run green queue, real-PostgreSQL lease/CAS and restart/preemption tests; run durable recovery and runtime truth. Compare B0 foreground queue delay and total review calls. Adapt Hermes' coalescing/idle mechanics, not its best-effort in-memory durability or fail-open enablement fallback; include notices if ported.

## L3 — suggestion to reviewed procedural skill

**Coverage/dependency:** F5; after L2/M3.

**Files:** add background draft adapter/tests; extend `background-review-service.ts`, background-learning contracts, `workflow-skill-capture-service.ts` only for shared pure source/markdown validation or artifact persistence extraction, `candidate-skill-artifacts.ts`, `packages/contracts/src/skill-governance.ts`, capability catalog/lifecycle and evidence repositories. Extend `src/workflow-skill-capture.integration.test.ts`, `skill-learning-service.test.ts`, `skill-evaluation-service.test.ts`, `governed-skill-instruction-service.test.ts` and skill-learning verification invariants.

**Interfaces:** `proposeBackgroundSkillDraft({jobId, workspaceId, sessionId, sourceTurnIds, sourceHashes, targetCandidateId?}): Promise<{candidateId, versionId, proposalId, activationPerformed:false}>`. Canonical source/evidence is re-read by the service; input cannot supply an operator ID or replace authority. Add `background_workflow` as a distinct candidate provenance kind; never label it authenticated correction evidence. Existing `prepare(sessionId, WorkflowSkillCaptureRequest, actor)` / `stage(sessionId, WorkflowSkillCaptureStageRequest, actor)` remain the explicit operator path.

- [ ] Write tests `background_draft_is_inspectable_but_never_callable`, `manual_workflow_capture_needs_no_three_session_recurrence`, `draft_replay_returns_the_same_version` and `source_or_reviewed_hash_change_blocks_promotion`. Assert activation is false and callable catalog omits the draft before exact evaluation/review. Failed, pending, unknown-effect and foreign-workspace work cannot seed it.
- [ ] Run red adapter/capability tests and the existing explicit workflow-capture tests. Preserve the three-distinct-clean-session threshold for automatic correction recurrence in `SkillLearningService`; do not weaken it to simulate a one-off manual lesson.
- [ ] Extend a useful skill suggestion into bounded `SKILL.md` candidate content with required inputs, steps, verification, failure handling and boundaries. Reuse existing validators, immutable bundle writing, proposal revisions and target-scope checks. The system author has only proposal rights; extracting a shared helper must not remove `WorkflowSkillCaptureService.stage`'s authenticated Chat author/hash guards.
- [ ] Bind evaluation fixtures and a held-out example to the exact candidate revision; use `SkillEvaluationService`, existing candidate Change Plan adapter and current approval path. Candidate edits invalidate evaluation/review; revocation removes fresh callable reuse. No skill changes its own grants or tools by writing instructions.
- [ ] Store candidate/proposal IDs in the durable review receipt, replacing the fingerprint-only result. Generate honest proposed/evaluated/approved/reused receipts for U4. Count an actual later instruction admission separately from success on a task.
- [ ] Run green integration/skill trust tests, `pnpm verify:skill-learning`, `pnpm verify:self-improvement:trust` and routed-context snapshots. Prove successful workflow → inactive draft → exact evaluation/review → fresh-session instruction admission → different-task improvement → revocation. No model-weight training claim is part of this feature.

## L4 — governed memory maintenance

**Coverage/dependency:** F5; after L2/M4.

**Files:** modify `memory-maintenance-service.ts`, `memory-consolidation-service.ts`, `chat-post-commit-effect-service.ts`, memory maintenance contracts/repository, current memory route/client projections and related tests. Create `apps/gateway/src/memory-maintenance-governed.integration.test.ts` and a new governed memory-plan validator alongside the lifecycle owner if needed.

**Interfaces:** `evaluateGovernedPostTurn({workspaceId, sessionId, sourceTurnId, effectExecutionId}): Promise<{status:'skipped'|'queued_for_review'; jobId?:string; reasonCode?:string}>` records a due decision/queued maintenance job under existing fences. The worker returns `{candidateIds:string[], reviewArtifactId?:string}`; only the existing lifecycle promotion path can make memory trusted. A typed proposed plan contains `add | merge | supersede`, exact source IDs/hashes and prior target IDs/hashes.

- [ ] Write red tests: enabled eligible maintenance queues governed work rather than `production_dark`; generated raw logs/tool output are not active recall sources; unreviewed maintenance output is never indexed as trusted memory; a stale prior-entry hash prevents apply; repeated worker completion yields the same proposals.
- [ ] Run `pnpm --filter @goatcitadel/gateway exec vitest run src/services/memory-maintenance-service.test.ts src/services/chat-post-commit-effect-service.test.ts src/memory-maintenance-governed.integration.test.ts` and demonstrate the current dark-stage case first.
- [ ] Reuse maintenance eligibility, cadence, source inspection and durable run records; generate review-only candidate artifacts outside automatically recalled workspace-file roots. Do not wire `noteSuccessfulRootTurnSync` into direct `writeMaintenanceArtifacts` as an implicit trusted-memory writer.
- [ ] Adapt the pinned OpenClaw consolidation validation: exact prior target evidence, grounded candidate mapping, no unrelated deletions/merges, matching subject/project lineage and a bounded output. Re-check secret/prompt-injection/source policy, canonical revisions and tombstones at apply. Any durable promotion still requires existing operator/governed authority.
- [ ] Replace the dark-stage receipt with queued/skipped/awaiting-review/completed truth. Historical maintenance files remain explicit legacy sources with their original trust; do not reclassify them as operator-approved on upgrade. Surface reconciliation if an old auto-retrievable generated artifact cannot prove its trust.
- [ ] Run green integration, real PostgreSQL transaction/idempotency, memory truth, routed-context snapshots and durable recovery. Prove a maintenance lesson becomes useful only after review via M4 and disappears from fresh recall after forget.

## L5 — evidence-based improvement monitoring

**Coverage/dependency:** F9; after B0. Independently releasable.

**Files:** extend `packages/contracts/src/improvement.ts`, improvement storage schema/repository paths, `apps/gateway/src/services/improvement-service.ts`, `improvement-snapshot-service.ts`, `improvement-review-precondition.ts`, their tests, and current shared/cockpit watch-status presenters. Add `improvement-watch-evidence.test.ts` and paired migration/compatibility tests.

**Interfaces:** extend existing `ImprovementActivationWatchStatus` with `insufficient_evidence`; record `positiveSignalCount` separately from all matched signals. Pure `evaluateImprovementWatch({deadlineReached, positiveSignalCount, requiredPositiveSignals, regressionCount}): 'watching'|'stable'|'insufficient_evidence'|'alerting'` uses only current, relevant, exact-candidate-revision signals. `requiredPositiveSignals` must be >0. `stable` reports observed operational stability, not a statistically proven comparative gain.

- [ ] Write assertions: `{deadlineReached:true, positiveSignalCount:0, requiredPositiveSignals:5, regressionCount:0}` returns `insufficient_evidence`; five relevant positives and zero regressions may return `stable`; neutral/unrelated signals do not count; a relevant negative returns `alerting` and invokes the existing governed restore path once.
- [ ] Run `pnpm --filter @goatcitadel/gateway exec vitest run src/services/improvement-watch-evidence.test.ts src/services/improvement-service.runtime.test.ts src/services/improvement-service.active-update-bias.test.ts`; prove the expiry case red first.
- [ ] Replace both deadline-or-target checks with the same evaluator. Record evidence counts/status atomically, preserve approval/snapshot recovery, and handle two simultaneous watch updates with CAS/transaction semantics. No automatic rollback bypass is introduced.
- [ ] Add a compatibility projection for historical `stable` rows whose evidence cannot prove coverage: show legacy/unverified evidence, never invent positives. Update API schema/UI vocabulary/filters together, using operator copy such as “Monitoring ended; more usage needed.”
- [ ] Run green tests and self-improvement trust/runtime truth. Demonstrate zero-traffic expiry, relevant success, negative evidence and concurrent recovery. B1 alone decides whether task-level comparative improvement is established.

## Subplan exit

- [ ] Disabled destinations make zero unnecessary model calls; local review yields to foreground; crash/replay produces one proposal per source/target generation.
- [ ] Manual workflow capture, automatic recurrence evidence and background-generated drafts remain distinct, all converging on the same governed evaluation/activation/revocation owners.
- [ ] Run `pnpm verify:skill-learning`, `pnpm verify:self-improvement:trust`, `pnpm verify:engineering-learnings`, `pnpm verify:memory:truth`, `pnpm verify:durable:recovery`, `pnpm verify:runtime:truth`, routed-context snapshots, schema parity/real PostgreSQL and docs checks as applicable.
- [ ] Record proposed/accepted/reused lessons, held-out task success, repeated mistake rate, queued/preempted/failed reviews, review cost and unknown settlements. No saved-suggestion count is presented as evidence of learning effectiveness.
- [ ] Document the enabled/disabled defaults, exact consent boundaries and rollback. Update the skill-learning lane's old “explicit only” invariant to acknowledge the new distinct proposal-only background source, without weakening authenticated-correction tests.
