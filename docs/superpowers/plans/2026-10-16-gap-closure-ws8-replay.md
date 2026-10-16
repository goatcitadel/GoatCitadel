# WS8 Side-Effect Replay and Code Mode Promote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Gmail, Trello and local-bridge writes replayable without ever sending twice (Task 8.1, PR A), then let operators promote an Aider patch through the hash-checked workbench path and keep the Docker backend posture honest (Tasks 8.2–8.3, PR B).

**Architecture:** PR A persists an AES-256-GCM sealed copy of each allowlisted side effect's runner payload on its `external_side_effect_runs` row (key held in the OS secret store, AAD binds `runId` + `payloadHash`). The replay job unseals it, re-hashes it against the row's `payloadHash`, and rebuilds the provider call from live connection config. Each provider gets a dedupe probe (Gmail `rfc822msgid:` search, Trello list scan for a `desc` marker, local bridge `Idempotency-Key` re-POST when the bridge enforces it). A crossed-boundary run (`unknown_external_outcome`) is only ever *reconciled* through that probe; it is never resent unless the provider enforces the key.

**Tech Stack:** TypeScript, Fastify gateway, vitest, `node:test` (storage), SQLite + Postgres, `node:crypto`.

**Spec:** `docs/superpowers/plans/2026-10-15-gap-closure-program.md` § "WS8 — Side-effect replay and Code Mode promote", issues goatcitadel/GoatCitadel#366 and #368, tracker #341. Builds on WS7 Task 7.3 (PR #381).

## Global Constraints

- Own worktree off `origin/main`; never edit `C:\personal-ai`; never `git stash`.
- vitest with `--maxWorkers=2`, low priority, one heavy job at a time; re-run a failed file alone before treating it as real.
- Gateway focused test: `pnpm --filter @goatcitadel/gateway exec vitest run <file> --maxWorkers=2`. Storage: `pnpm --filter @goatcitadel/storage exec tsx --test <file>`.
- `prettier --write` only on changed files. Search with `git grep`.
- New Postgres schema needs a migration that matches the v2 live render (nullable `TEXT` + `ADD COLUMN IF NOT EXISTS`, the v212 precedent), tested on fresh and upgraded lineages; bump the canonical column-count tripwire in `packages/storage/src/postgres-migrator.test.ts`, run `pnpm update:storage:migration-manifest`, bump literals in `scripts/verify-storage-migration-parity.test.mjs`.
- Gateway tests that `vi.mock("@goatcitadel/storage")` must spread any new real exports.
- Never run `architecture:baseline:update`; new service files get an entry in `scripts/verification/baselines/architecture-new-service-allowances.json`; `verify:architecture:metrics` must stay green (consolidate dependency reads in owner files).
- Do not touch `gateway-service.ts` (prettier line-budget trap).
- No personal paths in tracked files. Commits `<type>: <description>` ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never auto-redispatch an `unknown_after_send` / `unknown_external_outcome` effect unless the provider enforces the idempotency key.
- No hostile-code sandbox claim (PR B).
- Done = PR(s) against main with focused tests, `pnpm typecheck`, `pnpm verify:architecture:metrics`, `node scripts/verify-repo-hygiene.mjs`, `git diff --check` green.

## Review Focus

1. **Gmail rewrites the Message-ID, or the token lacks read scope.** The probe finds nothing or errors; the run must stay `unknown_external_outcome` (manual review) and nothing is resent. Pinned in Task 4 (`probe error leaves the run for manual review`).
2. **Sealed record copied from another run row.** AAD mismatch must refuse, even though the ciphertext itself is intact. Pinned in Task 3 (`refuses a record sealed for a different run`).
3. **Secret store unavailable (CI, Linux without secret-tool).** The live send still runs; no replay record is written; replay reports `job_unavailable`. Pinned in Task 3 and Task 5.
4. **Two replay workers reconcile the same crossed run.** The run-row CAS lets exactly one settle `completed`; the other observes a non-matching status and skips. Pinned in Task 2 (`markCompletedIfStatus` CAS) and Task 4.
5. **Completed runs keep sensitive bodies at rest.** Completion clears the sealed record. Pinned in Task 1.

