# Durable Runs + Replay Foundation

This document is historical implementation background for the durable execution foundation that now owns shipped resumable operator flows in GoatCitadel.

The canonical current runtime posture lives in `docs/CANONICAL_RUNTIME_STATE_MODEL.md`. Use that file for shipped behavior, release scope, and authority. This file explains how the durable foundation was assembled and what it introduced; it is not the active rollout source of truth.

## Current Shipped Posture

- Shipped Chat / Cowork / Code operator sends, retry, resume, approval wait/resume, worker restart recovery, and dead-letter recovery now run on durable execution by default.
- Cowork/orchestration now uses the durable workflow key `orchestration.plan.execute`, links each orchestration run to one durable run by default, and allocates one worktree per orchestration run by default.
- Approval resume for orchestration is durable-worker owned: the approval endpoint records operator intent and requeues the linked durable run, while the durable workflow resumes the same orchestration/worktree context.
- `assistant.durable.enabled`, `executionEnabled`, `chatAutoPromoteEnabled`, and `durableKernelV1Enabled` default to `true` in the shipped gateway runtime.
- `replayOverridesV1Enabled` remains default-off for replay-with-overrides.
- The earlier rollout guidance that described durable defaults as off is retired and must not be reintroduced here.

## Scope

- Add database schema for durable run bookkeeping.
- Add storage repository methods for runs, checkpoints, retries, and dead letters.
- Add storage-backed execution ownership with lease + CAS protection.
- Add worker discovery that does not depend on same-process nudges.
- Add read/write operator APIs for pause, resume, wake, retry, and dead-letter recovery.

## Runtime Flags and Defaults

- `assistant.durable.enabled` in gateway config (default: `true` in the shipped runtime)
- Env override: `GOATCITADEL_DURABLE_FOUNDATION_ENABLED=true|false`
- `assistant.durable.executionEnabled` (default: `true`)
- `assistant.durable.chatAutoPromoteEnabled` (default: `true`)
- `assistant.durable.durableKernelV1Enabled` (default: `true`)
- Diagnostics toggle (reserved): `assistant.durable.diagnosticsEnabled` and `GOATCITADEL_DURABLE_DIAGNOSTICS_ENABLED`

## Schema Added

Migration `v21` creates:

- `durable_runs`
- `durable_checkpoints`
- `durable_retries`
- `durable_dead_letters`

No existing tables were changed or dropped.

Later additive migrations extended `orchestration_runs` with durable/worktree ownership fields so operator views can inspect execution truth directly instead of inferring it from plan-state transitions alone.

## Contracts Added

- `DurableRunRecord`
- `DurableCheckpointRecord`
- `DurableRetryRecord`
- `DurableDeadLetterRecord`
- `DurableDiagnosticsResponse`

## API Added (Read-Only)

- `GET /api/v1/durable/diagnostics`
- `GET /api/v1/durable/runs?limit=...`
- `GET /api/v1/durable/dead-letters?limit=...`
- `GET /api/v1/durable/runs/:runId/checkpoints?limit=...`

## Runtime Semantics

- `waiting` means workflow-blocked and wakeable by a matching domain event.
- `paused` means operator-held and resumable only by explicit operator action.
- Successful wake changes `waiting -> queued`.
- Explicit operator resume changes `paused -> queued`.
- Only the claim path may change `queued -> running`.
- Running executions hold storage-backed leases (`leaseOwnerId`, `leaseExpiresAt`, `leaseHeartbeatAt`, `version`).
- Worker discovery uses periodic polling; `requestRunProcessing()` is only a local hint.

## Implementation Checklist

- [x] Storage migration and repository scaffolding
- [x] Contract exports
- [x] Gateway diagnostics methods
- [x] Gateway route registration
- [x] Repository skeleton tests
- [x] Execution-engine adoption for shipped durable flows
- [x] Queue consumers / idempotent worker runtime for shipped durable flows
- [x] DLQ operator actions for shipped durable flows

## Historical Notes

- The early foundation work landed behind explicit rollout flags so storage, queueing, and operator APIs could stabilize before they became the default shipped path.
- That staged rollout is complete for the shipped operator flows named above.
- Any future changes in durable ownership should update `docs/CANONICAL_RUNTIME_STATE_MODEL.md` first and then keep this background document aligned.
