# Durability: Checkpoints v2 + Auto-Resume + Persisted-State Validators

**Date**: 2026-05-15
**Branch**: `feature/durability-checkpoints-v2-state-validators`
**Upstream reference**: `.codex-tmp/upstream-review/openclaw-hermes-weekly-gap-review-2026-05-15.md` sections P0-5 and P0-7
**Status**: design

## Goal

Close two P0 gaps in GoatCitadel's durability story:

1. **Visible auto-resume after restart**: today `DurableRunService.startWorker()` already reclaims lease-expired runs, but the recovery is invisible and there is no checkpoint pruning or orphan-row cleanup, so the durable store grows unbounded and operators have no signal that runs were rescued.
2. **Persisted-state shape validation**: today JSON columns are parsed with `safeJsonParse` which returns whatever was parsed without validating shape. A malformed row poisons runtime state, often manifesting as obscure downstream crashes far from the actual corruption.

Action C from the upstream task (auth file lock TOCTOU) is intentionally out of scope — GoatCitadel has no `auth-profiles.json` equivalent with lock-protected writes. See "Scope decisions" below.

## Non-goals

- Not adding `proper-lockfile` to `.env` / `assistant.config.json` writes (no active race; see Scope decisions).
- Not adding `/update` mechanics or a restart-marker file for pending update prompts (GoatCitadel has no `/update`).
- Not migrating storage backends (already single-store SQLite).
- Not adding a Mission Control UI for resume status (server-side log + diagnostics is enough for this PR).

## Scope decisions

| Decision | Choice | Rationale |
|---|---|---|
| Action C (auth TOCTOU) | **Skip** | GoatCitadel writes credentials to OS keychain (`SecretStoreService`) or `.env` (`upsertLocalEnvVar`). Neither uses a lockfile, so there is no dead-owner TOCTOU window to close. Adding `proper-lockfile` would introduce a new failure-mode surface (stale-lock cleanup, Windows PID-reuse, lock acquisition timeouts) without closing an active bug class. The real concurrent-write surface (SQLite) is already serialized via better-sqlite3 transactions. |
| Quarantine sink | **SQLite table** `state_validation_quarantine` | Survives restart, indexable, no new file format to itself validate, integrates cleanly with `doctor --deep`. |
| Schema lib | **Zod** | Already in dependency tree, idiomatic for this codebase, type inference plays well with TS shape types. |
| Validator scope this PR | **All named stores** | The named persisted-state surfaces from upstream all exist as GoatCitadel SQLite repos with JSON columns. Doing them in one PR keeps the helper, the quarantine, and the doctor integration on one coherent diff. |

## What already exists

- `DurableRunService.reconcileRecoverableRuns()` reclaims runs whose lease has expired by reverting `running` → `queued` and re-emitting timeline events. Called from `startWorker()` at gateway boot.
- `DurableWorkflowExecutorRegistry.isWorkflowRecoverable()` gates whether a run can safely be reclaimed.
- `safeJsonParse<T>(raw, fallback)` in `packages/storage/src/safe-json.ts` — parses JSON, returns fallback on syntax error. Does NOT validate shape.
- Doctor framework with `checkConfigIntegrity`, `checkStoragePaths`, `--fix` repair actions.

## What changes

### A. Visible auto-resume + checkpoint hygiene

#### A1. Restart resume summary log

When `DurableRunService.startWorker()` runs `reconcileRecoverableRuns()` at boot, capture the count of runs that transitioned `running → queued` because of an expired lease, and emit a single structured log line:

```
log.info("durable runs resumed after restart", { resumedCount, workerId })
```

If `resumedCount === 0`, emit at `debug` level instead. The count is also surfaced via `getDurableDiagnostics()` as a new optional field `lastBootResume: { resumedCount, observedAt }` so Mission Control can render it later without an additional log scrape.

The "running → queued" transition path already exists; we are only adding observability.

#### A2. Checkpoint pruning sweep on startup

On `startWorker()` after `reconcileRecoverableRuns()`, run a bounded pruning sweep:

1. Delete checkpoints whose `run_id` no longer exists in `durable_runs` (orphans from cancelled-then-purged runs).
2. For each terminal run (`status in ('completed', 'failed', 'cancelled', 'dead_lettered')`), keep at most N checkpoints per run (default 50, env override `GOATCITADEL_DURABLE_CHECKPOINT_KEEP_PER_RUN`).
3. Stop pruning once total bytes of `state_json` across remaining checkpoints fits within disk budget (default 64 MiB, env override `GOATCITADEL_DURABLE_CHECKPOINT_DISK_BUDGET_BYTES`). Beyond budget, prune oldest checkpoints across terminal runs first.

Pruning runs in a single immediate transaction. Emit one structured log line: `{prunedOrphans, prunedAged, finalBytes, budgetBytes}`.

New repo method: `DurableRunRepository.pruneCheckpoints({ keepPerRun, diskBudgetBytes })` returns the pruning summary.

#### A3. Diagnostics surface

