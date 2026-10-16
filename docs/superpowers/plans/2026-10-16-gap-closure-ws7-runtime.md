# WS7 Runtime Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the six WS7 runtime-hardening gaps from the 2026-10-15 audit: dispatch-fenced external side effects, idempotent transcript outbox, legacy HTTP+SSE MCP, scope-checked citadel cron listing, graduated no-agent cron, and native Windows cell capacity owners.

**Architecture:** Each task lands in its owner: storage repositories (`packages/storage`) own durable markers and migrations (SQLite + Postgres, with convergence on both lineages); the gateway runner/route services own fencing and scope checks; the native cell controller owns capacity observation. Task 7.3 ships first in its own PR (WS8 depends on it); 7.1, 7.2, 7.4, 7.5 (and 7.6 if buildable) ship in a second PR.

**Tech Stack:** TypeScript pnpm monorepo, Fastify gateway, vitest (gateway), `node:test` via `tsx --test` (storage), SQLite (`node:sqlite`) + Postgres 16, C++ (remote-worker Windows cell).

**Spec:** `docs/superpowers/plans/2026-10-15-gap-closure-program.md` section "WS7 — Runtime hardening", plus its Global Constraints and Review Focus.

## Global Constraints

- Work only in this worktree (branched from `origin/main`); never edit the main checkout. Never `git stash`.
- Vitest: `pnpm --filter @goatcitadel/gateway exec vitest run <file> --maxWorkers=2`, low priority, one heavy job at a time. Re-run a failed file alone before treating it as real.
- Storage tests: `pnpm --filter @goatcitadel/storage exec tsx --test <file>`; SQLite through `TempSqliteFiles`.
- Search with `git grep` (the Grep tool silently omits matches on this tree).
- Gateway tests that `vi.mock("@goatcitadel/storage")` must spread any new real exports.
- New Postgres schema needs a convergence-safe migration tested on fresh AND upgraded lineage; after adding migrations run `pnpm update:storage:migration-manifest` and bump the reviewed literals in `scripts/verify-storage-migration-parity.test.mjs` (counts, last names, the no-`sqlPayloadSha256` version list).
- Package tests resolve `@goatcitadel/contracts` from `dist`: rebuild contracts (`pnpm --filter @goatcitadel/contracts build`) after editing it.
- Never `architecture:baseline:update`; a new service file needs an entry in `scripts/verification/baselines/architecture-new-service-allowances.json`.
- `prettier --write` only on files you changed. No personal paths in tracked files.
- Commit format `<type>: <description>` ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Done = focused tests, `pnpm typecheck`, `pnpm verify:architecture:metrics`, `node scripts/verify-repo-hygiene.mjs`, `git diff --check` all green.
- Gateway rule (apps/gateway/AGENTS.md): "Never auto-retry an ambiguous post-boundary effect."

## Review Focus

1. **Old holder wakes up after takeover.** A pre-dispatch holder whose lease expired and was taken over must fail its boundary CAS and never call the provider. Pinned in Task 1 (repo) and Task 2 (runner).
2. **Crash after the dispatched marker, lease expires.** The next claim must settle `unknown_after_send` and never redispatch, unless the effect declares a provider-enforced idempotency key. Pinned in Tasks 1 and 2, on SQLite and Postgres.
3. **Upgraded installs.** Rows created before the `dispatched_at` column and transcript rows written before the unique index must survive the migration (duplicates collapsed, not a boot failure). Pinned in Tasks 1 and 4.
4. **SSE endpoint event pointing elsewhere.** A legacy SSE server that announces a cross-origin or non-allowlisted POST endpoint must be refused before any POST. Pinned in Task 5.
5. **Cron listing with a foreign or missing citadel scope.** Must return 403 / no rows, never another citadel's jobs. Pinned in Task 6.

---

## PR A — Task 7.3 (ships first)

### Task 1: Dispatched marker and `unknown_after_send` in the mutation idempotency repo

**Files:**
- Modify: `packages/storage/src/mutation-idempotency-repo.ts`
- Modify: `packages/storage/src/sqlite.ts` (new migration at the tail of the last group, after v264)
- Modify: `packages/storage/src/postgres/migrations.ts` (new migration after v211)
- Modify: `scripts/verify-storage-migration-parity.test.mjs` literals; regenerate the migration manifest
- Test: `packages/storage/src/mutation-idempotency-repo.test.ts`, `packages/storage/src/postgres/real-postgres.test.ts` (block near the existing `stale-claim-${suffix}` proof)

