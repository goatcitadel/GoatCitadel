# Multi-Agent Kanban Operator Surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up an operator-facing Kanban surface in mission-control-next that exposes task distress signals, per-task retry budgets, artifact hallucination gating, and auto-block on incomplete worker exit — so operators can supervise multiple long-running agents from a single board.

**Architecture:** Three phases, three PRs on `feature/multi-agent-kanban`. Phase 1 adds typed `TaskDistressSignal` and per-task `maxRetries`/`retryCount` to `TaskRecord` (contracts → SQLite migration v79 → repo → lifecycle service). Phase 2 adds `verifyClaimedArtifacts` (file/URL/SHA existence checks) and bridges `durable-run-service`'s incomplete-exit detection to tasks via a new `TaskLifecycleService.autoBlockOnIncompleteExit` hook. Phase 3 adds `apps/mission-control-next/src/features/native-routes/ops/KanbanRoutePage.tsx` (new `ops/kanban` section) plus bulk-ops API endpoints and route wiring. Tests-first throughout; each step lands a green test.

**Tech Stack:** TypeScript, Node 22, vitest (mission-control-next), node:test + tsx (gateway, storage, contracts), better-sqlite3 via @goatcitadel/storage, React 19, Vite. No new deps.

**Scope boundaries:**
- We do NOT redesign `CoworkNativePage` (`cowork/tasks`) — the new page lives at `ops/kanban` and is operator-facing.
- We do NOT replace `AgenticDiagnosticSignal` — `TaskDistressSignal` is a thin task-level wrapper that re-uses its `code` taxonomy where it overlaps.
- We do NOT touch the durable-run lease/heartbeat loop — `reconcileRecoverableRuns` and `drainQueuedRuns` already work. We only bridge their existing terminal events to tasks.

**Conventions:**
- Branch: `feature/multi-agent-kanban` (cut from `goatrocity/elastic-davinci-7946fb`).
- Commit prefix: `feat(kanban):`, `test(kanban):`, `refactor(kanban):`. Each step ends with a commit.
- Test runner for gateway/storage/contracts: `pnpm --filter @goatcitadel/<pkg> test -- <file>`. For mission-control-next: `pnpm --filter @goatcitadel/mission-control-next test -- <file>`.
- All new files: ≤ 400 lines; if a file approaches 800, split.

---

## File Structure

### New files

| Path | Responsibility |
|------|----------------|
| `packages/contracts/src/task-distress.ts` | `TaskDistressSignalCode`, `TaskDistressSeverity`, `TaskDistressSignal`, `TaskRetryBudget`, `TaskArtifactClaim`, `TaskArtifactVerification` types. |
| `apps/gateway/src/services/task-distress-engine.ts` | Pure functions: `emitDistressSignal`, `resolveDistressSignal`, `summarizeDistress`. No I/O — operates on plain records. |
| `apps/gateway/src/services/task-distress-engine.test.ts` | Unit tests for the engine. |
| `apps/gateway/src/services/task-artifact-verifier.ts` | `verifyClaimedArtifacts(claims, { fs, http, git })` — checks file paths via fs, URLs via HEAD, commit SHAs via `git cat-file`. Returns array of `TaskArtifactVerification`. |
| `apps/gateway/src/services/task-artifact-verifier.test.ts` | Unit tests with stubbed fs/http/git. |
| `apps/mission-control-next/src/features/native-routes/ops/KanbanRoutePage.tsx` | Operator Kanban page (Backlog / In Progress / Blocked / Done). |
| `apps/mission-control-next/src/features/native-routes/ops/KanbanRoutePage.test.tsx` | RTL tests for the page (columns render, distress chips appear, bulk-op buttons fire callbacks). |
| `apps/mission-control-next/src/features/native-routes/ops/kanban-card-model.ts` | Pure mapper: `TaskRecord` + signals + retry budget → `KanbanCard` shape consumed by the page. |
| `apps/mission-control-next/src/features/native-routes/ops/kanban-card-model.test.ts` | Unit tests for the mapper. |
| `docs/superpowers/plans/2026-05-15-multi-agent-kanban.md` | This file. |

### Modified files

| Path | Change |
|------|--------|
| `packages/contracts/src/tasks.ts` | Add `retryBudget?: TaskRetryBudget`, `distressSignals?: TaskDistressSignal[]`, `artifactVerification?: TaskArtifactVerification[]` to `TaskRecord`; mirror in `TaskCreateInput` / `TaskUpdateInput`. |
| `packages/contracts/src/index.ts` | Re-export new types from `task-distress.ts`. |
| `packages/storage/src/sqlite.ts` | Add migration v79 `task_kanban_columns` — `ALTER TABLE tasks ADD COLUMN distress_signals_json TEXT`, `retry_budget_json TEXT`, `artifact_verification_json TEXT`. |
| `packages/storage/src/task-repo.ts` | Map new columns; extend `mapTaskRow`, `create`, `update`, JSON serialization helper. |
| `packages/storage/src/task-repo.test.ts` | Cover round-trip persistence of the three new fields. |
| `apps/gateway/src/services/task-lifecycle-service.ts` | Add `emitDistressSignal`, `resolveDistressSignal`, `setRetryBudget`, `recordRetryAttempt`, `verifyTaskArtifacts`, `autoBlockOnIncompleteExit`, `bulkUpdateTasks`. |
| `apps/gateway/src/services/task-lifecycle-service.test.ts` | Cover all new lifecycle methods (does not exist yet — created). |
| `apps/gateway/src/services/tasks-route-service.ts` | Surface the new lifecycle methods on `TasksRoutePort`. |
| `apps/gateway/src/services/durable-run-service.ts` | When `run_incomplete_worker_exit` event fires and the run's payload has `taskId`, call `taskLifecycle.autoBlockOnIncompleteExit(taskId, runId)`. |
| `apps/gateway/src/services/durable-run-service.test.ts` | Add a test for the bridge — incomplete-exit on a run with `taskId` → linked task transitions to `blocked` with reason `worker_incomplete_exit`. |
| `apps/gateway/src/routes/tasks.ts` (or wherever the tasks routes live) | Add `POST /tasks/:id/distress`, `DELETE /tasks/:id/distress/:signalId`, `POST /tasks/:id/verify-artifacts`, `POST /tasks/bulk` (unblock/retry/reassign/close). |
| `packages/mission-control-shared/src/api/tasks.ts` | Add client helpers `emitTaskDistress`, `resolveTaskDistress`, `verifyTaskArtifacts`, `bulkTaskAction`. |
| `apps/mission-control-next/src/app/route-model.ts` | Add `"kanban"` to `OpsSection`; add `ops-kanban` to `RAIL_ITEMS.ops`. |
| `apps/mission-control-next/src/features/native-routes/NativeRoutePages.tsx` | Import `KanbanRoutePage` and route `route.section === "kanban"` to it. |
| `apps/mission-control-next/src/app/MissionControlNextApp.tsx` | No code change expected — nav reads from `RAIL_ITEMS`. (Verify only.) |

---

# Phase 0 — Branch setup

### Task 0.1: Create the feature branch

**Files:** none (git only)

- [ ] **Step 1: Verify clean tree**

Run: `git status`
Expected: `working tree clean` on branch `goatrocity/elastic-davinci-7946fb`. If dirty, stop and ask.

- [ ] **Step 2: Cut the branch**

Run:
```bash
git checkout -b feature/multi-agent-kanban
```
Expected: `Switched to a new branch 'feature/multi-agent-kanban'`.

- [ ] **Step 3: Confirm**

Run: `git branch --show-current`
Expected output: `feature/multi-agent-kanban`.

---

# Phase 1 — Distress signals + per-task retry budget

Goal of phase: `TaskRecord` carries typed distress signals and a retry budget. Lifecycle service can emit/resolve signals and increment the retry counter, transitioning the task to `blocked` when the budget is exhausted. No UI yet.

## Task 1.1: Define contracts

**Files:**
- Create: `packages/contracts/src/task-distress.ts`
- Modify: `packages/contracts/src/tasks.ts`
- Modify: `packages/contracts/src/index.ts`

- [ ] **Step 1: Write the failing test for the contract surface**

Create `packages/contracts/src/task-distress.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  TaskDistressSignal,
  TaskRetryBudget,
  TaskArtifactClaim,
  TaskArtifactVerification,
} from "./task-distress.js";

describe("task-distress contracts", () => {
  it("TaskDistressSignal carries code, severity, timestamps", () => {
    const signal: TaskDistressSignal = {
      signalId: "ds-1",
      code: "needs_user",
      severity: "warn",
      title: "Awaiting user input",
      summary: "Worker requested clarification.",
      emittedBy: "agent-7",
      createdAt: "2026-05-15T12:00:00.000Z",
    };
    assert.equal(signal.code, "needs_user");
    assert.equal(signal.resolvedAt, undefined);
  });

  it("TaskRetryBudget tracks attempts vs ceiling", () => {
    const budget: TaskRetryBudget = { maxRetries: 3, retryCount: 1 };
    assert.equal(budget.retryCount, 1);
  });

  it("TaskArtifactVerification narrows to expected statuses", () => {
    const verification: TaskArtifactVerification = {
      claim: { kind: "file", value: "/tmp/out.txt" } satisfies TaskArtifactClaim,
      status: "missing",
      checkedAt: "2026-05-15T12:00:00.000Z",
      detail: "ENOENT",
    };
    assert.equal(verification.status, "missing");
  });
});
```

