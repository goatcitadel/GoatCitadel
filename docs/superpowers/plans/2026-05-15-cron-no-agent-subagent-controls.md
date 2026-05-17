# Cron `no_agent` + Subagent Control Knobs Implementation Plan

> Implementation-plan artifact only. This document may name proposed files, commands, tests, and runtime behavior; treat those as plan intent, not shipped 1.0 truth, unless the current implementation and release evidence prove them.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Explore four upstream-parity operator knobs for GoatCitadel: `no_agent` cron watchdog mode (O4), `context_from`+`workdir` cron chaining (O5), `cron run --wait` CLI (O6), and real budget enforcement of subagent child-spawn timeout + depth ceiling (O3).

**Architecture:** The plan routes each item through a clear contract layer (`packages/contracts`) → storage layer (`packages/storage` + SQL migrations) → service layer (`apps/gateway/src/services`) → entry layer (CLI for O6, dispatcher for O3). The original workstream assumed a `feature/cron-no-agent-subagent-controls` branch and independent phase commits so any one could be reverted without the others.

**Tech Stack:** TypeScript strict mode, Vitest, Zod, better-sqlite3, Postgres migrations array, Node CLI via `process.argv`.

**Reference upstream review:** OpenClaw/Hermes 2026-05-15 gap-review themes O3, O4, O5, and O6. The scratch review file was not committed and is not a source of release truth.

---

## File Structure

### Created
- `apps/gateway/src/services/gateway/cron-no-agent-runner.ts` — child-process runner for `no_agent` jobs (one responsibility: spawn → capture stdout → return result)
- `apps/gateway/src/services/gateway/cron-no-agent-runner.test.ts`
- `apps/gateway/src/cron-cli.ts` — CLI entrypoint for `goatcitadel cron run/runs`
- `apps/gateway/src/cron-cli.test.ts`
- `apps/gateway/src/services/subagent-budget-enforcer.ts` — pure helpers for timeout + depth enforcement
- `apps/gateway/src/services/subagent-budget-enforcer.test.ts`

### Modified
- `packages/contracts/src/monitoring.ts` — `CronJobAction` adds `no_agent`; `CronJobActionConfig` adds `noAgent`; `CronJobRecord` adds `workdir`, `contextFrom`, `lastRunOutput`, `lastRunId`
- `packages/contracts/src/config-schemas.ts` — `CronJobSchema` enum update + new optional fields; new `AgentSubagentDefaultsSchema`
- `packages/contracts/src/agentic-runtime.ts` — `AgenticDiagnosticCode` adds `max_depth_exceeded` and `timeout_exceeded`; `AgenticSubagentMetadata` adds `depth`
- `packages/storage/src/sqlite.ts` — `cron_jobs` adds `workdir`, `context_from`, `last_run_output`, `last_run_id` columns
- `packages/storage/src/postgres/migrations.ts` — add migrations 32 (no_agent action + workdir/context_from) and 33 (last_run_output/last_run_id)
- `packages/storage/src/cron-job-repo.ts` — row mapping/upsert for new columns
- `apps/gateway/src/services/gateway/cron-automation-service.ts` — `no_agent` handler, `contextFrom` resolution, `workdir` plumbing, return `runId` from `runCronJobNow`, add `findCronRunById`
- `apps/gateway/src/services/cron-route-service.ts` — expose `findCronRunById`
- `apps/gateway/src/services/cron-scheduler-service.ts` — pass through new methods
- `apps/gateway/src/services/chat-delegation-service.ts` — track `depth` on child runs; enforce `maxDepth` before spawn; enforce `childTimeoutSeconds` via `AbortSignal`

---

## Phase 0: Branch + Skeleton

### Task 0.1: Create feature branch

**Files:** none

- [ ] **Step 1: Confirm clean working tree**

Run: `git status --porcelain`
Expected: empty output

- [ ] **Step 2: Create + check out feature branch**

Run: `git checkout -b feature/cron-no-agent-subagent-controls`
Expected: `Switched to a new branch 'feature/cron-no-agent-subagent-controls'`

---

## Phase 1: O4 — `no_agent` cron watchdog mode

Goal: a cron job kind that runs a script-only command and delivers stdout verbatim when non-empty.

### Task 1.1: Extend `CronJobAction` + `CronJobActionConfig` in contracts (failing test first)

**Files:**
- Modify: `packages/contracts/src/monitoring.ts:81-101`
- Test: `packages/contracts/src/monitoring.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/monitoring.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { CronJobAction, CronJobActionConfig, CronJobRecord } from "./monitoring.js";

describe("CronJobAction", () => {
  it("includes no_agent", () => {
    const action: CronJobAction = "no_agent";
    expect(action).toBe("no_agent");
  });
});

describe("CronJobActionConfig", () => {
  it("accepts noAgent configuration", () => {
    const config: CronJobActionConfig = {
      noAgent: {
        command: "echo",
        args: ["alert"],
        timeoutMs: 5_000,
        deliveryChannel: { channelKey: "ops" },
      },
    };
    expect(config.noAgent?.command).toBe("echo");
  });
});

describe("CronJobRecord", () => {
  it("carries workdir, contextFrom, lastRunOutput, lastRunId", () => {
    const record: CronJobRecord = {
      jobId: "id",
      name: "n",
      action: "no_agent",
      schedule: "*/5 * * * *",
      enabled: true,
      workdir: "/tmp/x",
      contextFrom: "other-job",
      lastRunOutput: "alert",
      lastRunId: "run-1",
    };
    expect(record.workdir).toBe("/tmp/x");
    expect(record.contextFrom).toBe("other-job");
    expect(record.lastRunOutput).toBe("alert");
    expect(record.lastRunId).toBe("run-1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/contracts test -- monitoring.test`
Expected: FAIL with "Type 'no_agent' is not assignable to type 'CronJobAction'" or similar TypeScript errors.

- [ ] **Step 3: Update `monitoring.ts`**

Replace lines 81-101 of `packages/contracts/src/monitoring.ts`:

```typescript
export type CronJobAction =
  | "task"
  | "improvement"
  | "backup"
  | "memory_flush"
  | "cost_report"
  | "update_review"
  | "watchdog"
  | "no_agent";

export type CronWatchdogCheckId = "runtime_health" | "durable_dead_letters" | "channel_delivery_queue" | "mcp_posture";
export type CronWatchdogStatus = "ok" | "warning" | "error";

export interface CronWatchdogConfig {
  checkId?: CronWatchdogCheckId;
  severityThreshold?: Extract<CronWatchdogStatus, "warning" | "error">;
  notifyHomeChannel?: boolean;
}

export interface CronNoAgentDeliveryChannel {
  channelKey: string;
  target?: string;
}

export interface CronNoAgentConfig {
  command: string;
  args?: string[];
  timeoutMs?: number;
  deliveryChannel?: CronNoAgentDeliveryChannel;
}

export interface CronJobActionConfig {
  watchdog?: CronWatchdogConfig;
  noAgent?: CronNoAgentConfig;
}
```

Replace `CronJobRecord` (lines 111-123) with the four new optional fields appended:

```typescript
export interface CronJobRecord {
  jobId: string;
  name: string;
  action: CronJobAction;
  actionConfig?: CronJobActionConfig;
  description?: string;
  schedule: string;
  enabled: boolean;
  endAt?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  updatedAt?: string;
  workdir?: string;
  contextFrom?: string;
  lastRunOutput?: string;
  lastRunId?: string;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @goatcitadel/contracts test -- monitoring.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/monitoring.ts packages/contracts/src/monitoring.test.ts
git commit -m "feat(contracts): add no_agent cron action + workdir/contextFrom fields"
```

### Task 1.2: Update Zod `CronJobSchema`

**Files:**
- Modify: `packages/contracts/src/config-schemas.ts:559-578`
- Test: `packages/contracts/src/config-schemas.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/contracts/src/config-schemas.test.ts`:

```typescript
import { CronJobSchema } from "./config-schemas.js";

describe("CronJobSchema no_agent + chaining fields", () => {
  it("accepts no_agent action with noAgent actionConfig", () => {
    const parsed = CronJobSchema.parse({
      jobId: "probe",
      name: "Probe",
      action: "no_agent",
      actionConfig: { noAgent: { command: "echo", args: ["hi"], timeoutMs: 1000 } },
      schedule: "*/5 * * * *",
      enabled: true,
    });
    expect(parsed.action).toBe("no_agent");
  });

  it("accepts workdir and contextFrom", () => {
    const parsed = CronJobSchema.parse({
      jobId: "chained",
      name: "Chained",
      action: "task",
      schedule: "*/5 * * * *",
      enabled: true,
      workdir: "/tmp/test",
      contextFrom: "upstream",
    });
    expect(parsed.workdir).toBe("/tmp/test");
    expect(parsed.contextFrom).toBe("upstream");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/contracts test -- config-schemas.test`
Expected: FAIL because `no_agent` not in enum.

- [ ] **Step 3: Update `CronJobSchema`**

Replace lines 559-572 of `packages/contracts/src/config-schemas.ts`:

```typescript
export const CronJobSchema = z
  .object({
    jobId: z.string(),
    name: z.string(),
    action: z
      .enum([
        "task",
        "improvement",
        "backup",
        "memory_flush",
        "cost_report",
        "update_review",
        "watchdog",
        "no_agent",
      ])
      .default("task"),
    actionConfig: z.record(z.string(), z.unknown()).optional(),
    description: z.string().optional(),
    schedule: z.string(),
    enabled: z.boolean(),
    endAt: z.string().optional(),
    workdir: z.string().optional(),
    contextFrom: z.string().optional(),
  })
  .passthrough();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @goatcitadel/contracts test -- config-schemas.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/config-schemas.ts packages/contracts/src/config-schemas.test.ts
git commit -m "feat(contracts): extend cron Zod schema with no_agent + chaining fields"
```

### Task 1.3: SQLite + Postgres schema migrations

