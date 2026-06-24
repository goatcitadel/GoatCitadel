# Code Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate all findings from the 2026-06-23 overall code review (security hardening, storage correctness/perf, runtime perf, frontend perf/a11y, and cleanup) — excluding the Vite 8 upgrade, which is tracked separately.

**Architecture:** Five independently-shippable phases. Each phase produces working, tested software on its own and can be committed/merged without the others. Phase order reflects risk: security first, then data-layer, then runtime, then frontend, then cleanup. Mechanical fixes ship with literal code; the two larger refactors (device-token-at-rest, projection-service read/write split) are broken into sub-steps with real anchor code and a flagged design decision.

**Tech Stack:** TypeScript (Node 22), pnpm workspaces, Vitest 4 (test runner), better-sqlite3 / node:sqlite + Postgres (`pg`), Fastify (gateway HTTP), React + Vite (mission-control-next).

---

## Pre-flight (read once before starting)

- [ ] **Confirm the test runner invocation.** This repo uses Vitest 4 via per-package `test` scripts. Verify the exact filter names:
  - Run: `pnpm -r exec node -e "console.log(require('./package.json').name)"` (lists every workspace package name).
  - Expected names used in this plan: `@goatcitadel/gateway`, `@goatcitadel/storage`, `@goatcitadel/policy-engine`, `@goatcitadel/mission-control-next`, `@goatcitadel/mission-control-shared`. If any differ, substitute accordingly throughout.
- [ ] **Confirm a clean baseline.** `git status` should be clean except the two untracked `docs/citadel_update/*` files. Do not commit those.
- [ ] **Branch.** Do not work on `main`. Run: `git checkout -b fix/code-review-remediation-2026-06-23`
- [ ] **Note:** All anchor line numbers were accurate as of commit `1dab232d5`. Before editing any file, re-open it and confirm the anchor still matches (the codebase is actively changed by concurrent sessions). If an anchor drifted, locate the same construct by its surrounding code shown in each task.

## Decisions required (resolve before Phase 1 Task 2 and Phase 5 Task 4)

These three items need a human/product call; the plan provides the recommended default in each task:

1. **Device-token delivery mechanism** (Phase 1, Task 4): in-memory ephemeral map (recommended, simplest) vs. SSE push to the waiting poller.
2. **Citadel Ward enforcement default** (Phase 5, Task 4): keep off-by-default + document loudly (recommended for now) vs. flip to opt-out.
3. **macOS keychain argv exposure** (Phase 5, Task 5): accept the documented platform limitation (recommended — already mitigated/commented) vs. invest in a `keytar`/native-binding rewrite.

---

# Phase 1 — Security Hardening

Ship target: one PR. Touches `apps/gateway/src/services/{secret-store-service,tool-invocation-coordinator-service,settings-auth-service,chat-proactive-service}.ts`.

## Task 1: Scope keychain-helper subprocess env to a minimal allowlist

**Severity:** HIGH (verified). The secret-management layer spreads the entire `process.env` (provider API keys, `GOATCITADEL_AUTH_TOKEN`, mesh tokens) into `powershell` / `security` / `secret-tool` child processes.

**Files:**
- Modify: `apps/gateway/src/services/secret-store-service.ts:299-326` (the `runCommand` helper)
- Test: `apps/gateway/src/services/secret-store-service.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test** — assert the child env does NOT carry an unrelated secret. Add to the test file:

```typescript
import { describe, it, expect, vi } from "vitest";
import * as childProcess from "node:child_process";

describe("runCommand env scoping", () => {
  it("does not pass unrelated process.env secrets to the child", () => {
    process.env.UNRELATED_FAKE_SECRET = "sk-should-not-leak";
    const spy = vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0, stdout: "ok", stderr: "", pid: 1, output: [], signal: null,
    } as never);
    // setWindowsCredential/setMacCredential route through runCommand; invoke the
    // platform setter indirectly via the public API used in this file's other tests,
    // OR export runCommand for testing. Here we assert via the spy:
    // (call the smallest public method that reaches runCommand on this platform)
    // ...
    const passedEnv = (spy.mock.calls[0]?.[2] as { env?: Record<string, string> })?.env ?? {};
    expect(passedEnv.UNRELATED_FAKE_SECRET).toBeUndefined();
    delete process.env.UNRELATED_FAKE_SECRET;
    spy.mockRestore();
  });
});
```

> Note: if `runCommand` is module-private and unreachable, export it as `export function runCommand(...)` for testability (it is currently a free function in the module) and assert directly: `runCommand("node", ["-e", "0"], { GOATCITADEL_SECRET_VALUE: "x" })` then inspect `spy.mock.calls[0][2].env`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/gateway test -- secret-store-service`
Expected: FAIL — `UNRELATED_FAKE_SECRET` is present in the child env.

- [ ] **Step 3: Implement minimal-env scoping.** Replace the `env` construction in `runCommand` (currently lines 305-312):