**Interfaces:**
- Produces:
  - `MutationIdempotencyStatus = "pending" | "completed" | "failed" | "unknown_after_send"`
  - `MutationIdempotencyRecord.dispatchedAt?: string`
  - `MutationIdempotencyClaimResult` gains `| { outcome: "unknown_after_send"; record }` and `claimKind` gains `"redispatch_after_stale_send"`.
  - `claim(input & { providerIdempotencyKeyEnforced?: boolean })`
  - `markDispatched(input: { method; routePath; idempotencyKey; actorScope?; claimToken: string; leaseDurationMs?: number; now?: string }): { outcome: "dispatched"; record: MutationIdempotencyRecord } | { outcome: "claim_lost"; record?: MutationIdempotencyRecord }` — CAS on `status='pending' AND claim_token=@claimToken`; sets `dispatched_at=@now`, rotates `claim_token` to a new UUID, refreshes `claim_expires_at` (= now + lease, or NULL when no lease).
  - `markUnknownAfterSend(input: { method; routePath; idempotencyKey; actorScope?; claimToken: string; updatedAt?: string }): boolean` — CAS from `pending`+token to `unknown_after_send`, clears `claim_expires_at`.

Semantics:
- Stale takeover (lease expired, token unchanged) of a row with `dispatched_at IS NULL` → `claimed` / `retry_after_stale_claim` (unchanged).
- Stale takeover of a row with `dispatched_at` set and `providerIdempotencyKeyEnforced !== true` → atomically (`WHERE … AND claim_token IS @previousClaimToken AND expired`) set `status='unknown_after_send'`, `claim_expires_at=NULL`, rotate token to a fresh UUID nobody holds → return `{ outcome: "unknown_after_send" }`.
- Same with `providerIdempotencyKeyEnforced === true` → takeover like today, `claimKind: "redispatch_after_stale_send"`.
- Any claim on a row already `unknown_after_send` → `{ outcome: "unknown_after_send" }` (payload mismatch still wins first).
- `reviveFailedStmt` clears `dispatched_at` (a failure is only settled when dispatch is proven not to have happened).
- `markCompleted`/`markFailed` with a token stay CAS (`status='pending' AND claim_token=@claimToken`); after a takeover the old token is rejected.

Migration (`mutation_idempotency_dispatch_fence`): SQLite `addColumnIfMissingIfTableExists(db, "mutation_idempotency", "dispatched_at", "TEXT")`; Postgres `ALTER TABLE mutation_idempotency ADD COLUMN IF NOT EXISTS dispatched_at TEXT;`. Nullable TEXT matches the v2 live render on both lineages (the v2 render reads the SQLite blueprint, so fresh installs get the column there and the ALTER is a no-op). Check whether `status` has a CHECK constraint on either dialect (`git grep -n "status IN ('pending'" packages/storage/src`); widen it if present.

- [ ] **Step 1: Write failing repo tests** in `mutation-idempotency-repo.test.ts` (use `createRepoWithDatabaseClock`/explicit `now` like the existing stale-claim test at ~L159):

