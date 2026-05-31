# Canonical Runtime State Model

Last updated: 2026-04-12

This document defines the repo-native authority model for the core runtime nouns that appear across Gateway, Mission Control, storage, and replay.

## Purpose

GoatCitadel uses several operator-facing terms that are easy to blur together during implementation:

- `session`
- `turn`
- `run`
- `approval`
- `realtime event`

This file states which concept is canonical, what store owns it, and which views are derived projections rather than primary truth.

## Canonical Concepts

### Session

Definition:
A routed conversation container. A session is the durable identity for an ongoing exchange within Chat or an external channel binding.

Authority:
- Contract shape: `packages/contracts/src/session.ts`
- Session shell metadata: `packages/storage/src/chat-session-meta-repo.ts`
- Transcript event durability: transcript log plus transcript outbox

Notes:
- Mission Control session summaries are derived read models.
- A session is not the same thing as a run.

### Turn

Definition:
A single user or assistant step within a session, including execution-side details like tool use, retrieval, routing, and citations.

Authority:
- Execution trace: `packages/storage/src/chat-turn-trace-repo.ts`

Notes:
- Turns are scoped to a session.
- A turn may create or resume one or more runs.

### Durable Run

Definition:
A resumable execution lifecycle used when work must survive pause/resume, approval waits, retries, or background processing.

Authority:
- Contract shape: `packages/contracts/src/durable.ts`
- Persistence: `packages/storage/src/durable-run-repo.ts`

Implementation status:
- Schema and storage repository: complete through the protected storage migration set.
- Read-only diagnostics API: complete.
- Mission-session Chat / Cowork / Code LLM HTTP/SSE send, retry, resume, approval wait/resume, linked proactive wakes, durable-linked chat stream resumption, worker restart recovery, retry scheduling, and dead-letter recovery mechanics are durably owned for the `1.0` operator path.
- Queue consumers / idempotent worker runtime for the shipped durable path: complete.
- DLQ operator actions for the shipped durable path: complete.
- See `docs/DURABLE_RUNS_REPLAY_FOUNDATION.md` for historical implementation background and migration context, not the active rollout source of truth.

Notes:
- A run records execution intent and outcome for the shipped resumable operator flow set.
- Durable execution now owns worker startup, retry scheduling, wake/resume, dead-letter recovery mechanics, approval wait/resume wake effects, approval-linked proactive wakes, and durable-linked chat-turn stream resumption for mission-session Chat / Cowork / Code operator work.
- Cowork/orchestration runs are durable-run backed and worktree-owned. `orchestration_runs.status`, `currentWaveId`, and `currentPhaseId` describe plan/operator position; `durableRunId`, `executionState`, `worktreePath`, `worktreeStatus`, and `worktreeBaseRef` describe execution truth.
- Approval-gated orchestration resume must re-enter the linked durable run. An approval action may set resume intent on the orchestration record, but durable worker execution remains the authority that advances phases after approval.
- External writeback sessions remain visible operator sessions. Integration operator write actions now record audit-only `external_writeback` evidence envelopes so the external side-effect intent and outcome are durable and inspectable. Local bridge writes, Activepieces triggers, Trello card creation, and Gmail send actions claim idempotency before crossing the external boundary and record replay outcome, replay-attempt, and manual retry posture evidence. The external side-effect run ledger is populated by the shared runner and stores pre-boundary, started, completed, failed-before-boundary, and unknown-outcome states. The replay-safe worker may retry failed-before-boundary or stale claimed-not-sent runs only when the owning integration reconstructs the original safe payload; unknown post-boundary outcomes stay manual. Activepieces preserves workflow-run id/status/url evidence when the webhook returns it, without claiming autonomous workflow execution or polling.
- Legacy traces without durable linkage may still require compatibility reads or resume fallbacks for historical rows, but new mission-session LLM sends do not bypass durable ownership.
- Runs may be linked to sessions, turns, tasks, and approvals.
- The `durableKernelV1Enabled` feature flag gates durable-run APIs. The `replayOverridesV1Enabled` flag (default: off) gates replay-with-overrides.

### Approval

Definition:
A durable human decision point for risky or policy-gated work.

Authority:
- Contract shape: `packages/contracts/src/approvals.ts`
- Persistence: `packages/storage/src/approval-repo.ts`
- Follow-on effect persistence: `packages/storage/src/approval-effect-repo.ts`

Canonical linkage fields:
- `sessionId`
- `turnId`
- `taskId`
- `workspaceId`
- `durableRunId`
- `correlationId`
- `traceId`
- `connectorId`
- `tokenId`
- `toolName`
- `actionType`

Notes:
- Approval payloads may still contain legacy nested values, but operator surfaces should prefer explicit `linkage`.
- Replay snapshots may expose a top-level `durableRunId`, but the approval linkage is the canonical association.
- Runtime lifecycle responses must expose per-field provenance for `sessionId`, `turnId`, `runId`, `approvalId`, and `taskId`.
- `RuntimeLifecycleResponse.canonical` is the operator-facing canonical field set. For approval-scoped reads, `canonical.sessionId`, `canonical.taskId`, and `canonical.runId` must prefer `approval.linkage` over turn-trace, execution-plan, delegation, or wait-run inference.
- `RuntimeLifecycleResponse.linked` is the related/inferred set. It may include alternate runs, sessions, turns, and tasks, but those values do not overwrite the canonical field set.
- Approval resolution follow-on truth is owned by `approval + approval_events + approval_effects`.
- `approval_wait_runs` remains a canonical wait mapping, but it is not canonical execution truth. Mission Control should label it as wait mapping, not canonical run ownership. Post-resolution wake, pending action execution, inbox finalization, and after-hooks are tracked through effect rows.