```typescript
function runCommand(
  command: string,
  args: string[],
  envOverrides?: Record<string, string>,
  options: RunOptions = {},
): { status: number; stdout: string; stderr: string } {
  // SECURITY: do NOT spread process.env into keychain helper subprocesses — it
  // would expose every provider API key / auth token to `ps` and OS process-env
  // logging. Pass only the OS vars the helpers need to locate/run, plus the
  // explicit per-call overrides (service/account/value).
  const SAFE_ENV_KEYS = [
    "PATH", "Path", "PATHEXT", "HOME", "USERPROFILE", "SystemRoot", "SYSTEMROOT",
    "windir", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "ComSpec",
  ];
  const baseEnv: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      baseEnv[key] = value;
    }
  }
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: {
      ...baseEnv,
      ...(envOverrides ?? {}),
    },
    input: options.stdin,
  });
  // ... (rest unchanged: status/allowed/throw/return)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @goatcitadel/gateway test -- secret-store-service`
Expected: PASS. Also run the full secret-store suite to confirm keychain set/get/delete still resolve `PATH` correctly on the host platform.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/secret-store-service.ts apps/gateway/src/services/secret-store-service.test.ts
git commit -m "fix(secrets): scope keychain-helper subprocess env to minimal allowlist"
```

## Task 2: Re-evaluate policy on the approved-external-runtime replay path

**Severity:** HIGH (verified). `invokeApprovedExternalRuntimeTool` calls the override handler at `tool-invocation-coordinator-service.ts:696` with no `policyEngine.invoke()` gate, unlike `invokeTool` (which gates at lines 461-470). The replay path trusts the caller's approval-binding entirely; if toolName/args drift between approval and replay, the destructive-arg gate + Ward check never fire.

**Files:**
- Modify: `apps/gateway/src/services/tool-invocation-coordinator-service.ts:662-696`
- Test: `apps/gateway/src/services/tool-invocation-coordinator-service.test.ts`

- [ ] **Step 1: Write the failing test** — a replayed tool whose policy evaluation returns a deny must be blocked, not executed. Mock `host.policyEngine.invoke` to return a deny `ToolInvokeResult` and assert the override handler is never called and the outcome is `blocked`. (Mirror the existing `invokeTool` deny-path test in this file for the harness shape.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/gateway test -- tool-invocation-coordinator-service`
Expected: FAIL — handler executes despite the deny (no gate today).

- [ ] **Step 3: Add the gate.** In `invokeApprovedExternalRuntimeTool`, after the `overrideHandler` availability check (currently lines 671-678) and BEFORE `const startedAt = Date.now();` (line 679), insert the same gate `invokeTool` uses at 461-470:

```typescript
    // SECURITY: re-evaluate policy on replay. The approval-binding is validated
    // upstream, but defense-in-depth requires the deny-wins / destructive-arg /
    // Ward gate to run here too — toolName or args could have drifted between
    // approval and replay.
    const replayPolicyCheck = await this.host.policyEngine.invoke({
      ...normalizedRequest,
      externalRuntime: true,
    });
    const replayPolicyFailure = buildPluginOverridePolicyFailure(replayPolicyCheck);
    if (replayPolicyFailure) {
      return replayPolicyFailure;
    }
```

> `buildPluginOverridePolicyFailure` is already imported in this file (used at line 466). Confirm the import is present.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @goatcitadel/gateway test -- tool-invocation-coordinator-service`
Expected: PASS. Run the full file suite to confirm the legitimate-replay path (policy allows) still executes the handler.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/tool-invocation-coordinator-service.ts apps/gateway/src/services/tool-invocation-coordinator-service.test.ts
git commit -m "fix(security): re-evaluate policy on approved external-runtime tool replay"
```

## Task 3: Make the proactive restricted-policy callback mandatory (fail-closed)

**Severity:** MEDIUM (verified). At `chat-proactive-service.ts:1438`, `resolveToolPolicyContext?.()` is optional; if a host doesn't wire it, `permissionProfileId` is `undefined` and the scheduled-restricted deny-list is bypassed for autonomous proactive execution.

**Files:**
- Modify: `apps/gateway/src/services/chat-proactive-service.ts:1434-1461`
- Reference (for the restricted fallback): `apps/gateway/src/services/autonomous-turn-policy.ts` (`buildAutonomousTurnContext` / the `SCHEDULED_RESTRICTED_*` constants)
- Test: `apps/gateway/src/services/chat-proactive-service.test.ts`

- [ ] **Step 1: Write the failing test** — when `resolveToolPolicyContext` is NOT provided, `executeProactiveToolAction` must still pass a restricted `policyContext`/`permissionProfileId` to `invokeTool` (assert `invokeTool` mock received a defined restricted profile), OR throw/block rather than invoking unrestricted.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/gateway test -- chat-proactive-service`
Expected: FAIL — `invokeTool` is called with `permissionProfileId: undefined`.

- [ ] **Step 3: Implement the fallback.** Replace the optional call (lines 1438-1449) so an absent callback yields a constructed restricted context (preferred) rather than `undefined`:

```typescript
      const policyContext =
        this.callbacks.resolveToolPolicyContext?.({
          operatorId: actor.operatorId,
          authActorId: actor.authActorId,
          authActorSource: actor.authActorSource,
          workspaceId,
          sessionId: action.sessionId,
          taskId: action.linkedTaskId,
          runId: durableRunId,
          surface,
          permissionProfileId: actor.permissionProfileId,
          localOperatorOverrideId: actor.localOperatorOverrideId,
        }) ?? buildRestrictedProactivePolicyContext({ actor, workspaceId, sessionId: action.sessionId, surface });