```ts
it("refuses redispatch of a stale claim that crossed the dispatch boundary", () => {
  const repo = createRepo();
  const identity = { method: "POST", routePath: "external_side_effect:x", idempotencyKey: "k-sent", actorScope: "s", payloadHash: "h", leaseDurationMs: 1_000 };
  const first = repo.claim({ ...identity, now: "2026-10-16T00:00:00.000Z" });
  assert.equal(first.outcome, "claimed");
  const marked = repo.markDispatched({ ...identity, claimToken: first.record.claimToken!, now: "2026-10-16T00:00:00.100Z" });
  assert.equal(marked.outcome, "dispatched");
  assert.ok(marked.outcome === "dispatched" && marked.record.dispatchedAt);
  assert.notEqual(marked.outcome === "dispatched" ? marked.record.claimToken : undefined, first.record.claimToken);
  const takeover = repo.claim({ ...identity, now: "2026-10-16T00:00:05.000Z" });
  assert.equal(takeover.outcome, "unknown_after_send");
  assert.equal(repo.get(identity)?.status, "unknown_after_send");
  assert.equal(repo.claim({ ...identity, now: "2026-10-16T00:10:00.000Z" }).outcome, "unknown_after_send");
  const heldToken = marked.outcome === "dispatched" ? marked.record.claimToken! : "";
  assert.equal(repo.markCompleted({ ...identity, claimToken: heldToken }), false);
});

it("takes over an unmarked stale claim and fences the old holder at the boundary", () => {
  const repo = createRepo();
  const identity = { method: "POST", routePath: "external_side_effect:x", idempotencyKey: "k-unsent", actorScope: "s", payloadHash: "h", leaseDurationMs: 1_000 };
  const first = repo.claim({ ...identity, now: "2026-10-16T00:00:00.000Z" });
  const second = repo.claim({ ...identity, now: "2026-10-16T00:00:05.000Z" });
  assert.equal(second.outcome, "claimed");
  assert.equal(second.outcome === "claimed" ? second.claimKind : undefined, "retry_after_stale_claim");
  assert.equal(repo.markDispatched({ ...identity, claimToken: first.record.claimToken!, now: "2026-10-16T00:00:05.100Z" }).outcome, "claim_lost");
  assert.equal(repo.markCompleted({ ...identity, claimToken: first.record.claimToken! }), false);
  const marked = repo.markDispatched({ ...identity, claimToken: second.record.claimToken!, now: "2026-10-16T00:00:05.200Z" });
  assert.equal(marked.outcome, "dispatched");
  assert.equal(repo.markCompleted({ ...identity, claimToken: marked.outcome === "dispatched" ? marked.record.claimToken : undefined }), true);
});

it("allows redispatch of a sent stale claim only with a provider-enforced idempotency key", () => {
  const repo = createRepo();
  const identity = { method: "POST", routePath: "external_side_effect:x", idempotencyKey: "k-provider", actorScope: "s", payloadHash: "h", leaseDurationMs: 1_000 };
  const first = repo.claim({ ...identity, now: "2026-10-16T00:00:00.000Z" });
  repo.markDispatched({ ...identity, claimToken: first.record.claimToken!, now: "2026-10-16T00:00:00.100Z" });
  const takeover = repo.claim({ ...identity, providerIdempotencyKeyEnforced: true, now: "2026-10-16T00:00:05.000Z" });
  assert.equal(takeover.outcome, "claimed");
  assert.equal(takeover.outcome === "claimed" ? takeover.claimKind : undefined, "redispatch_after_stale_send");
});

it("settles an owned dispatched claim as unknown_after_send", () => {
  const repo = createRepo();
  const identity = { method: "POST", routePath: "external_side_effect:x", idempotencyKey: "k-ambiguous", actorScope: "s", payloadHash: "h" };
  const first = repo.claim(identity);
  const marked = repo.markDispatched({ ...identity, claimToken: first.record.claimToken! });
  const token = marked.outcome === "dispatched" ? marked.record.claimToken! : "";
  assert.equal(repo.markUnknownAfterSend({ ...identity, claimToken: "wrong" }), false);
  assert.equal(repo.markUnknownAfterSend({ ...identity, claimToken: token }), true);
  assert.equal(repo.claim(identity).outcome, "unknown_after_send");
});
```

Also add a migration test: open a temp DB, `ALTER TABLE mutation_idempotency DROP COLUMN dispatched_at` is not possible on older SQLite — instead assert via `PRAGMA table_info(mutation_idempotency)` that `dispatched_at` exists after `tempDbs.open`.

- [ ] **Step 2: Run** `pnpm --filter @goatcitadel/storage exec tsx --test src/mutation-idempotency-repo.test.ts` — expect FAIL (`markDispatched is not a function`).
- [ ] **Step 3: Implement** the repo changes, both migrations, `mapRow` (`dispatched_at` → `dispatchedAt`), and the new statements described above. Keep the stale-takeover statement's `${previousClaimTokenMatchesSql}` pattern for the new `settleStaleDispatchedStmt`.
- [ ] **Step 4: Run** the repo test file again — expect PASS. Then `pnpm update:storage:migration-manifest`, bump the literals in `scripts/verify-storage-migration-parity.test.mjs` (SQLite 265 / last name `mutation_idempotency_dispatch_fence`; Postgres 212 / same name; append 212 to the no-sha list only if the new PG migration has no `integritySha256`), and run `node --test scripts/verify-storage-migration-parity.test.mjs`.
- [ ] **Step 5: Postgres proof.** Extend the real-PG block next to `stale-claim-${suffix}` with the "sent stale claim settles unknown_after_send" and "unmarked stale claim taken over, old holder fenced" assertions (same shapes as Step 1). Run against a disposable PG16 cluster in the scratchpad (`initdb`, `pg_ctl start -o "-p 55432"`), `GOATCITADEL_TEST_POSTGRES_URL=postgres://…@127.0.0.1:55432/postgres pnpm --filter @goatcitadel/storage test:postgres`. Upgraded lineage: run `runPostgresMigrations` up to v211, insert a pending legacy row, then run all migrations; assert the row survives with `dispatched_at` NULL and the schema-shape gate passes.
- [ ] **Step 6: Commit** `feat(storage): dispatch-fence mutation idempotency claims`.

### Task 2: Runner records the marker before the provider call and settles ambiguous takeovers

**Files:**
- Modify: `packages/contracts/src/integrations.ts` (`IntegrationExternalWritebackReplayOutcome` += `"unknown_after_send"`)
- Modify: `apps/gateway/src/services/external-side-effect-runner-service.ts`
- Test: `apps/gateway/src/services/external-side-effect-runner-service.test.ts`