**Files:**
- Modify: `packages/storage/src/sqlite.ts:1101-1113`
- Modify: `packages/storage/src/postgres/migrations.ts:907` (append two new migrations)
- Test: `packages/storage/src/cron-job-repo.test.ts` (existing)

- [ ] **Step 1: Write the failing repo test**

Append to `packages/storage/src/cron-job-repo.test.ts`:

```typescript
describe("CronJobRepository workdir/contextFrom/lastRunOutput/lastRunId", () => {
  it("persists and reads new columns", () => {
    const db = openInMemoryDb();
    const repo = new CronJobRepository(db);
    const saved = repo.upsert({
      jobId: "probe",
      name: "Probe",
      action: "no_agent",
      actionConfig: { noAgent: { command: "echo", args: ["alert"] } },
      schedule: "*/5 * * * *",
      enabled: true,
      workdir: "/tmp/test",
      contextFrom: "upstream",
      lastRunOutput: "alert",
      lastRunId: "run-1",
    });
    const reloaded = repo.get("probe");
    expect(reloaded?.workdir).toBe("/tmp/test");
    expect(reloaded?.contextFrom).toBe("upstream");
    expect(reloaded?.lastRunOutput).toBe("alert");
    expect(reloaded?.lastRunId).toBe("run-1");
    expect(reloaded?.action).toBe("no_agent");
    expect(saved.workdir).toBe("/tmp/test");
  });
});
```

(Use the existing `openInMemoryDb` helper that other repo tests use. If it does not yet exist in that file, replicate the setup from another `*-repo.test.ts` such as `task-subagent-repo.test.ts`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/storage test -- cron-job-repo.test`
Expected: FAIL — columns don't exist.

- [ ] **Step 3: Update `sqlite.ts` schema**

Replace lines 1101-1113 of `packages/storage/src/sqlite.ts`:

```sql
    CREATE TABLE IF NOT EXISTS cron_jobs (
      job_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      action TEXT NOT NULL DEFAULT 'task',
      action_config_json TEXT,
      description TEXT,
      schedule TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      end_at TEXT,
      last_run_at TEXT,
      next_run_at TEXT,
      workdir TEXT,
      context_from TEXT,
      last_run_output TEXT,
      last_run_id TEXT,
      updated_at TEXT NOT NULL
    );
```

Also locate the migration-style `ALTER TABLE` block for cron_jobs in the same file (if it exists, around versioned sqlite migrations) and add equivalent `ALTER TABLE cron_jobs ADD COLUMN IF NOT EXISTS …` lines. If sqlite.ts uses idempotent CREATE TABLE only for in-memory tests, also add an in-place ALTER block guarded by `PRAGMA table_info` so existing DBs gain the columns.

- [ ] **Step 4: Add Postgres migrations 32 + 33**

Append to `packages/storage/src/postgres/migrations.ts` after line 906 (before the closing `]`):

```typescript
  {
    version: 32,
    name: "cron_jobs_workdir_and_context_from",
    sql: `
      ALTER TABLE cron_jobs
        ADD COLUMN IF NOT EXISTS workdir TEXT,
        ADD COLUMN IF NOT EXISTS context_from TEXT;
    `,
  },
  {
    version: 33,
    name: "cron_jobs_last_run_output_and_run_id",
    sql: `
      ALTER TABLE cron_jobs
        ADD COLUMN IF NOT EXISTS last_run_output TEXT,
        ADD COLUMN IF NOT EXISTS last_run_id TEXT;
    `,
  },
```

- [ ] **Step 5: Update `cron-job-repo.ts`**

Modify `packages/storage/src/cron-job-repo.ts`:

(a) Extend `CronJobRow` interface (lines 5-17):

```typescript
interface CronJobRow {
  job_id: string;
  name: string;
  action: string;
  action_config_json: string | null;
  description: string | null;
  schedule: string;
  enabled: number;
  end_at: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  workdir: string | null;
  context_from: string | null;
  last_run_output: string | null;
  last_run_id: string | null;
  updated_at: string;
}
```

(b) Update `upsertStmt` SQL (line 26-43) to include the four new columns:

```typescript
    this.upsertStmt = db.prepare(`
      INSERT INTO cron_jobs (
        job_id, name, action, action_config_json, description, schedule, enabled,
        end_at, last_run_at, next_run_at, workdir, context_from, last_run_output, last_run_id, updated_at
      ) VALUES (
        @jobId, @name, @action, @actionConfigJson, @description, @schedule, @enabled,
        @endAt, @lastRunAt, @nextRunAt, @workdir, @contextFrom, @lastRunOutput, @lastRunId, @updatedAt
      )
      ON CONFLICT(job_id) DO UPDATE SET
        name = excluded.name,
        action = excluded.action,
        action_config_json = excluded.action_config_json,
        description = excluded.description,
        schedule = excluded.schedule,
        enabled = excluded.enabled,
        end_at = excluded.end_at,
        last_run_at = excluded.last_run_at,
        next_run_at = excluded.next_run_at,
        workdir = excluded.workdir,
        context_from = excluded.context_from,
        last_run_output = excluded.last_run_output,
        last_run_id = excluded.last_run_id,
        updated_at = excluded.updated_at
    `);
```

(c) Update `upsert` method (lines 50-69) to bind new fields:

```typescript
  public upsert(job: CronJobRecord, now = new Date().toISOString()): CronJobRecord {
    this.upsertStmt.run({
      jobId: job.jobId,
      name: job.name,
      action: job.action,
      actionConfigJson: job.actionConfig ? JSON.stringify(job.actionConfig) : null,
      description: job.description ?? null,
      schedule: job.schedule,
      enabled: job.enabled ? 1 : 0,
      endAt: job.endAt ?? null,
      lastRunAt: job.lastRunAt ?? null,
      nextRunAt: job.nextRunAt ?? null,
      workdir: job.workdir ?? null,
      contextFrom: job.contextFrom ?? null,
      lastRunOutput: job.lastRunOutput ?? null,
      lastRunId: job.lastRunId ?? null,
      updatedAt: now,
    });

    return {
      ...job,
      updatedAt: now,
    };
  }
```

(d) Update `mapRow` (lines 101-116):

```typescript
function mapRow(row: CronJobRow): CronJobRecord {
  const actionConfig = safeJsonParse<CronJobRecord["actionConfig"] | undefined>(row.action_config_json, undefined);
  return {
    jobId: row.job_id,
    name: row.name,
    action: row.action as CronJobRecord["action"],
    ...(actionConfig ? { actionConfig } : {}),
    description: row.description ?? undefined,
    schedule: row.schedule,
    enabled: Boolean(row.enabled),
    endAt: row.end_at ?? undefined,
    lastRunAt: row.last_run_at ?? undefined,
    nextRunAt: row.next_run_at ?? undefined,
    workdir: row.workdir ?? undefined,
    contextFrom: row.context_from ?? undefined,
    lastRunOutput: row.last_run_output ?? undefined,
    lastRunId: row.last_run_id ?? undefined,
    updatedAt: row.updated_at,
  };
}
```

(e) Update `isCronJobRow` (lines 145-162) to accept the new nullable columns:

```typescript
function isCronJobRow(row: unknown): row is CronJobRow {
  if (!isRecord(row)) {
    return false;
  }
  return (
    typeof row.job_id === "string" &&
    typeof row.name === "string" &&
    typeof row.action === "string" &&
    (typeof row.action_config_json === "string" || row.action_config_json === null) &&
    (typeof row.description === "string" || row.description === null) &&
    typeof row.schedule === "string" &&
    typeof row.enabled === "number" &&
    (typeof row.end_at === "string" || row.end_at === null) &&
    (typeof row.last_run_at === "string" || row.last_run_at === null) &&
    (typeof row.next_run_at === "string" || row.next_run_at === null) &&
    (typeof row.workdir === "string" || row.workdir === null) &&
    (typeof row.context_from === "string" || row.context_from === null) &&
    (typeof row.last_run_output === "string" || row.last_run_output === null) &&
    (typeof row.last_run_id === "string" || row.last_run_id === null) &&
    typeof row.updated_at === "string"
  );
}
```

(f) Update `cronJobsMatch` (lines 118-131) to compare the new fields too:

```typescript
function cronJobsMatch(existing: CronJobRecord, next: CronJobRecord): boolean {
  return (
    existing.jobId === next.jobId &&
    existing.name === next.name &&
    existing.action === next.action &&
    JSON.stringify(existing.actionConfig ?? {}) === JSON.stringify(next.actionConfig ?? {}) &&
    existing.description === next.description &&
    existing.schedule === next.schedule &&
    existing.enabled === next.enabled &&
    existing.endAt === next.endAt &&
    existing.lastRunAt === next.lastRunAt &&
    existing.nextRunAt === next.nextRunAt &&
    existing.workdir === next.workdir &&
    existing.contextFrom === next.contextFrom &&
    existing.lastRunOutput === next.lastRunOutput &&
    existing.lastRunId === next.lastRunId
  );
}
```

- [ ] **Step 6: Run repo test**

Run: `pnpm --filter @goatcitadel/storage test -- cron-job-repo.test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/storage/src/sqlite.ts packages/storage/src/postgres/migrations.ts packages/storage/src/cron-job-repo.ts packages/storage/src/cron-job-repo.test.ts
git commit -m "feat(storage): add cron workdir/contextFrom/lastRunOutput/lastRunId columns"
```

### Task 1.4: `no_agent` runner module

**Files:**
- Create: `apps/gateway/src/services/gateway/cron-no-agent-runner.ts`
- Test: `apps/gateway/src/services/gateway/cron-no-agent-runner.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/gateway/src/services/gateway/cron-no-agent-runner.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { runNoAgentCommand } from "./cron-no-agent-runner.js";