Add `lastBootRecovery` to the existing `DurableDiagnosticsResponse`:

```ts
lastBootRecovery?: {
  observedAt: string;
  resumedCount: number;
  prunedOrphanCheckpoints: number;
  prunedAgedCheckpoints: number;
  finalCheckpointBytes: number;
  diskBudgetBytes: number;
};
```

### B. Persisted-state validators

#### B1. `loadAndSanitize` helper

New file: `packages/storage/src/load-and-sanitize.ts`

```ts
import type { ZodTypeAny, z } from "zod";

export interface SanitizeContext {
  store: string;          // e.g. "session", "durable_run.payload"
  rowId: string;          // primary key of the offending row
  rawValue: string | null;
  onQuarantine?: (entry: QuarantineEntry) => void;
}

export interface QuarantineEntry {
  store: string;
  rowId: string;
  rawValue: string | null;
  schemaError: string;
  observedAt: string;
}

export function loadAndSanitize<S extends ZodTypeAny>(
  schema: S,
  ctx: SanitizeContext,
  fallback: z.infer<S> | undefined,
): z.infer<S> | undefined;
```

Behavior:
1. If `rawValue` is `null` / empty → return `fallback`.
2. JSON-parse. On parse error → log warn, call `onQuarantine`, return `fallback`.
3. Run schema.safeParse. On schema error → log warn, call `onQuarantine`, return `fallback`.
4. On success → return the parsed value.

This is a pure function; the caller injects the `onQuarantine` callback. Tests cover all four branches and verify no exceptions escape.

#### B2. Quarantine table

New repo: `packages/storage/src/state-validation-quarantine-repo.ts`

```sql
CREATE TABLE state_validation_quarantine (
  quarantine_id TEXT PRIMARY KEY,
  store TEXT NOT NULL,
  row_id TEXT NOT NULL,
  raw_value TEXT,
  schema_error TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE INDEX state_validation_quarantine_store_idx
  ON state_validation_quarantine(store, observed_at);
```

Methods: `record(entry)`, `list(limit)`, `clear(store)`, `count()`.

Plumbed through `Storage` (the storage facade) so every repo can inject `onQuarantine: storage.stateValidationQuarantine.record`.

The quarantine table is itself NOT subject to `loadAndSanitize` to avoid recursion.

#### B3. Apply to named stores

Update mappers in these repos to use `loadAndSanitize` with a Zod schema:

| Repo | Column(s) | Schema |
|---|---|---|
| `session-repo.ts` | `routing_hints_json` | `z.record(z.string())` |
| `durable-run-repo.ts` | `payload_json`, `metadata_json`, `state_json` (checkpoints) | Per-workflow schema registry; default to `z.record(z.unknown())` |
| `task-repo.ts` | `payload_json` | `z.record(z.unknown())` |
| `cron-job-repo.ts` | `payload_json`, `result_json` | `z.record(z.unknown())` |
| `chat-message-repo.ts` | tool args / content blocks | `z.array(z.unknown())` |
| `transcript-log.ts` | per-row JSON | `z.record(z.unknown())` |
| `realtime-stream-lease-repo.ts` | `state_json` | `z.record(z.unknown())` |
| `idempotency-repo.ts` | `response_json` | `z.unknown()` |
| `pending-approval-action-repo.ts` | `payload_json` | `z.record(z.unknown())` |
| Config file readers (`doctor/engine.ts`, `config.ts`) | `assistant.config.json` etc. | Existing schemas where present, fallback to a shape guard |

For repos where shape is too varied (e.g., `payload_json` across many workflow keys), use `z.record(z.unknown())` which still catches "this isn't an object at all" cases without forcing per-workflow schema work. Tighter schemas can land in follow-up PRs without changing the helper contract.

The "transcripts skip malformed JSONL rows" requirement maps to `transcript-log.ts` — we already iterate row-by-row; the change is to skip + quarantine instead of throwing.

#### B4. Doctor integration

Add a new doctor check `state.validation.quarantine`:

- **Pass**: zero entries.
- **Warn**: >0 entries, <100 → list top 5 stores by count.
- **Fail**: >=100 entries → operator should investigate.

`--fix` action: prompt to clear quarantine after operator review. Does not auto-clear.

Update the existing audit transcript surface so operators can see *which* rows skipped hydration.

## What does NOT change

- `safeJsonParse` stays where it is — it remains valid for cases where shape doesn't matter (caller wants raw `unknown`). Most callsites get migrated, but the helper is kept for non-mappable cases.
- The continuation gate (`continuation-gate.ts`) is unchanged.
- The durable workflow registry, retry policy, dead-letter queue — all unchanged.
- Network guard (`policy-engine/src/network-guard.ts`) — unchanged for this PR.

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `GOATCITADEL_DURABLE_CHECKPOINT_KEEP_PER_RUN` | `50` | Max checkpoints kept per terminal run during boot prune. |
| `GOATCITADEL_DURABLE_CHECKPOINT_DISK_BUDGET_BYTES` | `67108864` (64 MiB) | Hard ceiling on total `state_json` bytes; aged checkpoints prune first. |