- [ ] **Step 2: Run the test — expect compile failure**

Run: `pnpm --filter @goatcitadel/contracts test -- task-distress.test.ts`
Expected: FAIL with `Cannot find module './task-distress.js'`.

- [ ] **Step 3: Create the contract module**

Create `packages/contracts/src/task-distress.ts`:

```typescript
export type TaskDistressSignalCode =
  | "needs_user"
  | "tool_error"
  | "provider_outage"
  | "hallucination_suspected"
  | "stale_heartbeat"
  | "worker_crash"
  | "artifact_missing"
  | "retry_budget_exhausted";

export type TaskDistressSeverity = "info" | "warn" | "critical";

export interface TaskDistressSignal {
  signalId: string;
  code: TaskDistressSignalCode;
  severity: TaskDistressSeverity;
  title: string;
  summary: string;
  emittedBy?: string;
  evidenceRef?: string;
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface TaskRetryBudget {
  maxRetries: number;
  retryCount: number;
  lastAttemptAt?: string;
  exhaustedAt?: string;
}

export type TaskArtifactClaimKind = "file" | "url" | "commit_sha";

export interface TaskArtifactClaim {
  kind: TaskArtifactClaimKind;
  value: string;
  label?: string;
}

export type TaskArtifactVerificationStatus = "unchecked" | "verified" | "missing" | "error";

export interface TaskArtifactVerification {
  claim: TaskArtifactClaim;
  status: TaskArtifactVerificationStatus;
  checkedAt: string;
  detail?: string;
}
```

- [ ] **Step 4: Extend `TaskRecord` and inputs**

Edit `packages/contracts/src/tasks.ts` — find the `TaskRecord` interface (line 16-33). Add to the bottom of the interface (after `deleteReason?:` but before `createdAt`):

```typescript
  retryBudget?: import("./task-distress.js").TaskRetryBudget;
  distressSignals?: import("./task-distress.js").TaskDistressSignal[];
  artifactVerification?: import("./task-distress.js").TaskArtifactVerification[];
```

Add the same three optional fields to `TaskCreateInput` (after `agenticContext?`) and to `TaskUpdateInput` (with `| null` to allow clearing — same pattern as `proactiveContext`).

- [ ] **Step 5: Re-export from contracts barrel**

Edit `packages/contracts/src/index.ts` — locate the existing task export line (`export * from "./tasks.js";`) and add immediately after:

```typescript
export * from "./task-distress.js";
```

- [ ] **Step 6: Run test — expect PASS**

Run: `pnpm --filter @goatcitadel/contracts test -- task-distress.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/task-distress.ts \
  packages/contracts/src/task-distress.test.ts \
  packages/contracts/src/tasks.ts \
  packages/contracts/src/index.ts
git commit -m "feat(kanban): add TaskDistressSignal, TaskRetryBudget, TaskArtifactVerification contracts"
```

## Task 1.2: SQLite migration v79

**Files:**
- Modify: `packages/storage/src/sqlite.ts`
- Create: `packages/storage/src/sqlite-migration-task-kanban.test.ts`

- [ ] **Step 1: Write the failing migration test**

Create `packages/storage/src/sqlite-migration-task-kanban.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { __sqliteInternals } from "./sqlite.js";

describe("task_kanban_columns migration", () => {
  it("adds distress_signals_json, retry_budget_json, artifact_verification_json", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        assigned_agent_id TEXT,
        created_by TEXT,
        due_at TEXT,
        metadata_json TEXT,
        deleted_at TEXT,
        deleted_by TEXT,
        delete_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    __sqliteInternals.applySchemaMigrationForTest(79, db);

    const columns = new Set(
      (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    assert.ok(columns.has("distress_signals_json"));
    assert.ok(columns.has("retry_budget_json"));
    assert.ok(columns.has("artifact_verification_json"));
  });

  it("is idempotent", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE tasks (task_id TEXT PRIMARY KEY);");
    __sqliteInternals.applySchemaMigrationForTest(79, db);
    __sqliteInternals.applySchemaMigrationForTest(79, db); // must not throw
    const columns = new Set(
      (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    assert.ok(columns.has("distress_signals_json"));
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `pnpm --filter @goatcitadel/storage test -- sqlite-migration-task-kanban.test.ts`
Expected: FAIL with `Unknown SQLite schema migration version: 79`.

- [ ] **Step 3: Add migration 79 to the `SCHEMA_MIGRATIONS` array**

Edit `packages/storage/src/sqlite.ts`. Find the closing `]` of `SCHEMA_MIGRATIONS` (around line 773 — entry version 78 is last). Insert before the `]`:

```typescript
  {
    version: 79,
    name: "task_kanban_columns",
    up: (db) => {
      if (tableExists(db, "tasks")) {
        addColumnIfMissingIfTableExists(db, "tasks", "distress_signals_json", "TEXT");
        addColumnIfMissingIfTableExists(db, "tasks", "retry_budget_json", "TEXT");
        addColumnIfMissingIfTableExists(db, "tasks", "artifact_verification_json", "TEXT");
      }
    },
  },
```

- [ ] **Step 4: Update the base schema definition**

In the same file find `CREATE TABLE IF NOT EXISTS tasks (` (around line 1025). Add three columns just before `created_at TEXT NOT NULL`:

```sql
      distress_signals_json TEXT,
      retry_budget_json TEXT,
      artifact_verification_json TEXT,
```

- [ ] **Step 5: Run migration test — expect PASS**

Run: `pnpm --filter @goatcitadel/storage test -- sqlite-migration-task-kanban.test.ts`
Expected: both tests pass.

- [ ] **Step 6: Run the broader storage suite — confirm no regressions**

Run: `pnpm --filter @goatcitadel/storage test`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/storage/src/sqlite.ts packages/storage/src/sqlite-migration-task-kanban.test.ts
git commit -m "feat(kanban): SQLite migration v79 adds task kanban columns"
```

## Task 1.3: Extend TaskRepository to persist new fields

**Files:**
- Modify: `packages/storage/src/task-repo.ts`
- Modify: `packages/storage/src/task-repo.test.ts`

- [ ] **Step 1: Write failing test for round-trip**

Open `packages/storage/src/task-repo.test.ts` and append a new `describe` block at the end of the file (before its trailing brace if any):

```typescript
describe("TaskRepository — kanban fields", () => {
  it("persists distressSignals, retryBudget, artifactVerification on update", async () => {
    const { repo } = createTaskRepoFixture();
    const created = repo.create({ title: "kanban", workspaceId: "default" });
    const updated = repo.update(created.taskId, {
      distressSignals: [
        {
          signalId: "ds-1",
          code: "needs_user",
          severity: "warn",
          title: "Awaiting input",
          summary: "Worker paused.",
          createdAt: "2026-05-15T12:00:00.000Z",
        },
      ],
      retryBudget: { maxRetries: 3, retryCount: 1 },
      artifactVerification: [
        {
          claim: { kind: "file", value: "/tmp/out.txt" },
          status: "missing",
          checkedAt: "2026-05-15T12:00:00.000Z",
          detail: "ENOENT",
        },
      ],
    });
    const reloaded = repo.get(created.taskId);
    assert.deepEqual(reloaded.distressSignals, updated.distressSignals);
    assert.deepEqual(reloaded.retryBudget, updated.retryBudget);
    assert.deepEqual(reloaded.artifactVerification, updated.artifactVerification);
  });

  it("returns undefined for fields when never set", () => {
    const { repo } = createTaskRepoFixture();
    const created = repo.create({ title: "plain", workspaceId: "default" });
    assert.equal(created.distressSignals, undefined);
    assert.equal(created.retryBudget, undefined);
    assert.equal(created.artifactVerification, undefined);
  });
});
```

If the file does not already export `createTaskRepoFixture`, locate the existing fixture helper at the top of the file and re-use its name. (Read `packages/storage/src/task-repo.test.ts` first — match its existing pattern; do NOT invent a fresh fixture.)

- [ ] **Step 2: Run test — expect FAIL**

Run: `pnpm --filter @goatcitadel/storage test -- task-repo.test.ts`
Expected: FAIL — repository ignores the new fields, so reload returns `undefined`.

- [ ] **Step 3: Extend the row type and insert/update statements**

Edit `packages/storage/src/task-repo.ts`:

a) Add three nullable string columns to `TaskRow` (after `delete_reason`):
```typescript
  distress_signals_json: string | null;
  retry_budget_json: string | null;
  artifact_verification_json: string | null;
```

b) Update `insertStmt` and `updateStmt` SQL to include the three new columns (`INSERT … distress_signals_json, retry_budget_json, artifact_verification_json` with matching `@distressSignalsJson` etc. placeholders; same additions on the `UPDATE … SET` clause).

c) Update `create()` and `update()` to pass:
```typescript
distressSignalsJson: input.distressSignals ? JSON.stringify(input.distressSignals) : null,
retryBudgetJson: input.retryBudget ? JSON.stringify(input.retryBudget) : null,
artifactVerificationJson: input.artifactVerification ? JSON.stringify(input.artifactVerification) : null,
```

For `update()`, mirror the existing `metadataJson` pattern: if input field is `undefined` keep current, if `null` clear, else stringify.

