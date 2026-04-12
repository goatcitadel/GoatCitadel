# Durable Runs + Replay Foundation

This document tracks the durable execution foundation that now owns shipped resumable operator flows in GoatCitadel.

## Scope

- Add database schema for durable run bookkeeping.
- Add storage repository methods for runs, checkpoints, retries, and dead letters.
- Add storage-backed execution ownership with lease + CAS protection.
- Add worker discovery that does not depend on same-process nudges.
- Add read/write operator APIs for pause, resume, wake, retry, and dead-letter recovery.

## Feature Flag

- `assistant.durable.enabled` in gateway config (default: `false`)
- Env override: `GOATCITADEL_DURABLE_FOUNDATION_ENABLED=true|false`
- Diagnostics toggle (reserved): `assistant.durable.diagnosticsEnabled` and `GOATCITADEL_DURABLE_DIAGNOSTICS_ENABLED`

## Schema Added

Migration `v21` creates:

- `durable_runs`
- `durable_checkpoints`
- `durable_retries`
- `durable_dead_letters`

No existing tables were changed or dropped.

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

## Next Step (Activation Plan)

1. Add durable worker loop behind a second flag.
2. Migrate one low-risk flow (manual replay) to durable queue mode.
3. Validate retries and checkpoint resume end-to-end in staging.
4. Add DLQ triage UI and replay-with-overrides action.
