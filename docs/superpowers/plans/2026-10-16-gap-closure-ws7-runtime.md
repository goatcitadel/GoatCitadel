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

<!-- PR B tasks are appended below once the survey of their owners is complete. -->