describe("runNoAgentCommand", () => {
  it("returns empty stdout for a command that prints nothing", async () => {
    const result = await runNoAgentCommand({
      command: process.platform === "win32" ? "cmd" : "sh",
      args: process.platform === "win32" ? ["/c", "rem"] : ["-c", "true"],
    });
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("captures stdout verbatim from a non-empty echo", async () => {
    const result = await runNoAgentCommand({
      command: process.platform === "win32" ? "cmd" : "sh",
      args: process.platform === "win32" ? ["/c", "echo alert"] : ["-c", "printf 'alert'"],
    });
    expect(result.stdout.trim()).toBe("alert");
    expect(result.exitCode).toBe(0);
  });

  it("runs in the configured workdir", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no-agent-cwd-"));
    try {
      const result = await runNoAgentCommand({
        command: process.platform === "win32" ? "cmd" : "sh",
        args: process.platform === "win32" ? ["/c", "cd"] : ["-c", "pwd"],
        workdir: dir,
      });
      // realpathSync handles macOS /tmp -> /private/tmp etc.
      expect(fs.realpathSync(result.stdout.trim())).toBe(fs.realpathSync(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kills the process after timeoutMs and reports timedOut=true", async () => {
    const result = await runNoAgentCommand({
      command: process.platform === "win32" ? "cmd" : "sh",
      args: process.platform === "win32" ? ["/c", "ping -n 5 127.0.0.1 > NUL"] : ["-c", "sleep 5"],
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/gateway test -- cron-no-agent-runner.test`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `cron-no-agent-runner.ts`**

Create `apps/gateway/src/services/gateway/cron-no-agent-runner.ts`:

```typescript
import { spawn } from "node:child_process";

export interface NoAgentRunInput {
  command: string;
  args?: string[];
  workdir?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface NoAgentRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export async function runNoAgentCommand(input: NoAgentRunInput): Promise<NoAgentRunResult> {
  return new Promise((resolve) => {
    const child = spawn(input.command, input.args ?? [], {
      cwd: input.workdir,
      env: input.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timeoutId =
      input.timeoutMs && input.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, input.timeoutMs)
        : undefined;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const settle = (exitCode: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      resolve({ stdout, stderr, exitCode, timedOut });
    };

    child.on("error", () => settle(null));
    child.on("close", (code) => settle(code));
  });
}
```

- [ ] **Step 4: Run test**

Run: `pnpm --filter @goatcitadel/gateway test -- cron-no-agent-runner.test`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/gateway/cron-no-agent-runner.ts apps/gateway/src/services/gateway/cron-no-agent-runner.test.ts
git commit -m "feat(gateway): add no_agent cron command runner"
```

### Task 1.5: Wire `no_agent` into `CronAutomationService`

**Files:**
- Modify: `apps/gateway/src/services/gateway/cron-automation-service.ts`
- Test: `apps/gateway/src/services/gateway/cron-automation-service.test.ts`

- [ ] **Step 1: Write the failing service test**

Append to `apps/gateway/src/services/gateway/cron-automation-service.test.ts`:

```typescript
describe("no_agent cron action", () => {
  it("skips delivery when stdout is empty", async () => {
    const realtime = vi.fn();
    const service = makeServiceWithNoAgent({
      realtime,
      runner: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
    });
    service.createCronJob({
      jobId: "probe-empty",
      name: "probe-empty",
      action: "no_agent",
      schedule: "*/5 * * * *",
      actionConfig: { noAgent: { command: "echo", args: [""] } },
    });
    await service.runCronJobNow("probe-empty");
    const events = realtime.mock.calls.map((call) => call[2]?.type).filter(Boolean);
    expect(events).not.toContain("cron_no_agent_output");
    const job = service.getCronJob("probe-empty");
    expect(job.lastRunOutput).toBeUndefined();
  });

  it("delivers stdout verbatim and stores it on lastRunOutput when non-empty", async () => {
    const realtime = vi.fn();
    const service = makeServiceWithNoAgent({
      realtime,
      runner: async () => ({ stdout: "alert", stderr: "", exitCode: 0, timedOut: false }),
    });
    service.createCronJob({
      jobId: "probe-alert",
      name: "probe-alert",
      action: "no_agent",
      schedule: "*/5 * * * *",
      actionConfig: { noAgent: { command: "echo", args: ["alert"] } },
    });
    await service.runCronJobNow("probe-alert");
    const payloads = realtime.mock.calls
      .filter((call) => call[2]?.type === "cron_no_agent_output")
      .map((call) => call[2]);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.output).toBe("alert");
    const job = service.getCronJob("probe-alert");
    expect(job.lastRunOutput).toBe("alert");
  });
});
```

Add a `makeServiceWithNoAgent` helper near the top of the test file:

```typescript
function makeServiceWithNoAgent(opts: {
  realtime: ReturnType<typeof vi.fn>;
  runner: (input: unknown) => Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>;
}): CronAutomationService {
  const storage = makeFakeStorage();
  const deps: CronAutomationServiceDeps = {
    storage,
    persistCronJobsConfig: () => {},
    publishRealtime: opts.realtime,
    requireFeatureEnabled: () => {},
    isFeatureEnabled: () => false,
    runHandlers: {
      task: async () => ({}),
      improvement: async () => {},
      backup: async () => {},
      memoryFlush: async () => {},
      costReport: async () => {},
      updateReview: async () => {},
      watchdog: async () => ({ status: "ok", checkId: "runtime_health", summary: "ok" }),
      noAgent: opts.runner,
    },
  };
  return new CronAutomationService(deps);
}
```

(Use the existing `makeFakeStorage` helper if present, or extract one from prior tests that wraps `FakeDb`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/gateway test -- cron-automation-service.test`
Expected: FAIL — no_agent action unsupported.

- [ ] **Step 3: Update `CronAutomationServiceDeps`**

In `apps/gateway/src/services/gateway/cron-automation-service.ts` lines 25-40, extend the `runHandlers` shape:

```typescript
export interface CronAutomationServiceDeps {
  storage: Storage;
  persistCronJobsConfig: () => void;
  publishRealtime: (eventType: string, source: string, payload?: Record<string, unknown>) => void;
  requireFeatureEnabled: (flag: "cronReviewQueueV1Enabled") => void;
  isFeatureEnabled: (flag: "cronReviewQueueV1Enabled") => boolean;
  runHandlers: {
    task: (job: CronJobRecord, context?: { contextFrom?: string; contextOutput?: string }) => Promise<{ taskId?: string } | void>;
    improvement: () => Promise<void>;
    backup: () => Promise<void>;
    memoryFlush: () => Promise<void>;
    costReport: () => Promise<void>;
    updateReview: () => Promise<void>;
    watchdog: (job: CronJobRecord) => Promise<CronWatchdogRunResult>;
    noAgent: (input: {
      command: string;
      args?: string[];
      workdir?: string;
      timeoutMs?: number;
    }) => Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>;
  };
}
```

- [ ] **Step 4: Add the `no_agent` branch to `runCronJobNow`**

In `runCronJobNow` (around lines 170-293), insert after the `update_review` branch (line 265) and before the closing `else` (line 266):

```typescript
    } else if (job.action === "no_agent") {
      const noAgentConfig = job.actionConfig?.noAgent;
      if (!noAgentConfig?.command) {
        throw new Error(`no_agent cron job missing command: ${normalizedJobId}`);
      }
      const runId = randomUUID();
      const runResult = await this.deps.runHandlers.noAgent({
        command: noAgentConfig.command,
        args: noAgentConfig.args,
        workdir: job.workdir,
        timeoutMs: noAgentConfig.timeoutMs,
      });
      const finishedAt = new Date().toISOString();
      const stdoutTrimmed = runResult.stdout.replace(/\r?\n$/, "");
      const hasOutput = stdoutTrimmed.length > 0;
      const saved = this.deps.storage.cronJobs.upsert(
        {
          ...job,
          lastRunAt: finishedAt,
          lastRunOutput: hasOutput ? stdoutTrimmed : undefined,
          lastRunId: runId,
          nextRunAt: computeNextCronRunAt(job.schedule, new Date(finishedAt), job.endAt),
        },
        finishedAt,
      );
      this.deps.persistCronJobsConfig();
      runSummary = {
        ...runResult,
        action: job.action,
        runId,
        hasOutput,
        nextRunAt: saved.nextRunAt,
      };
      if (hasOutput) {
        this.deps.publishRealtime("cron_job_run", "cron", {
          type: "cron_no_agent_output",
          jobId: saved.jobId,
          runId,
          output: stdoutTrimmed,
          deliveryChannel: noAgentConfig.deliveryChannel,
        });
      }
```

- [ ] **Step 5: Make `no_agent` count as a scheduled action**

Update `isScheduledCronAction` (line 621-623):

```typescript
function isScheduledCronAction(action: CronJobRecord["action"]): boolean {
  return action === "task" || action === "watchdog" || action === "no_agent";
}
```

- [ ] **Step 6: Make `normalizeCronJobActionConfig` accept noAgent config**

Replace `normalizeCronJobActionConfig` (lines 586-607):

```typescript
function normalizeCronJobActionConfig(
  value: unknown,
  action: CronJobRecord["action"],
): CronJobRecord["actionConfig"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const rawValue = value as Record<string, unknown>;
  if (action === "watchdog") {
    const rawWatchdog =
      rawValue.watchdog && typeof rawValue.watchdog === "object" && !Array.isArray(rawValue.watchdog)
        ? (rawValue.watchdog as Record<string, unknown>)
        : {};
    const checkId = normalizeWatchdogCheckId(rawWatchdog.checkId);
    const severityThreshold = rawWatchdog.severityThreshold === "error" ? "error" : "warning";
    return {
      watchdog: {
        checkId,
        severityThreshold,
        notifyHomeChannel: rawWatchdog.notifyHomeChannel === true,
      },
    };
  }
  if (action === "no_agent") {
    const rawNoAgent =
      rawValue.noAgent && typeof rawValue.noAgent === "object" && !Array.isArray(rawValue.noAgent)
        ? (rawValue.noAgent as Record<string, unknown>)
        : undefined;
    if (!rawNoAgent || typeof rawNoAgent.command !== "string" || !rawNoAgent.command.trim()) {
      throw new Error("no_agent cron job requires actionConfig.noAgent.command.");
    }
    const args = Array.isArray(rawNoAgent.args)
      ? rawNoAgent.args.filter((token): token is string => typeof token === "string")
      : undefined;
    const timeoutMs =
      typeof rawNoAgent.timeoutMs === "number" && Number.isFinite(rawNoAgent.timeoutMs) && rawNoAgent.timeoutMs > 0
        ? Math.floor(rawNoAgent.timeoutMs)
        : undefined;
    const rawChannel =
      rawNoAgent.deliveryChannel && typeof rawNoAgent.deliveryChannel === "object" && !Array.isArray(rawNoAgent.deliveryChannel)
        ? (rawNoAgent.deliveryChannel as Record<string, unknown>)
        : undefined;
    const deliveryChannel =
      rawChannel && typeof rawChannel.channelKey === "string"
        ? {
            channelKey: rawChannel.channelKey,
            target: typeof rawChannel.target === "string" ? rawChannel.target : undefined,
          }
        : undefined;
    return {
      noAgent: {
        command: rawNoAgent.command.trim(),
        ...(args ? { args } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
        ...(deliveryChannel ? { deliveryChannel } : {}),
      },
    };
  }
  return undefined;
}
```

- [ ] **Step 7: Run test**

Run: `pnpm --filter @goatcitadel/gateway test -- cron-automation-service.test`
Expected: PASS (both new tests + existing ones).

- [ ] **Step 8: Wire the runner into the factory**

Find the file that constructs `CronAutomationServiceDeps` at runtime (search: `new CronAutomationService(`). It's most likely in a gateway runtime factory. Update its `runHandlers.noAgent` to call the new `runNoAgentCommand`:

Find `new CronAutomationService(` with `grep -rn "new CronAutomationService" apps/gateway/src/`. Edit the deps to add:

```typescript
runHandlers: {
  // ...existing handlers...
  noAgent: (input) => runNoAgentCommand(input),
},
```

Import: `import { runNoAgentCommand } from "./cron-no-agent-runner.js";` (path-relative to the factory file).

- [ ] **Step 9: Commit**

```bash
git add apps/gateway/src/services/gateway/cron-automation-service.ts apps/gateway/src/services/gateway/cron-automation-service.test.ts apps/gateway/src/services/gateway-runtime-factory.ts
git commit -m "feat(gateway): wire no_agent cron action runner end-to-end"
```

---

## Phase 2: O5 — `context_from` chaining + per-job `workdir`

Goal: surface `workdir` on every job (already in storage from Phase 1) and let one job consume another's last successful output.

### Task 2.1: Pipe `workdir` into createCronJob/updateCronJob

**Files:**
- Modify: `apps/gateway/src/services/gateway/cron-automation-service.ts`
- Modify: `apps/gateway/src/services/cron-scheduler-service.ts`
- Test: `apps/gateway/src/services/gateway/cron-automation-service.test.ts`

- [ ] **Step 1: Write the failing service test**

Append to `apps/gateway/src/services/gateway/cron-automation-service.test.ts`:

```typescript
describe("createCronJob workdir + contextFrom", () => {
  it("stores workdir and contextFrom on the persisted record", () => {
    const service = makeServiceWithNoAgent({ realtime: vi.fn(), runner: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }) });
    const saved = service.createCronJob({
      jobId: "chained",
      name: "Chained",
      action: "task",
      schedule: "*/5 * * * *",
      workdir: "/tmp/test",
      contextFrom: "upstream",
    });
    expect(saved.workdir).toBe("/tmp/test");
    expect(saved.contextFrom).toBe("upstream");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/gateway test -- cron-automation-service.test`
Expected: FAIL — fields not accepted by createCronJob.

- [ ] **Step 3: Extend createCronJob/updateCronJob signatures**

In `apps/gateway/src/services/gateway/cron-automation-service.ts`:

`createCronJob` signature + body (lines 58-99):

```typescript
  public createCronJob(input: {
    jobId: string;
    name: string;
    action?: CronJobRecord["action"];
    description?: string;
    schedule: string;
    enabled?: boolean;
    endAt?: string;
    actionConfig?: unknown;
    workdir?: string;
    contextFrom?: string;
  }): CronJobRecord {
    const jobId = normalizeCronJobId(input.jobId);
    if (this.deps.storage.cronJobs.get(jobId)) {
      throw new Error(`Cron job already exists: ${jobId}`);
    }
    const action = normalizeCronJobAction(input.action);
    const job: CronJobRecord = {
      jobId,
      name: normalizeCronJobName(input.name),
      action,
      actionConfig: normalizeCronJobActionConfig(input.actionConfig, action),
      description: normalizeCronJobDescription(input.description),
      schedule: normalizeCronSchedule(input.schedule),
      enabled: input.enabled ?? true,
      endAt: normalizeCronEndAt(input.endAt),
      workdir: normalizeCronWorkdir(input.workdir),
      contextFrom: normalizeCronContextFrom(input.contextFrom),
      lastRunAt: undefined,
      nextRunAt: undefined,
    };
    if (isScheduledCronAction(job.action)) {
      job.nextRunAt = computeNextCronRunAt(job.schedule, new Date(), job.endAt);
    }
    const saved = this.deps.storage.cronJobs.upsert(job);
    this.deps.persistCronJobsConfig();
    this.deps.publishRealtime("system", "cron", {
      type: "cron_job_created",
      jobId: saved.jobId,
      name: saved.name,
      action: saved.action,
      schedule: saved.schedule,
      enabled: saved.enabled,
    });
    return saved;
  }
```

`updateCronJob` similarly accepts `workdir?: string | null` and `contextFrom?: string | null` and updates them when defined.

Add helpers below the service class:

```typescript
export function normalizeCronWorkdir(value: string | undefined | null): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > 1024) {
    throw new Error("Cron workdir must be 1024 characters or less.");
  }
  return trimmed;
}

export function normalizeCronContextFrom(value: string | undefined | null): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  // Validate via existing id rules.
  return normalizeCronJobId(trimmed);
}
```

- [ ] **Step 4: Forward fields through the scheduler facade**

Update `apps/gateway/src/services/cron-scheduler-service.ts` `createCronJob`/`updateCronJob` signatures to include `workdir?: string` and `contextFrom?: string | null`. Forward them to the service.

- [ ] **Step 5: Run test**

Run: `pnpm --filter @goatcitadel/gateway test -- cron-automation-service.test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/services/gateway/cron-automation-service.ts apps/gateway/src/services/cron-scheduler-service.ts apps/gateway/src/services/gateway/cron-automation-service.test.ts
git commit -m "feat(gateway): accept workdir + contextFrom on cron create/update"
```

### Task 2.2: Resolve `contextFrom` at run time and pass to task handler

**Files:**
- Modify: `apps/gateway/src/services/gateway/cron-automation-service.ts`
- Test: `apps/gateway/src/services/gateway/cron-automation-service.test.ts`

- [ ] **Step 1: Write the failing service test**

Append to `cron-automation-service.test.ts`:

```typescript
describe("contextFrom resolution", () => {
  it("passes upstream lastRunOutput to task handler as contextOutput", async () => {
    const realtime = vi.fn();
    const captured: Array<{ contextFrom?: string; contextOutput?: string }> = [];
    const storage = makeFakeStorage();
    storage.cronJobs.upsert({
      jobId: "upstream",
      name: "Upstream",
      action: "no_agent",
      schedule: "*/5 * * * *",
      enabled: true,
      lastRunOutput: "context-payload",
    });
    const deps: CronAutomationServiceDeps = {
      storage,
      persistCronJobsConfig: () => {},
      publishRealtime: realtime,
      requireFeatureEnabled: () => {},
      isFeatureEnabled: () => false,
      runHandlers: {
        task: async (_job, ctx) => {
          captured.push(ctx ?? {});
          return { taskId: "task-1" };
        },
        improvement: async () => {},
        backup: async () => {},
        memoryFlush: async () => {},
        costReport: async () => {},
        updateReview: async () => {},
        watchdog: async () => ({ status: "ok", checkId: "runtime_health", summary: "ok" }),
        noAgent: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
      },
    };
    const service = new CronAutomationService(deps);
    service.createCronJob({
      jobId: "downstream",
      name: "Downstream",
      action: "task",
      schedule: "*/5 * * * *",
      contextFrom: "upstream",
    });
    await service.runCronJobNow("downstream");
    expect(captured[0]?.contextFrom).toBe("upstream");
    expect(captured[0]?.contextOutput).toBe("context-payload");
  });

  it("passes undefined contextOutput when contextFrom job has no lastRunOutput yet", async () => {
    const realtime = vi.fn();
    const captured: Array<{ contextFrom?: string; contextOutput?: string }> = [];
    const storage = makeFakeStorage();
    storage.cronJobs.upsert({
      jobId: "upstream-empty",
      name: "Upstream",
      action: "no_agent",
      schedule: "*/5 * * * *",
      enabled: true,
    });
    const deps: CronAutomationServiceDeps = {
      storage,
      persistCronJobsConfig: () => {},
      publishRealtime: realtime,
      requireFeatureEnabled: () => {},
      isFeatureEnabled: () => false,
      runHandlers: {
        task: async (_job, ctx) => {
          captured.push(ctx ?? {});
          return { taskId: "t" };
        },
        improvement: async () => {},
        backup: async () => {},
        memoryFlush: async () => {},
        costReport: async () => {},
        updateReview: async () => {},
        watchdog: async () => ({ status: "ok", checkId: "runtime_health", summary: "ok" }),
        noAgent: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
      },
    };
    const service = new CronAutomationService(deps);
    service.createCronJob({
      jobId: "downstream-empty",
      name: "Downstream",
      action: "task",
      schedule: "*/5 * * * *",
      contextFrom: "upstream-empty",
    });
    await service.runCronJobNow("downstream-empty");
    expect(captured[0]?.contextFrom).toBe("upstream-empty");
    expect(captured[0]?.contextOutput).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/gateway test -- cron-automation-service.test`
Expected: FAIL — handler does not get a context arg.

- [ ] **Step 3: Update task branch in `runCronJobNow`**

Replace the `if (job.action === "task")` branch (lines 181-204) of `runCronJobNow`:

```typescript
    if (job.action === "task") {
      const context = this.resolveCronJobContext(job);
      const taskResult = await this.deps.runHandlers.task(job, context);
      const finishedAt = new Date().toISOString();
      const saved = this.deps.storage.cronJobs.upsert(
        {
          ...job,
          lastRunAt: finishedAt,
          nextRunAt: computeNextCronRunAt(job.schedule, new Date(finishedAt), job.endAt),
        },
        finishedAt,
      );
      this.deps.persistCronJobsConfig();
      runSummary = {
        ...runSummary,
        action: job.action,
        taskId: taskResult?.taskId,
        nextRunAt: saved.nextRunAt,
        contextFrom: context?.contextFrom,
      };
      this.deps.publishRealtime("cron_job_run", "cron", {
        type: "scheduled_task_created",
        jobId: saved.jobId,
        taskId: taskResult?.taskId,
        name: saved.name,
        contextFrom: context?.contextFrom,
      });
    }
```

Add the resolver method on `CronAutomationService` (anywhere inside the class):

```typescript
  private resolveCronJobContext(job: CronJobRecord): { contextFrom?: string; contextOutput?: string } | undefined {
    if (!job.contextFrom) {
      return undefined;
    }
    const upstream = this.deps.storage.cronJobs.get(job.contextFrom);
    return {
      contextFrom: job.contextFrom,
      contextOutput: upstream?.lastRunOutput,
    };
  }
```

- [ ] **Step 4: Run test**

Run: `pnpm --filter @goatcitadel/gateway test -- cron-automation-service.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/gateway/cron-automation-service.ts apps/gateway/src/services/gateway/cron-automation-service.test.ts
git commit -m "feat(gateway): resolve cron contextFrom upstream output before task run"
```

### Task 2.3: Propagate workdir into no_agent runs

Already wired in Phase 1 — verify with a regression test:

- [ ] **Step 1: Add test**

Append to `cron-automation-service.test.ts`:

```typescript
it("forwards workdir into the no_agent runner", async () => {
  const captured: Array<{ workdir?: string }> = [];
  const service = makeServiceWithNoAgent({
    realtime: vi.fn(),
    runner: async (input) => {
      captured.push({ workdir: (input as { workdir?: string }).workdir });
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    },
  });
  service.createCronJob({
    jobId: "wd",
    name: "Wd",
    action: "no_agent",
    schedule: "*/5 * * * *",
    workdir: "/tmp/test",
    actionConfig: { noAgent: { command: "echo" } },
  });
  await service.runCronJobNow("wd");
  expect(captured[0]?.workdir).toBe("/tmp/test");
});
```

- [ ] **Step 2: Run test**

Run: `pnpm --filter @goatcitadel/gateway test -- cron-automation-service.test`
Expected: PASS (already wired in Phase 1).

- [ ] **Step 3: Commit**

```bash
git add apps/gateway/src/services/gateway/cron-automation-service.test.ts
git commit -m "test(gateway): assert workdir reaches no_agent runner"
```

---

## Phase 3: O6 — `cron run --wait` CLI

Goal: a CLI entrypoint `goatcitadel cron run <jobId> [--wait] [--timeout <ms>] [--poll-interval <ms>]` and `goatcitadel cron runs --run-id <id>` for querying.

### Task 3.1: Service returns `runId` from `runCronJobNow`; add `findCronRunById`

**Files:**
- Modify: `apps/gateway/src/services/gateway/cron-automation-service.ts`
- Test: `apps/gateway/src/services/gateway/cron-automation-service.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `cron-automation-service.test.ts`:

```typescript
describe("runCronJobNow returns runId", () => {
  it("returns the runId for the manual run", async () => {
    const service = makeServiceWithNoAgent({
      realtime: vi.fn(),
      runner: async () => ({ stdout: "alert", stderr: "", exitCode: 0, timedOut: false }),
    });
    service.createCronJob({
      jobId: "rid",
      name: "Rid",
      action: "no_agent",
      schedule: "*/5 * * * *",
      actionConfig: { noAgent: { command: "echo" } },
    });
    const result = await service.runCronJobNow("rid");
    expect(typeof result.runId).toBe("string");
    expect(result.runId.length).toBeGreaterThan(0);
    expect(result.jobId).toBe("rid");
    expect(result.status).toBe("ok");
  });
});

describe("findCronRunById", () => {
  it("returns undefined for unknown run ids", () => {
    const service = makeServiceWithNoAgent({ realtime: vi.fn(), runner: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }) });
    expect(service.findCronRunById("missing")).toBeUndefined();
  });

  it("returns the job snapshot when a run id matches lastRunId", async () => {
    const service = makeServiceWithNoAgent({
      realtime: vi.fn(),
      runner: async () => ({ stdout: "alert", stderr: "", exitCode: 0, timedOut: false }),
    });
    service.createCronJob({
      jobId: "found",
      name: "Found",
      action: "no_agent",
      schedule: "*/5 * * * *",
      actionConfig: { noAgent: { command: "echo" } },
    });
    const result = await service.runCronJobNow("found");
    const lookup = service.findCronRunById(result.runId);
    expect(lookup?.jobId).toBe("found");
    expect(lookup?.runId).toBe(result.runId);
    expect(lookup?.status).toBe("ok");
    expect(lookup?.output).toBe("alert");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/gateway test -- cron-automation-service.test`
Expected: FAIL.

- [ ] **Step 3: Update `runCronJobNow` return type**

Change the signature on line 170 of `cron-automation-service.ts`:

```typescript
  public async runCronJobNow(jobId: string): Promise<{ jobId: string; runId: string; status: "ok" }> {
```

Inside the method, generate one `runId = randomUUID()` near the top (right after `const job = this.getCronJob(normalizedJobId);` check), and pass it through into every branch (set on the persisted job as `lastRunId`, included in the realtime payload, and returned at the end):

```typescript
    const runId = randomUUID();
```

For the `task` branch update upsert to include `lastRunId: runId`. Same for `watchdog`, `improvement`, `backup`, `memory_flush`, `cost_report`, `update_review`, and `no_agent`. (The `no_agent` branch from Phase 1 already had a `runId` — replace its local with the outer `runId`.)

At the end of `runCronJobNow` (line 289-292), update the final return:

```typescript
    return {
      jobId: normalizedJobId,
      runId,
      status: "ok",
    };
```

- [ ] **Step 4: Add `findCronRunById`**

Add a new public method on `CronAutomationService`:

```typescript
  public findCronRunById(runId: string): {
    runId: string;
    jobId: string;
    status: "ok";
    finishedAt?: string;
    output?: string;
  } | undefined {
    const normalized = runId.trim();
    if (!normalized) {
      return undefined;
    }
    const match = this.deps.storage.cronJobs.list().find((job) => job.lastRunId === normalized);
    if (!match) {
      return undefined;
    }
    return {
      runId: normalized,
      jobId: match.jobId,
      status: "ok",
      finishedAt: match.lastRunAt,
      output: match.lastRunOutput,
    };
  }
```

- [ ] **Step 5: Forward through scheduler + route**

Update `cron-scheduler-service.ts` `runCronJobNow` return type to `Promise<{ jobId: string; runId: string; status: "ok" }>`. Add `findCronRunById(host, runId)`.

Update `cron-route-service.ts` to expose `findCronRunById` in `cronRouteMethods`.

- [ ] **Step 6: Run test**

Run: `pnpm --filter @goatcitadel/gateway test -- cron-automation-service.test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src/services/gateway/cron-automation-service.ts apps/gateway/src/services/gateway/cron-automation-service.test.ts apps/gateway/src/services/cron-scheduler-service.ts apps/gateway/src/services/cron-route-service.ts
git commit -m "feat(gateway): return runId from cron runs and expose findCronRunById"
```

### Task 3.2: New `cron-cli.ts` entrypoint with `--wait`

**Files:**
- Create: `apps/gateway/src/cron-cli.ts`
- Create: `apps/gateway/src/cron-cli.test.ts`

- [ ] **Step 1: Write the failing CLI test**

Create `apps/gateway/src/cron-cli.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { runCronCli, type CronCliPort } from "./cron-cli.js";

function makePort(overrides: Partial<CronCliPort> = {}): CronCliPort {
  return {
    runCronJobNow: vi.fn().mockResolvedValue({ jobId: "j", runId: "r1", status: "ok" }),
    findCronRunById: vi.fn().mockReturnValue({ runId: "r1", jobId: "j", status: "ok", output: "alert" }),
    ...overrides,
  };
}

describe("runCronCli", () => {
  it("invokes runCronJobNow and prints the result for `cron run <jobId>`", async () => {
    const port = makePort();
    const writes: string[] = [];
    await runCronCli(["run", "j"], { port, write: (line) => writes.push(line) });
    expect(port.runCronJobNow).toHaveBeenCalledWith("j");
    expect(writes.join("\n")).toContain('"runId": "r1"');
  });

  it("blocks via findCronRunById when --wait is set, polling until a result resolves", async () => {
    let calls = 0;
    const port = makePort({
      runCronJobNow: vi.fn().mockResolvedValue({ jobId: "j", runId: "r1", status: "ok" }),
      findCronRunById: vi.fn().mockImplementation(() => {
        calls += 1;
        return calls >= 2 ? { runId: "r1", jobId: "j", status: "ok", output: "alert" } : undefined;
      }),
    });
    const writes: string[] = [];
    await runCronCli(["run", "j", "--wait", "--timeout", "5000", "--poll-interval", "1"], {
      port,
      write: (line) => writes.push(line),
    });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(writes.join("\n")).toContain('"output": "alert"');
  });

  it("exits with timeout error when --wait elapses without a result", async () => {
    const port = makePort({
      runCronJobNow: vi.fn().mockResolvedValue({ jobId: "j", runId: "r1", status: "ok" }),
      findCronRunById: vi.fn().mockReturnValue(undefined),
    });
    const writes: string[] = [];
    await expect(
      runCronCli(["run", "j", "--wait", "--timeout", "20", "--poll-interval", "1"], {
        port,
        write: (line) => writes.push(line),
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it("prints `cron runs --run-id` lookup result", async () => {
    const port = makePort();
    const writes: string[] = [];
    await runCronCli(["runs", "--run-id", "r1"], { port, write: (line) => writes.push(line) });
    expect(port.findCronRunById).toHaveBeenCalledWith("r1");
    expect(writes.join("\n")).toContain('"output": "alert"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/gateway test -- cron-cli.test`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `cron-cli.ts`**

Create `apps/gateway/src/cron-cli.ts`:

```typescript
/* eslint-disable no-console -- CLI entrypoint intentionally writes structured output to stdout. */
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import type { BundledPostgresRuntimeHandle } from "./bundled-postgres-runtime.js";
import { ensureBundledPostgresRuntime } from "./bundled-postgres-runtime.js";
import { repoHasConfigMarker } from "./config-files.js";
import { loadLocalEnvFile } from "./env-file.js";
import { loadGatewayConfig } from "./config.js";
import { createGatewayAdminRuntime } from "./services/gateway-runtime-factory.js";

export interface CronCliPort {
  runCronJobNow(jobId: string): Promise<{ jobId: string; runId: string; status: "ok" }>;
  findCronRunById(runId: string): { runId: string; jobId: string; status: "ok"; finishedAt?: string; output?: string } | undefined;
}

export interface CronCliIo {
  port: CronCliPort;
  write: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  return args[index + 1];
}

export async function runCronCli(args: string[], io: CronCliIo): Promise<void> {
  const [command, ...rest] = args;
  if (command === "run") {
    await runRunCommand(rest, io);
    return;
  }
  if (command === "runs") {
    await runRunsCommand(rest, io);
    return;
  }
  throw new Error(`Unknown cron command: ${command ?? "(empty)"}`);
}

async function runRunCommand(args: string[], io: CronCliIo): Promise<void> {
  const jobId = args.find((token, index) => index === 0 && !token.startsWith("--"));
  if (!jobId) {
    throw new Error("cron run requires <jobId>");
  }
  const wait = args.includes("--wait");
  const timeoutMsRaw = readFlag(args, "--timeout");
  const pollMsRaw = readFlag(args, "--poll-interval");
  const timeoutMs = timeoutMsRaw ? Number.parseInt(timeoutMsRaw, 10) : 60_000;
  const pollMs = pollMsRaw ? Number.parseInt(pollMsRaw, 10) : 250;
  const sleep = io.sleep ?? defaultSleep;
  const now = io.now ?? Date.now;

  const queued = await io.port.runCronJobNow(jobId);
  if (!wait) {
    io.write(JSON.stringify(queued, null, 2));
    return;
  }

  const startedAt = now();
  while (true) {
    const found = io.port.findCronRunById(queued.runId);
    if (found) {
      io.write(JSON.stringify(found, null, 2));
      return;
    }
    if (now() - startedAt >= timeoutMs) {
      throw new Error(`cron run --wait timed out after ${timeoutMs}ms (runId=${queued.runId})`);
    }
    await sleep(pollMs);
  }
}

async function runRunsCommand(args: string[], io: CronCliIo): Promise<void> {
  const runId = readFlag(args, "--run-id");
  if (!runId) {
    throw new Error("cron runs requires --run-id <id>");
  }
  const result = io.port.findCronRunById(runId);
  if (!result) {
    throw new Error(`No cron run found for runId=${runId}`);
  }
  io.write(JSON.stringify(result, null, 2));
}

function resolveRootDir(): string {
  const envRoot = process.env.GOATCITADEL_ROOT_DIR?.trim();
  if (envRoot) {
    return path.resolve(envRoot);
  }
  const candidates = [process.cwd(), path.resolve(process.cwd(), ".."), path.resolve(process.cwd(), "../..")];
  for (const candidate of candidates) {
    if (repoHasConfigMarker(candidate)) {
      return candidate;
    }
  }
  return path.resolve(process.cwd(), "../..");
}

export async function main(): Promise<void> {
  loadLocalEnvFile();
  const args = process.argv.slice(2);
  if (args[0] !== "cron") {
    console.log("Usage: goatcitadel cron run <jobId> [--wait] [--timeout <ms>] [--poll-interval <ms>]");
    console.log("       goatcitadel cron runs --run-id <id>");
    process.exitCode = 1;
    return;
  }
  const config = await loadGatewayConfig(resolveRootDir());
  let bundledPostgres: BundledPostgresRuntimeHandle | undefined;
  if (config.assistant.database.driver === "postgres") {
    bundledPostgres = await ensureBundledPostgresRuntime(config);
  }
  const gateway = createGatewayAdminRuntime(config);
  await gateway.init();
  try {
    const port: CronCliPort = {
      runCronJobNow: (jobId) => gateway.runCronJobNow(jobId),
      findCronRunById: (runId) => gateway.findCronRunById(runId),
    };
    await runCronCli(args.slice(1), {
      port,
      write: (line) => console.log(line),
    });
  } finally {
    await gateway.close();
    await bundledPostgres?.stop();
  }
}

const invokedAsScript = typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  main().catch((error) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: Expose `runCronJobNow` + `findCronRunById` on the admin runtime port**

In `apps/gateway/src/services/gateway-runtime-factory.ts` (the `GatewayAdminPort`) add the two methods so the CLI can call them. Wire them to the cron automation service.

- [ ] **Step 5: Run test**

Run: `pnpm --filter @goatcitadel/gateway test -- cron-cli.test`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/cron-cli.ts apps/gateway/src/cron-cli.test.ts apps/gateway/src/services/gateway-runtime-factory.ts
git commit -m "feat(gateway): goatcitadel cron run --wait + cron runs --run-id CLI"
```

### Task 3.3: Register `cron` CLI as a binary

**Files:**
- Modify: `apps/gateway/package.json`

- [ ] **Step 1: Add CLI entry**

In `apps/gateway/package.json`, locate the existing `bin` block (it already has `goat`/admin). Add `goatcitadel-cron` (or use an existing convention found there):

```json
{
  "bin": {
    "goatcitadel-admin": "dist/admin-cli.js",
    "goatcitadel-cron": "dist/cron-cli.js"
  }
}
```

If the existing `bin` style differs, match it. Otherwise leave the CLI invokable via `node apps/gateway/dist/cron-cli.js`.

- [ ] **Step 2: Commit**

```bash
git add apps/gateway/package.json
git commit -m "chore(gateway): register goatcitadel-cron CLI binary"
```

---

## Phase 4: O3 — Subagent child-spawn timeout + depth ceiling

Goal: make `child_timeout_seconds` (default 600) an enforced budget; add `max_depth` (default 4); expose both as `agents.defaults.subagents.{childTimeoutSeconds, maxDepth}`.

### Task 4.1: Diagnostic codes + metadata depth field

**Files:**
- Modify: `packages/contracts/src/agentic-runtime.ts:35-52,237-252`
- Test: `packages/contracts/src/agentic-runtime.test.ts` (new or extend existing)

- [ ] **Step 1: Write the failing test**

Create or extend `packages/contracts/src/agentic-runtime.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { AgenticDiagnosticCode, AgenticSubagentMetadata } from "./agentic-runtime.js";

describe("AgenticDiagnosticCode", () => {
  it("includes max_depth_exceeded and timeout_exceeded", () => {
    const codes: AgenticDiagnosticCode[] = ["max_depth_exceeded", "timeout_exceeded"];
    expect(codes).toHaveLength(2);
  });
});

describe("AgenticSubagentMetadata", () => {
  it("accepts a depth integer", () => {
    const md: AgenticSubagentMetadata = { depth: 2 };
    expect(md.depth).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/contracts test -- agentic-runtime.test`
Expected: FAIL — codes/property unknown.

- [ ] **Step 3: Update `AgenticDiagnosticCode`**

Replace `AgenticDiagnosticCode` (lines 35-52) of `packages/contracts/src/agentic-runtime.ts`:

```typescript
export type AgenticDiagnosticCode =
  | "repeated_tool_result"
  | "post_compaction_loop"
  | "missing_assistant_output"
  | "stale_approval"
  | "child_timeout"
  | "timeout_exceeded"
  | "max_depth_exceeded"
  | "spawn_failure"
  | "worker_crash"
  | "stale_worker"
  | "invalid_assignee_profile"
  | "unsafe_status_transition"
  | "provider_fallback_loop"
  | "dirty_worktree_without_artifact"
  | "missing_claimed_artifact"
  | "missing_claimed_file"
  | "missing_claimed_test"
  | "repeated_phase_failure"
  | "final_delivery_retry";
```

- [ ] **Step 4: Add `depth` to `AgenticSubagentMetadata`**

Update lines 237-252:

```typescript
export interface AgenticSubagentMetadata {
  runId?: string;
  parentRunId?: string;
  profileId?: string;
  contextMode?: AgenticContextMode;
  index?: number;
  depth?: number;
  dependsOnStepIds?: string[];
  heartbeatAt?: string;
  timeoutAt?: string;
  failureClass?: AgenticFailureClass;
  diagnostics?: AgenticDiagnosticSignal[];
  costUsd?: number;
  tokenTotal?: number;
  filesTouched?: string[];
  handoffEvidence?: AgenticHandoffEvidence;
}
```

- [ ] **Step 5: Update failure-class mapper**

In `apps/gateway/src/services/task-lifecycle-service.ts` `mapDiagnosticToFailureClass` (lines 915-940), add cases:

```typescript
    case "child_timeout":
    case "timeout_exceeded":
      return "timeout";
    case "max_depth_exceeded":
      return "spawn_failure";
```

- [ ] **Step 6: Run test**

Run: `pnpm --filter @goatcitadel/contracts test -- agentic-runtime.test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/agentic-runtime.ts packages/contracts/src/agentic-runtime.test.ts apps/gateway/src/services/task-lifecycle-service.ts
git commit -m "feat(contracts): add subagent depth + timeout/max_depth diagnostic codes"
```

### Task 4.2: Zod schema for `agents.defaults.subagents`

**Files:**
- Modify: `packages/contracts/src/config-schemas.ts`
- Test: `packages/contracts/src/config-schemas.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `config-schemas.test.ts`:

```typescript
import { AgentSubagentDefaultsSchema } from "./config-schemas.js";

describe("AgentSubagentDefaultsSchema", () => {
  it("defaults childTimeoutSeconds to 600 and maxDepth to 4", () => {
    const parsed = AgentSubagentDefaultsSchema.parse({});
    expect(parsed.childTimeoutSeconds).toBe(600);
    expect(parsed.maxDepth).toBe(4);
  });

  it("accepts overrides", () => {
    const parsed = AgentSubagentDefaultsSchema.parse({ childTimeoutSeconds: 900, maxDepth: 3 });
    expect(parsed.childTimeoutSeconds).toBe(900);
    expect(parsed.maxDepth).toBe(3);
  });

  it("rejects non-positive values", () => {
    expect(() => AgentSubagentDefaultsSchema.parse({ childTimeoutSeconds: 0 })).toThrow();
    expect(() => AgentSubagentDefaultsSchema.parse({ maxDepth: 0 })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/contracts test -- config-schemas.test`
Expected: FAIL — schema missing.

- [ ] **Step 3: Add the schema**

Append to `packages/contracts/src/config-schemas.ts` (after the CronJobsConfigSchema block):

```typescript
// ---------------------------------------------------------------------------
// Agent Subagent Defaults
// ---------------------------------------------------------------------------

export const AgentSubagentDefaultsSchema = z
  .object({
    childTimeoutSeconds: z.number().int().positive().default(600),
    maxDepth: z.number().int().positive().default(4),
  })
  .passthrough();

export type AgentSubagentDefaultsInput = z.input<typeof AgentSubagentDefaultsSchema>;
export type AgentSubagentDefaults = z.output<typeof AgentSubagentDefaultsSchema>;
```

- [ ] **Step 4: Run test**

Run: `pnpm --filter @goatcitadel/contracts test -- config-schemas.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/config-schemas.ts packages/contracts/src/config-schemas.test.ts
git commit -m "feat(contracts): add agents.defaults.subagents schema (childTimeoutSeconds, maxDepth)"
```

### Task 4.3: Pure budget enforcer module

**Files:**
- Create: `apps/gateway/src/services/subagent-budget-enforcer.ts`
- Test: `apps/gateway/src/services/subagent-budget-enforcer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/gateway/src/services/subagent-budget-enforcer.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  computeChildDepth,
  enforceMaxDepth,
  runWithChildTimeout,
} from "./subagent-budget-enforcer.js";

describe("computeChildDepth", () => {
  it("returns 1 when no parent depth is provided", () => {
    expect(computeChildDepth(undefined)).toBe(1);
  });
  it("returns parentDepth + 1", () => {
    expect(computeChildDepth(3)).toBe(4);
  });
});

describe("enforceMaxDepth", () => {
  it("returns nothing when depth is within budget", () => {
    expect(() => enforceMaxDepth({ depth: 2, maxDepth: 4 })).not.toThrow();
  });
  it("throws max_depth_exceeded when depth equals or exceeds maxDepth", () => {
    expect(() => enforceMaxDepth({ depth: 4, maxDepth: 4 })).toThrowError(/max_depth_exceeded/);
    expect(() => enforceMaxDepth({ depth: 5, maxDepth: 4 })).toThrowError(/max_depth_exceeded/);
  });
});

describe("runWithChildTimeout", () => {
  it("returns the operation result when it resolves before the timeout", async () => {
    const result = await runWithChildTimeout({
      timeoutSeconds: 1,
      run: async () => "ok",
    });
    expect(result).toBe("ok");
  });
  it("rejects with timeout_exceeded when the operation runs past the timeout", async () => {
    await expect(
      runWithChildTimeout({
        timeoutSeconds: 0.05,
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return "late";
        },
      }),
    ).rejects.toThrowError(/timeout_exceeded/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/gateway test -- subagent-budget-enforcer.test`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the module**

Create `apps/gateway/src/services/subagent-budget-enforcer.ts`:

```typescript
export interface ChildDepthInput {
  depth: number;
  maxDepth: number;
}

export class SubagentBudgetError extends Error {
  public constructor(
    public readonly code: "max_depth_exceeded" | "timeout_exceeded",
    message: string,
  ) {
    super(message);
    this.name = "SubagentBudgetError";
  }
}

export function computeChildDepth(parentDepth: number | undefined): number {
  const base = typeof parentDepth === "number" && Number.isFinite(parentDepth) ? Math.max(0, Math.floor(parentDepth)) : 0;
  return base + 1;
}

export function enforceMaxDepth(input: ChildDepthInput): void {
  if (!Number.isFinite(input.maxDepth) || input.maxDepth < 1) {
    return;
  }
  if (input.depth >= input.maxDepth) {
    throw new SubagentBudgetError(
      "max_depth_exceeded",
      `max_depth_exceeded: depth=${input.depth} exceeds maxDepth=${input.maxDepth}`,
    );
  }
}

export interface ChildTimeoutInput<T> {
  timeoutSeconds: number;
  run: (signal: AbortSignal) => Promise<T>;
}

export async function runWithChildTimeout<T>(input: ChildTimeoutInput<T>): Promise<T> {
  if (!Number.isFinite(input.timeoutSeconds) || input.timeoutSeconds <= 0) {
    return input.run(new AbortController().signal);
  }
  const controller = new AbortController();
  const timeoutMs = Math.max(1, Math.round(input.timeoutSeconds * 1000));
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(
        new SubagentBudgetError(
          "timeout_exceeded",
          `timeout_exceeded: child run exceeded ${input.timeoutSeconds}s budget`,
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([input.run(controller.signal), timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
```

- [ ] **Step 4: Run test**

Run: `pnpm --filter @goatcitadel/gateway test -- subagent-budget-enforcer.test`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/subagent-budget-enforcer.ts apps/gateway/src/services/subagent-budget-enforcer.test.ts
git commit -m "feat(gateway): pure subagent budget enforcer (timeout + depth)"
```

### Task 4.4: Plumb budget enforcement into `chat-delegation-service`

**Files:**
- Modify: `apps/gateway/src/services/chat-delegation-service.ts`
- Test: `apps/gateway/src/services/chat-delegation-service.test.ts` (existing — extend)

- [ ] **Step 1: Write the failing test**

Add to `apps/gateway/src/services/chat-delegation-service.test.ts`:

```typescript
describe("subagent budget enforcement", () => {
  it("rejects a child spawn with max_depth_exceeded when depth equals maxDepth", async () => {
    const service = makeDelegationService({ subagentDefaults: { childTimeoutSeconds: 600, maxDepth: 2 } });
    await expect(
      service.executeDelegateRequest({
        sessionId: "session-with-depth-2-parent",
        objective: "test",
        // parent metadata indicates depth=2 already; new child would be depth 3 ≥ maxDepth 2
        parentSubagentDepth: 2,
      }),
    ).rejects.toThrow(/max_depth_exceeded/);
  });

  it("kills a child that runs past childTimeoutSeconds and surfaces timeout_exceeded to parent", async () => {
    const service = makeDelegationService({
      subagentDefaults: { childTimeoutSeconds: 0.05, maxDepth: 4 },
      slowChild: true,
    });
    await expect(
      service.executeDelegateRequest({
        sessionId: "session-slow",
        objective: "test",
      }),
    ).rejects.toThrow(/timeout_exceeded/);
  });
});
```

(Provide a small `makeDelegationService` helper that stubs the storage and the LLM call. For the slow child test, the stub `agentSendChatMessage` resolves after 500ms; the budget at 50ms should kill it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/gateway test -- chat-delegation-service.test`
Expected: FAIL — no budget enforcement.

- [ ] **Step 3: Update `chat-delegation-service.ts`**

Near the top of the file, add:

```typescript
import {
  computeChildDepth,
  enforceMaxDepth,
  runWithChildTimeout,
  SubagentBudgetError,
} from "./subagent-budget-enforcer.js";
```

Extend the service constructor host with the new defaults source (or read from request). Modify `executeDelegationStep` to:

(a) Compute `depth = computeChildDepth(parentSubagentDepth)` at the start.
(b) Call `enforceMaxDepth({ depth, maxDepth })` before any work.
(c) Wrap the `deps.agentSendChatMessage(...)` call in `runWithChildTimeout({ timeoutSeconds, run: async (signal) => deps.agentSendChatMessage(childSession.sessionId, { ...request, abortSignal: signal }) })`.
(d) Propagate `depth` into `childMetadataBase`.
(e) On `SubagentBudgetError`, mark the step `failed`, mark the parent run `failed`, and attach an `AgenticDiagnosticSignal` with code `timeout_exceeded` or `max_depth_exceeded`.

Concrete shape near line 297-320 of the file:

```typescript
      const depth = computeChildDepth(parentSubagentDepth);
      enforceMaxDepth({ depth, maxDepth });
      const childMetadataBase: AgenticSubagentMetadata = {
        runId: childRunId,
        parentRunId: runId,
        profileId: step.role,
        contextMode: "isolated",
        index: step.index,
        depth,
        dependsOnStepIds: step.dependsOnStepIds,
        heartbeatAt: startedAt,
      };
      // ...registerTaskSubagent unchanged...

      try {
        const response = await runWithChildTimeout({
          timeoutSeconds,
          run: async (signal) =>
            deps.agentSendChatMessage(
              childSession.sessionId,
              buildDelegatedChatSendRequest({
                /* existing request fields */
                abortSignal: signal,
              }),
            ),
        });
        // ...rest of branch unchanged...
      } catch (error) {
        if (error instanceof SubagentBudgetError) {
          // mark step failed + record diagnostic
          const finishedAt = new Date().toISOString();
          deps.storage.chatDelegationSteps.patch(step.stepId, {
            status: "failed",
            finishedAt,
            summary: error.code === "timeout_exceeded" ? "Child timed out." : "Maximum delegation depth exceeded.",
          });
          throw error;
        }
        throw error;
      }
```

Task 4.5 below plumbs `AbortSignal` end-to-end so the child LLM call actually aborts when the budget elapses (in-scope per user direction).

`maxDepth` and `timeoutSeconds` should be sourced from:

```typescript
const subagentDefaults = host.subagentDefaults ?? { childTimeoutSeconds: 600, maxDepth: 4 };
const maxDepth = subagentDefaults.maxDepth;
const timeoutSeconds = subagentDefaults.childTimeoutSeconds;
```

Add `subagentDefaults` to `ChatDelegationServiceHost` interface.

- [ ] **Step 4: Run test**

Run: `pnpm --filter @goatcitadel/gateway test -- chat-delegation-service.test`
Expected: PASS.

- [ ] **Step 5: Wire `subagentDefaults` from config**

In the file that constructs `ChatDelegationService` (search for `new ChatDelegationService` or where the host is built), pass through `config.agents?.defaults?.subagents` parsed by `AgentSubagentDefaultsSchema`. If the path is unset, the default `{ childTimeoutSeconds: 600, maxDepth: 4 }` kicks in.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/services/chat-delegation-service.ts apps/gateway/src/services/chat-delegation-service.test.ts
git commit -m "feat(gateway): enforce subagent childTimeoutSeconds + maxDepth budgets"
```

### Task 4.5: Plumb AbortSignal through `agentSendChatMessage`

Goal: when the budget enforcer aborts, the in-flight child LLM call is actually torn down (not just race-lost).

**Files to discover first (search before editing):**
- `deps.agentSendChatMessage` definition — find with `grep -rn "agentSendChatMessage" apps/gateway/src/ --include="*.ts" -l`
- `buildDelegatedChatSendRequest` — at `apps/gateway/src/services/delegated-chat-request.ts`
- The LLM service entrypoint behind `agentSendChatMessage` — likely under `apps/gateway/src/services/llm-service.ts` or `chat-turn-stream-service.ts`

- [ ] **Step 1: Add `abortSignal` to `ChatSendMessageRequest` (or matching internal request type)**

Find the type used by `agentSendChatMessage`. If it's `ChatSendMessageRequest` in `packages/contracts/src/chat.ts`, that's a public contract — instead add `abortSignal` to an internal envelope. Most likely the gateway has a local `AgentSendInput` or extends the contract. Pattern:

```typescript
// internal to gateway, not in @goatcitadel/contracts public surface
export interface AgentSendChatMessageOptions {
  abortSignal?: AbortSignal;
}
```

Update `agentSendChatMessage(sessionId: string, request: ChatSendMessageRequest, options?: AgentSendChatMessageOptions): Promise<ChatSendMessageResponse>`.

- [ ] **Step 2: Write the failing test**

In `apps/gateway/src/services/chat-delegation-service.test.ts`, add:

```typescript
it("forwards AbortSignal into agentSendChatMessage when budget timer fires", async () => {
  let observedSignal: AbortSignal | undefined;
  const llmStarted = new Promise<void>((resolve) => {
    // resolves when the LLM stub sees the signal
    setTimeout(resolve, 5);
  });
  const service = makeDelegationService({
    subagentDefaults: { childTimeoutSeconds: 0.02, maxDepth: 4 },
    agentSendChatMessage: async (_sessionId, _request, options) => {
      observedSignal = options?.abortSignal;
      await llmStarted;
      // wait long enough to be aborted
      await new Promise((resolve, reject) => {
        const onAbort = (): void => reject(new Error("aborted"));
        if (options?.abortSignal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        options?.abortSignal?.addEventListener("abort", onAbort);
        setTimeout(() => resolve(undefined), 500);
      });
      return { assistantMessage: { content: "late" }, trace: { status: "completed" } } as never;
    },
  });
  await expect(
    service.executeDelegateRequest({ sessionId: "s", objective: "test" }),
  ).rejects.toThrow(/timeout_exceeded/);
  expect(observedSignal).toBeInstanceOf(AbortSignal);
  expect(observedSignal?.aborted).toBe(true);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @goatcitadel/gateway test -- chat-delegation-service.test`
Expected: FAIL — signal not forwarded or not actually firing.

- [ ] **Step 4: Update `chat-delegation-service.ts`**

Change the call site inside `runWithChildTimeout`:

```typescript
const response = await runWithChildTimeout({
  timeoutSeconds,
  run: async (signal) =>
    deps.agentSendChatMessage(
      childSession.sessionId,
      buildDelegatedChatSendRequest({ /* existing fields */ }),
      { abortSignal: signal },
    ),
});
```

- [ ] **Step 5: Plumb signal into the LLM transport**

Find the transport layer (provider HTTP call) — typically a `fetch` call in `apps/gateway/src/services/llm-service.ts` or per-provider files under `apps/gateway/src/services/llm-providers/*`. Pass `signal: abortSignal` through to `fetch(..., { signal })`. For SDK-based providers (Anthropic/OpenAI), pass `signal` via their request options.

This step touches several files. For each provider call, audit + add `signal` forwarding under the same commit. Use the `AgentSendChatMessageOptions` to thread it from `agentSendChatMessage` → provider client.

- [ ] **Step 6: Run test**

Run: `pnpm --filter @goatcitadel/gateway test -- chat-delegation-service.test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src/services/chat-delegation-service.ts apps/gateway/src/services/chat-delegation-service.test.ts apps/gateway/src/services/llm-service.ts apps/gateway/src/services/llm-providers/
git commit -m "feat(gateway): plumb AbortSignal through agentSendChatMessage into provider calls"
```

---

## Phase 5: Cross-cutting verification

### Task 5.1: Full test suite + typecheck

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: all green. If failures, fix under the same branch.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: zero errors.

- [ ] **Step 3: Run lint**

Run: `pnpm lint`
Expected: zero violations.

### Task 5.2: Manual verification scripts

Document a short manual verification script in `docs/cron-no-agent-subagent-controls-verify.md`:

```markdown
# Manual verification

## no_agent — empty stdout = silent

1. `goatcitadel-cron run probe-empty` (job runs `echo ""`)
2. Inspect realtime log: no `cron_no_agent_output` event.
3. `goatcitadel-cron runs --run-id <id>` → `output` is undefined.

## no_agent — non-empty stdout = verbatim

1. `goatcitadel-cron run probe-alert` (job runs `echo alert`)
2. Realtime event payload contains `"output": "alert"`.

## context_from — A reads B's last output

1. Create job B (`no_agent`, `echo X`). Run it.
2. Create job A (`task`, `contextFrom: B`). Run it.
3. Verify the task handler receives `{ contextFrom: "B", contextOutput: "X" }`.

## workdir

1. Create `no_agent` job with `workdir: /tmp/test`. Script: `pwd`.
2. Realtime payload has output equal to `/tmp/test`.

## cron run --wait

1. `goatcitadel-cron run my-job --wait --timeout 60000`
2. CLI blocks, returns final JSON, exits 0.

## Subagent budgets

1. Force a child run that exceeds 600s → parent run fails with diagnostic code `timeout_exceeded`.
2. Force a 5-deep delegation chain (parent depth 4 → spawn) → spawn rejected with `max_depth_exceeded`.
```

- [ ] **Step 1: Add doc**

Save the above as `docs/cron-no-agent-subagent-controls-verify.md`.

- [ ] **Step 2: Commit**

```bash
git add docs/cron-no-agent-subagent-controls-verify.md
git commit -m "docs: manual verification script for cron + subagent control knobs"
```

### Task 5.3: Open the PR

- [ ] **Step 1: Push**

Run: `git push -u origin feature/cron-no-agent-subagent-controls`

- [ ] **Step 2: Open PR (only when user requests)**

Use `gh pr create` with a body summarizing O3/O4/O5/O6 and the verification doc.

---

## Self-review

**Spec coverage:**

| Spec item | Implemented in | Verified by |
|-----------|----------------|-------------|
| O4: no_agent kind, empty=silent, non-empty=verbatim | Phase 1 Tasks 1.1–1.5 | Phase 1 tests + `cron-no-agent-runner.test.ts` + manual probe-empty/probe-alert |
| O5: context_from chaining | Phase 2 Task 2.2 | `contextFrom resolution` tests |
| O5: per-job workdir | Phase 1 Task 1.3, Phase 2 Tasks 2.1/2.3 | `forwards workdir into no_agent runner` test |
| O6: `cron run --wait` with timeout/poll | Phase 3 Tasks 3.1–3.2 | `cron-cli.test.ts` (4 cases) |
| O6: `cron runs --run-id` | Phase 3 Tasks 3.1–3.2 | `findCronRunById` tests + CLI test |
| O3: childTimeoutSeconds budget (default 600) | Phase 4 Tasks 4.2–4.4 | `chat-delegation-service.test.ts` slow-child case |
| O3: maxDepth ceiling (default 4) | Phase 4 Tasks 4.2–4.4 | `chat-delegation-service.test.ts` max-depth case |
| O3: `agents.defaults.subagents.{childTimeoutSeconds, maxDepth}` | Phase 4 Tasks 4.2–4.4 | `AgentSubagentDefaultsSchema` tests |

**Placeholder scan:** none — every step includes the full code or commands.

**Type consistency:**
- `CronJobAction` enum extended in both contracts and Zod schema.
- `lastRunId`, `lastRunOutput`, `workdir`, `contextFrom` consistently named across record, repo, SQL.
- `findCronRunById` shape `{ runId, jobId, status, finishedAt?, output? }` used identically in service, route, CLI port, and CLI test.
- `SubagentBudgetError.code` values match the new `AgenticDiagnosticCode` entries.

---

## Execution

**Plan complete and saved to `docs/superpowers/plans/2026-05-15-cron-no-agent-subagent-controls.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

**Which approach?**