```

Add a small helper (top of the file or imported from `autonomous-turn-policy.ts`) that returns a context pinned to the scheduled-restricted permission profile. Confirm the exact restricted-profile identifier in `autonomous-turn-policy.ts` and reuse it — do not invent a new profile id.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @goatcitadel/gateway test -- chat-proactive-service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/chat-proactive-service.ts apps/gateway/src/services/chat-proactive-service.test.ts
git commit -m "fix(security): fail-closed to restricted policy for proactive tool execution"
```

## Task 4: Stop storing the device token in plaintext at rest

**Severity:** MEDIUM-HIGH (verified return path). The approved device token is written to the `approved_token_plaintext` column and returned on status poll (`device-access-helpers.ts:283-286`), nulled only after delivery (`settings-auth-service.ts:~1170`). Operator-equivalent credential sits in SQLite in plaintext until first poll.

> **DECISION (resolve first):** delivery mechanism — (a) **in-memory ephemeral map** keyed by `requestId` with a short TTL (recommended: simplest, no schema change, plaintext never touches disk); or (b) SSE push to the waiting poller. This plan implements (a).

**Files:**
- Modify: `apps/gateway/src/services/settings-auth-service.ts` (token approve/store path ~808-821 and the null-out ~1170)
- Modify: `apps/gateway/src/services/device-access-helpers.ts:275-290` (`mapDeviceAccessStatusResponse`)
- Test: `apps/gateway/src/services/settings-auth-service.test.ts` (or the device-access test file)

- [ ] **Step 1: Read the full flow first.** Open `settings-auth-service.ts` and trace: where the device token is generated, where `approvedTokenPlaintext` is written to the record, and the status-poll read path. Document the three line ranges in the PR description.

- [ ] **Step 2: Write the failing test** — after approval, the persisted `auth_device_requests` row must NOT contain the plaintext token; the status poll (first call) still returns the token; a second poll returns no token.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/gateway test -- settings-auth-service`
Expected: FAIL — plaintext is present in the persisted row.

- [ ] **Step 4: Implement in-memory ephemeral delivery.**
  - Add a private `Map<string /*requestId*/, { token: string; expiresAt: number }>` on the service (or a small module-scoped store) with a TTL (e.g. the device-token expiry, capped at a few minutes).
  - On approval: put the plaintext in the map; persist only the existing hashed/opaque fields to the row (do not write `approved_token_plaintext`). If the column must remain for back-compat, write `NULL`.
  - In `mapDeviceAccessStatusResponse` / the status handler: read the plaintext from the map; on first successful delivery, delete the map entry (single-use), matching today's "null after delivery" semantics.
  - Expire map entries lazily on read and via the existing reaper/interval if one exists.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @goatcitadel/gateway test -- settings-auth-service`