---

## File Structure (PR A)

| File | Responsibility |
|---|---|
| `packages/storage/src/external-side-effect-run-repo.ts` | `replay_record_json` column read/write, `markCompletedIfStatus` CAS, clear record on completion |
| `packages/storage/src/mutation-idempotency-repo.ts` | `markReconciledCompleted` (only `unknown_after_send` → `completed`) |
| `packages/storage/src/sqlite.ts`, `postgres/migrations.ts` | SQLite v266 / PG v213 `external_side_effect_replay_record` |
| `apps/gateway/src/services/external-side-effect-replay-record.ts` (new) | seal/open with secret-store key, AAD binding, re-hash check |
| `apps/gateway/src/services/external-side-effect-reconciliation.ts` (new) | reconcile a crossed run through a provider probe |
| `apps/gateway/src/services/external-side-effect-runner-service.ts` | export payload hash; worker calls reconciliation; `reconciled` result |
| `apps/gateway/src/services/integration-writeback-run-inputs.ts` (new) | Gmail/Trello/local-bridge run-input builders + dedupe probes, shared by live and replay |
| `apps/gateway/src/services/integration-action-service.ts` | live paths call the shared builders; seal the record before the boundary |
| `apps/gateway/src/services/external-side-effect-replay-job-service.ts` | extended allowlist; build jobs from the sealed record |
| `apps/gateway/src/services/durable-execution-service.ts` | map the `reconciled` worker result into the checkpoint |
| `apps/gateway/src/services/gateway-route-composition-integrations.ts` | wire `replayRecords` into the integration host |

---

### Task 1: Storage — sealed replay record column, CAS completion, reconciled mutation

**Files:**
- Modify: `packages/storage/src/external-side-effect-run-repo.ts`, `packages/storage/src/mutation-idempotency-repo.ts`, `packages/storage/src/sqlite.ts`, `packages/storage/src/postgres/migrations.ts`
- Modify (tripwires): `packages/storage/src/sqlite-migration-versioning.test.ts`, `packages/storage/src/postgres-migrator.test.ts`, `scripts/verify-storage-migration-parity.test.mjs`, `scripts/verification/baselines/storage-migrations.json` (regenerated)
- Test: `packages/storage/src/external-side-effect-run-repo.test.ts` (create if absent, else extend), `packages/storage/src/mutation-idempotency-repo.test.ts`, `packages/storage/src/postgres/real-postgres.test.ts` (upgraded lineage)

**Interfaces:**
- Produces on `ExternalSideEffectRunRepository`:
  - `attachReplayRecord(runId: string, sealedRecordJson: string): boolean` — sets only when the column is NULL; returns whether it wrote.
  - `getReplayRecord(runId: string): string | undefined`
  - `markCompletedIfStatus(runId: string, expectedStatus: ExternalSideEffectRunStatus, input: { replayOutcome?; responsePayload?; externalReferenceId?; envelopeId? }, now?: string): ExternalSideEffectRunRecord` — returns the current row (unchanged when the CAS missed).
  - `markCompleted` and `markCompletedIfStatus` set `replay_record_json = NULL`.
- Produces on `MutationIdempotencyRepository`: `markReconciledCompleted(input: MutationIdempotencyIdentityInput & { updatedAt?: string }): boolean` — `UPDATE … SET status='completed', claim_expires_at=NULL WHERE identity AND status='unknown_after_send'`.
- `ExternalSideEffectRunRecord` (contracts) does NOT gain the column; `SELECT *` mapping ignores it.

