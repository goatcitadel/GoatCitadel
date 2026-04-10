# Canonical Runtime State Model

Last updated: 2026-04-10

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
- Schema and storage repository: complete (migration v21).
- Read-only diagnostics API: complete.
- Execution-engine adoption: **in progress** — `DurableRunService` now starts a background worker loop and auto-drains eligible queued runs, but not every critical runtime flow is durably owned yet.
- Queue consumers / idempotent worker runtime: **not yet complete**.
- DLQ operator actions: **not yet complete**.
- See `docs/DURABLE_RUNS_REPLAY_FOUNDATION.md` for the full activation checklist.

Notes:
- A run records execution intent and outcome; it is not yet the default execution path.
- Durable execution now owns worker startup, retry scheduling, wake/resume, and dead-letter recovery mechanics, but most core chat-turn execution still begins from gateway-owned synchronous entry paths before promoting into durable flow.
- Runs may be linked to sessions, turns, tasks, and approvals.
- The `durableKernelV1Enabled` feature flag gates durable-run APIs. The `replayOverridesV1Enabled` flag (default: off) gates replay-with-overrides.

### Approval

Definition:
A durable human decision point for risky or policy-gated work.

Authority:
- Contract shape: `packages/contracts/src/approvals.ts`
- Persistence: `packages/storage/src/approval-repo.ts`

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

## Linkage Rules

When a runtime action emits multiple records, link them explicitly instead of recovering relationships from nested payloads.

### Approval creation

Approval creation should attach explicit linkage before the approval is surfaced to UI or replay:

- preserve inbound linkage from the caller when present
- attach request attribution (`correlationId`, `traceId`) when available
- attach `durableRunId` once approval-wait lifecycle plumbing exists

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
- Learned-memory dedup and memory-maintenance dedup are independent implementations without coordination.

Notes:
- Memory ownership is currently distributed across `MemoryContextService`, `MemoryMaintenanceService`, `ChatLearnedMemoryService`, `memory-facade-service.ts`, and `memory-item-helpers.ts`. There is no single service that owns the full memory lifecycle.
- `ChatLearnedMemoryService` is storage-repo backed for learned-memory item persistence.
- Remaining direct-SQL owners in core runtime-adjacent code still include `GatewayService`, `MemoryMaintenanceService`, `ImprovementService`, `PromptPackService`, `ChatProactiveService`, and selected migration/ops services such as `database-cutover-service.ts` and `gateway/cron-automation-service.ts`.

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