Expected: PASS (all three assertions).

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/services/settings-auth-service.ts apps/gateway/src/services/device-access-helpers.ts apps/gateway/src/services/settings-auth-service.test.ts
git commit -m "fix(security): deliver device token via ephemeral in-memory store, never plaintext at rest"
```

---

# Phase 2 — Storage Correctness & Performance

Ship target: one PR. Touches `packages/storage/src/{sqlite,autonomy-audit-repo}.ts`, `packages/storage/src/postgres/migrations.ts`, and `apps/gateway/src/services/autonomy-control-service.ts`.

## Task 1: Add the missing `cost_ledger(created_at)` index on SQLite

**Severity:** HIGH (verified). Time-range cost summaries (`summaryByAgent/Task/UsageAvailability`) full-scan because SQLite only has `idx_cost_ledger_day` and `idx_cost_ledger_session_id` — nothing on `created_at`.

**Files:**
- Modify: `packages/storage/src/sqlite.ts:1517-1522` (append migration v131) and `:1939-1940` (fresh-schema index block)
- Test: `packages/storage/src/sqlite.migrations.test.ts` (or the existing storage migration test)

- [ ] **Step 1: Write the failing test** — open a fresh DB through the migrator, then assert the index exists:

```typescript
it("creates idx_cost_ledger_created_at", () => {
  const db = openTestDatabase(); // existing helper in the storage tests
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='cost_ledger'",
  ).all() as Array<{ name: string }>;
  expect(rows.map((r) => r.name)).toContain("idx_cost_ledger_created_at");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/storage test -- sqlite`
Expected: FAIL — index not found.

- [ ] **Step 3a: Append migration v131.** Insert immediately before the closing `];` at line 1522 (after the v130 entry):

```typescript
  {
    version: 131,
    name: "cost_ledger_created_at_index",
    up: (db) => {
      if (tableExists(db, "cost_ledger")) {
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_cost_ledger_created_at
            ON cost_ledger(created_at);
        `);
      }
    },
  },
```

- [ ] **Step 3b: Add to the fresh schema.** At lines 1939-1940 (the `idx_cost_ledger_day` / `idx_cost_ledger_session_id` block), add:

```typescript
    CREATE INDEX IF NOT EXISTS idx_cost_ledger_created_at ON cost_ledger(created_at);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @goatcitadel/storage test -- sqlite`
Expected: PASS. Also run the full storage suite — the migration-parity test pins versions, so confirm v131 is accepted as the new max.

- [ ] **Step 5: Commit**

```bash
git add packages/storage/src/sqlite.ts packages/storage/src/sqlite.migrations.test.ts
git commit -m "perf(storage): add cost_ledger(created_at) index for time-range summaries"
```

## Task 2: Bound `listUnrevertedSince` with a pushed-down LIMIT

**Severity:** HIGH (verified). `autonomy-audit-repo.ts:56-60` `listSinceStmt` has no LIMIT; `listUnrevertedSince` (line 114) loads all unreverted rows into memory and the caller (`autonomy-control-service.ts:~156`) slices after.

**Files:**
- Modify: `packages/storage/src/autonomy-audit-repo.ts:56-60` and `:114-116`
- Modify: `apps/gateway/src/services/autonomy-control-service.ts` (the `listUnrevertedSince` caller, ~line 156)
- Test: `packages/storage/src/autonomy-audit-repo.test.ts`

- [ ] **Step 1: Write the failing test** — insert N unreverted rows, call `listUnrevertedSince(epoch, { limit: 2 })`, assert exactly 2 rows returned (newest-first), proving the cap is applied in SQL.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/storage test -- autonomy-audit-repo`
Expected: FAIL — `listUnrevertedSince` has no `limit` parameter.

- [ ] **Step 3a: Push LIMIT into the statement** (lines 56-60):

```typescript
    this.listSinceStmt = db.prepare(`
      SELECT * FROM autonomy_audit
      WHERE occurred_at >= ? AND reverted = 0
      ORDER BY occurred_at DESC, audit_id DESC
      LIMIT ?
    `);
```

- [ ] **Step 3b: Add the bounded param** (lines 114-116):

```typescript
  public listUnrevertedSince(sinceIso: string, limit = 10_000): AutonomyAuditEntry[] {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 10_000;
    return this.listSinceStmt.all(sinceIso, safeLimit).map(toRow).filter(isEntryRow).map(mapRow);
  }
```

- [ ] **Step 3c: Thread the caller's cap down.** In `autonomy-control-service.ts`, pass the effective limit into `listUnrevertedSince(sinceIso, opts.limit ?? 10_000)` instead of slicing the full result afterward.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @goatcitadel/storage test -- autonomy-audit-repo` then `pnpm --filter @goatcitadel/gateway test -- autonomy-control-service`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add packages/storage/src/autonomy-audit-repo.ts apps/gateway/src/services/autonomy-control-service.ts packages/storage/src/autonomy-audit-repo.test.ts
git commit -m "perf(storage): bound autonomy-audit listUnrevertedSince with pushed-down LIMIT"
```

## Task 3: Freeze the Postgres v7 migration's embedded schema (immutability)

**Severity:** MEDIUM (agent-reported). `postgres/migrations.ts:344-422` ends with `${buildPostgresRuntimeSchemaSql()}`, so every future change to the canonical schema silently mutates the historical v7 migration body — violating the v1–v28 immutability contract.

**Files:**
- Modify: `packages/storage/src/postgres/migrations.ts:344-422`
- Test: `packages/storage/src/postgres/migrations.test.ts` (the parity/hash test if present)

- [ ] **Step 1: Confirm the anchor.** Open the file and verify v7's body calls `buildPostgresRuntimeSchemaSql()` inline.
- [ ] **Step 2: Snapshot the SQL.** Capture the CURRENT output of `buildPostgresRuntimeSchemaSql()` as it stands today into a frozen string constant, e.g. `const POSTGRES_V7_FROZEN_SCHEMA_SQL = \`...\`;` placed next to v7. (Generate it by logging the function output once in a scratch test; paste verbatim.)
- [ ] **Step 3: Replace the inline call** in v7's body with `${POSTGRES_V7_FROZEN_SCHEMA_SQL}`.
- [ ] **Step 4: Verify** the migration parity/hash test still passes and a fresh Postgres migrate (if an integration harness exists) reaches the same schema. Run: `pnpm --filter @goatcitadel/storage test -- postgres`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/storage/src/postgres/migrations.ts packages/storage/src/postgres/migrations.test.ts
git commit -m "fix(storage): freeze Postgres v7 embedded schema snapshot for migration immutability"
```

---

# Phase 3 — Runtime Performance & Correctness

Ship target: one PR. Touches `apps/gateway/src/services/{cowork-agentic-projection-service,chat-proactive-service,chat-turn-prep-service}.ts`.

## Task 1: Make `getAgenticRunTree` read-only and de-duplicate its query fan-out

**Severity:** HIGH (agent-reported). The "read" GET runs `reconcile*` DB `patch()` writes on every poll (lost-update races with the orchestrator) and re-issues `listByRun` up to 3× plus per-step `chatTurnTraces.get` + `durableRuns.getRun` (~33 reads on a 10-step run).

**Files:**
- Modify: `apps/gateway/src/services/cowork-agentic-projection-service.ts:97-267` (read path), `:379-432` (reconcile writes), `:52-95` (`listAgenticRuns` per-run trace fetch)
- Test: `apps/gateway/src/services/cowork-agentic-projection-service.test.ts`

- [ ] **Step 1: Confirm anchors** and map every `this.storage.*.patch(...)` call inside `getAgenticRunTree`/`reconcile*`.
- [ ] **Step 2: Write the failing test** — calling `getAgenticRunTree` must issue ZERO `patch` writes (spy on the repo `patch` methods; assert not called). Add a second test: a 5-step run resolves traces with a single bulk fetch (assert `chatTurnTraces.get` is not called per-step once bulk-loading is in).
- [ ] **Step 3: Run test to verify it fails.** Run: `pnpm --filter @goatcitadel/gateway test -- cowork-agentic-projection-service`. Expected: FAIL (writes happen; per-step gets happen).
- [ ] **Step 4: Implement.**
  - Move reconciliation OUT of the GET. Reconciliation should run only from the durable-kernel path that already holds the correct locking context. The projection GET becomes strictly read-only.
  - Load all delegation steps ONCE at entry; pass the array through `resolveRunWorkspaceId` / `reconcileRunSteps` instead of each re-calling `listByRun`.
  - Bulk-fetch child traces and durable runs: collect all `turnId`/`runId` values, issue `IN (...)` queries (add `listByIds`/`getMany` repo methods if absent), resolve in memory.
  - Apply the same bulk-fetch to `listAgenticRuns` (collect `turnId`s, one `WHERE turn_id IN (...)`).
- [ ] **Step 5: Run test to verify it passes.** Run the file suite. Expected: PASS. Manually confirm the Cowork tree still renders identical data (the reconcile effect must still happen, just from the kernel path).
- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/services/cowork-agentic-projection-service.ts apps/gateway/src/services/cowork-agentic-projection-service.test.ts
git commit -m "perf(cowork): make agentic run projection read-only and bulk-fetch traces"
```

## Task 2: Replace de-novo cadence open-work check with an existence query

**Severity:** HIGH (agent-reported). `chat-proactive-service.ts:418-426, 506-517` runs ~2 DB reads × every non-reactive session on each 2-min scheduler tick (300 sessions → 300+ queries/tick), and `hasOpenDeNovoWork` fetches up to 20 rows to answer "≥1 pending?".

**Files:**
- Modify: `apps/gateway/src/services/chat-proactive-service.ts:506-517` (`hasOpenDeNovoWork`) and the `agentCommitments` repo it calls (add a `hasOpenBySession` existence method)
- Modify: `packages/storage/src/<agent-commitments-repo>.ts` (add `SELECT 1 ... LIMIT 1`)
- Test: the proactive service test + the commitments repo test

- [ ] **Step 1: Write the failing test** — a repo `hasOpenBySession(sessionId)` returns `true` with ≥1 pending commitment and `false` otherwise, issuing a single `LIMIT 1` query.
- [ ] **Step 2: Run test to verify it fails.** Expected: FAIL — method does not exist.
- [ ] **Step 3: Implement** `hasOpenBySession` as `SELECT 1 FROM agent_commitments WHERE session_id = ? AND <pending predicate> LIMIT 1` and rewrite `hasOpenDeNovoWork` to call it instead of `listBySession(sessionId, 20).some(...)`. Keep the existing cheap in-memory gates ordered before the DB check.
- [ ] **Step 4: Run tests to verify they pass.** Run both suites. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/chat-proactive-service.ts packages/storage/src/*agent-commitment* packages/storage/src/*agent-commitment*.test.ts
git commit -m "perf(proactive): existence query for de-novo open-work cadence gate"
```

## Task 3: Tighten the planner LLM timeout

**Severity:** MEDIUM (verified constant). `chat-turn-prep-service.ts:75` `CHAT_PLANNER_COMPLETION_TIMEOUT_MS = 2500` adds up to 2.5s to every non-fast turn before the free template fallback fires.

**Files:**
- Modify: `apps/gateway/src/services/chat-turn-prep-service.ts:75` (+ the call site ~930-996)
- Test: `apps/gateway/src/services/chat-turn-prep-service.test.ts`

- [ ] **Step 1: Decide the approach** — either (a) lower the constant to `1000`, or (b) start the planner LLM call in parallel with the existing `Promise.all` (guidance/thread-knowledge/session-state) and join with a shorter timeout. (a) is the minimal fix; (b) removes the wait from the critical path. Recommended: (a) now, (b) if profiling shows the planner is still on the hot path.
- [ ] **Step 2: Write/adjust the test** asserting the timeout constant is ≤ 1000 (guards regressions) and the fallback plan is produced when the LLM exceeds it.
- [ ] **Step 3: Implement** the change.
- [ ] **Step 4: Run test.** Run: `pnpm --filter @goatcitadel/gateway test -- chat-turn-prep-service`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/chat-turn-prep-service.ts apps/gateway/src/services/chat-turn-prep-service.test.ts
git commit -m "perf(chat): tighten planner completion timeout to cut turn latency under load"
```

## Task 4: Atomicity hardening for proactive run patch + reconcile finalSummary

**Severity:** MEDIUM (agent-reported). `patchProactiveRun` (chat-proactive-service.ts:839-894) is a non-atomic read-modify-write (lost-update window on concurrent approval resolution); `reconcileRunSteps` (cowork-agentic-projection-service.ts:412-431) can clobber the orchestrator's `finalSummary` with a generic fallback string.

**Files:**
- Modify: `apps/gateway/src/services/chat-proactive-service.ts:839-894`
- Modify: `apps/gateway/src/services/cowork-agentic-projection-service.ts:412-431` (now part of the kernel reconcile path after Phase 3 Task 1)
- Test: respective service tests

- [ ] **Step 1:** Write failing tests — (a) two concurrent `patchProactiveRun` calls must not lose a field write (assert COALESCE-style merge); (b) `reconcileRunSteps` must NOT overwrite a non-null orchestrator `finalSummary`.
- [ ] **Step 2:** Verify they fail.
- [ ] **Step 3:** Implement — wrap the proactive run read-modify-write in a `BEGIN IMMEDIATE` transaction (or a single `UPDATE ... SET field = COALESCE(@patch, field)` for non-regressing fields); guard the reconcile finalSummary write with `if (run.finalSummary == null)` and reload the run immediately before patching.
- [ ] **Step 4:** Verify tests pass.
- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/chat-proactive-service.ts apps/gateway/src/services/cowork-agentic-projection-service.ts
git commit -m "fix(runtime): atomic proactive run patch + preserve orchestrator finalSummary"
```

---

# Phase 4 — Frontend Performance & Accessibility

Ship target: one PR. Touches `packages/mission-control-shared/src/components/chat/*` and `apps/mission-control-next/src/features/*`.

## Task 1: Remove the double scroll-drive on streamed tokens

**Severity:** MEDIUM (verified). `ChatThreadView.tsx:140-149` runs a manual `scrollToIndex` effect keyed on `threadSignalsKey` (which includes `streamingPreview.visibleText.length`, `:132`) while Virtuoso already runs `followOutput="auto"` (`:189`) — two mechanisms fight on every token and can yank a user who scrolled up.

**Files:**
- Modify: `packages/mission-control-shared/src/components/chat/ChatThreadView.tsx:132, 140-149, 189`
- Test: `packages/mission-control-shared/src/components/chat/ChatThreadView.test.tsx`

- [ ] **Step 1:** Write/adjust a test asserting the manual `scrollToIndex` effect does not re-run on `visibleText.length` change (e.g. spy on the ref method, advance streaming text, assert no extra call while `followOutput` is auto).
- [ ] **Step 2:** Verify it fails.
- [ ] **Step 3:** Implement — rely solely on Virtuoso `followOutput` for stream-follow; if an explicit nudge is needed, gate it on turn-id/turn-count change, not `visibleText.length`, and never while `followOutput === "auto"`. Remove `streamingPreview.visibleText.length` from `threadSignalsKey`.
- [ ] **Step 4:** Verify it passes.
- [ ] **Step 5: Commit**

```bash
git add packages/mission-control-shared/src/components/chat/ChatThreadView.tsx packages/mission-control-shared/src/components/chat/ChatThreadView.test.tsx
git commit -m "perf(chat-ui): drop redundant manual scroll-drive during streaming"
```

## Task 2: Incrementalize the streaming markdown split (O(n²) → O(delta))

**Severity:** MEDIUM (verified). `AssistantMessageRenderer.tsx:340 → splitStreamingMarkdown (:361-415)` re-runs a full forward scan from scratch each token; cumulative O(n²) over a long answer.

**Files:**
- Modify: `packages/mission-control-shared/src/components/chat/AssistantMessageRenderer.tsx:340, 361-415`
- Test: same-dir test file

- [ ] **Step 1:** Write a test feeding incremental content and asserting output equivalence with the current full-scan (correctness guard), plus a perf-shape assertion (the split receives only the delta + carried state).
- [ ] **Step 2:** Verify the correctness test passes against current code (refactor must preserve output) and add the incremental-state test that fails today.
- [ ] **Step 3:** Implement — carry last fence-state + last paragraph-boundary index across tokens in a `ref` keyed on the streaming turn id; each delta processes only new characters. Keep the memoized `stable` block; only the `tail` re-parses.
- [ ] **Step 4:** Verify tests pass.
- [ ] **Step 5: Commit**

```bash
git add packages/mission-control-shared/src/components/chat/AssistantMessageRenderer.tsx packages/mission-control-shared/src/components/chat/AssistantMessageRenderer.test.tsx
git commit -m "perf(chat-ui): incremental streaming markdown split to remove O(n^2) re-scan"
```

## Task 3: Stop the per-second screen-reader re-announce on pending approvals

**Severity:** MEDIUM a11y (verified). `InlineApprovalPrompt.tsx:61-76` ticks a 1s countdown inside a `role="alert"` (`:117-120`), so the whole approval prompt is re-read once per second.

**Files:**
- Modify: `packages/mission-control-shared/src/components/chat/InlineApprovalPrompt.tsx:61-76, 117-120`
- Test: same-dir test file

- [ ] **Step 1:** Write a test asserting the ticking countdown node is NOT inside an assertive live region (query the `role="alert"` subtree; assert the countdown text is `aria-live="off"` or `aria-hidden` or outside it).
- [ ] **Step 2:** Verify it fails.
- [ ] **Step 3:** Implement — keep `role="alert"` on the static decision text only; move the countdown out of the alert subtree or set `aria-live="off"` / `aria-hidden="true"` on the ticking element. (Interval cleanup is already correct — leave it.)
- [ ] **Step 4:** Verify it passes.
- [ ] **Step 5: Commit**

```bash
git add packages/mission-control-shared/src/components/chat/InlineApprovalPrompt.tsx packages/mission-control-shared/src/components/chat/InlineApprovalPrompt.test.tsx
git commit -m "fix(a11y): stop per-second alert re-announce on pending approval countdown"
```

## Task 4: Cap/window high-cardinality lists (Kanban + NativeList callers)

**Severity:** MEDIUM (verified anchors). `KanbanRoutePage.tsx:188-198` renders up to 200 multi-element cards with no windowing and re-renders all on each selection toggle; `NativeList` callers (memory, browser-session events) render every row.

**Files:**
- Modify: `apps/mission-control-next/src/features/native-routes/ops/KanbanRoutePage.tsx:50, 188-198, 217-233`
- Modify (lower priority): `apps/mission-control-next/src/features/native-routes/library/MemoryRoutePage.tsx:487`, `ops/BrowserSessionsRoutePage.tsx:431, 442`
- Test: route page tests

- [ ] **Step 1:** Write a test asserting a column with 200 source runs renders ≤ a capped number of cards (e.g. 50) with a "show more" affordance.
- [ ] **Step 2:** Verify it fails.
- [ ] **Step 3:** Implement — cap visible cards per column (`.slice(0, 50)` + "+N more"), memoize the card component, and keep `selected` as a stable structure so a toggle doesn't re-render all cards. Apply the same "+N more" cap to the memory and browser-event lists (the cost/pareto lists already do this — copy that pattern).
- [ ] **Step 4:** Verify it passes.
- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/features/native-routes/ops/KanbanRoutePage.tsx apps/mission-control-next/src/features/native-routes/library/MemoryRoutePage.tsx apps/mission-control-next/src/features/native-routes/ops/BrowserSessionsRoutePage.tsx
git commit -m "perf(ui): cap high-cardinality Kanban/memory/event lists with show-more"
```

## Task 5: Pause shell-status polling on hidden tabs

**Severity:** LOW (verified). `apps/mission-control-next/src/app/use-shell-status.ts:114-122` keeps the 15s dashboard+health poll firing when `document.hidden`, unlike `useRefreshSubscription` (which gates on visibility at `:157`).

**Files:**
- Modify: `apps/mission-control-next/src/app/use-shell-status.ts:114-122`
- Test: `apps/mission-control-next/src/app/use-shell-status.test.ts`

- [ ] **Step 1:** Write a test: with `document.hidden = true`, advancing 15s does not call `fetchDashboardState`/`fetchHealthSummary`.
- [ ] **Step 2:** Verify it fails.
- [ ] **Step 3:** Implement — skip (or back off) the tick when `document.hidden`, mirroring `useRefreshSubscription.ts:157`. Refresh once on `visibilitychange` back to visible.
- [ ] **Step 4:** Verify it passes.
- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/app/use-shell-status.ts apps/mission-control-next/src/app/use-shell-status.test.ts
git commit -m "perf(ui): pause shell-status polling while tab is hidden"
```

---

# Phase 5 — Cleanup, Lower-Severity Hardening & Decisions

Ship target: one PR (except the dead-code trim, which may warrant its own PR for review clarity). These are terser; each is still test-backed where it changes behavior.

## Task 1: Trim the dead shadcn/`GC*` component surface

**Severity:** LOW-MEDIUM (verified partial-dead). ~23 of ~30 barrel exports in `packages/mission-control-shared/src/components/ui/index.ts` have zero non-test consumers; with no `"sideEffects": false`, the `export *` barrel won't tree-shake them.

- [ ] **Step 1:** For each export in `components/ui/index.ts`, grep the repo (`apps/` + `packages/`, excluding tests) for usage. Produce a kept/removed list. KNOWN LIVE (do not remove): `Sheet*`, `Badge`, `GCModal`, `GCSelect`, `GCSwitch`, `GCSegmentedControl`, `GCCombobox`.
- [ ] **Step 2:** Add `"sideEffects": false` to `packages/mission-control-shared/package.json` (verify the package has no CSS/polyfill side-effect imports first; if it does, use the array form listing those files).
- [ ] **Step 3:** Trim the barrel to live exports and delete the unused module files. Do NOT delete the folder.
- [ ] **Step 4:** Verify — `pnpm --filter @goatcitadel/mission-control-shared build` and `pnpm --filter @goatcitadel/mission-control-next build` both succeed; run both test suites.
- [ ] **Step 5: Commit**

```bash
git add packages/mission-control-shared
git commit -m "chore(ui): remove dead shadcn/GC component exports + enable tree-shaking"
```

## Task 2: Defense-in-depth — quote identifiers in dynamic DDL helpers

**Severity:** LOW (verified no current injection path). `sqlite.ts:6578-6583` `addColumnIfMissing` and `postgres/migrator.ts:52-82` interpolate table/column names unquoted.

- [ ] **Step 1:** Write a test passing an identifier needing quoting (e.g. a reserved word) to `addColumnIfMissing` and asserting it succeeds.
- [ ] **Step 2:** Verify it fails (or is fragile).
- [ ] **Step 3:** Apply the existing `quoteSqliteIdentifier` to `tableName`/`columnName` in `addColumnIfMissing` (leave `columnSql` — it's a type expression; document callers must pass static literals). Quote `migrationsTable` in the Postgres migrator, or narrow its type to a known literal union.
- [ ] **Step 4:** Verify tests + full storage suite pass.
- [ ] **Step 5: Commit** `git commit -m "harden(storage): quote identifiers in dynamic DDL helpers"`

## Task 3: Pre-prepare `improvement-service` SQL + add owner-scope filter to MCP elicitation list

**Severity:** LOW / MEDIUM. (a) `improvement-service.ts:680-703, 745-754` re-`prepare()`s SQL on every call. (b) The HTTP `GET /api/v1/mcp/elicitations` returns all elicitations without an `operatorId` scope filter (matters under future multi-tenancy).

- [ ] **(a)** Pre-prepare the workspace-filtered and unfiltered statement variants at service init (mirror `CostLedgerRepository`'s constructor), or cache behind a `Map<string, DbStatement>`. Test: assert `prepare` is called once across N list calls.
- [ ] **(b)** Apply the `owner` scope filter (at minimum `operatorId`) on the HTTP list path, matching the MCP-tool path. Test: operator A cannot see operator B's elicitations.
- [ ] **Commit** `git commit -m "perf(improvement): cache prepared SQL; fix(mcp): scope elicitation list by operator"`

## Task 4: DECISION — Citadel Ward enforcement default

**Severity:** MEDIUM (fail-open-by-design behind a flag). `engine.ts:699-708` — with `GOATCITADEL_CITADEL_ENFORCEMENT` off (default), Ward `deny`/`require_approval` are silently allowed for legacy callers.

- [ ] **Step 1: Decide** (human): keep off-by-default + document loudly (recommended for now — flipping changes runtime behavior for every legacy caller) OR flip to opt-out.
- [ ] **Step 2a (if keep):** Add a prominent comment at `engine.ts:699` and a README/SECURITY note stating Ward enforcement requires the flag; add a startup log line when enforcement is off. No behavior change.
- [ ] **Step 2b (if flip):** Make the flag opt-OUT (`!== "0"`), add tests that a Ward `deny` blocks by default, and run the full policy-engine + gateway suites to catch newly-enforced denials.
- [ ] **Step 3: Commit** the chosen path.

## Task 5: DECISION + harden — remote-resolve endpoint and macOS keychain argv

**Severity:** MEDIUM / LOW.

- [ ] **(a) Remote-resolve endpoint** (`routes/approvals.ts:240-252`, public access class): add a route-level rate limit and bind the remote action token to a `connectorId` audience that is verified on resolve. Also unify the loopback check (`approvals.ts:121` should consult `request.authActorSource === "loopback"` rather than re-implementing the IP test, so `allowLoopbackBypass = false` is honored). Tests: rate-limit triggers; loopback creation is rejected when bypass disabled.
- [ ] **(b) macOS keychain argv** (`secret-store-service.ts:214`): **DECISION** — accept the documented limitation (recommended; already commented + error-path redacted) or invest in a native binding. If accepting, no code change; record the decision in `SECURITY.md`.
- [ ] **Commit** `git commit -m "harden(approvals): rate-limit + connector-bind remote-resolve; unify loopback check"`

## Task 6: Minor frontend correctness/perf cleanups

**Severity:** LOW (verified anchors). Batch these small ones:

- [ ] `api/chat.ts:736-804` — wrap stream consume in `try/finally`, emit a terminal `stream.aborted`/`stream.error` (distinguish `AbortError`) so cancelled streams don't leave orphaned `stream.start` diagnostics.
- [ ] `CitadelCouncilRoutePage.tsx:116-127` — add a `useId()` + `htmlFor` label to the council `<select>` (match the sibling Citadel form fields).
- [ ] `RuntimeRoutePage.tsx:1365` — narrow the `content` `useMemo` deps to the specific stable fields used (`runtime.notice`, `runtime.daemonBusy`, `runtime.reload`, `runtime.runDaemonAction`) instead of the whole `runtime` object.
- [ ] `useMemoryOperatorSnapshot.ts:311-368` — depend on primitive ids (`selectedRun?.runId`, `selectedRun?.durableRunId`) instead of the `maintenanceRuns` array reference to stop redundant re-fetches on every poll.
- [ ] **Commit** `git commit -m "fix(ui): stream-abort diagnostics, council select label, memo dep narrowing"`

---

## Final verification (run before opening PRs)

- [ ] Per-package suites green for every touched package: `pnpm --filter @goatcitadel/gateway test`, `pnpm --filter @goatcitadel/storage test`, `pnpm --filter @goatcitadel/policy-engine test`, `pnpm --filter @goatcitadel/mission-control-next test`, `pnpm --filter @goatcitadel/mission-control-shared test`.
- [ ] Typecheck: `pnpm -r typecheck` (or per touched package).
- [ ] Lint: `pnpm lint` (note the known eslint `.scratch` external-repo false-fail — exclude those paths if present).
- [ ] Governance/docs gates (Phase 2 + 5 touch SQL): `pnpm docs:check` — in particular `check-no-inline-sql` and `check-no-empty-catch`. If any new gateway-service inline SQL was added, update the allowlist intentionally.
- [ ] Storage migration parity test passes with v131 as the new max version.

## Self-review notes (coverage map)

Every review finding maps to a task: env-spread→P1.T1; approved-runtime re-eval→P1.T2; proactive optional callback→P1.T3; device-token-at-rest→P1.T4; cost_ledger index→P2.T1; unbounded listSinceStmt→P2.T2; Postgres v7 immutability→P2.T3; projection writes-in-GET + O(N) fan-out→P3.T1; de-novo cadence→P3.T2; planner timeout→P3.T3; patchProactiveRun/reconcile finalSummary→P3.T4; double scroll→P4.T1; O(n²) markdown→P4.T2; alert re-announce→P4.T3; unbounded UI lists→P4.T4; hidden-tab polling→P4.T5; dead components→P5.T1; DDL identifier quoting→P5.T2; improvement prepare + MCP elicitation scope→P5.T3; Ward default→P5.T4; remote-resolve + loopback + macOS argv→P5.T5; stream-abort/council-label/memo-deps/array-id re-fetch→P5.T6.