**Interfaces:**
- Consumes: Task 1 `markDispatched`, `markUnknownAfterSend`, `claim({ providerIdempotencyKeyEnforced })`, outcome `"unknown_after_send"`.
- Produces:
  - `ExternalSideEffectClaimInput.providerIdempotencyKeyEnforced?: boolean` (forwarded to `claim`).
  - `MutationIdempotencyStore` Pick adds optional `markDispatched` and `markUnknownAfterSend`.
  - `DEFAULT_EXTERNAL_SIDE_EFFECT_CLAIM_LEASE_MS = 15 * 60 * 1000`, applied when `requireDurableBoundaryRecord` is true and `claimLeaseDurationMs` is unset (strict callers are guaranteed to mark the boundary before dispatch, so wall-clock takeover can only seize unmarked claims). Non-strict legacy callers keep no lease.

Behavior:
- `rotateExternalSideEffectMutationClaimAtBoundary`: when `mutationStore.markDispatched` exists, call it with the held token (and the lease) — `claim_lost` → throw `ExternalSideEffectMutationClaimLostError`; otherwise adopt the rotated token. Without `markDispatched` keep today's markFailed+claim rotation, and refuse a lease (pass no `leaseDurationMs`), because takeover safety needs the marker.
- Claim outcome `unknown_after_send` → `blocked`, `blockedReason: "external_side_effect_unknown_after_send"`, resumeState `manual_review_unknown_external_outcome`, run status `unknown_external_outcome`; message: `${label} may already have been sent before an interrupted holder lost its claim; it will not be sent again automatically. Reconcile it with the provider.`
- On a post-boundary ambiguous failure (`manualReconciliationRequired && !boundaryClaimLost`), settle the mutation row with `markUnknownAfterSend` (best effort, token-fenced) so it stops reading as `in_progress` forever.

- [ ] **Step 1: Write failing tests** (real SQLite `Storage` like the existing "does not let non-strict completion readback failure…" test at ~L963; use `storage.runImmediateTransaction` for `runClaimTransaction` and the real `storage.externalSideEffectRuns`):
  1. *stale unmarked claim is taken over and dispatched once*: claim via `storage.mutationIdempotency.claim({…, leaseDurationMs: 1, now: past})` to simulate a crashed pre-boundary holder; then `runIdempotentExternalSideEffect({ requireDurableBoundaryRecord: true, claimLeaseDurationMs: 1, … execute: async (c) => { await c.markExternalCallStarted(); provider(); return { id: "sent" }; } })` → `status: "executed"`, provider called once; the crashed holder's token → `markCompleted` returns false.
  2. *stale marked claim settles unknown_after_send*: claim + `markDispatched` with a past `now` and a 1 ms lease; run → `status: "blocked"`, `blockedReason: "external_side_effect_unknown_after_send"`, provider not called.
  3. *provider-enforced key redispatches*: same as 2 with `providerIdempotencyKeyEnforced: true` → `executed`, provider called once.
  4. *old holder fenced at the boundary*: start a run whose `execute` first triggers a takeover (call `storage.mutationIdempotency.claim` with a later `now`) and then calls `markExternalCallStarted()` → result `failed`, provider never called, error code `EXTERNAL_SIDE_EFFECT_BOUNDARY_CLAIM_LOST`.
  5. *ambiguous post-boundary failure settles the row*: execute marks started then throws → mutation row status `unknown_after_send`; a second run with the same key → `blocked` with `external_side_effect_unknown_after_send`.
- [ ] **Step 2: Run** `pnpm --filter @goatcitadel/gateway exec vitest run src/services/external-side-effect-runner-service.test.ts --maxWorkers=2` — expect the new tests to FAIL.
- [ ] **Step 3: Implement** the contract enum, `pnpm --filter @goatcitadel/contracts build`, then the runner changes. Fix every exhaustive switch/record over `IntegrationExternalWritebackReplayOutcome` that typecheck flags (`git grep -n "idempotency_unavailable\"" -- apps packages` to find mappers).
- [ ] **Step 4: Run** the runner test file plus `external-side-effect-replay-job-service.test.ts`, `approved-external-runtime-side-effect-service.test.ts`, `integration-action-service.test.ts` — expect PASS. Then `pnpm --filter @goatcitadel/gateway typecheck`.
- [ ] **Step 5: Commit** `feat(gateway): fence external side effects with a dispatched marker`.

### Task 3: PR A gates