### Realtime Event

Definition:
A retained operator signal emitted onto the live stream for Mission Control and related consumers.

Authority:
- Contract shape: `packages/contracts/src/monitoring.ts`
- Persistence and retention: `packages/storage/src/realtime-event-repo.ts`

Canonical classification fields:
- `eventClass`
  - `domain_fact`
  - `operational_signal`
  - `ui_notification`
- `eventAuthority`
  - `retained_stream`
  - `durable_history`
  - `derived_projection`
- `links`
  - `sessionId`
  - `turnId`
  - `runId`
  - `approvalId`
  - `taskId`
  - `workspaceId`
  - `connectorId`
  - `tokenId`
  - `messageId`

Notes:
- Realtime events are not the authoritative historical record for sessions or runs.
- The stream is retained and pruned. Consumers must treat it as an operator signal lane, not complete history.
- Producers for approval/run/session/task/proactive events must populate `eventClass`, `eventAuthority`, and `links` explicitly.
- Repository inference is legacy compatibility-only. Protected approval/session/task/orchestration/auth-device event types must fail loudly when explicit metadata is omitted.
- If a compatibility shim remains for non-protected legacy callers, it must emit diagnostics and be removable without changing the protected producer contract.

## Linkage Rules

When a runtime action emits multiple records, link them explicitly instead of recovering relationships from nested payloads.

### Approval creation

Approval creation should attach explicit linkage before the approval is surfaced to UI or replay:

- preserve inbound linkage from the caller when present
- attach request attribution (`correlationId`, `traceId`) when available
- attach `durableRunId` from approval-wait lifecycle linkage when a durable wait/run owns the resolution path

## Read Precedence

Operator-facing runtime lifecycle reads should follow this order:

1. explicit stored linkage / explicit realtime envelope links
2. canonical side-table relationships
3. durable/task/session canonical references
4. compatibility fallback inference from payload, preview, or metadata

Fallback reads remain temporary compatibility behavior. Mission Control should label inferred relationships as inferred, not canonical.

For approval-scoped lifecycle reads, apply the precedence per field:

1. query `approvalId` and approval existence
2. `approval.linkage.sessionId`, `approval.linkage.taskId`, `approval.linkage.durableRunId`
3. explicit turn-trace / execution-plan / delegation linkage
4. wait mapping display via `approval_wait_runs`
5. compatibility fallback inference

### Approval-related realtime events

Approval events should carry `links.approvalId` and any known related identifiers such as:

- `sessionId`
- `taskId`
- `runId`
- `connectorId`
- `tokenId`

### Session-derived realtime events

Session stream events should carry `links.sessionId` and related `taskId` when known.

### Prompt-pack outcomes

Prompt-pack status must preserve `approval_paused` separately from `failed`.

### Memory Context

Definition:
A distilled or composed context pack drawn from memory items, learned memory, and workspace knowledge for use in prompts and reasoning.

Authority:
- Context pack cache: `packages/storage/src/memory-context-repo.ts`
- Memory items: `packages/storage/src/memory-item-repo.ts`
- Learned memory: `apps/gateway/src/services/chat-learned-memory-service.ts` via `packages/storage/src/chat-learned-memory-repo.ts`

Implementation status:
- QMD composition, distillation, and caching: complete.
- Memory maintenance (retention, compaction, recommendations): feature-flagged behind `memoryMaintenanceV1Enabled`.
- Learned-memory promotion, dedupe, workspace scope resolution, maintenance recommendation suppression, memory item list/edit/forget/history, and shared write-policy decisions now route through lifecycle-owned policy helpers coordinated by `MemoryLifecycleService`.
- Memory context citations carry retrieval strategy and match-signal provenance. Current retrieval is lexical/recency plus optional operator-visible semantic hints from memory item metadata; this is not a vector/embedding semantic search claim.

Notes:
- `MemoryLifecycleService` is the operator-facing lifecycle owner for context composition, learned-memory entry points, maintenance policy/run orchestration, memory item list/edit/forget/history, and shared dedupe/scope/write policy decisions.
- `MemoryContextService`, `ChatLearnedMemoryService`, and `MemoryMaintenanceService` remain focused collaborators behind that owner.
- `ChatLearnedMemoryService` is storage-repo backed for learned-memory item persistence.
- Remaining direct-SQL owners in core runtime-adjacent code no longer include `GatewayService` for `memory_items` lifecycle flows; selected migration and ops services may still touch adjacent stores outside the memory lifecycle owner boundary.

## Derived Views

The following are explicitly derived projections, not canonical truth:

- Mission Control session summaries and timeline rollups
- dashboard refresh topic inference
- replay-gap banners
- UI freshness smoothing indicators

Derived views should prefer explicit `links`, `eventClass`, and `eventAuthority` over payload scraping or keyword heuristics.

## Migration Guidance

When touching old code:

1. Prefer adding explicit linkage and classification fields over adding more payload inference.
2. Preserve backwards compatibility for older rows/events where practical.
3. Keep canonical writes close to the owning repository or contract boundary.
4. Treat UI scraping helpers as compatibility fallbacks, not the primary path.