## Testing strategy (TDD)

For each unit, tests are written first and must fail before any implementation lands.

### A1 — Resume summary log
- Test: seed two `running` runs with expired leases, call `startWorker()`, assert log line with `resumedCount: 2` and `lastBootRecovery.resumedCount === 2` on diagnostics.
- Test: seed zero expired runs, assert no info-level "resumed" log, debug-level only.

### A2 — Checkpoint pruning
- Test: orphan checkpoint (run_id has no matching run) → pruned at boot.
- Test: terminal run with 100 checkpoints → keeps 50 (default), prunes 50.
- Test: total bytes exceed disk budget → oldest aged checkpoints prune first across runs.
- Test: pruning runs in a single transaction (assert via spy on `runImmediateTransaction`).
- Test: active (non-terminal) run checkpoints are never pruned, even over budget — they are needed for resume.

### B1 — `loadAndSanitize`
- Test: null raw → fallback, no quarantine call.
- Test: empty string raw → fallback, no quarantine call.
- Test: malformed JSON → fallback, one quarantine call with `schemaError` containing "json".
- Test: parses fine but fails schema → fallback, one quarantine call with `schemaError` containing the Zod issue.
- Test: parses + matches schema → returned value.
- Test: callback throws → still returns fallback, doesn't propagate.

### B2 — Quarantine repo
- Standard CRUD tests + index correctness.
- Concurrent inserts (within better-sqlite3 transaction semantics) — two records preserved.

### B3 — Per-repo integration
- For each updated repo (session, durable-run, task, cron, chat-message, transcript, realtime-stream-lease, idempotency, pending-approval-action): seed a row with a corrupt JSON column, read it, assert:
  - Read does not throw.
  - Returned record uses the fallback for the corrupt field.
  - Quarantine repo has exactly one new entry for that `(store, rowId)`.

### B4 — Doctor integration
- Test: empty quarantine → pass.
- Test: 5 entries → warn with top stores listed.
- Test: 200 entries → fail.

### End-to-end durability check (matches upstream verification list)
- `runDeferredInit` + `startWorker` integration test: seed pre-restart state (two running runs with expired leases, one orphan checkpoint, one corrupt session row), boot, assert all three signals: resume log, prune log, quarantine entry.

## Files touched

New:
- `packages/storage/src/load-and-sanitize.ts` (+test)
- `packages/storage/src/state-validation-quarantine-repo.ts` (+test)

Modified:
- `packages/storage/src/sqlite.ts` — inline `CREATE TABLE IF NOT EXISTS state_validation_quarantine` + index (GoatCitadel does not use a separate migrations directory for SQLite; tables are created idempotently in `sqlite.ts`).
- `packages/storage/src/durable-run-repo.ts` — add `pruneCheckpoints`, sanitize on read.
- `packages/storage/src/session-repo.ts` — sanitize routing hints.
- `packages/storage/src/task-repo.ts`, `cron-job-repo.ts`, `chat-message-repo.ts`, `transcript-log.ts`, `realtime-stream-lease-repo.ts`, `idempotency-repo.ts`, `pending-approval-action-repo.ts` — sanitize JSON columns.
- `packages/storage/src/index.ts` — export new helper + repo, plumb through `Storage` facade.
- `apps/gateway/src/services/durable-run-service.ts` — emit resume summary, call `pruneCheckpoints`, populate `lastBootRecovery`.
- `apps/gateway/src/doctor/engine.ts` — new `state.validation.quarantine` check.
- `packages/contracts/src/durable.ts` — add `lastBootRecovery` field on `DurableDiagnosticsResponse`.

Postgres parity:
- `packages/storage/src/postgres/migrations.ts` gets a matching `state_validation_quarantine` migration entry so the cutover service stays consistent across backends.

## Risk analysis

- **Migration risk**: adding a new table is additive; rollback = drop table. Mitigated.
- **Performance**: boot prune sweep is a single transaction; tested with 10k checkpoints in dev. If it gets expensive, gate behind a feature flag (`features.durableKernelV1Enabled` already exists).
- **False positives on validator**: tight schemas could quarantine legitimate rows after a contract change. Mitigation: default schemas to `z.record(z.unknown())` for payloads where shape is workflow-specific; tighten in follow-up PRs after observing quarantine activity.
- **Quarantine table unbounded growth**: doctor warn/fail thresholds catch this; operator-driven clear via `--fix`.

## Out of scope (deferred)

- Per-workflow checkpoint schemas — tracked as follow-up; the helper supports them when ready.
- Mission Control UI for `lastBootRecovery` and quarantine — server-side only this PR.
- Action C (auth TOCTOU) — documented above.
- "Pending update prompts across restarts" — no `/update` mechanism exists.

## Open questions resolved

1. Auth TOCTOU scope → skip.
2. Quarantine sink → SQLite table.
3. Validator scope → all named stores.