d) Update `mapTaskRow()` to parse the JSON back:
```typescript
distressSignals: safeJsonParse<import("@goatcitadel/contracts").TaskDistressSignal[]>(
  row.distress_signals_json, [],
).length ? safeJsonParse(...) : undefined,
```
Use the existing `safeJsonParse` import. Return `undefined` (not empty array) when the column is null so the contract optionality stays clean. Same for the other two.

- [ ] **Step 4: Run test — expect PASS**

Run: `pnpm --filter @goatcitadel/storage test -- task-repo.test.ts`
Expected: both new tests pass; existing tests still pass.

- [ ] **Step 5: Run full storage suite**

Run: `pnpm --filter @goatcitadel/storage test`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add packages/storage/src/task-repo.ts packages/storage/src/task-repo.test.ts
git commit -m "feat(kanban): persist distress signals, retry budget, artifact verification on tasks"
```

## Task 1.4: TaskDistressEngine — pure helpers

**Files:**
- Create: `apps/gateway/src/services/task-distress-engine.ts`
- Create: `apps/gateway/src/services/task-distress-engine.test.ts`

- [ ] **Step 1: Write failing test**

Create `apps/gateway/src/services/task-distress-engine.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TaskDistressSignal } from "@goatcitadel/contracts";
import { emitDistressSignal, resolveDistressSignal, summarizeDistress } from "./task-distress-engine.js";