- [ ] `pnpm typecheck`, `pnpm verify:architecture:metrics`, `node scripts/verify-repo-hygiene.mjs`, `git diff --check origin/main...HEAD`, storage + migration-parity tests.
- [ ] Update `docs/CANONICAL_RUNTIME_STATE_MODEL.md` if it lists external side-effect mutation states (`git grep -n "claimed_not_sent\|unknown_external_outcome" docs`).
- [ ] Push branch, open PR A against `main`.

---

## PR B — Tasks 7.1, 7.2, 7.4, 7.5, 7.6

Survey corrections to the program plan (recorded as rulings in the SDD ledger):
- 7.2: in SQLite mode transcripts are per-session JSONL files (`packages/storage/src/transcript-log.ts`), not a table; Postgres `transcript_events` already has `PRIMARY KEY (session_id, event_id)` and `append` already reuses the existing sequence. A unique index has nothing to attach to in SQLite mode, so idempotency comes from an outbox attempt marker plus an eventId lookup on the retry path. No schema change.
- 7.4: `CitadelAccessScope` does not exist yet, and `workspaces-route-service.ts` has no scope check to copy (only an optional filter; `routes/citadels.ts` 404s unknown citadels). This task defines the scope type and the check.
- 7.6: the pinned MSVC `14.44.35207` + Windows SDK `10.0.26100.0` exist on this host, so the native task is attempted.

### Task 5: Legacy HTTP+SSE MCP transport (7.1)

**Files:**
- Create: `apps/gateway/src/services/mcp-legacy-sse-transport.ts` (keeps `mcp-http-transport.ts` focused; add an allowance entry to `scripts/verification/baselines/architecture-new-service-allowances.json` if the architecture metrics lane requires one for this path)
- Modify: `apps/gateway/src/services/mcp-http-transport.ts` (`withHttpMcpClient` dispatches `server.transport === "sse"` to the legacy client; both return `HttpMcpClient`)
- Modify: `apps/gateway/src/routes/mcp.ts` (~L780-955 preview copy)
- Test: `apps/gateway/src/services/mcp-runtime.test.ts` (reuse the real `node:http` server pattern of `withRemoteMcpHttpServer`, L59-91; add a GET-stream variant)

**Interfaces:**
- Produces: `withLegacySseMcpClient<T>(server: McpServerRecord, timeoutMs: number, options: McpRuntimeTransportOptions, run: (client: HttpMcpClient) => Promise<T>, signal?: AbortSignal): Promise<T>`.