- [ ] **Step 1: Write failing repo tests** (SQLite `:memory:` via the package's existing test setup / `TempSqliteFiles`):
  - `attachReplayRecord writes once and getReplayRecord returns it` — second attach returns `false`, value unchanged.
  - `markCompleted clears the sealed replay record` — `getReplayRecord` → `undefined`.
  - `markCompletedIfStatus settles only from the expected status` — from `unknown_external_outcome` → `completed` with `externalReferenceId`; a second call expecting `unknown_external_outcome` returns the `completed` row unchanged.
  - `markReconciledCompleted settles only unknown_after_send` — `pending` row returns `false`; `unknown_after_send` row → `completed`.
- [ ] **Step 2: Run** `pnpm --filter @goatcitadel/storage exec tsx --test src/external-side-effect-run-repo.test.ts src/mutation-idempotency-repo.test.ts` → FAIL (methods missing).
- [ ] **Step 3: Migrations.** SQLite v266 `external_side_effect_replay_record`: `addColumnIfMissingIfTableExists(db, "external_side_effect_runs", "replay_record_json", "TEXT")`. PG v213 same name: `ALTER TABLE external_side_effect_runs ADD COLUMN IF NOT EXISTS replay_record_json TEXT;` with its `integritySha256`. (WS2 #387 also claims SQLite v266 / PG v213; the second to merge renumbers.)
- [ ] **Step 4: Implement the repo methods** above.
- [ ] **Step 5: Tripwires.** Bump sqlite last-migration test to v266, PG column count `5_085` → `5_086` (+comment), parity literals (265→266, 212→213, last names, v213 sha), run `pnpm update:storage:migration-manifest`.
- [ ] **Step 6: Upgraded-lineage proof.** In `real-postgres.test.ts`, assert the column exists after migrating ≤212 then full (skips without a real PG, as the file already does).
- [ ] **Step 7: Run** the storage tests from Step 2 plus `src/sqlite-migration-versioning.test.ts src/postgres-migrator.test.ts` and `node --test scripts/verify-storage-migration-parity.test.mjs` → PASS.
- [ ] **Step 8: Commit** `feat(storage): sealed replay record column and reconciled completion`.

### Task 2: Runner — exported payload hash, reconciliation of crossed runs

**Files:**
- Create: `apps/gateway/src/services/external-side-effect-reconciliation.ts`
- Modify: `apps/gateway/src/services/external-side-effect-runner-service.ts`, `apps/gateway/src/services/durable-execution-service.ts`
- Test: `apps/gateway/src/services/external-side-effect-reconciliation.test.ts`

**Interfaces:**
- Consumes: Task 1 repo methods (through `ExternalSideEffectRunStore` optional members `markCompletedIfStatus?` and mutation store optional `markReconciledCompleted?`).
- Produces:
  - `export function hashExternalSideEffectPayload(value: unknown, externalDestinationFingerprint: string | undefined): string` (now exported from the runner).
  - On `IdempotentExternalSideEffectRunInput<TValue>`: `reconcileExternalOutcome?(): Promise<ExternalSideEffectProbeResult>` where `type ExternalSideEffectProbeResult = { found: true; externalReferenceId?: string; output?: Record<string, unknown> } | { found: false; reason: string }`.
  - `ExternalSideEffectReplayWorkerResult` gains `{ status: "reconciled"; run; externalReferenceId?: string; message: string }`; skip reasons gain `"external_outcome_not_found"` and `"external_call_in_flight"`.
  - `reconcileCrossedExternalSideEffectRun<TValue>(run, job, options: { checkedAt: string; staleAfterMs: number }): Promise<ExternalSideEffectReplayWorkerResult<TValue> | undefined>` — `undefined` when the job has no probe (worker keeps the old `external_boundary_already_crossed` skip).

Rules: only `unknown_external_outcome`, or `external_call_started` that `isStatusStale` says is stale (else skip `external_call_in_flight`). Probe throws → skip `external_outcome_not_found` with the error summarized (no raw provider text). Found → in `job.runClaimTransaction`: `markCompletedIfStatus(run.runId, run.status, { replayOutcome: "duplicate", externalReferenceId, responsePayload: { reconciled: true, ...output } })` and `mutationStore.markReconciledCompleted?.({ method: "POST", routePath: run.routePath, idempotencyKey: run.idempotencyKey, actorScope: run.actorScope })`; if the returned row is not `completed` (CAS lost) → skip `completed`. Not found → skip `external_outcome_not_found`, message "The provider shows no matching effect; the outcome stays unknown and replay will not resend it." The worker never calls `execute` for these runs.

- [ ] **Step 1: Write failing tests:** `settles a crossed run completed when the probe finds the effect`, `never executes a crossed run when the probe finds nothing`, `leaves a fresh external_call_started run alone`, `probe error leaves the run for manual review`, `a lost completion CAS reports completed without double settlement`, and `jobs without a probe keep the boundary-crossed skip` (via `runReplaySafeExternalSideEffectWorker` with real SQLite `Storage({ dbPath: ":memory:" })` + `createSqliteAsyncStorage`, as `external-side-effect-runner-service.test.ts` does).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the new file; in the worker, when eligibility reason is `external_boundary_already_crossed`, build the job, check identity mismatch as today, then delegate to `reconcileCrossedExternalSideEffectRun`. Add `reconciled` to `mapExternalSideEffectReplayResult` and a `reconciled` count to the replay checkpoint in `durable-execution-service.ts`.
- [ ] **Step 4: Run** the new test plus `external-side-effect-runner-service.test.ts` and `durable-execution-service` external-replay tests → PASS.
- [ ] **Step 5: Commit** `feat(gateway): reconcile crossed external side effects through provider probes`.

### Task 3: Sealed replay record service

**Files:**
- Create: `apps/gateway/src/services/external-side-effect-replay-record.ts`
- Modify: `apps/gateway/src/services/gateway-route-composition-integrations.ts`, `apps/gateway/src/services/integration-action-service.ts` (host type only)
- Test: `apps/gateway/src/services/external-side-effect-replay-record.test.ts`

**Interfaces:**
- Produces:
  - `export interface ExternalSideEffectReplayRecords { seal(input: { runId: string; payloadHash: string; payload: unknown }): Promise<boolean>; open(run: Pick<ExternalSideEffectRunRecord, "runId" | "payloadHash">): Promise<{ payload: unknown } | undefined>; }`
  - `export function createExternalSideEffectReplayRecords(deps: { resolveKey(): Buffer | undefined; runs: { attachReplayRecord(runId: string, json: string): boolean | Promise<boolean>; getReplayRecord(runId: string): string | undefined | Promise<string | undefined> } }): ExternalSideEffectReplayRecords`
  - `export function resolveExternalSideEffectReplayKey(secretStore: Pick<SecretStoreService, "isAvailable" | "getSecret" | "setSecret"> | undefined): Buffer | undefined` — account `external-side-effect-replay:master_key`, base64 32-byte key generated on first use, `undefined` when unavailable or on error.
  - `IntegrationActionHost.replayRecords?: ExternalSideEffectReplayRecords`.
- Record JSON: `{ "v": 1, "alg": "aes-256-gcm", "iv", "ciphertext", "tag" }` (base64). Plaintext `JSON.stringify({ payload })`. AAD: `goatcitadel:external-side-effect-replay:v1\0<runId>\0<payloadHash>`.
- `seal` returns `false` (never throws) when no key; logs a warning through `logger.child("external-side-effect-replay-record")` on a write error.
- `open` returns `undefined` on: no record, no key, malformed JSON, GCM auth failure (tamper / wrong AAD). It does not re-hash — the job builder re-hashes with the live destination fingerprint (Task 5).

- [ ] **Step 1: Write failing tests:** `round-trips a sealed payload for the same run`, `refuses a tampered ciphertext`, `refuses a record sealed for a different run`, `refuses a record sealed under a different payload hash`, `seal reports false without a key and writes nothing`, `resolveExternalSideEffectReplayKey generates once and reuses the stored key`, `resolveExternalSideEffectReplayKey returns undefined when the store is unavailable`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; wire `replayRecords: createExternalSideEffectReplayRecords({ resolveKey: () => resolveExternalSideEffectReplayKey(gateway.secretStore), runs: gateway.storage.externalSideEffectRuns })` in `buildIntegrationActionHostForGateway`. Add the new file to the allowances JSON.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(gateway): seal external side-effect replay records with the secret store`.

### Task 4: Shared provider run inputs with dedupe

**Files:**
- Create: `apps/gateway/src/services/integration-writeback-run-inputs.ts`
- Modify: `apps/gateway/src/services/integration-action-service.ts`
- Test: `apps/gateway/src/services/integration-writeback-run-inputs.test.ts`; keep `integration-action-service.test.ts` green.

**Interfaces:**
- Consumes: `IntegrationActionHost` (+ `replayRecords`, Task 3), `ExternalSideEffectProbeResult` (Task 2).
- Produces (each returns `{ input: IdempotentExternalSideEffectRunInput<ParsedProviderResponse>; target: string } | { blockedReason: string; message: string }`, mirroring `buildActivepiecesTriggerWebhookRunInput`):
  - `buildGmailSendRunInput(host, connection, options: { checkedAt; payload: GmailSendPayload; idempotencyKey?; actorScope?; replay?: boolean })`, `GmailSendPayload = { provider: "gmail"; to: string; subject: string; bodyText: string }`.
  - `buildTrelloCardCreateRunInput(host, connection, options: { …; payload: TrelloCardPayload })`, `TrelloCardPayload = { provider: "trello"; listId: string; name: string; desc: string }`.
  - `buildLocalBridgeWriteRunInput(host, connection, action, options: { …; payload: LocalBridgePayload })`, `LocalBridgePayload = { provider: "local_bridge"; catalogId: string; actionId: string; input: Record<string, unknown> }`.
  - `deriveGmailMessageId(scope: WritebackDedupeScope): string` → `<gc-<first 32 hex of digest under "goatcitadel:gmail-message-id:v2">@goatcitadel.local>`, where `WritebackDedupeScope = { routePath; actorScope; idempotencyKey }` (the runner mutation identity); digest = sha256(domain + " " + JSON.stringify([routePath, actorScope, idempotencyKey])).
  - `deriveTrelloIdempotencyMarker(scope: WritebackDedupeScope): string` → `[goatcitadel-idempotency:<first 32 hex of digest under "goatcitadel:trello-marker:v2">]`; `deriveLocalBridgeIdempotencyKey(scope)` → full 64-hex digest under `"goatcitadel:local-bridge-idempotency-key:v2"`.
- Behavior pinned by the spec:
  - Every builder sets `externalDestinationFingerprint` (Gmail: send URL; Trello: `<base>/1/cards` with no key/token; bridge: selected target) and, inside `execute`, calls `host.replayRecords?.seal({ runId: claim.sideEffectRunId, payloadHash: claim.payloadHash, payload })` before `claim.markExternalCallStarted()` (skip when `sideEffectRunId` is absent).
  - Gmail raw message gains `Message-ID: deriveGmailMessageId(<claim scope>)`. Probe: `GET /gmail/v1/users/me/messages?q=rfc822msgid:<id>&includeSpamTrash=true&maxResults=1` with the bearer token; found when `messages[0].id` exists (`externalReferenceId: "messageId:<id>"`).
  - Trello sent `desc` = `payload.desc + "\n\n" + marker`. Probe: `GET /1/lists/<listId>/cards/all?fields=id,desc,shortUrl&key&token`; found when a card's `desc` contains the marker (`externalReferenceId: "id:<cardId>"`).
  - Local bridge POST carries header `Idempotency-Key: deriveLocalBridgeIdempotencyKey(<claim scope>)` (never the raw key). When connection config `idempotencyKeyEnforced` reads `"true"`, the input sets `providerIdempotencyKeyEnforced: true` and its probe re-POSTs with the same key (found on 2xx); otherwise no probe.
  - When `options.replay` is true, Gmail/Trello `execute` runs the probe first; found → `claim.markExternalCallNotRequired()` and return the found output without sending; probe error → throw before the boundary.
  - Every builder sets `reconcileExternalOutcome` to its probe (bridge: only when enforced).

- [ ] **Step 1: Write failing tests** (fake `fetchWithDiagnosticsTimeout` recording calls): `gmail send carries the derived Message-ID`, `gmail replay finds the sent message and does not resend`, `gmail probe searches by rfc822msgid`, `trello create embeds the marker and fingerprints a secret-free destination`, `trello replay finds the marked card and does not recreate`, `local bridge sends the Idempotency-Key header`, `local bridge probe exists only when the bridge enforces the key`, `seals the replay record before crossing the boundary`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; replace the inline Gmail write, Trello write and local-bridge side-effect blocks in `integration-action-service.ts` with calls to the builders (responses/messages unchanged). Add the new file to the allowances JSON.
- [ ] **Step 4: Run** the new test and `integration-action-service.test.ts` → PASS (update only assertions that pin the exact raw Gmail message / Trello desc / bridge headers).
- [ ] **Step 5: Commit** `feat(gateway): provider-side dedupe for Gmail, Trello and local bridge writes`.

### Task 5: Replay allowlist and end-to-end replay proofs

**Files:**
- Modify: `apps/gateway/src/services/external-side-effect-replay-job-service.ts`
- Test: `apps/gateway/src/services/external-side-effect-replay-job-service.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4.
- Allowlist becomes: Activepieces `trigger_webhook`; `integration_operator_action` + `automation.gmail` + `write`; `integration_operator_action` + `productivity.trello` + `write`; `integration_local_bridge_action` + each of `productivity.apple-notes`, `productivity.apple-reminders`, `productivity.things3`, `productivity.bear` + `write`.
- For non-Activepieces entries: `host.replayRecords?.open(run)` → missing ⇒ `undefined`; rebuild via the Task 4 builder with `replay: true`, `idempotencyKey: run.idempotencyKey`, `actorScope: run.actorScope`; then `hashExternalSideEffectPayload(sealed.payload, input.externalDestinationFingerprint) !== run.payloadHash` ⇒ `undefined` (tamper/drift refusal). Ward re-check and workspace/catalog drift checks as today.

- [ ] **Step 1: Write failing tests** (real `Storage({ dbPath: ":memory:" })`, real replay-records with an in-memory key, fake provider):
  - `gmail: replay after a provider timeout produces exactly one email` — live send: provider stores the message then the fetch rejects (timeout) → run `unknown_external_outcome`; run the replay worker → result `reconciled`, run `completed`, provider send count 1.
  - `trello: replay after a provider timeout produces exactly one card` — same shape.
  - `local bridge: an enforcing bridge reconciles a timed-out write with the same Idempotency-Key`; `a non-enforcing bridge stays in manual review` (bridge POST count 1).
  - `gmail: a pre-boundary failure replays from the sealed record and sends once`.
  - `refuses replay when the sealed payload was tampered` (corrupt `replay_record_json` in the row) → `job_unavailable`, no provider call.
  - `refuses replay when the sealed payload no longer hashes to the run` (record sealed for a different payload under the same AAD inputs is impossible, so: change live destination ⇒ fingerprint drift) → `undefined`.
  - `exposes exactly the reviewed allowlist` (replace the old single-entry test).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the replay-job test file + runner + integration-action tests → PASS.
- [ ] **Step 5: Docs truth.** Update every doc that says only Activepieces is replayable (`git grep -n "trigger_webhook" -- docs README.md`), and describe the local-bridge `Idempotency-Key` contract and the operator-attested `idempotencyKeyEnforced` config in the integrations doc that documents bridge actions.
- [ ] **Step 6: Commit** `feat(gateway): replay Gmail, Trello and local-bridge writes from sealed records`.

### Task 6: PR A proof lane

- [ ] `pnpm typecheck`; `pnpm verify:architecture:metrics`; `node scripts/verify-repo-hygiene.mjs`; `git diff --check origin/main...HEAD`; focused tests from Tasks 1–5. Fix metrics by consolidating dependency reads (never baseline update).
- [ ] Open PR A: `Closes #366` only if all "Done when" boxes hold (replay contracts for all three, allowlist extended, replay tests per connector), `Refs #341`.

---

## PR B — Tasks 8.2 and 8.3

Detailed after PR A, against main at that time (appended below as Tasks 7+).