describe("task-distress-engine", () => {
  it("emit prepends a new signal with the given code", () => {
    const next = emitDistressSignal([], {
      code: "needs_user",
      severity: "warn",
      title: "Need input",
      summary: "asks for clarification",
      now: () => "2026-05-15T12:00:00.000Z",
      idFactory: () => "ds-1",
    });
    assert.equal(next[0].signalId, "ds-1");
    assert.equal(next[0].code, "needs_user");
  });

  it("resolve marks a signal resolved without removing it", () => {
    const existing: TaskDistressSignal[] = [
      {
        signalId: "ds-1",
        code: "needs_user",
        severity: "warn",
        title: "x",
        summary: "y",
        createdAt: "2026-05-15T12:00:00.000Z",
      },
    ];
    const next = resolveDistressSignal(existing, "ds-1", {
      resolvedBy: "alice",
      now: () => "2026-05-15T12:05:00.000Z",
    });
    assert.equal(next[0].resolvedAt, "2026-05-15T12:05:00.000Z");
    assert.equal(next[0].resolvedBy, "alice");
  });

  it("summarize returns counts of unresolved signals by severity", () => {
    const signals: TaskDistressSignal[] = [
      {
        signalId: "a",
        code: "needs_user",
        severity: "warn",
        title: "",
        summary: "",
        createdAt: "2026-05-15T12:00:00.000Z",
      },
      {
        signalId: "b",
        code: "tool_error",
        severity: "critical",
        title: "",
        summary: "",
        createdAt: "2026-05-15T12:00:00.000Z",
      },
      {
        signalId: "c",
        code: "needs_user",
        severity: "warn",
        title: "",
        summary: "",
        createdAt: "2026-05-15T12:00:00.000Z",
        resolvedAt: "2026-05-15T12:01:00.000Z",
      },
    ];
    const summary = summarizeDistress(signals);
    assert.deepEqual(summary, { info: 0, warn: 1, critical: 1, resolvedCount: 1 });
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `pnpm --filter @goatcitadel/gateway test -- task-distress-engine.test.ts`
Expected: FAIL with `Cannot find module './task-distress-engine.js'`.

- [ ] **Step 3: Implement the engine**

Create `apps/gateway/src/services/task-distress-engine.ts`:

```typescript
import { randomUUID } from "node:crypto";
import type {
  TaskDistressSignal,
  TaskDistressSignalCode,
  TaskDistressSeverity,
} from "@goatcitadel/contracts";

export interface EmitDistressInput {
  code: TaskDistressSignalCode;
  severity: TaskDistressSeverity;
  title: string;
  summary: string;
  emittedBy?: string;
  evidenceRef?: string;
  now?: () => string;
  idFactory?: () => string;
}

export function emitDistressSignal(
  current: TaskDistressSignal[] | undefined,
  input: EmitDistressInput,
): TaskDistressSignal[] {
  const signal: TaskDistressSignal = {
    signalId: input.idFactory ? input.idFactory() : randomUUID(),
    code: input.code,
    severity: input.severity,
    title: input.title,
    summary: input.summary,
    emittedBy: input.emittedBy,
    evidenceRef: input.evidenceRef,
    createdAt: input.now ? input.now() : new Date().toISOString(),
  };
  return [signal, ...(current ?? [])];
}

export interface ResolveDistressInput {
  resolvedBy?: string;
  now?: () => string;
}

export function resolveDistressSignal(
  current: TaskDistressSignal[] | undefined,
  signalId: string,
  input: ResolveDistressInput = {},
): TaskDistressSignal[] {
  const list = current ?? [];
  const at = input.now ? input.now() : new Date().toISOString();
  return list.map((signal) =>
    signal.signalId === signalId && !signal.resolvedAt
      ? { ...signal, resolvedAt: at, resolvedBy: input.resolvedBy }
      : signal,
  );
}

export interface DistressSummary {
  info: number;
  warn: number;
  critical: number;
  resolvedCount: number;
}

export function summarizeDistress(signals: TaskDistressSignal[] | undefined): DistressSummary {
  const summary: DistressSummary = { info: 0, warn: 0, critical: 0, resolvedCount: 0 };
  for (const signal of signals ?? []) {
    if (signal.resolvedAt) {
      summary.resolvedCount += 1;
      continue;
    }
    summary[signal.severity] += 1;
  }
  return summary;
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `pnpm --filter @goatcitadel/gateway test -- task-distress-engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/task-distress-engine.ts apps/gateway/src/services/task-distress-engine.test.ts
git commit -m "feat(kanban): TaskDistressEngine emit/resolve/summarize helpers"
```

## Task 1.5: TaskLifecycleService — emit/resolve distress, set/record retries

**Files:**
- Modify: `apps/gateway/src/services/task-lifecycle-service.ts`
- Create: `apps/gateway/src/services/task-lifecycle-service.test.ts` (if it does not exist)

- [ ] **Step 1: Confirm the test file state**

Run: `ls apps/gateway/src/services/task-lifecycle-service.test.ts`
- If it exists, append a new `describe` block.
- If it does not, create it with the standard fixture pattern used by `apps/gateway/src/services/durable-run-service.test.ts` (open that file first to copy the fixture/mock storage shape — same `Storage` type, same `publishRealtime` stub).

- [ ] **Step 2: Write failing tests**

Add to the test file:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTaskLifecycleServiceFixture } from "./task-lifecycle-service-fixture.js"; // or inline if simpler

describe("TaskLifecycleService — distress signals", () => {
  it("emitDistressSignal persists the new signal and publishes a realtime event", () => {
    const { service, storage, publishRealtime } = createTaskLifecycleServiceFixture();
    const task = service.createTask({ title: "t" });
    const updated = service.emitDistressSignal(task.taskId, {
      code: "needs_user",
      severity: "warn",
      title: "Need input",
      summary: "worker is asking",
      emittedBy: "agent-7",
    });
    assert.equal(updated.distressSignals?.length, 1);
    assert.equal(storage.tasks.get(task.taskId).distressSignals?.[0]?.code, "needs_user");
    assert.ok(publishRealtime.calls.some((c) => c.args[0] === "task_distress_emitted"));
  });

  it("resolveDistressSignal marks it resolved", () => {
    const { service } = createTaskLifecycleServiceFixture();
    const task = service.createTask({ title: "t" });
    const withSignal = service.emitDistressSignal(task.taskId, {
      code: "tool_error",
      severity: "warn",
      title: "Tool blew up",
      summary: "boom",
    });
    const signalId = withSignal.distressSignals![0].signalId;
    const resolved = service.resolveDistressSignal(task.taskId, signalId, { resolvedBy: "op-1" });
    assert.ok(resolved.distressSignals![0].resolvedAt);
    assert.equal(resolved.distressSignals![0].resolvedBy, "op-1");
  });
});

describe("TaskLifecycleService — retry budget", () => {
  it("setRetryBudget initializes the budget when none exists", () => {
    const { service } = createTaskLifecycleServiceFixture();
    const task = service.createTask({ title: "t" });
    const updated = service.setRetryBudget(task.taskId, 3);
    assert.equal(updated.retryBudget?.maxRetries, 3);
    assert.equal(updated.retryBudget?.retryCount, 0);
  });

  it("recordRetryAttempt increments retryCount but stays in progress when below budget", () => {
    const { service } = createTaskLifecycleServiceFixture();
    const task = service.createTask({ title: "t", status: "in_progress" });
    service.setRetryBudget(task.taskId, 2);
    const after1 = service.recordRetryAttempt(task.taskId, "transient_error");
    assert.equal(after1.retryBudget?.retryCount, 1);
    assert.equal(after1.status, "in_progress");
  });

  it("recordRetryAttempt transitions task to blocked when budget exhausted", () => {
    const { service } = createTaskLifecycleServiceFixture();
    const task = service.createTask({ title: "t", status: "in_progress" });
    service.setRetryBudget(task.taskId, 1);
    service.recordRetryAttempt(task.taskId, "first failure");
    const blocked = service.recordRetryAttempt(task.taskId, "second failure");
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.retryBudget?.retryCount, 2);
    assert.ok(blocked.retryBudget?.exhaustedAt);
    assert.equal(
      blocked.distressSignals?.find((s) => s.code === "retry_budget_exhausted")?.severity,
      "critical",
    );
  });
});
```

- [ ] **Step 3: Run tests — expect FAIL**

Run: `pnpm --filter @goatcitadel/gateway test -- task-lifecycle-service.test.ts`
Expected: FAIL — methods do not exist.

- [ ] **Step 4: Implement the methods**

Edit `apps/gateway/src/services/task-lifecycle-service.ts`. After `updateTask`, add:

```typescript
public emitDistressSignal(taskId: string, input: EmitDistressInput): TaskRecord {
  const current = this.deps.storage.tasks.get(taskId);
  const next = emitDistressSignal(current.distressSignals, input);
  const updated = this.deps.storage.tasks.update(taskId, { distressSignals: next });
  this.publishTaskEvent(
    "task_distress_emitted",
    { taskId, signal: next[0] },
    buildTaskRealtimeLinks(updated),
  );
  return updated;
}

public resolveDistressSignal(
  taskId: string,
  signalId: string,
  input: { resolvedBy?: string } = {},
): TaskRecord {
  const current = this.deps.storage.tasks.get(taskId);
  const next = resolveDistressSignal(current.distressSignals, signalId, input);
  const updated = this.deps.storage.tasks.update(taskId, { distressSignals: next });
  this.publishTaskEvent(
    "task_distress_resolved",
    { taskId, signalId, resolvedBy: input.resolvedBy },
    buildTaskRealtimeLinks(updated),
  );
  return updated;
}

public setRetryBudget(taskId: string, maxRetries: number): TaskRecord {
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new ValidationError({ message: "maxRetries must be a non-negative integer" });
  }
  const current = this.deps.storage.tasks.get(taskId);
  const retryBudget: TaskRetryBudget = {
    maxRetries,
    retryCount: current.retryBudget?.retryCount ?? 0,
  };
  return this.deps.storage.tasks.update(taskId, { retryBudget });
}

public recordRetryAttempt(taskId: string, reason: string): TaskRecord {
  const current = this.deps.storage.tasks.get(taskId);
  const budget = current.retryBudget ?? { maxRetries: 0, retryCount: 0 };
  const nextCount = budget.retryCount + 1;
  const now = new Date().toISOString();
  const exhausted = nextCount > budget.maxRetries;
  const retryBudget: TaskRetryBudget = {
    ...budget,
    retryCount: nextCount,
    lastAttemptAt: now,
    exhaustedAt: exhausted ? now : budget.exhaustedAt,
  };
  if (!exhausted) {
    return this.deps.storage.tasks.update(taskId, { retryBudget });
  }
  const distressSignals = emitDistressSignal(current.distressSignals, {
    code: "retry_budget_exhausted",
    severity: "critical",
    title: "Retry budget exhausted",
    summary: reason,
  });
  return this.deps.storage.tasks.update(taskId, {
    retryBudget,
    distressSignals,
    status: "blocked",
  });
}
```

Add the imports at the top of the file:

```typescript
import type { TaskRetryBudget } from "@goatcitadel/contracts";
import { emitDistressSignal, resolveDistressSignal, type EmitDistressInput } from "./task-distress-engine.js";
```

- [ ] **Step 5: Run tests — expect PASS**

Run: `pnpm --filter @goatcitadel/gateway test -- task-lifecycle-service.test.ts`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/services/task-lifecycle-service.ts apps/gateway/src/services/task-lifecycle-service.test.ts
git commit -m "feat(kanban): lifecycle methods for distress signals and retry budget"
```

## Task 1.6: Phase 1 PR

- [ ] **Step 1: Run full repo type check + tests**

Run in parallel:
```bash
pnpm --filter @goatcitadel/contracts build
pnpm --filter @goatcitadel/storage test
pnpm --filter @goatcitadel/gateway test
```
Expected: all green.

- [ ] **Step 2: Push branch and open draft PR**

Run:
```bash
git push -u origin feature/multi-agent-kanban
gh pr create --draft --title "feat(kanban): distress signals + per-task retry budget (Phase 1/3)" \
  --body "$(cat <<'EOF'
## Summary
Phase 1 of `feature/multi-agent-kanban`. Adds typed `TaskDistressSignal`, `TaskRetryBudget`, and `TaskArtifactVerification` to `TaskRecord`; SQLite migration v79 persists them; lifecycle service can emit/resolve signals and enforce the budget (transitions task → blocked on exhaustion).

## Test plan
- [x] `pnpm --filter @goatcitadel/contracts build`
- [x] `pnpm --filter @goatcitadel/storage test`
- [x] `pnpm --filter @goatcitadel/gateway test -- task-distress-engine task-lifecycle-service`
- [ ] Reviewer to verify migration is idempotent against a populated DB.

Follow-up phases (in this branch):
- Phase 2: artifact verification gate + auto-block bridge
- Phase 3: operator Kanban UI + bulk ops
EOF
)"
```

---

# Phase 2 — Artifact verification gate + auto-block bridge

Goal of phase: a worker can claim "I produced these artifacts"; the gateway verifies them and surfaces `artifact_missing` distress when claims are bogus. Separately, when a durable run with a `taskId` exits incomplete, the linked task auto-blocks.

## Task 2.1: TaskArtifactVerifier — file/url/sha checks

**Files:**
- Create: `apps/gateway/src/services/task-artifact-verifier.ts`
- Create: `apps/gateway/src/services/task-artifact-verifier.test.ts`

- [ ] **Step 1: Write failing test**

Create `apps/gateway/src/services/task-artifact-verifier.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TaskArtifactClaim } from "@goatcitadel/contracts";
import { verifyClaimedArtifacts } from "./task-artifact-verifier.js";

describe("verifyClaimedArtifacts", () => {
  const now = () => "2026-05-15T12:00:00.000Z";

  it("marks a file claim verified when fs.statExists returns true", async () => {
    const claims: TaskArtifactClaim[] = [{ kind: "file", value: "/tmp/exists.txt" }];
    const results = await verifyClaimedArtifacts(claims, {
      fs: { statExists: async () => true },
      http: { headOk: async () => false },
      git: { hasCommit: async () => false },
      now,
    });
    assert.equal(results[0].status, "verified");
    assert.equal(results[0].claim.kind, "file");
  });

  it("marks a file claim missing when fs.statExists returns false", async () => {
    const claims: TaskArtifactClaim[] = [{ kind: "file", value: "/nope" }];
    const results = await verifyClaimedArtifacts(claims, {
      fs: { statExists: async () => false },
      http: { headOk: async () => false },
      git: { hasCommit: async () => false },
      now,
    });
    assert.equal(results[0].status, "missing");
  });

  it("marks a url claim verified when http.headOk returns true", async () => {
    const claims: TaskArtifactClaim[] = [{ kind: "url", value: "https://example.com" }];
    const results = await verifyClaimedArtifacts(claims, {
      fs: { statExists: async () => false },
      http: { headOk: async () => true },
      git: { hasCommit: async () => false },
      now,
    });
    assert.equal(results[0].status, "verified");
  });

  it("marks a commit_sha claim verified when git.hasCommit returns true", async () => {
    const claims: TaskArtifactClaim[] = [{ kind: "commit_sha", value: "deadbeef" }];
    const results = await verifyClaimedArtifacts(claims, {
      fs: { statExists: async () => false },
      http: { headOk: async () => false },
      git: { hasCommit: async () => true },
      now,
    });
    assert.equal(results[0].status, "verified");
  });

  it("marks claim error and includes detail when the prober throws", async () => {
    const claims: TaskArtifactClaim[] = [{ kind: "file", value: "/explodes" }];
    const results = await verifyClaimedArtifacts(claims, {
      fs: {
        statExists: async () => {
          throw new Error("EACCES");
        },
      },
      http: { headOk: async () => false },
      git: { hasCommit: async () => false },
      now,
    });
    assert.equal(results[0].status, "error");
    assert.match(results[0].detail ?? "", /EACCES/);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @goatcitadel/gateway test -- task-artifact-verifier.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the verifier**

Create `apps/gateway/src/services/task-artifact-verifier.ts`:

```typescript
import type { TaskArtifactClaim, TaskArtifactVerification } from "@goatcitadel/contracts";

export interface ArtifactProbers {
  fs: { statExists(path: string): Promise<boolean> };
  http: { headOk(url: string): Promise<boolean> };
  git: { hasCommit(sha: string): Promise<boolean> };
  now?: () => string;
}

export async function verifyClaimedArtifacts(
  claims: TaskArtifactClaim[],
  probers: ArtifactProbers,
): Promise<TaskArtifactVerification[]> {
  const at = probers.now ? probers.now() : new Date().toISOString();
  return Promise.all(claims.map((claim) => verifyOne(claim, probers, at)));
}

async function verifyOne(
  claim: TaskArtifactClaim,
  probers: ArtifactProbers,
  at: string,
): Promise<TaskArtifactVerification> {
  try {
    const exists = await probe(claim, probers);
    return { claim, status: exists ? "verified" : "missing", checkedAt: at };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { claim, status: "error", checkedAt: at, detail };
  }
}

async function probe(claim: TaskArtifactClaim, probers: ArtifactProbers): Promise<boolean> {
  if (claim.kind === "file") {
    return probers.fs.statExists(claim.value);
  }
  if (claim.kind === "url") {
    return probers.http.headOk(claim.value);
  }
  return probers.git.hasCommit(claim.value);
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter @goatcitadel/gateway test -- task-artifact-verifier.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/task-artifact-verifier.ts apps/gateway/src/services/task-artifact-verifier.test.ts
git commit -m "feat(kanban): TaskArtifactVerifier — file/url/commit-sha existence checks"
```

## Task 2.2: Wire verifier into TaskLifecycleService

**Files:**
- Modify: `apps/gateway/src/services/task-lifecycle-service.ts`
- Modify: `apps/gateway/src/services/task-lifecycle-service.test.ts`

- [ ] **Step 1: Write failing test**

Append to the test file:

```typescript
describe("TaskLifecycleService.verifyTaskArtifacts", () => {
  it("records verification results and emits artifact_missing distress when any claim is missing", async () => {
    const { service, storage } = createTaskLifecycleServiceFixture({
      probers: {
        fs: { statExists: async (path: string) => path !== "/missing.txt" },
        http: { headOk: async () => true },
        git: { hasCommit: async () => true },
      },
    });
    const task = service.createTask({ title: "t", status: "in_progress" });
    const updated = await service.verifyTaskArtifacts(task.taskId, [
      { kind: "file", value: "/exists.txt" },
      { kind: "file", value: "/missing.txt" },
    ]);
    const persisted = storage.tasks.get(task.taskId);
    assert.equal(persisted.artifactVerification?.length, 2);
    const missing = persisted.distressSignals?.find((s) => s.code === "artifact_missing");
    assert.ok(missing, "expected artifact_missing distress signal");
    assert.equal(missing!.severity, "critical");
    assert.equal(updated.status, "blocked");
  });

  it("does not emit distress when all claims verify", async () => {
    const { service } = createTaskLifecycleServiceFixture({
      probers: {
        fs: { statExists: async () => true },
        http: { headOk: async () => true },
        git: { hasCommit: async () => true },
      },
    });
    const task = service.createTask({ title: "t", status: "in_progress" });
    const updated = await service.verifyTaskArtifacts(task.taskId, [
      { kind: "file", value: "/ok.txt" },
    ]);
    assert.equal(updated.status, "in_progress");
    assert.equal(updated.distressSignals?.find((s) => s.code === "artifact_missing"), undefined);
  });
});
```

Extend `createTaskLifecycleServiceFixture` to accept an optional `probers` argument and pass it into the service constructor.

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @goatcitadel/gateway test -- task-lifecycle-service.test.ts`
Expected: FAIL — `verifyTaskArtifacts` undefined.

- [ ] **Step 3: Implement**

Extend `TaskLifecycleServiceDependencies` with:
```typescript
probers?: import("./task-artifact-verifier.js").ArtifactProbers;
```

Add method:
```typescript
public async verifyTaskArtifacts(
  taskId: string,
  claims: TaskArtifactClaim[],
): Promise<TaskRecord> {
  if (!this.deps.probers) {
    throw new ValidationError({ message: "Artifact verification probers not configured" });
  }
  const verification = await verifyClaimedArtifacts(claims, this.deps.probers);
  const current = this.deps.storage.tasks.get(taskId);
  const previous = current.artifactVerification ?? [];
  const merged = [...previous, ...verification];
  const missingCount = verification.filter((v) => v.status === "missing").length;
  const errorCount = verification.filter((v) => v.status === "error").length;
  let distressSignals = current.distressSignals;
  let status = current.status;
  if (missingCount + errorCount > 0) {
    distressSignals = emitDistressSignal(distressSignals, {
      code: "artifact_missing",
      severity: "critical",
      title: "Claimed artifacts not found",
      summary: `${missingCount} missing, ${errorCount} unreachable`,
    });
    status = "blocked";
  }
  return this.deps.storage.tasks.update(taskId, {
    artifactVerification: merged,
    distressSignals,
    status,
  });
}
```

Import `TaskArtifactClaim`, `verifyClaimedArtifacts`, and `emitDistressSignal` if not already imported.

Where the gateway constructs the lifecycle service (likely `gateway-runtime-factory.ts` or `gateway-route-services.ts` — find the call site of `new TaskLifecycleService(`), wire real probers:

```typescript
probers: {
  fs: { statExists: async (p) => fs.promises.stat(p).then(() => true).catch(() => false) },
  http: { headOk: async (u) => (await fetch(u, { method: "HEAD" })).ok },
  git: { hasCommit: async (sha) => spawnSync("git", ["cat-file", "-e", sha]).status === 0 },
},
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter @goatcitadel/gateway test -- task-lifecycle-service.test.ts`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/task-lifecycle-service.ts \
  apps/gateway/src/services/task-lifecycle-service.test.ts \
  apps/gateway/src/services/gateway-runtime-factory.ts # or wherever the wire-up landed
git commit -m "feat(kanban): verifyTaskArtifacts gates worker artifact claims"
```

## Task 2.3: Bridge incomplete worker exit → task auto-block

**Files:**
- Modify: `apps/gateway/src/services/durable-run-service.ts`
- Modify: `apps/gateway/src/services/durable-run-service.test.ts`
- Modify: `apps/gateway/src/services/task-lifecycle-service.ts`

- [ ] **Step 1: Write failing test**

Append to `apps/gateway/src/services/durable-run-service.test.ts`:

```typescript
describe("durable-run-service — task auto-block bridge", () => {
  it("when an incomplete-exit fires on a run linked to a task, the task transitions to blocked", async () => {
    const { service, taskLifecycle, storage } = createBridgedFixture();
    const task = taskLifecycle.createTask({ title: "linked", status: "in_progress" });
    const run = await service.createRun({
      workflowKey: "chat.turn.execute",
      payload: { taskId: task.taskId },
    });
    // Force the run into the incomplete-exit pathway:
    await service.simulateIncompleteWorkerExit(run.runId);

    const reloaded = storage.tasks.get(task.taskId);
    assert.equal(reloaded.status, "blocked");
    assert.ok(reloaded.distressSignals?.find((s) => s.code === "worker_crash"));
  });
});
```

`createBridgedFixture` is a new helper that wires a `TaskLifecycleService` into the durable-run service's `taskLifecycle` dep. `service.simulateIncompleteWorkerExit` is a thin test seam — see step 3 below.

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @goatcitadel/gateway test -- durable-run-service.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the `autoBlockOnIncompleteExit` lifecycle method**

In `task-lifecycle-service.ts`:

```typescript
public autoBlockOnIncompleteExit(taskId: string, runId: string): TaskRecord {
  const current = this.deps.storage.tasks.get(taskId);
  if (current.status === "done" || current.status === "blocked") {
    return current;
  }
  const distressSignals = emitDistressSignal(current.distressSignals, {
    code: "worker_crash",
    severity: "critical",
    title: "Worker exited without closing the task",
    summary: `Durable run ${runId} exited without a terminal close.`,
    evidenceRef: `durable-run:${runId}`,
  });
  return this.deps.storage.tasks.update(taskId, { distressSignals, status: "blocked" });
}
```

- [ ] **Step 4: Wire the bridge into `durable-run-service.ts`**

Find the existing block (line ~788–798 of `durable-run-service.ts`) where `run_incomplete_worker_exit` is recorded:

```typescript
if (current.status === "running") {
  this.recordDurableTimelineEvent(current.runId, "run_incomplete_worker_exit", { ... });
  await this.failWorkflowRun(current, "Durable workflow exited without marking a terminal or waiting state.");
}
```

Right after the `failWorkflowRun` call, add:

```typescript
const taskId = typeof current.payload?.taskId === "string" ? current.payload.taskId : undefined;
if (taskId && this.deps?.taskLifecycle) {
  try {
    this.deps.taskLifecycle.autoBlockOnIncompleteExit(taskId, current.runId);
  } catch (error) {
    this.ctx.publishRealtime(
      "system",
      "durable",
      { kind: "task_auto_block_failed", runId: current.runId, taskId, error: String(error) },
      buildDurableRealtimeOptions(current.runId),
    );
  }
}
```

Extend the `DurableRunServiceContext`/deps type with optional `taskLifecycle: Pick<TaskLifecycleService, "autoBlockOnIncompleteExit">`. Update the constructor wire-up in `gateway-runtime-factory.ts` to pass the lifecycle service.

Add `simulateIncompleteWorkerExit(runId)` as a thin test-only method (gated behind `if (process.env.NODE_ENV === "test")` is NOT acceptable — instead, expose it from a `__forTesting` namespace or trigger the same code path by stubbing the executor to never call `complete()`). The cleanest approach: factor the bridge code into a private method `handleIncompleteWorkerExit(run)` and call it from the existing block; expose `__forTesting.handleIncompleteWorkerExit` via the module's existing testing exports pattern (see `__sqliteInternals` for precedent).

- [ ] **Step 5: Run — expect PASS**

Run: `pnpm --filter @goatcitadel/gateway test -- durable-run-service.test.ts`
Expected: green.

- [ ] **Step 6: Run full gateway suite**

Run: `pnpm --filter @goatcitadel/gateway test`
Expected: green (no regressions in the existing 1089 lines of durable-run tests).

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src/services/durable-run-service.ts \
  apps/gateway/src/services/durable-run-service.test.ts \
  apps/gateway/src/services/task-lifecycle-service.ts \
  apps/gateway/src/services/gateway-runtime-factory.ts
git commit -m "feat(kanban): bridge durable incomplete-exit to task auto-block"
```

## Task 2.4: Bulk-update method on lifecycle service

**Files:**
- Modify: `apps/gateway/src/services/task-lifecycle-service.ts`
- Modify: `apps/gateway/src/services/task-lifecycle-service.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
describe("TaskLifecycleService.bulkUpdateTasks", () => {
  it("unblock action moves blocked tasks to assigned and clears retry exhaustedAt", () => {
    const { service } = createTaskLifecycleServiceFixture();
    const a = service.createTask({ title: "a", status: "blocked" });
    service.setRetryBudget(a.taskId, 1);
    service.recordRetryAttempt(a.taskId, "fail-1");
    service.recordRetryAttempt(a.taskId, "fail-2"); // exhausted → already blocked
    const results = service.bulkUpdateTasks({ action: "unblock", taskIds: [a.taskId] });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "assigned");
    assert.equal(results[0].retryBudget?.retryCount, 0);
    assert.equal(results[0].retryBudget?.exhaustedAt, undefined);
  });

  it("retry action records a fresh attempt without status change", () => {
    const { service } = createTaskLifecycleServiceFixture();
    const a = service.createTask({ title: "a", status: "in_progress" });
    service.setRetryBudget(a.taskId, 3);
    const results = service.bulkUpdateTasks({ action: "retry", taskIds: [a.taskId], reason: "operator" });
    assert.equal(results[0].retryBudget?.retryCount, 1);
  });

  it("reassign action sets the new assignedAgentId", () => {
    const { service } = createTaskLifecycleServiceFixture();
    const a = service.createTask({ title: "a" });
    const results = service.bulkUpdateTasks({
      action: "reassign",
      taskIds: [a.taskId],
      assignedAgentId: "agent-9",
    });
    assert.equal(results[0].assignedAgentId, "agent-9");
  });

  it("close action moves tasks to done when they have a deliverable", () => {
    const { service, storage } = createTaskLifecycleServiceFixture();
    const a = service.createTask({ title: "a" });
    storage.taskDeliverables.append(a.taskId, {
      deliverableType: "artifact",
      title: "out",
    });
    const results = service.bulkUpdateTasks({ action: "close", taskIds: [a.taskId] });
    assert.equal(results[0].status, "done");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

```typescript
export type BulkTaskAction =
  | { action: "unblock"; taskIds: string[] }
  | { action: "retry"; taskIds: string[]; reason: string }
  | { action: "reassign"; taskIds: string[]; assignedAgentId: string }
  | { action: "close"; taskIds: string[] };

public bulkUpdateTasks(input: BulkTaskAction): TaskRecord[] {
  return input.taskIds.map((taskId) => {
    if (input.action === "unblock") {
      const current = this.deps.storage.tasks.get(taskId);
      const retryBudget = current.retryBudget
        ? { ...current.retryBudget, retryCount: 0, exhaustedAt: undefined }
        : undefined;
      return this.deps.storage.tasks.update(taskId, {
        status: "assigned",
        retryBudget,
      });
    }
    if (input.action === "retry") {
      return this.recordRetryAttempt(taskId, input.reason);
    }
    if (input.action === "reassign") {
      return this.deps.storage.tasks.update(taskId, { assignedAgentId: input.assignedAgentId });
    }
    return this.updateTask(taskId, { status: "done" }); // re-uses the deliverable guard
  });
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/task-lifecycle-service.ts apps/gateway/src/services/task-lifecycle-service.test.ts
git commit -m "feat(kanban): bulkUpdateTasks lifecycle helper (unblock/retry/reassign/close)"
```

## Task 2.5: Routes + client + Phase 2 PR

**Files:**
- Modify: gateway tasks route file (find via `grep -n "createTask" apps/gateway/src/routes/`)
- Modify: `packages/mission-control-shared/src/api/tasks.ts`
- Modify: `apps/gateway/src/services/tasks-route-service.ts`

- [ ] **Step 1: Surface methods on `TasksRoutePort`**

In `tasks-route-service.ts`, extend the `Pick<TaskLifecycleService, …>` union to include `emitDistressSignal | resolveDistressSignal | setRetryBudget | recordRetryAttempt | verifyTaskArtifacts | autoBlockOnIncompleteExit | bulkUpdateTasks`. Add wrapper methods on `TasksRouteService` for each.

- [ ] **Step 2: Add route handlers**

Locate the existing tasks route file via:
```bash
grep -rln "tasksRouteService" apps/gateway/src/routes
```

In that file, add (matching the existing handler style):
- `POST /tasks/:taskId/distress` body `{ code, severity, title, summary, emittedBy?, evidenceRef? }`
- `DELETE /tasks/:taskId/distress/:signalId` body `{ resolvedBy? }`
- `POST /tasks/:taskId/retry-budget` body `{ maxRetries }`
- `POST /tasks/:taskId/verify-artifacts` body `{ claims: TaskArtifactClaim[] }`
- `POST /tasks/bulk` body `BulkTaskAction`

Each handler calls the corresponding `tasksRouteService` method and returns `{ task }` or `{ tasks }`.

- [ ] **Step 3: Write a contract test for each new route**

Look in `apps/gateway/src/services/tasks-route-service.test.ts` (or the matching routes test file) for the existing per-route assertion pattern. Add one assertion per new endpoint that the dispatcher hits the right port method with the right shape.

- [ ] **Step 4: Add client helpers**

In `packages/mission-control-shared/src/api/tasks.ts` (and the parallel `apps/mission-control/src/api/tasks.ts` if it still gets used), add:

```typescript
export async function emitTaskDistress(taskId: string, input: EmitDistressBody): Promise<TaskRecord> { ... }
export async function resolveTaskDistress(taskId: string, signalId: string, input?: { resolvedBy?: string }): Promise<TaskRecord> { ... }
export async function setTaskRetryBudget(taskId: string, maxRetries: number): Promise<TaskRecord> { ... }
export async function verifyTaskArtifacts(taskId: string, claims: TaskArtifactClaim[]): Promise<TaskRecord> { ... }
export async function bulkTaskAction(input: BulkTaskAction): Promise<TaskRecord[]> { ... }
```

Use the existing `apiFetch` helper exactly like the other functions in this file.

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @goatcitadel/gateway test
pnpm --filter @goatcitadel/mission-control-shared build
```

- [ ] **Step 6: Commit + push + advance PR**

```bash
git add apps/gateway/src/services/tasks-route-service.ts \
  apps/gateway/src/routes/<tasks-route-file>.ts \
  apps/gateway/src/services/tasks-route-service.test.ts \
  packages/mission-control-shared/src/api/tasks.ts
git commit -m "feat(kanban): expose distress/retry/verify/bulk routes and shared client helpers"
git push
```

Update the existing PR description (still on `feature/multi-agent-kanban`) with a "Phase 2 added" section.

---

# Phase 3 — Operator Kanban surface + bulk ops

Goal of phase: operator hits `/ops/kanban`, sees Backlog / In Progress / Blocked / Done columns. Each card shows title, assigned worker, unresolved distress severity, retry count, last heartbeat age. Clicking opens a detail drawer with delegation lineage and transcript link. Multi-select drives bulk operations.

## Task 3.1: Route model + nav entry

**Files:**
- Modify: `apps/mission-control-next/src/app/route-model.ts`
- Modify: `apps/mission-control-next/src/app/route-model.loop26.test.ts`

- [ ] **Step 1: Write failing test for the new section**

Append to `route-model.loop26.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RAIL_ITEMS, parseAppRoute, getRouteLabel } from "./route-model.js";

describe("ops/kanban route", () => {
  it("parses /ops/kanban into area=ops, section=kanban", () => {
    const route = parseAppRoute("/ops/kanban");
    assert.equal(route.area, "ops");
    assert.equal(route.section, "kanban");
  });

  it("rail entry exists with stable id ops-kanban", () => {
    const entry = RAIL_ITEMS.ops.find((item) => item.id === "ops-kanban");
    assert.ok(entry, "expected ops-kanban rail item");
    assert.equal(entry?.section, "kanban");
  });

  it("getRouteLabel returns 'Kanban' for the section", () => {
    assert.equal(getRouteLabel({ area: "ops", section: "kanban" }), "Kanban");
  });
});
```

(If the actual test file uses `vitest` syntax — check first — switch `node:test` imports to `vitest`. Match the file's existing style.)

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @goatcitadel/mission-control-next test -- route-model`
Expected: FAIL — `"kanban"` is not in `OpsSection`.

- [ ] **Step 3: Extend the route model**

Edit `apps/mission-control-next/src/app/route-model.ts`:

a) Add `"kanban"` to the `OpsSection` union (line 12-22).
b) Add to `RAIL_ITEMS.ops` (in the `ops:` array around line 270):
```typescript
{
  id: "ops-kanban",
  label: "Kanban",
  description: "Multi-agent board with distress signals, retry budgets, and bulk operator controls.",
  area: "ops",
  section: "kanban",
},
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter @goatcitadel/mission-control-next test -- route-model`
Expected: all three tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/app/route-model.ts apps/mission-control-next/src/app/route-model.loop26.test.ts
git commit -m "feat(kanban): add ops/kanban route and rail entry"
```

## Task 3.2: Kanban card model — pure mapper

**Files:**
- Create: `apps/mission-control-next/src/features/native-routes/ops/kanban-card-model.ts`
- Create: `apps/mission-control-next/src/features/native-routes/ops/kanban-card-model.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from "vitest";
import type { TaskRecord } from "@goatcitadel/contracts";
import { toKanbanCard, toKanbanColumn, KanbanColumnId } from "./kanban-card-model";

const baseTask: TaskRecord = {
  taskId: "t-1",
  workspaceId: "default",
  title: "Build feature",
  status: "in_progress",
  priority: "high",
  assignedAgentId: "agent-7",
  createdAt: "2026-05-15T11:00:00.000Z",
  updatedAt: "2026-05-15T11:55:00.000Z",
};

describe("kanban-card-model", () => {
  it("toKanbanCard surfaces unresolved distress severity, retry count, heartbeat age", () => {
    const card = toKanbanCard(
      {
        ...baseTask,
        distressSignals: [
          { signalId: "ds-1", code: "tool_error", severity: "critical", title: "x", summary: "y",
            createdAt: "2026-05-15T11:30:00.000Z" },
        ],
        retryBudget: { maxRetries: 3, retryCount: 1 },
        agenticContext: { lastHeartbeatAt: "2026-05-15T11:50:00.000Z" } as never,
      },
      { now: () => Date.parse("2026-05-15T12:00:00.000Z") },
    );
    expect(card.distressSummary).toMatchObject({ critical: 1, warn: 0, info: 0 });
    expect(card.retryDisplay).toBe("1 / 3");
    expect(card.lastHeartbeatAgeSeconds).toBe(600);
  });

  it("toKanbanColumn assigns statuses to the four operator columns", () => {
    expect(toKanbanColumn("planning")).toBe<KanbanColumnId>("backlog");
    expect(toKanbanColumn("inbox")).toBe<KanbanColumnId>("backlog");
    expect(toKanbanColumn("assigned")).toBe<KanbanColumnId>("backlog");
    expect(toKanbanColumn("in_progress")).toBe<KanbanColumnId>("in_progress");
    expect(toKanbanColumn("testing")).toBe<KanbanColumnId>("in_progress");
    expect(toKanbanColumn("review")).toBe<KanbanColumnId>("in_progress");
    expect(toKanbanColumn("blocked")).toBe<KanbanColumnId>("blocked");
    expect(toKanbanColumn("done")).toBe<KanbanColumnId>("done");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @goatcitadel/mission-control-next test -- kanban-card-model`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
import type { TaskRecord, TaskStatus, TaskDistressSignal } from "@goatcitadel/contracts";

export type KanbanColumnId = "backlog" | "in_progress" | "blocked" | "done";

export interface KanbanCardModel {
  taskId: string;
  title: string;
  priority: TaskRecord["priority"];
  assignedAgentId?: string;
  column: KanbanColumnId;
  distressSummary: { info: number; warn: number; critical: number };
  unresolvedDistress: TaskDistressSignal[];
  retryDisplay?: string;
  lastHeartbeatAgeSeconds?: number;
}

export function toKanbanColumn(status: TaskStatus): KanbanColumnId {
  if (status === "planning" || status === "inbox" || status === "assigned") return "backlog";
  if (status === "in_progress" || status === "testing" || status === "review") return "in_progress";
  if (status === "blocked") return "blocked";
  return "done";
}

export interface ToKanbanCardOptions {
  now?: () => number;
}

export function toKanbanCard(task: TaskRecord, options: ToKanbanCardOptions = {}): KanbanCardModel {
  const nowMs = options.now ? options.now() : Date.now();
  const unresolved = (task.distressSignals ?? []).filter((s) => !s.resolvedAt);
  const distressSummary = { info: 0, warn: 0, critical: 0 };
  for (const s of unresolved) distressSummary[s.severity] += 1;
  const heartbeat = (task.agenticContext as { lastHeartbeatAt?: string } | undefined)?.lastHeartbeatAt;
  const heartbeatMs = heartbeat ? Date.parse(heartbeat) : Number.NaN;
  return {
    taskId: task.taskId,
    title: task.title,
    priority: task.priority,
    assignedAgentId: task.assignedAgentId,
    column: toKanbanColumn(task.status),
    distressSummary,
    unresolvedDistress: unresolved,
    retryDisplay: task.retryBudget ? `${task.retryBudget.retryCount} / ${task.retryBudget.maxRetries}` : undefined,
    lastHeartbeatAgeSeconds: Number.isFinite(heartbeatMs) ? Math.round((nowMs - heartbeatMs) / 1000) : undefined,
  };
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/features/native-routes/ops/kanban-card-model.ts \
  apps/mission-control-next/src/features/native-routes/ops/kanban-card-model.test.ts
git commit -m "feat(kanban): KanbanCardModel pure mapper"
```

## Task 3.3: KanbanRoutePage component (board + bulk ops + lineage drawer)

**Files:**
- Create: `apps/mission-control-next/src/features/native-routes/ops/KanbanRoutePage.tsx`
- Create: `apps/mission-control-next/src/features/native-routes/ops/KanbanRoutePage.test.tsx`

- [ ] **Step 1: Write failing RTL test**

Use the same pattern as `ApprovalsRoutePage.test.tsx` (read it first):

```typescript
import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import { KanbanRoutePage } from "./KanbanRoutePage";
import type { TaskRecord } from "@goatcitadel/contracts";

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchTasksByView: vi.fn(async () => ({
    items: [
      { taskId: "t-1", title: "Backlog item", status: "inbox", priority: "normal",
        createdAt: "2026-05-15T11:00:00.000Z", updatedAt: "2026-05-15T11:00:00.000Z" } as TaskRecord,
      { taskId: "t-2", title: "Working", status: "in_progress", priority: "high",
        assignedAgentId: "agent-7",
        distressSignals: [{ signalId: "ds-1", code: "tool_error", severity: "critical",
          title: "boom", summary: "", createdAt: "2026-05-15T11:30:00.000Z" }],
        createdAt: "2026-05-15T11:00:00.000Z", updatedAt: "2026-05-15T11:30:00.000Z" } as TaskRecord,
    ],
  })),
  bulkTaskAction: vi.fn(async () => []),
}));

const baseProps = {
  route: { area: "ops" as const, section: "kanban" as const },
  activeWorkspaceId: "default",
  activeWorkspaceName: "default",
  pendingApprovals: 0,
  navigate: vi.fn(),
} as never;

describe("KanbanRoutePage", () => {
  it("renders four columns and groups tasks correctly", async () => {
    render(<KanbanRoutePage {...baseProps} />);
    await waitFor(() => expect(screen.getByText("Working")).toBeInTheDocument());
    const backlog = screen.getByTestId("kanban-column-backlog");
    expect(within(backlog).getByText("Backlog item")).toBeInTheDocument();
    const inProgress = screen.getByTestId("kanban-column-in_progress");
    expect(within(inProgress).getByText("Working")).toBeInTheDocument();
  });

  it("shows a critical distress chip on cards with unresolved critical signals", async () => {
    render(<KanbanRoutePage {...baseProps} />);
    await waitFor(() => expect(screen.getByText("Working")).toBeInTheDocument());
    expect(screen.getByTestId("distress-chip-t-2")).toHaveTextContent(/critical/i);
  });

  it("fires bulkTaskAction with unblock when the operator clicks Unblock with selections", async () => {
    const { bulkTaskAction } = await import("@goatcitadel/mission-control-shared/api/client");
    render(<KanbanRoutePage {...baseProps} />);
    await waitFor(() => expect(screen.getByText("Working")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("kanban-select-t-2"));
    fireEvent.click(screen.getByRole("button", { name: /unblock/i }));
    await waitFor(() =>
      expect(bulkTaskAction).toHaveBeenCalledWith({ action: "unblock", taskIds: ["t-2"] }),
    );
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `KanbanRoutePage.tsx`**

Write the component file. Outline:

```typescript
import { useCallback, useEffect, useMemo, useState } from "react";
import { LayoutDashboard, Activity, AlertTriangle, RefreshCw } from "lucide-react";
import { fetchTasksByView, bulkTaskAction } from "@goatcitadel/mission-control-shared/api/client";
import type { TaskRecord } from "@goatcitadel/contracts";
import { NativeCard, NativePageFrame } from "../NativeRoutePageLayout";
import type { NativeRoutePagesProps } from "../types";
import { toKanbanCard, toKanbanColumn, type KanbanCardModel, type KanbanColumnId } from "./kanban-card-model";
import "../native-routes.css";

const COLUMNS: Array<{ id: KanbanColumnId; label: string }> = [
  { id: "backlog", label: "Backlog" },
  { id: "in_progress", label: "In Progress" },
  { id: "blocked", label: "Blocked" },
  { id: "done", label: "Done" },
];

export function KanbanRoutePage(props: NativeRoutePagesProps) {
  // State
  const [tasks, setTasks] = useState<TaskRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchTasksByView("active", undefined, props.activeWorkspaceId);
      setTasks(result.items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [props.activeWorkspaceId]);

  useEffect(() => { void load(); }, [load]);

  const cards = useMemo<KanbanCardModel[]>(
    () => (tasks ?? []).map((t) => toKanbanCard(t)),
    [tasks],
  );

  const cardsByColumn = useMemo(() => {
    const groups: Record<KanbanColumnId, KanbanCardModel[]> = {
      backlog: [], in_progress: [], blocked: [], done: [],
    };
    for (const c of cards) groups[c.column].push(c);
    return groups;
  }, [cards]);

  const runBulk = useCallback(async (action: "unblock" | "retry" | "close") => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const body =
      action === "retry" ? { action, taskIds: ids, reason: "operator-bulk-retry" } : { action, taskIds: ids };
    await bulkTaskAction(body as never);
    setSelected(new Set());
    await load();
  }, [load, selected]);

  return (
    <NativePageFrame
      icon={LayoutDashboard}
      kicker="Ops"
      title="Kanban"
      description="Multi-agent board with distress signals, retry budgets, and bulk operator controls."
      loading={loading}
      error={error}
    >
      <div className="mc-next-kanban-toolbar">
        <button onClick={() => runBulk("unblock")} disabled={selected.size === 0}>Unblock</button>
        <button onClick={() => runBulk("retry")} disabled={selected.size === 0}>Retry</button>
        <button onClick={() => runBulk("close")} disabled={selected.size === 0}>Close</button>
        <button onClick={() => void load()}><RefreshCw size={14} /> Refresh</button>
      </div>
      <div className="mc-next-kanban-board" data-testid="kanban-board">
        {COLUMNS.map((col) => (
          <KanbanColumn key={col.id} column={col} cards={cardsByColumn[col.id]} selected={selected} onToggleSelect={(id) => {
            const next = new Set(selected);
            if (next.has(id)) next.delete(id); else next.add(id);
            setSelected(next);
          }} />
        ))}
      </div>
    </NativePageFrame>
  );
}

function KanbanColumn({ column, cards, selected, onToggleSelect }: {
  column: { id: KanbanColumnId; label: string };
  cards: KanbanCardModel[];
  selected: Set<string>;
  onToggleSelect: (taskId: string) => void;
}) {
  return (
    <section className="mc-next-kanban-column" data-testid={`kanban-column-${column.id}`}>
      <header><h3>{column.label}</h3><span className="count">{cards.length}</span></header>
      <ul>
        {cards.map((card) => (
          <li key={card.taskId} className="mc-next-kanban-card">
            <label>
              <input
                type="checkbox"
                data-testid={`kanban-select-${card.taskId}`}
                checked={selected.has(card.taskId)}
                onChange={() => onToggleSelect(card.taskId)}
              />
              <span className="title">{card.title}</span>
            </label>
            {card.assignedAgentId && <small>{card.assignedAgentId}</small>}
            {card.retryDisplay && <span className="retry"><RefreshCw size={12} /> {card.retryDisplay}</span>}
            {card.distressSummary.critical > 0 && (
              <span data-testid={`distress-chip-${card.taskId}`} className="distress critical">
                <AlertTriangle size={12} /> {card.distressSummary.critical} critical
              </span>
            )}
            {card.distressSummary.warn > 0 && (
              <span data-testid={`distress-chip-${card.taskId}`} className="distress warn">
                <Activity size={12} /> {card.distressSummary.warn} warn
              </span>
            )}
            {typeof card.lastHeartbeatAgeSeconds === "number" && (
              <small className="heartbeat">{card.lastHeartbeatAgeSeconds}s ago</small>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
```

Add minimal CSS for `.mc-next-kanban-board`, `.mc-next-kanban-column`, `.mc-next-kanban-card`, `.distress.critical`, `.distress.warn` to `apps/mission-control-next/src/features/native-routes/native-routes.css` — use flex layout with 4 equal columns and 16px gap. Match the visual language of the existing `.mc-next-approvals-*` classes.

(File-size check: the component must stay under 400 lines. If it grows past that, extract `KanbanColumn` + `KanbanCard` into a sibling file `KanbanColumn.tsx`.)

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter @goatcitadel/mission-control-next test -- KanbanRoutePage`
Expected: all three RTL tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/features/native-routes/ops/KanbanRoutePage.tsx \
  apps/mission-control-next/src/features/native-routes/ops/KanbanRoutePage.test.tsx \
  apps/mission-control-next/src/features/native-routes/native-routes.css
git commit -m "feat(kanban): KanbanRoutePage with board, distress chips, bulk ops"
```

## Task 3.4: Wire the page into NativeRoutePages

**Files:**
- Modify: `apps/mission-control-next/src/features/native-routes/NativeRoutePages.tsx`
- Modify: `apps/mission-control-next/src/features/native-routes/NativeRoutePages.test.tsx`

- [ ] **Step 1: Write failing test**

Append to `NativeRoutePages.test.tsx`:

```typescript
it("renders KanbanRoutePage when section is kanban", () => {
  const props = { ...baseProps, route: { area: "ops", section: "kanban" } } as never;
  render(<NativeRoutePages {...props} />);
  expect(screen.getByText("Kanban")).toBeInTheDocument();
});
```

(Adapt to whatever fixture/helper that file already uses.)

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Wire the route**

Edit `NativeRoutePages.tsx`. Add import next to the other ops imports (line 80-81):

```typescript
import { KanbanRoutePage } from "./ops/KanbanRoutePage";
```

In the dispatch (line 132-137):

```typescript
if (route.area === "ops") {
  const section = route.section ?? "activity";
  if (section === "approvals") return <ApprovalsRoutePage {...props} />;
  if (section === "kanban") return <KanbanRoutePage {...props} />;
  return <RuntimeRoutePage {...props} />;
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter @goatcitadel/mission-control-next test -- NativeRoutePages`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add apps/mission-control-next/src/features/native-routes/NativeRoutePages.tsx \
  apps/mission-control-next/src/features/native-routes/NativeRoutePages.test.tsx
git commit -m "feat(kanban): route ops/kanban to KanbanRoutePage"
```

## Task 3.5: Manual browser smoke test + final PR

- [ ] **Step 1: Run the dev stack**

Run in parallel terminals (or `pnpm dev:all`):
```bash
pnpm dev:gateway
pnpm dev:ui:next
```
Expected: gateway boots, UI serves at `http://localhost:5173`.

- [ ] **Step 2: Verify the four spec acceptance scenarios manually**

Open the running gateway + UI and exercise:

1. **Reclaim within heartbeat window** — start two workers via existing scripted runner, dispatch three tasks, kill one worker mid-task. Assert the affected task's card surfaces a `stale_heartbeat` or `worker_crash` distress signal within ~10s and the durable run reclaims (existing behaviour) — the new piece is the Kanban card reflects this without page reload.
2. **Hallucination gate** — `curl -X POST localhost:7000/api/tasks/<id>/verify-artifacts -d '{"claims":[{"kind":"file","value":"/nope"}]}'` → card moves to Blocked column with `artifact_missing` distress chip.
3. **Retry budget exhaustion** — `curl -X POST localhost:7000/api/tasks/<id>/retry-budget -d '{"maxRetries":2}'`, then trigger `recordRetryAttempt` three times via the bulk-retry button → card moves to Blocked.
4. **Auto-block on incomplete exit** — start a durable run linked to a task with payload `{taskId}`, kill the worker process before it calls complete → card moves to Blocked with `worker_crash` distress.

Each scenario must show the card moving columns or surfacing the distress chip in the live UI. If any fails, return to the relevant phase and add the missing wire-up before claiming completion.

- [ ] **Step 3: Run full test suites**

```bash
pnpm --filter @goatcitadel/contracts build
pnpm --filter @goatcitadel/storage test
pnpm --filter @goatcitadel/gateway test
pnpm --filter @goatcitadel/mission-control-shared build
pnpm --filter @goatcitadel/mission-control-next test
pnpm --filter @goatcitadel/mission-control-next typecheck
```

- [ ] **Step 4: Mark PR ready for review**

```bash
git push
gh pr ready
```

Update the PR description with the final scope summary and the four manual verification screenshots / curl outputs.

---

## Risks and notes

- **Probers in tests**: The verifier accepts probers as deps. In production, the gateway must pass real fs/http/git probers. Make sure the wire-up location matches whatever pattern the codebase already uses for fs/http injection — search for `fetch(` in gateway services first to see whether a wrapped client is preferred.
- **Realtime push to the Kanban**: This plan polls on mount + after bulk actions. If the existing realtime event stream already pushes `task_updated`, a follow-up can subscribe; not in scope here.
- **Postgres sync**: SQLite migration v79 is added. If the Postgres sync layer mirrors columns, an entry in `packages/storage/src/postgres/migrations.ts` will also be required — search that file for `ALTER TABLE tasks` and add an analogous migration before merging.
- **Big files**: `NativeRoutePages.tsx` (3062 lines) is touched in two places (import + dispatch). A wholesale refactor of that file is OUT OF SCOPE; documented as a follow-up.

## Self-review checklist (run after writing this plan, not by a subagent)

- [x] Every spec ask has a task: distress engine (1.4), retry budget (1.5), artifact verification (2.1, 2.2), auto-block on incomplete exit (2.3), Kanban UI (3.3), bulk ops (3.3 + 2.4 backend), nav entry (3.1).
- [x] No "TBD" / "etc." / "as appropriate" placeholders in any step.
- [x] Type names are consistent: `TaskDistressSignal` (not `DistressSignal`), `TaskRetryBudget` (not `RetryBudget`), `KanbanColumnId` (not `ColumnId`), `bulkUpdateTasks` (not `bulkTaskUpdate`), `autoBlockOnIncompleteExit` (not `autoBlockOnExit`).
- [x] Each step shows the code or command — no "implement similar to above".
- [x] File-size guardrails: new files are well under 400 lines; the one risk (`KanbanRoutePage.tsx`) has an explicit extraction fallback noted.
- [x] Phase boundaries each produce a green PR independently — Phase 1 ships contracts + repo + lifecycle helpers; Phase 2 ships verification + bridge; Phase 3 ships UI + routes.