Behavior (MCP 2024-11-05 HTTP+SSE):
1. `GET server.url` with `Accept: text/event-stream` plus the same auth headers (`buildMcpHttpAuthHeaders`) through `fetchAllowlisted` with `options.networkAllowlist`.
2. Read SSE events until the first `event: endpoint`; its `data` is a URL resolved against `server.url`. Bound the wait with the existing 25 s read timeout (`MCP_HTTP_RESPONSE_READ_TIMEOUT_MS`, or the caller's `timeoutMs` when smaller).
3. Refuse (`MCP SSE server <label> announced a cross-origin message endpoint.`) unless `new URL(endpoint).origin === new URL(server.url).origin`; keep the `fetchAllowlisted` call (with `options.networkAllowlist`) for every POST so the endpoint is allowlist-checked too.
4. `request()` POSTs the JSON-RPC message to the endpoint (expect 2xx, typically 202) and resolves with the `event: message` whose JSON `id` matches, read off the GET stream. `notify()` POSTs without awaiting a stream reply. Every stream event is capped at `MCP_HTTP_RESPONSE_BODY_MAX_BYTES` (1 MB) and each response waits at most the read timeout.
5. `initialize` → `notifications/initialized` → `run(client)`; `close()` aborts the GET stream.
6. Session failure retried once: the existing `invokeMcpRuntimeTool` retry already reconnects for `isExplicitlyRetrySafeMcpSessionFailure`; make a POST to the endpoint that answers 404 before dispatch surface as the same expired-session pre-dispatch error so that path applies.

Preview copy (`routes/mcp.ts`): name the transport truthfully. `runtimePath` stays `generic_remote_http_sse`; the `runtime_supported` next action becomes "Connect and invoke through the governed MCP runtime path (Streamable HTTP, or the legacy HTTP+SSE handshake for `sse` records, which only POSTs to a same-origin, allowlisted endpoint); Gateway policy, approvals, network allowlists, and audit still apply." Keep `GOATCITADEL_EXPERIMENTAL_REMOTE_MCP_TRANSPORTS` as the gate for *unsupported-auth* record creation (allowlisted `sse` servers with supported auth were already runtime-supported, just on the wrong wire protocol). Update the stale line in `GOATCITADEL_PRODUCT_GAP_REVIEW_CLAUDE.md:123` if it still claims stdio-only.

- [ ] **Step 1: Write failing tests** in `mcp-runtime.test.ts` (describe "legacy HTTP+SSE transport"): a helper server answering `GET /sse` with `text/event-stream`, writing `event: endpoint\ndata: /messages?sessionId=s1\n\n`, accepting `POST /messages` with 202 and pushing `event: message\ndata: <json-rpc reply>\n\n` on the open stream. Cases:
  - handshake ok: `discoverMcpTools({ ...createRemoteTestServer(url + "/sse"), transport: "sse" }, 1000, { networkAllowlist: [host] })` returns the listed tool, and the server saw POSTs only at `/messages`.
  - cross-origin endpoint rejected: endpoint on another listening port → rejects with `cross-origin`, and neither server recorded a POST.
  - oversize rejected: a `message` event larger than 1 MB → rejects with `exceeded 1048576 bytes`.
  - session failure retried once: first POST to the endpoint returns 404 before dispatch on the first connection only; `invokeMcpRuntimeTool` returns `ok: true`, `retryCount: 1`, and two GET connections were opened.
- [ ] **Step 2: Run** `pnpm --filter @goatcitadel/gateway exec vitest run src/services/mcp-runtime.test.ts --maxWorkers=2` → new tests FAIL.
- [ ] **Step 3: Implement** the legacy client and the dispatch in `withHttpMcpClient`, reusing the bounded-read helpers (export small helpers from `mcp-http-transport.ts` rather than copying them).
- [ ] **Step 4: Run** the file again plus `src/routes/mcp.test.ts` → PASS. Update the copy assertions in `mcp.test.ts` that pin the old next-action string.
- [ ] **Step 5: Commit** `feat(gateway): legacy HTTP+SSE MCP transport with same-origin endpoint fence`.

### Task 6: Transcript outbox idempotency (7.2)

**Files:**
- Modify: `packages/storage/src/transcript-outbox-repo.ts` (add `markAttemptStarted(eventId, { attemptedAt })`: sets `last_attempt_at` without touching `attempt_count`, only while `delivered_at IS NULL`)
- Modify: `packages/storage/src/transcript-log.ts` and `packages/storage/src/postgres-transcript-log.ts` (add `findEventOffset(sessionId: string, eventId: string): Promise<number | undefined>`; JSONL: stream the session file line by line and return the byte offset of the line whose `eventId` matches; Postgres: `SELECT event_sequence FROM transcript_events WHERE session_id=@sessionId AND event_id=@eventId`)
- Modify: `packages/gateway-core/src/event-ingest.ts` (`flushTranscriptOutboxSession`)
- Test: `packages/storage/src/transcript-outbox-repo.test.ts`, `packages/storage/src/transcript-log.test.ts`, `packages/storage/src/postgres-transcript-log.test.ts`, `packages/gateway-core/src/event-ingest.test.ts`

**Interfaces:**
- Produces: `TranscriptOutboxRepository.markAttemptStarted(eventId: string, input: { attemptedAt: string }): TranscriptOutboxRecord | undefined`; `findEventOffset` on both transcript logs.

Drain algorithm per record:
1. If `record.lastAttemptAt` is set (an earlier attempt began and may have appended), `const existing = await storage.transcripts.findEventOffset(record.sessionId, record.eventId)`; if found, skip the append and use that offset.
2. Otherwise `await storage.transcriptOutbox.markAttemptStarted(record.eventId, { attemptedAt: now })`, then `append`.
3. `markDelivered` as today. On failure: `markFailed` as today, and log with `logger.child("event-ingest").warn("transcript append failed after event commit", { sessionId, eventId, attemptCount, error })` using gateway-core's structured logger (`./logger.js`). Remove the `console.warn` and its eslint-disable comment. Leave the unrelated billing `console.warn` alone.

- [ ] **Step 1: Write failing tests:**
  - event-ingest (real `Storage({ dbPath: ":memory:", transcriptsDir })`): ingest an event, make `transcriptOutbox.markDelivered` throw once (then delegate), drain again → `storage.transcripts.read(sessionId)` has exactly one event with that eventId and the outbox row is delivered.
  - crash variant: for a pending outbox row call `markAttemptStarted` + `transcripts.append` manually (process death before `markDelivered`), then drain → still exactly one line.
  - the existing "returns success even when transcript append fails after commit" test asserts the structured logger warn instead of `vi.spyOn(console, "warn")`.
  - transcript-log: `findEventOffset` returns the offset `append` returned, `undefined` for an unknown id or missing file. Postgres log: fake statement returns the sequence.
  - outbox repo: `markAttemptStarted` sets `lastAttemptAt`, keeps `attemptCount`; no-op on a delivered row.
- [ ] **Step 2: Run** `pnpm --filter @goatcitadel/storage exec tsx --test src/transcript-outbox-repo.test.ts src/transcript-log.test.ts src/postgres-transcript-log.test.ts` and `pnpm --filter @goatcitadel/gateway-core exec vitest run src/event-ingest.test.ts --maxWorkers=2` → FAIL.
- [ ] **Step 3: Implement.** Rebuild storage dist if gateway-core resolves it from `dist` (`pnpm --filter @goatcitadel/storage build`).
- [ ] **Step 4: Run** the same commands → PASS.
- [ ] **Step 5: Commit** `fix(gateway-core): idempotent transcript outbox drain with structured logging`.

### Task 7: Watchtower access control on citadel cron listing (7.4)

**Files:**
- Modify: `packages/contracts/src/citadels.ts` (add `CitadelAccessScope`, `canReadCitadel`)
- Modify: `packages/storage/src/cron-job-repo.ts` (`listByCitadel(scope: CitadelAccessScope)`; delete the TODO)
- Modify: `apps/gateway/src/services/gateway/cron-automation-service.ts` (`listCronJobsForCitadel(scope)`), `apps/gateway/src/services/cron-route-service.ts` (port method), `apps/gateway/src/routes/dashboard.ts` (`GET /api/v1/cron/jobs?citadelId=`)
- Test: `packages/storage/src/cron-job-repo.citadel.test.ts`, `apps/gateway/src/routes/dashboard.cron.test.ts`, `packages/contracts/src/citadels.test.ts`

**Interfaces:**
```ts
/** Server-built Watchtower authority for one citadel-scoped read. Never parsed from a request. */
export interface CitadelAccessScope {
  citadelId: string;
  /** Citadels the authenticated actor may read; "all" only for the local operator auth class. */
  readableCitadelIds: "all" | readonly string[];
}
export function canReadCitadel(scope: CitadelAccessScope): boolean; // false for blank id; true for "all"; else membership
```
- Repo: `listByCitadel(scope)` returns `[]` when `!canReadCitadel(scope)`; otherwise today's query (citadel rows plus global `citadel_id IS NULL` rows — global schedules are installation-wide; say so in the JSDoc).
- Gateway check (first caller): the route accepts optional `citadelId` (`z.string().trim().min(1).max(200)`); without it the route behaves as today. With it, the service loads the citadel through `storage.citadels` (unknown → 404 `{ error: "Citadel <id> not found." }`, as `routes/citadels.ts` does), builds the scope server-side (`readableCitadelIds: "all"` for the operator access class that `/api/v1/cron` already requires per `route-access.ts`; any other caller gets `[]`), and returns 403 `{ error: "Citadel <id> is outside your Watchtower access scope." }` when `canReadCitadel` is false.

- [ ] **Step 1: Write failing tests:** contracts `canReadCitadel` (blank false, "all" true, listed true, unlisted false); repo: denied scope → `[]`, allowed → that citadel's jobs plus global jobs, never another citadel's; route: allowed → 200 with items, unknown citadel → 404, denied → 403, no `citadelId` → unchanged list.
- [ ] **Step 2: Run** `pnpm --filter @goatcitadel/contracts exec vitest run src/citadels.test.ts`, `pnpm --filter @goatcitadel/storage exec tsx --test src/cron-job-repo.citadel.test.ts`, `pnpm --filter @goatcitadel/gateway exec vitest run src/routes/dashboard.cron.test.ts --maxWorkers=2` → FAIL.
- [ ] **Step 3: Implement**; rebuild contracts dist.
- [ ] **Step 4: Run** again → PASS; `pnpm --filter @goatcitadel/gateway typecheck`.
- [ ] **Step 5: Commit** `feat: scope-checked citadel cron listing`.

### Task 8: Graduate no-agent cron (7.5)

**Files:**
- Modify: `apps/gateway/src/services/gateway/cron-no-agent-support.ts` (delete `EXPERIMENTAL_NO_AGENT_CRON_ENV`, `isExperimentalNoAgentCronEnabled`, `assertExperimentalNoAgentCronEnabled`, `buildNoAgentCronDisabledMessage`, `isOnlyNoAgentDisableUpdate`, `assertCronActionMutationAllowed`, `isCronActionEnabledForScheduledRun`, and their call sites)
- Modify: `apps/gateway/src/services/gateway/cron-automation-service.ts`, `apps/gateway/src/routes/dashboard.ts` (`isUnsupportedCronActionError` and its 409 branches), tests `cron-automation-service.test.ts`, `dashboard.cron.test.ts`
- Create: `apps/gateway/src/services/gateway/cron-no-agent-local-proof.test.ts`; root script `verify:cron:no-agent` → `pnpm --filter @goatcitadel/gateway exec vitest run src/services/gateway/cron-no-agent-local-proof.test.ts --maxWorkers=2`
- Modify docs: `docs/1_0_CONTRACT.md` (~L110), `docs/1_0_RELEASE_EVIDENCE.md` (~L154), `docs/cron-no-agent-subagent-controls-verify.md`

Proof content (local-only execution): a `CronAutomationService` wired with the real `runNoAgentCommand` runs a `no_agent` job whose command is `process.execPath` with args `["-e", "process.stdout.write('cron-local-ok')"]`; assert exit 0 and stdout surfaced in the `cron_no_agent_output` realtime event; no model/provider dependency invoked (stubs that throw if called); `shell: false` preserved (an arg containing `&&` is passed literally); the timeout path kills the child.

Contract text: move the L110 bullet out of the "must not claim" list into shipped behavior: "`no_agent` cron jobs run a local command (no model call, `shell: false`, bounded timeout) under the operator-only `/api/v1/cron` route class; proof lane `pnpm verify:cron:no-agent`." Update the release-evidence and verify-checklist docs to match.

- [ ] **Step 1:** Write the proof test; flip `cron-automation-service.test.ts` "keeps no_agent cron jobs behind the explicit experimental env gate" to expect create / run-now / scheduled execution to work without any env stub; delete the `vi.stubEnv(EXPERIMENTAL_NO_AGENT_CRON_ENV, …)` lines; replace the route 409 test in `dashboard.cron.test.ts` with one asserting `no_agent` create returns 2xx.
- [ ] **Step 2: Run** those files → FAIL.
- [ ] **Step 3:** Remove the gate and the route mapping; update docs; add the root script.
- [ ] **Step 4: Run** the files + `pnpm verify:cron:no-agent` → PASS; `git grep -n GOATCITADEL_EXPERIMENTAL_NO_AGENT_CRON` returns only plan/history docs.
- [ ] **Step 5: Commit** `feat(gateway): graduate no-agent cron with a local-only proof lane`.

### Task 9: Windows cell capacity owners (7.6)

**Files:**
- Modify: `apps/remote-worker-windows-cell-native/src/cell_controller_main.cpp` (~L107-216)
- Modify: `apps/remote-worker-windows-cell-native/src/cell_controller_protocol.hpp` (L226-233 comment: drop "The installed service does not yet supply this owner")
- Modify: `apps/remote-worker-windows-cell-native/tests/cell_controller_protocol_test.cpp` and `scripts/packaging/remote-worker-windows-cell-controller-protocol.test.mjs` (asserted counts)

**Interfaces:** three static members on `Connection` with the exact `observe_capacity` / `observe_backing_capacity` / `observe_inventory` pointer shapes from `cell_controller_protocol.hpp`, e.g.
```cpp
static DWORD ObserveCapacity(void* context, CellProvisioningJournal& journal, const CellProvisioningAnchor& anchor,
  const CellFileSha256& digest, const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard,
  CellProvisioningFootprint* output) noexcept;
```
Each casts `context` to `Connection&`, requires the measurement hold that `BeginMeasurement` acquired and verified for this request (workload quiescence), returns `ERROR_NOT_SUPPORTED` without touching the journal when the hold is absent, and otherwise delegates to the journal observation API that operation uses (find it from the fixture lambdas and `cell_controller_protocol.cpp` call sites ~L1140/L1157/L1196). Wire all three into `owner` in `Run()` beside `observe_pool_capacity`.

- [ ] **Step 1:** In the protocol fixture, change `native-capacity-missing-hold` per the program plan to expect success once the hold owner is supplied, and add coverage that capacity, backing-capacity and inventory still refuse (`ERROR_NOT_SUPPORTED`, journal bytes unchanged) without a hold.
- [ ] **Step 2: Run** `node --test scripts/packaging/remote-worker-windows-cell-controller-protocol.test.mjs` → FAIL.
- [ ] **Step 3: Implement**; update the asserted counts in the `.mjs` test to the new fixture output.
- [ ] **Step 4: Run** the protocol test (ASAN and non-ASAN) plus `remote-worker-windows-cell-capacity.test.mjs`, `-backing-capacity`, `-mounted-capacity`, `-joined-capacity-wire`, `-installed-pool` → PASS.
- [ ] **Step 5: Commit** `feat(remote-worker): installed cell capacity, backing and inventory owners`.
- If the toolchain cannot build, stop and report BLOCKED with the exact compiler/linker output; PR B ships without it.

### Task 10: PR B gates

- [ ] `pnpm typecheck`, `pnpm verify:architecture:metrics`, `node scripts/verify-repo-hygiene.mjs`, `git diff --check origin/main...HEAD`, `pnpm docs:check`.
- [ ] Push, open PR B against `main` (stacked on PR A's branch if PR A has not merged; say so in the PR body).
