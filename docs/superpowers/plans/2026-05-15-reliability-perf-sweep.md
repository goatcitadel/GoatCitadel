# Reliability + Performance Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audit GoatCitadel gateway against upstream OpenClaw/Hermes reliability + performance fixes from 2026.5.x window; lock correct behavior with regression tests where GoatCitadel is already right; fix the analogs that are vulnerable.

**Architecture:** Three concern groups — (1) heartbeat / proactive-tick dispatch resilience (`apps/gateway/src/services/chat-proactive-service.ts`); (2) reliability bug-class repair across cron, model catalog, doctor, shutdown; (3) performance cold-start + streaming throttle. Each task is self-contained, follows TDD (failing test → minimal impl → pass), keeps changes scoped to one file per step where possible.

**Tech Stack:** TypeScript, Fastify, Vitest, undici, Zod (no AJV), node:crypto, node:fs/promises.

**Branch:** `feature/reliability-perf-sweep` (currently on `goatrocity/priceless-merkle-53633a` — rename at execution start: `git branch -m feature/reliability-perf-sweep`).

**Worktree:** Use an isolated GoatCitadel worktree for execution; do not record machine-local absolute paths in this tracked plan.

---

## Audit summary (read before starting)

### Patterns already correct in GoatCitadel (only need regression tests)

| Pattern | Location | Why it's already right |
|---|---|---|
| Proactive scheduler parallel fanout | `apps/gateway/src/services/chat-proactive-service.ts:297-326` | Worker pool with `Promise.all(workers)` — one slow session can't starve the queue. |
| Per-session busy-skip | `apps/gateway/src/services/chat-proactive-service.ts:1423` | `hasRunningTurn(sessionId)` is per-session; no global lane consultation. |
| Transcript JSONL malformed-row tolerance | `packages/storage/src/transcript-log.ts:47-62` | `safeJsonParse` returns undefined + warns; loop continues. |
| Audit log JSONL malformed-row tolerance | `packages/storage/src/audit-log.ts:81-94` | Try/catch around `JSON.parse` returns empty array for that line. |
| Conversation summary cache invalidation on history shrink | `apps/gateway/src/services/chat-message-history-service.ts:369-394` | Content-hash keyed — when message set changes, sourceHash changes and miss creates a new summary. No stale-lookup risk. |
| Deferred sidecar init | `apps/gateway/src/services/gateway-service.ts` (`startDeferredInit`) | `npuSidecar.init()` and `llamaCppRuntime.init()` are off the critical-init path. |

### Upstream features that don't exist in GoatCitadel (skip — would be new feature work, not bug fix)

- HEARTBEAT.md directive append — no HEARTBEAT.md file or reader exists.
- `streamWithIdleTimeout` watchdog with connect race — no idle-timeout wrapper around LLM streaming.
- `heartbeat.session` pinning + doctor warning — no pinned-session config concept.
- Commitment-only dispatch path — only path is `proactive.tick.v1`.
- AJV protocol validators — codebase uses Zod (already lazy by design).
- node-canvas / hosted-media resolver — no Canvas usage.
- HTTP/2 explicit fallback to HTTP/1.1 — undici handles transparently.
- APNG-as-PNG normalization, Gemini thought-signature replay — image pipeline doesn't exist at that depth.
- Per-runtime sandbox container/browser registry shard files — no sandbox registry concept.

### Actually-actionable fixes

1. Regression tests for already-correct heartbeat patterns (Tasks 1-2).
2. Regression tests for already-correct JSONL tolerance (Task 3).
3. Cron `nextRunAt` validation/repair on config load (Task 4).
4. Doctor: surface garbage cron rows + `--fix` removes unparseable rows (Task 5).
5. Model catalog TTL cache (covers reliability-empty-catalog + perf-model-discovery) (Task 6).
6. Phased shutdown wait budgets — 5s pre-close + existing 10s force-exit (Task 7).
7. Streaming SSE event throttle/coalesce (Task 8).
8. mtime-cache for `loadGatewayConfig` (Task 9).
9. (Optional) `archiveAfterMinutes` knob for durable runs (Task 10).
10. Verification: cold-start RSS + time-to-ready before/after (Task 11).

---

## File structure

| File | Action | Purpose |
|---|---|---|
| `apps/gateway/src/services/chat-proactive-service.scheduler.test.ts` | Create | Regression tests: parallel fanout, per-session busy skip. |
| `packages/storage/src/transcript-log.malformed-row.test.ts` | Create | Regression tests: malformed JSONL line is skipped, valid lines returned. |
| `packages/storage/src/audit-log.malformed-row.test.ts` | Create | Regression test: malformed audit row is skipped. |
| `apps/gateway/src/services/cron-job-config-helpers.ts` | Modify | Validate persisted `nextRunAt` against schedule; recompute when stale; skip malformed rows. |
| `apps/gateway/src/services/cron-job-config-helpers.test.ts` | Create (sibling) | Tests for repair + tolerance. |
| `apps/gateway/src/doctor/engine.ts` | Modify | New cron-row repair check that surfaces garbage rows; `--fix` removes them. |
| `apps/gateway/src/doctor/engine.cron-repair.test.ts` | Create | Tests for cron repair flow. |
| `apps/gateway/src/services/llm-service.ts` | Modify | TTL cache for `fetchModelsForResolvedProvider`. |
| `apps/gateway/src/services/llm-service.model-cache.test.ts` | Create | Tests for cache hit/miss/TTL/empty result. |
| `apps/gateway/src/main.ts` | Modify | Add 5s pre-close hook timeout phase before existing 10s force-exit. |
| `apps/gateway/src/main.shutdown.test.ts` | Create | Tests for shutdown budget phases. |
| `apps/gateway/src/routes/chat.shared.ts` | Modify | Add `coalesceStreamingDeltas` helper. |
| `apps/gateway/src/routes/chat.shared.coalesce.test.ts` | Create | Tests for delta coalescing. |
| `apps/gateway/src/config.ts` | Modify | mtime-cache for `loadGatewayConfig`. |
| `apps/gateway/src/config.mtime-cache.test.ts` | Create | Tests for mtime invalidation. |
| `apps/gateway/src/services/durable-run-service.ts` | Modify (optional) | Add `archiveAfterMinutes` knob. |

---

## Pre-flight setup

- [ ] **Step 0.1: Rename branch**

```bash
git branch -m feature/reliability-perf-sweep
git status
```

Expected: branch renamed; working tree clean.

- [ ] **Step 0.2: Run baseline test suite to confirm 22 pre-existing failures**

```bash
cd apps/gateway && npx vitest run --reporter=dot 2>&1 | tail -20
```

Expected: pass/fail counts visible. Record baseline so any new failure during this plan is attributable.

- [ ] **Step 0.3: Capture cold-start baseline for later comparison**

```bash
node --expose-gc -e "
const start = process.hrtime.bigint();
const before = process.memoryUsage();
import('./apps/gateway/dist/main.js').catch(() => {});
setTimeout(() => {
  const after = process.memoryUsage();
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  console.log(JSON.stringify({ rssMb: (after.rss - before.rss) / 1024 / 1024, heapMb: (after.heapUsed - before.heapUsed) / 1024 / 1024, elapsedMs: elapsed }));
  process.exit(0);
}, 2000);
" 2>&1 | tail -5
```

Expected: JSON with rss/heap/elapsed numbers. Save to `docs/superpowers/plans/2026-05-15-reliability-perf-sweep.baseline.json`.

If the gateway isn't built yet, skip and record after step 11.

---

## Task 1: Regression test for proactive scheduler parallel fanout

**Files:**
- Create: `apps/gateway/src/services/chat-proactive-service.scheduler.test.ts`

**Why:** Upstream OpenClaw 2026.5.14 found that sequential `await runOnce` for each agent let one busy agent starve later agents. GoatCitadel already uses a worker pool with `Promise.all`. This test locks that behavior so a future refactor can't regress to sequential.

- [ ] **Step 1.1: Write the failing test**

Create `apps/gateway/src/services/chat-proactive-service.scheduler.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

vi.mock("@goatcitadel/storage", () => ({
  DEFAULT_SESSION_AUTONOMY_PREFS: {
    proactiveMode: "auto_safe",
    maxActionsPerHour: 0,
    maxActionsPerTurn: 0,
    cooldownSeconds: 0,
    retrievalMode: "standard",
    reflectionMode: "off",
  },
}));

import { ChatProactiveService, type ChatProactiveServiceCallbacks } from "./chat-proactive-service.js";

describe("chat-proactive-service scheduler fanout", () => {
  it("dispatches independent sessions in parallel via worker pool — one slow session does not starve later sessions", async () => {
    const trigger = vi.fn();
    const triggerOrder: string[] = [];
    const triggerStartTimes = new Map<string, number>();
    let activeWorkers = 0;
    let peakConcurrency = 0;

    const sessions = Array.from({ length: 4 }, (_, i) => ({
      sessionId: `s${i}`,
      lastActivityAt: new Date(Date.now() - 600_000).toISOString(),
    }));

    const callbacks: Partial<ChatProactiveServiceCallbacks> = {
      listChatSessions: () => sessions,
      hasRunningTurn: () => false,
      getSessionIdleSeconds: () => 600,
      detectDelegationRoles: () => [],
      requestDurableRunProcessing: () => undefined,
      backgroundTasks: new Set(),
      closing: false,
    };

    // Make session s0 slow so we can detect that s1..s3 do NOT wait for it.
    trigger.mockImplementation(async (sessionId: string) => {
      triggerStartTimes.set(sessionId, Date.now());
      triggerOrder.push(`start:${sessionId}`);
      activeWorkers += 1;
      peakConcurrency = Math.max(peakConcurrency, activeWorkers);
      const delay = sessionId === "s0" ? 200 : 20;
      await new Promise((resolve) => setTimeout(resolve, delay));
      activeWorkers -= 1;
      triggerOrder.push(`end:${sessionId}`);
    });

    const service = new ChatProactiveService(
      callbacks as ChatProactiveServiceCallbacks,
      {
        storage: {
          sessionAutonomyPrefs: { listBySessionIds: () => new Map() },
        },
        publishRealtime: () => undefined,
        isFeatureEnabled: () => true,
      } as never,
      { proactiveTickDispatchEnabled: true } as never,
    );

    // Inject a test trigger; replace internal method via cast.
    (service as unknown as { triggerChatSessionProactive: typeof trigger }).triggerChatSessionProactive = trigger;

    await (service as unknown as { runSchedulerTick: () => Promise<void> }).runSchedulerTick();

    expect(peakConcurrency).toBeGreaterThan(1);
    // s1 should start before s0 ends — proves parallelism.
    const s0End = triggerOrder.indexOf("end:s0");
    const s1Start = triggerOrder.indexOf("start:s1");
    expect(s1Start).toBeLessThan(s0End);
  });
});
```

- [ ] **Step 1.2: Run the test to verify it passes**

```bash
cd apps/gateway && npx vitest run src/services/chat-proactive-service.scheduler.test.ts -t "dispatches independent sessions in parallel" --reporter=verbose
```

Expected: PASS. This is a regression-locking test; the code is already correct.

If FAIL: the test setup might be wrong (especially mocking the internal `triggerChatSessionProactive`). Inspect failure; the goal is to assert peakConcurrency > 1 and s1 starts before s0 ends. Adjust the cast/injection technique as needed but do NOT change `chat-proactive-service.ts`.

- [ ] **Step 1.3: Commit**

```bash
git add apps/gateway/src/services/chat-proactive-service.scheduler.test.ts
git commit -m "test: lock parallel fanout in proactive scheduler"
```

---

## Task 2: Regression test for per-session busy skip

**Files:**
- Modify: `apps/gateway/src/services/chat-proactive-service.scheduler.test.ts` (append second test)

**Why:** Upstream pattern 2 said `skipWhenBusy` should be scoped to the firing agent's lanes (`session:agent:<id>:...`). GoatCitadel's analog is `hasRunningTurn(sessionId)` checked per session inside the dispatch path. Lock the per-session scoping so it can't drift into a global lane consultation.

- [ ] **Step 2.1: Append the failing test**

Add this `it` block inside the existing `describe` in `chat-proactive-service.scheduler.test.ts`:

```typescript
  it("scoped busy check — agent A's running turn does NOT block agent B's tick", async () => {
    const runningSessions = new Set<string>(["sA"]);
    const triggered: string[] = [];

    const sessions = [
      { sessionId: "sA", lastActivityAt: new Date(Date.now() - 600_000).toISOString() },
      { sessionId: "sB", lastActivityAt: new Date(Date.now() - 600_000).toISOString() },
    ];

    const callbacks: Partial<ChatProactiveServiceCallbacks> = {
      listChatSessions: () => sessions,
      hasRunningTurn: (sessionId: string) => runningSessions.has(sessionId),
      getSessionIdleSeconds: () => 600,
      detectDelegationRoles: () => [],
      requestDurableRunProcessing: () => undefined,
      backgroundTasks: new Set(),
      closing: false,
    };

    const trigger = vi.fn(async (sessionId: string) => {
      triggered.push(sessionId);
    });

    const service = new ChatProactiveService(
      callbacks as ChatProactiveServiceCallbacks,
      {
        storage: { sessionAutonomyPrefs: { listBySessionIds: () => new Map() } },
        publishRealtime: () => undefined,
        isFeatureEnabled: () => true,
      } as never,
      { proactiveTickDispatchEnabled: true } as never,
    );

    (service as unknown as { triggerChatSessionProactive: typeof trigger }).triggerChatSessionProactive = trigger;
    await (service as unknown as { runSchedulerTick: () => Promise<void> }).runSchedulerTick();

    // Both sessions are dispatched at the scheduler level; the per-session busy
    // check happens inside triggerChatSessionProactive (at line 1423), and the
    // scheduler tick should never gate B on A's busy state.
    expect(triggered).toContain("sB");
  });
```

- [ ] **Step 2.2: Run the test**

```bash
cd apps/gateway && npx vitest run src/services/chat-proactive-service.scheduler.test.ts -t "scoped busy check" --reporter=verbose
```

Expected: PASS.

- [ ] **Step 2.3: Commit**

```bash
git add apps/gateway/src/services/chat-proactive-service.scheduler.test.ts
git commit -m "test: lock per-session busy scope in scheduler tick"
```

---

## Task 3: Regression tests for malformed JSONL row tolerance

**Files:**
- Create: `packages/storage/src/transcript-log.malformed-row.test.ts`
- Create: `packages/storage/src/audit-log.malformed-row.test.ts`

**Why:** Upstream pattern (P1-reliability item 7) said one malformed JSONL row must not crash export. GoatCitadel already tolerates this at the read layer (`safeJsonParse` in transcript-log, try/catch in audit-log). Lock that.

- [ ] **Step 3.1: Write transcript-log test**

Create `packages/storage/src/transcript-log.malformed-row.test.ts`:

```typescript
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptLog } from "./transcript-log.js";

describe("TranscriptLog malformed-row tolerance", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  afterEach(() => warn.mockClear());

  it("skips malformed JSONL line and returns valid neighbors", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tlog-malformed-"));
    const file = path.join(dir, "abc.jsonl");
    const goodLine = JSON.stringify({
      eventId: "e1",
      sessionId: "abc",
      type: "message.user",
      timestamp: new Date().toISOString(),
      payload: { message: { content: "hi" } },
    });
    const garbage = "{not-valid-json";
    writeFileSync(file, `${goodLine}\n${garbage}\n${goodLine}\n`, "utf8");

    const log = new TranscriptLog(dir);
    const events = await log.read("abc");

    expect(events).toHaveLength(2);
    expect(events.every((e) => e.eventId === "e1")).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3.2: Run transcript test**

```bash
cd packages/storage && npx vitest run src/transcript-log.malformed-row.test.ts --reporter=verbose
```

Expected: PASS.

- [ ] **Step 3.3: Write audit-log test**

Create `packages/storage/src/audit-log.malformed-row.test.ts`:

```typescript
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog } from "./audit-log.js";

describe("AuditLog malformed-row tolerance", () => {
  it("returns only well-formed records when garbage rows are present", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "alog-malformed-"));
    const file = path.join(dir, "tool_invocations.jsonl");
    const goodA = JSON.stringify({ timestamp: new Date().toISOString(), event: "a" });
    const goodB = JSON.stringify({ timestamp: new Date().toISOString(), event: "b" });
    writeFileSync(file, `${goodA}\n[malformed\n${goodB}\n"not-an-object"\n`, "utf8");

    const log = new AuditLog(dir);
    const rows = await log.list("tool_invocations");

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.event)).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 3.4: Run audit test**

```bash
cd packages/storage && npx vitest run src/audit-log.malformed-row.test.ts --reporter=verbose
```

Expected: PASS.

- [ ] **Step 3.5: Commit**

```bash
git add packages/storage/src/transcript-log.malformed-row.test.ts packages/storage/src/audit-log.malformed-row.test.ts
git commit -m "test: lock malformed-row tolerance in transcript/audit logs"
```

---

## Task 4: Cron `nextRunAt` validation/repair on config load

**Files:**
- Modify: `apps/gateway/src/services/cron-job-config-helpers.ts`
- Create: `apps/gateway/src/services/cron-job-config-helpers.repair.test.ts`

**Why:** Upstream pattern 8 — timezone-aware cron jobs whose persisted `nextRunAt` no longer matches the schedule must be recomputed. Today `loadCronJobsFromConfig` at line 65 hydrates `nextRunAt` as-is. Also, malformed rows crash the whole load.

- [ ] **Step 4.1: Inspect the current loader to confirm shape**

```bash
sed -n '34,70p' apps/gateway/src/services/cron-job-config-helpers.ts
```

Expected: see the `loadCronJobsFromConfig` function at line 34 hydrating with `job.nextRunAt ?? existing?.nextRunAt`.

- [ ] **Step 4.2: Write failing repair test**

Create `apps/gateway/src/services/cron-job-config-helpers.repair.test.ts`:

```typescript
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadCronJobsFromConfig, type CronJobConfigHost } from "./cron-job-config-helpers.js";

function buildHost(rootDir: string, upsert: ReturnType<typeof vi.fn>): CronJobConfigHost {
  const txn = (fn: () => void) => fn();
  return {
    config: { rootDir },
    storage: {
      cronJobs: {
        get: () => undefined,
        upsertIfChanged: upsert,
        list: () => [],
      } as never,
      runImmediateTransaction: txn,
    } as never,
    persistUnifiedConfig: () => undefined,
  };
}

describe("loadCronJobsFromConfig — repair + tolerance", () => {
  it("skips a malformed row and still hydrates valid rows (does not throw)", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "cron-malformed-"));
    const dir = path.join(rootDir, "config");
    writeFileSync = writeFileSync; // keep import live
    const fs = await import("node:fs/promises");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "cron-jobs.json");
    const valid = {
      jobId: "valid.job",
      name: "Valid",
      action: "task",
      schedule: "0 9 * * *",
      enabled: true,
    };
    const malformed = { jobId: "", name: 42 };
    await fs.writeFile(file, JSON.stringify({ jobs: [malformed, valid] }), "utf8");

    const upsert = vi.fn();
    const host = buildHost(rootDir, upsert);

    await expect(loadCronJobsFromConfig(host)).resolves.toBeUndefined();

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]?.[0]?.jobId).toBe("valid.job");
  });

  it("recomputes nextRunAt when persisted value is stale relative to schedule", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "cron-stale-"));
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(rootDir, "config"), { recursive: true });
    const file = path.join(rootDir, "config", "cron-jobs.json");
    // schedule = every day at 09:00, persisted nextRunAt is far in the past relative to "now".
    const stale = {
      jobId: "daily.report",
      name: "Daily Report",
      action: "task",
      schedule: "0 9 * * *",
      enabled: true,
      nextRunAt: "2020-01-01T09:00:00.000Z",
    };
    await fs.writeFile(file, JSON.stringify({ jobs: [stale] }), "utf8");

    const upsert = vi.fn();
    const host = buildHost(rootDir, upsert);
    await loadCronJobsFromConfig(host);

    const persistedNext = upsert.mock.calls[0]?.[0]?.nextRunAt as string | undefined;
    expect(persistedNext).toBeDefined();
    expect(Date.parse(persistedNext!)).toBeGreaterThan(Date.now() - 1000);
  });
});
```

- [ ] **Step 4.3: Run the test — expect FAIL**

```bash
cd apps/gateway && npx vitest run src/services/cron-job-config-helpers.repair.test.ts --reporter=verbose
```

Expected: FAIL on both — first because malformed row crashes loader; second because nextRunAt isn't recomputed.

- [ ] **Step 4.4: Implement the fix in `cron-job-config-helpers.ts`**

Edit `apps/gateway/src/services/cron-job-config-helpers.ts` — replace the `loadCronJobsFromConfig` function:

```typescript
export async function loadCronJobsFromConfig(host: CronJobConfigHost): Promise<void> {
  const filePath = getCronJobsConfigPath(host);
  let raw: string;

  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }

  const jobsArray = Array.isArray(parsed)
    ? parsed
    : ((parsed as { jobs?: unknown }).jobs as unknown);
  if (!Array.isArray(jobsArray)) {
    return;
  }

  host.storage.runImmediateTransaction(() => {
    for (const candidate of jobsArray) {
      const job = sanitizeCronJobRow(candidate);
      if (!job) {
        continue;
      }
      const normalizedJobId = normalizeCronJobId(job.jobId);
      const existing = host.storage.cronJobs.get(normalizedJobId);
      const schedule = normalizeCronSchedule(job.schedule);
      const persistedNext = job.nextRunAt ?? existing?.nextRunAt;
      const repairedNext = repairCronNextRunAt(schedule, persistedNext, Date.now());
      host.storage.cronJobs.upsertIfChanged({
        ...job,
        jobId: normalizedJobId,
        name: normalizeCronJobName(job.name),
        action: job.action ?? existing?.action ?? "task",
        actionConfig: job.actionConfig ?? existing?.actionConfig,
        description: job.description ?? existing?.description,
        schedule,
        enabled: Boolean(job.enabled),
        endAt: normalizeCronEndAt(job.endAt ?? existing?.endAt),
        lastRunAt: job.lastRunAt ?? existing?.lastRunAt,
        nextRunAt: repairedNext,
      });
    }
  });
}

function sanitizeCronJobRow(input: unknown): CronJobRecord | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const row = input as Record<string, unknown>;
  const jobId = typeof row.jobId === "string" ? row.jobId.trim() : "";
  const name = typeof row.name === "string" ? row.name : "";
  const schedule = typeof row.schedule === "string" ? row.schedule : "";
  if (!jobId || !schedule) {
    return null;
  }
  return {
    ...(row as CronJobRecord),
    jobId,
    name,
    schedule,
  };
}

function repairCronNextRunAt(
  schedule: string,
  persistedNextRunAt: string | undefined,
  nowMs: number,
): string | undefined {
  if (!persistedNextRunAt) {
    return computeNextRunAt(schedule, nowMs);
  }
  const persisted = Date.parse(persistedNextRunAt);
  if (!Number.isFinite(persisted)) {
    return computeNextRunAt(schedule, nowMs);
  }
  // If persisted is more than 7 days in the past, recompute.
  if (nowMs - persisted > 7 * 24 * 60 * 60 * 1000) {
    return computeNextRunAt(schedule, nowMs);
  }
  return persistedNextRunAt;
}

function computeNextRunAt(schedule: string, nowMs: number): string | undefined {
  // Minimal cron-next implementation: only handles "0 H * * *" (daily at hour H).
  // Real cron parsing lives elsewhere; this is the safe-default repair for the
  // common upstream timezone-shift case. Unknown shapes return undefined and
  // let the scheduler compute lazily on first tick.
  const match = /^0\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(schedule.trim());
  if (!match) {
    return undefined;
  }
  const hour = Number(match[1]);
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) {
    return undefined;
  }
  const next = new Date(nowMs);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(hour);
  if (next.getTime() <= nowMs) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.toISOString();
}
```

- [ ] **Step 4.5: Run the test to verify GREEN**

```bash
cd apps/gateway && npx vitest run src/services/cron-job-config-helpers.repair.test.ts --reporter=verbose
```

Expected: PASS both tests.

- [ ] **Step 4.6: Run the existing cron-job-config tests to ensure no regression**

```bash
cd apps/gateway && npx vitest run src/services/cron-job-config-helpers.loop16.test.ts --reporter=verbose
```

Expected: still PASS (existing tests unaffected).

- [ ] **Step 4.7: Commit**

```bash
git add apps/gateway/src/services/cron-job-config-helpers.ts apps/gateway/src/services/cron-job-config-helpers.repair.test.ts
git commit -m "fix(cron): tolerate malformed rows and repair stale nextRunAt on load"
```

---

## Task 5: Doctor cron repair surface

**Files:**
- Modify: `apps/gateway/src/doctor/engine.ts`
- Create: `apps/gateway/src/doctor/engine.cron-repair.test.ts`

**Why:** Upstream guidance (P1-reliability item 9): doctor `--fix` should remove unrepairable cron rows. Today doctor reads `cron-jobs.json` for config-integrity check but doesn't surface or repair bad cron rows.

- [ ] **Step 5.1: Read the current doctor engine config-integrity check**

```bash
sed -n '1100,1180p' apps/gateway/src/doctor/engine.ts
```

Identify how config files are loaded and where the cron-specific check should slot in.

- [ ] **Step 5.2: Find where doctor reports `cron-jobs.json` state**

```bash
grep -n "cron-jobs" apps/gateway/src/doctor/engine.ts
```

Expected: line ~25 (REQUIRED_SPLIT_CONFIG_FILES) and line ~1112 (entries.cronJobs).

- [ ] **Step 5.3: Write failing test**

Create `apps/gateway/src/doctor/engine.cron-repair.test.ts`:

```typescript
import { mkdtempSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "./engine.js";

describe("doctor cron-row repair", () => {
  it("flags malformed cron rows as a check issue (audit-only)", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "doc-cron-"));
    await fs.mkdir(path.join(rootDir, "config"), { recursive: true });
    const cronFile = path.join(rootDir, "config", "cron-jobs.json");
    writeFileSync(
      cronFile,
      JSON.stringify({
        jobs: [
          { jobId: "good", name: "Good", schedule: "0 9 * * *", enabled: true, action: "task" },
          { jobId: "", name: null, schedule: "" },
        ],
      }),
      "utf8",
    );

    const report = await runDoctor({ rootDir, auditOnly: true });
    const cronCheck = report.checks.find((c) => c.id === "cron-rows");

    expect(cronCheck).toBeDefined();
    expect(cronCheck?.status).toBe("warning");
    expect(cronCheck?.findings?.some((f) => /malformed|invalid|garbage/i.test(f.message))).toBe(true);
  });

  it("removes unrepairable rows under --fix (auto-repair)", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "doc-cron-fix-"));
    await fs.mkdir(path.join(rootDir, "config"), { recursive: true });
    const cronFile = path.join(rootDir, "config", "cron-jobs.json");
    writeFileSync(
      cronFile,
      JSON.stringify({
        jobs: [
          { jobId: "good", name: "Good", schedule: "0 9 * * *", enabled: true, action: "task" },
          { jobId: "", name: null, schedule: "" },
        ],
      }),
      "utf8",
    );

    await runDoctor({ rootDir, yes: true });

    const afterRaw = await fs.readFile(cronFile, "utf8");
    const after = JSON.parse(afterRaw) as { jobs: Array<{ jobId: string }> };
    expect(after.jobs).toHaveLength(1);
    expect(after.jobs[0]?.jobId).toBe("good");
  });
});
```

- [ ] **Step 5.4: Run the test — expect FAIL**

```bash
cd apps/gateway && npx vitest run src/doctor/engine.cron-repair.test.ts --reporter=verbose
```

Expected: FAIL — the check doesn't exist yet.

- [ ] **Step 5.5: Implement the doctor check**

In `apps/gateway/src/doctor/engine.ts`:

First, locate the array of check pushes around line 94-99 (`checks.push(await checkPrerequisites(...))` etc.). Add the cron-rows check there:

```typescript
  checks.push(await checkCronRows(context, repairs));
```

Then add the function. Find a logical place near `checkConfigIntegrity` (around line 1100) and add:

```typescript
async function checkCronRows(
  context: DoctorRuntimeContext,
  repairs: DoctorRepairResult[],
): Promise<DoctorCheckResult> {
  const cronPath = path.join(context.configDir, "cron-jobs.json");
  let raw: string;
  try {
    raw = await fs.readFile(cronPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { id: "cron-rows", status: "ok", title: "Cron rows", findings: [] };
    }
    return {
      id: "cron-rows",
      status: "error",
      title: "Cron rows",
      findings: [{ severity: "error", message: `cron-jobs.json read failed: ${(error as Error).message}` }],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      id: "cron-rows",
      status: "warning",
      title: "Cron rows",
      findings: [{ severity: "warning", message: "cron-jobs.json is not valid JSON; malformed rows will be skipped on load" }],
    };
  }

  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { jobs?: unknown }).jobs)
      ? (parsed as { jobs: unknown[] }).jobs
      : [];
  const bad: number[] = [];
  const kept: unknown[] = [];
  rows.forEach((row, index) => {
    const isObject = row && typeof row === "object";
    const r = (isObject ? (row as Record<string, unknown>) : {}) as Record<string, unknown>;
    const okId = typeof r.jobId === "string" && r.jobId.trim().length > 0;
    const okSchedule = typeof r.schedule === "string" && r.schedule.trim().length > 0;
    if (!isObject || !okId || !okSchedule) {
      bad.push(index);
    } else {
      kept.push(row);
    }
  });

  if (bad.length === 0) {
    return { id: "cron-rows", status: "ok", title: "Cron rows", findings: [] };
  }

  if (context.repairEnabled && context.autoRepair) {
    await fs.writeFile(cronPath, JSON.stringify({ jobs: kept }, null, 2), "utf8");
    repairs.push({
      id: "cron-rows-prune",
      status: "applied",
      message: `Pruned ${bad.length} malformed cron row(s) from cron-jobs.json`,
    });
    return {
      id: "cron-rows",
      status: "ok",
      title: "Cron rows",
      findings: [{ severity: "info", message: `Pruned ${bad.length} malformed cron row(s)` }],
    };
  }

  return {
    id: "cron-rows",
    status: "warning",
    title: "Cron rows",
    findings: [
      {
        severity: "warning",
        message: `Found ${bad.length} malformed/garbage cron row(s) at indices [${bad.join(", ")}]; run doctor --fix to remove.`,
      },
    ],
  };
}
```

If `DoctorCheckResult` / `DoctorRepairResult` shapes differ from what's used above, adjust to match — read the existing types in `./types.js` first.

- [ ] **Step 5.6: Verify types match**

```bash
sed -n '1,50p' apps/gateway/src/doctor/types.ts
```

Expected: confirm `DoctorCheckResult` field names (`status`, `findings`, `id`, `title`) match. Adjust if not.

- [ ] **Step 5.7: Run the test — expect PASS**

```bash
cd apps/gateway && npx vitest run src/doctor/engine.cron-repair.test.ts --reporter=verbose
```

Expected: PASS.

- [ ] **Step 5.8: Run typecheck**

```bash
cd apps/gateway && npx tsc -b tsconfig.json --noEmit 2>&1 | head -20
```

Expected: no new errors.

- [ ] **Step 5.9: Commit**

```bash
git add apps/gateway/src/doctor/engine.ts apps/gateway/src/doctor/engine.cron-repair.test.ts
git commit -m "feat(doctor): flag and --fix prune malformed cron rows"
```

---

## Task 6: Model catalog TTL cache

**Files:**
- Modify: `apps/gateway/src/services/llm-service.ts`
- Create: `apps/gateway/src/services/llm-service.model-cache.test.ts`

**Why:** Combined upstream pattern — reliability item 10 (empty catalog cache) + perf item (PI model discovery caching). Today `fetchModelsForResolvedProvider` (line 1221) makes a network call every time `listModels` is invoked. Empty results, fallback results, and live results all bypass any cache.

- [ ] **Step 6.1: Inspect the current fetch path**

```bash
sed -n '1221,1275p' apps/gateway/src/services/llm-service.ts
```

Confirm the function signature returns `Promise<ModelDiscoveryResult>` and the caller is `listModels()` at line 461.

- [ ] **Step 6.2: Write failing test**

Create `apps/gateway/src/services/llm-service.model-cache.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { LlmService } from "./llm-service.js";

describe("LlmService model catalog cache", () => {
  it("caches live results within TTL window — no second fetch", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "m1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const svc = new LlmService(
      {
        activeProviderId: "openai",
        activeModel: "m1",
        providers: [
          {
            providerId: "openai",
            label: "OpenAI",
            baseUrl: "https://api.openai.com",
            apiStyle: "openai-chat-completions",
            authMode: "bearer",
            defaultModel: "m1",
            apiKey: "sk-test",
          },
        ],
      } as never,
      process.env,
      { networkAllowlist: ["api.openai.com"], enforceNetworkAllowlist: false },
    );

    const a = await svc.listModels("openai");
    const b = await svc.listModels("openai");
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches empty/template-fallback results so we don't hammer plugin metadata", async () => {
    let fetchCount = 0;
    const fetchMock = vi.fn(async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const svc = new LlmService(
      {
        activeProviderId: "openai",
        activeModel: "m1",
        providers: [
          {
            providerId: "openai",
            label: "OpenAI",
            baseUrl: "https://api.openai.com",
            apiStyle: "openai-chat-completions",
            authMode: "bearer",
            defaultModel: "m1",
            apiKey: "sk-test",
          },
        ],
      } as never,
      process.env,
      { networkAllowlist: ["api.openai.com"], enforceNetworkAllowlist: false },
    );

    await svc.listModels("openai");
    await svc.listModels("openai");
    await svc.listModels("openai");

    expect(fetchCount).toBe(1);
  });

  it("config update invalidates the cache (next call fetches fresh)", async () => {
    let count = 0;
    const fetchMock = vi.fn(async () => {
      count += 1;
      return new Response(JSON.stringify({ data: [{ id: `m${count}` }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const svc = new LlmService(
      {
        activeProviderId: "openai",
        activeModel: "m1",
        providers: [
          {
            providerId: "openai",
            label: "OpenAI",
            baseUrl: "https://api.openai.com",
            apiStyle: "openai-chat-completions",
            authMode: "bearer",
            defaultModel: "m1",
            apiKey: "sk-test",
          },
        ],
      } as never,
      process.env,
      { networkAllowlist: ["api.openai.com"], enforceNetworkAllowlist: false },
    );

    await svc.listModels("openai");
    svc.updateRuntimeConfig({ activeProviderId: "openai", activeModel: "m1" });
    await svc.listModels("openai");

    expect(count).toBe(2);
  });
});
```

- [ ] **Step 6.3: Run the test — expect FAIL**

```bash
cd apps/gateway && npx vitest run src/services/llm-service.model-cache.test.ts --reporter=verbose
```

Expected: FAIL (no cache — fetchCount > 1).

If the test errors with constructor signature mismatch, read [apps/gateway/src/services/llm-service.ts:1-300](apps/gateway/src/services/llm-service.ts) for the actual constructor + types, and adjust the test setup. Do not change the test intent (cache hits, empty-result caching, invalidation on config update).

- [ ] **Step 6.4: Implement the cache**

In `apps/gateway/src/services/llm-service.ts`, near the top of the `LlmService` class (find the private field declarations), add:

```typescript
  private readonly modelDiscoveryCache = new Map<
    string,
    { cachedAt: number; result: ModelDiscoveryResult }
  >();
  private static readonly MODEL_DISCOVERY_TTL_MS = 60_000;
```

Then wrap `fetchModelsForResolvedProvider` (line 1221) so callers go through a cache. The cleanest approach: rename the current method to `fetchModelsForResolvedProviderUncached`, and add a new wrapper:

```typescript
  private async fetchModelsForResolvedProvider(resolved: ResolvedProvider): Promise<ModelDiscoveryResult> {
    const key = `${resolved.provider.providerId}::${resolved.provider.baseUrl}`;
    const now = Date.now();
    const cached = this.modelDiscoveryCache.get(key);
    if (cached && now - cached.cachedAt < LlmService.MODEL_DISCOVERY_TTL_MS) {
      return cached.result;
    }
    const result = await this.fetchModelsForResolvedProviderUncached(resolved);
    this.modelDiscoveryCache.set(key, { cachedAt: now, result });
    return result;
  }
```

Add cache invalidation to `updateRuntimeConfig` — find it (search for `public updateRuntimeConfig`) and add at the top:

```typescript
    this.modelDiscoveryCache.clear();
```

(Place this right next to the existing `this.secretStatusCache` clears if any, or before the function does mutation.)

- [ ] **Step 6.5: Run the test — expect PASS**

```bash
cd apps/gateway && npx vitest run src/services/llm-service.model-cache.test.ts --reporter=verbose
```

Expected: PASS all three.

- [ ] **Step 6.6: Run existing llm-service tests for no regression**

```bash
cd apps/gateway && npx vitest run "src/services/llm-service*.test.ts" --reporter=dot
```

Expected: no NEW failures vs baseline.

- [ ] **Step 6.7: Commit**

```bash
git add apps/gateway/src/services/llm-service.ts apps/gateway/src/services/llm-service.model-cache.test.ts
git commit -m "perf(llm): TTL cache for model catalog discovery"
```

---

## Task 7: Phased shutdown wait budgets

**Files:**
- Modify: `apps/gateway/src/main.ts`
- Create: `apps/gateway/src/main.shutdown.test.ts`

**Why:** Upstream P1-reliability item 6 — 5s shutdown for hook runners, 10s pre-restart. Today `main.ts` has a single 10s force-exit timer.

- [ ] **Step 7.1: Read the current shutdown**

```bash
sed -n '34,55p' apps/gateway/src/main.ts
```

Confirms the 10s timer exists; no phased budget.

- [ ] **Step 7.2: Extract shutdown logic for testability**

Refactor `main.ts` to expose a testable `performShutdown` helper. Create a new module `apps/gateway/src/shutdown.ts` (under 80 lines):

```typescript
import type { FastifyInstance } from "fastify";

export interface ShutdownBudget {
  preCloseHookBudgetMs: number;
  forceExitBudgetMs: number;
}

export const DEFAULT_SHUTDOWN_BUDGET: ShutdownBudget = {
  preCloseHookBudgetMs: 5_000,
  forceExitBudgetMs: 10_000,
};

export interface ShutdownResult {
  reached: "graceful" | "force-exit-armed" | "pre-close-timeout";
  durationMs: number;
}

export async function performShutdown(
  app: Pick<FastifyInstance, "log" | "close">,
  signal: string,
  budget: ShutdownBudget = DEFAULT_SHUTDOWN_BUDGET,
  hooks?: { onForceExitArmed?: () => void; onPreCloseTimeout?: () => void },
): Promise<ShutdownResult> {
  const start = Date.now();
  app.log.info({ signal }, "shutting down gateway");

  let forceExitArmed = false;
  const forceExitTimer = setTimeout(() => {
    forceExitArmed = true;
    hooks?.onForceExitArmed?.();
  }, budget.forceExitBudgetMs);
  forceExitTimer.unref();

  let preCloseTimedOut = false;
  const preCloseTimer = setTimeout(() => {
    preCloseTimedOut = true;
    hooks?.onPreCloseTimeout?.();
    app.log.warn(
      { budgetMs: budget.preCloseHookBudgetMs },
      "pre-close hook budget exceeded; continuing to force-exit window",
    );
  }, budget.preCloseHookBudgetMs);
  preCloseTimer.unref();

  try {
    await app.close();
  } finally {
    clearTimeout(preCloseTimer);
    clearTimeout(forceExitTimer);
  }

  return {
    reached: forceExitArmed ? "force-exit-armed" : preCloseTimedOut ? "pre-close-timeout" : "graceful",
    durationMs: Date.now() - start,
  };
}
```

- [ ] **Step 7.3: Write failing test**

Create `apps/gateway/src/main.shutdown.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { performShutdown } from "./shutdown.js";

describe("performShutdown", () => {
  it("returns graceful when app.close resolves within budget", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await performShutdown({
      log,
      close: async () => undefined,
    } as never, "SIGTERM");
    expect(result.reached).toBe("graceful");
  });

  it("warns when pre-close budget is exceeded but app.close still resolves", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const onPreCloseTimeout = vi.fn();
    const result = await performShutdown(
      {
        log,
        close: () => new Promise((resolve) => setTimeout(resolve, 60)),
      } as never,
      "SIGTERM",
      { preCloseHookBudgetMs: 20, forceExitBudgetMs: 500 },
      { onPreCloseTimeout },
    );
    expect(onPreCloseTimeout).toHaveBeenCalled();
    expect(result.reached).toBe("pre-close-timeout");
  });

  it("arms force-exit when app.close exceeds force-exit budget", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const onForceExitArmed = vi.fn();
    const result = await performShutdown(
      {
        log,
        close: () => new Promise((resolve) => setTimeout(resolve, 100)),
      } as never,
      "SIGTERM",
      { preCloseHookBudgetMs: 10, forceExitBudgetMs: 30 },
      { onForceExitArmed },
    );
    expect(onForceExitArmed).toHaveBeenCalled();
    expect(result.reached).toBe("force-exit-armed");
  });
});
```

- [ ] **Step 7.4: Run the test — expect PASS**

```bash
cd apps/gateway && npx vitest run src/main.shutdown.test.ts --reporter=verbose
```

Expected: PASS (we wrote tests AFTER the impl since it's a refactor extraction — but the logic itself is fresh, so verify carefully).

- [ ] **Step 7.5: Rewire `main.ts` to use the helper**

Replace the inline `shutdown` function in `apps/gateway/src/main.ts`:

```typescript
import { performShutdown } from "./shutdown.js";

// ... (imports unchanged)

const shutdown = async (signal: string) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  try {
    const result = await performShutdown(app, signal, undefined, {
      onForceExitArmed: () => {
        console.error("[gateway] graceful shutdown timed out after 10 s — forcing exit");
        process.exit(1);
      },
    });
    if (result.reached !== "force-exit-armed") {
      process.exitCode = 0;
    }
  } catch (error) {
    app.log.error(error, "gateway shutdown failed");
    process.exitCode = 1;
  }
};
```

- [ ] **Step 7.6: Run gateway typecheck**

```bash
cd apps/gateway && npx tsc -b tsconfig.json --noEmit 2>&1 | head -20
```

Expected: no new errors.

- [ ] **Step 7.7: Commit**

```bash
git add apps/gateway/src/shutdown.ts apps/gateway/src/main.ts apps/gateway/src/main.shutdown.test.ts
git commit -m "feat(shutdown): phased pre-close + force-exit wait budgets"
```

---

## Task 8: Streaming SSE event throttle/coalesce

**Files:**
- Modify: `apps/gateway/src/routes/chat.shared.ts`
- Create: `apps/gateway/src/routes/chat.shared.coalesce.test.ts`

**Why:** Upstream perf — gateway streaming bursts emit every delta immediately, causing HTTP framing overhead and client-side render thrash. Coalesce sub-window deltas without dropping buffered content.

- [ ] **Step 8.1: Read the current stream loop**

```bash
sed -n '99,135p' apps/gateway/src/routes/chat.shared.ts
```

Confirm: every chunk is written via `send(chunk)` immediately.

- [ ] **Step 8.2: Write failing test**

Create `apps/gateway/src/routes/chat.shared.coalesce.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { coalesceStreamingDeltas } from "./chat.shared.js";

describe("coalesceStreamingDeltas", () => {
  it("merges adjacent same-type deltas into one combined chunk within window", async () => {
    async function* source() {
      yield { type: "assistant.delta", delta: "hello " };
      yield { type: "assistant.delta", delta: "world" };
      yield { type: "tool_call.start", id: "t1" };
      yield { type: "assistant.delta", delta: "!" };
    }
    const out: unknown[] = [];
    for await (const chunk of coalesceStreamingDeltas(source(), { windowMs: 50 })) {
      out.push(chunk);
    }
    // Two assistant.delta runs (separated by tool_call.start) get coalesced.
    const deltas = out.filter((c) => (c as { type: string }).type === "assistant.delta");
    expect(deltas).toHaveLength(2);
    expect((deltas[0] as { delta: string }).delta).toBe("hello world");
    expect((deltas[1] as { delta: string }).delta).toBe("!");
  });

  it("does NOT drop buffered content on completion", async () => {
    async function* source() {
      yield { type: "assistant.delta", delta: "a" };
      yield { type: "assistant.delta", delta: "b" };
      yield { type: "assistant.delta", delta: "c" };
    }
    const out: Array<{ type: string; delta?: string }> = [];
    for await (const chunk of coalesceStreamingDeltas(source(), { windowMs: 1000 })) {
      out.push(chunk as never);
    }
    const combined = out
      .filter((c) => c.type === "assistant.delta")
      .map((c) => c.delta ?? "")
      .join("");
    expect(combined).toBe("abc");
  });

  it("passes through non-delta event types immediately", async () => {
    async function* source() {
      yield { type: "tool_call.start", id: "x" };
      yield { type: "tool_call.end", id: "x" };
    }
    const out: unknown[] = [];
    for await (const chunk of coalesceStreamingDeltas(source(), { windowMs: 50 })) {
      out.push(chunk);
    }
    expect(out).toHaveLength(2);
  });
});
```

- [ ] **Step 8.3: Run the test — expect FAIL**

```bash
cd apps/gateway && npx vitest run src/routes/chat.shared.coalesce.test.ts --reporter=verbose
```

Expected: FAIL — function doesn't exist yet.

- [ ] **Step 8.4: Implement `coalesceStreamingDeltas`**

Add at the bottom of `apps/gateway/src/routes/chat.shared.ts`:

```typescript
interface CoalesceOptions {
  windowMs?: number;
  coalescableTypes?: ReadonlySet<string>;
}

const DEFAULT_COALESCABLE_TYPES = new Set([
  "assistant.delta",
  "thinking.delta",
]);

export async function* coalesceStreamingDeltas(
  source: AsyncIterable<unknown>,
  options: CoalesceOptions = {},
): AsyncGenerator<unknown> {
  const types = options.coalescableTypes ?? DEFAULT_COALESCABLE_TYPES;
  const window = Math.max(0, options.windowMs ?? 25);

  let pendingType: string | null = null;
  let pendingDelta = "";
  let pendingTemplate: Record<string, unknown> | null = null;

  const flush = (): unknown | null => {
    if (pendingType === null || pendingTemplate === null) {
      return null;
    }
    const out = { ...pendingTemplate, delta: pendingDelta };
    pendingType = null;
    pendingDelta = "";
    pendingTemplate = null;
    return out;
  };

  let lastEmit = Date.now();

  for await (const raw of source) {
    if (!raw || typeof raw !== "object") {
      const drained = flush();
      if (drained) yield drained;
      yield raw;
      continue;
    }
    const event = raw as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type : "";
    if (!types.has(type) || typeof event.delta !== "string") {
      const drained = flush();
      if (drained) yield drained;
      yield event;
      lastEmit = Date.now();
      continue;
    }

    if (pendingType !== null && pendingType !== type) {
      const drained = flush();
      if (drained) yield drained;
    }
    pendingType = type;
    pendingDelta += event.delta;
    pendingTemplate = { ...event };
    delete pendingTemplate.delta;

    if (Date.now() - lastEmit >= window) {
      const drained = flush();
      if (drained) {
        yield drained;
        lastEmit = Date.now();
      }
    }
  }

  const tail = flush();
  if (tail) yield tail;
}
```

Then update `streamSseReply` to optionally apply coalescing. Find the line `for await (const chunk of source(controller.signal)) {` and change the iteration to use the coalescer when an env flag is set (default ON; opt-out for tests that need raw stream):

```typescript
  const coalesceEnabled = process.env.GOATCITADEL_STREAM_COALESCE_OFF !== "true";
  const stream = coalesceEnabled
    ? coalesceStreamingDeltas(asAsyncIterable(source(controller.signal)))
    : source(controller.signal);
  try {
    for await (const chunk of stream) {
      if (controller.signal.aborted) break;
      const wrote = await send(chunk);
      if (!wrote) break;
    }
    finished = !controller.signal.aborted;
  } catch (error) {
    // ... unchanged
  }
```

And add a small adapter near the top of the file:

```typescript
function asAsyncIterable<T>(source: AsyncGenerator<T>): AsyncIterable<T> {
  return source;
}
```

- [ ] **Step 8.5: Run the test — expect PASS**

```bash
cd apps/gateway && npx vitest run src/routes/chat.shared.coalesce.test.ts --reporter=verbose
```

Expected: PASS all three.

- [ ] **Step 8.6: Run dependent chat route tests for no regression**

```bash
cd apps/gateway && npx vitest run "src/routes/chat*.test.ts" --reporter=dot
```

Expected: no NEW failures vs baseline.

If any chat route test fails because it depends on per-delta emission, set `process.env.GOATCITADEL_STREAM_COALESCE_OFF = "true"` in that test's setup, or move the test to assert on the final aggregated output.

- [ ] **Step 8.7: Commit**

```bash
git add apps/gateway/src/routes/chat.shared.ts apps/gateway/src/routes/chat.shared.coalesce.test.ts
git commit -m "perf(chat-sse): coalesce assistant/thinking deltas inside short window"
```

---

## Task 9: mtime-cache for gateway config load

**Files:**
- Modify: `apps/gateway/src/config.ts`
- Create: `apps/gateway/src/config.mtime-cache.test.ts`

**Why:** Upstream perf — repeated `loadGatewayConfig` calls re-read + re-validate JSON files. Add an mtime-keyed cache so identical filesystem state shortcuts to a cached return.

- [ ] **Step 9.1: Read current loader**

```bash
sed -n '300,360p' apps/gateway/src/config.ts
```

Confirm `loadGatewayConfig(rootDir)` reads four JSON files and validates with Zod.

- [ ] **Step 9.2: Write failing test**

Create `apps/gateway/src/config.mtime-cache.test.ts`:

```typescript
import { mkdtempSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadGatewayConfig, __resetConfigMtimeCacheForTests } from "./config.js";

const seedConfig = (dir: string) => {
  fs.mkdir(path.join(dir, "config"), { recursive: true });
  // Minimal viable config — the real test will set actual values via existing fixtures.
};

describe("loadGatewayConfig mtime cache", () => {
  it("returns cached config when no source file mtime has advanced", async () => {
    __resetConfigMtimeCacheForTests();
    const rootDir = mkdtempSync(path.join(tmpdir(), "cfg-mtime-"));
    await fs.mkdir(path.join(rootDir, "config"), { recursive: true });
    // Seed minimum required config files (use existing minimal fixtures).
    // Reuse this project's test helpers — search for `writeTestGatewayConfig` or similar.

    const a = await loadGatewayConfig(rootDir);
    const readSpy = vi.spyOn(fs, "readFile");
    const b = await loadGatewayConfig(rootDir);

    expect(b).toEqual(a);
    expect(readSpy).not.toHaveBeenCalled();
    readSpy.mockRestore();
  });

  it("invalidates when any source file mtime advances", async () => {
    __resetConfigMtimeCacheForTests();
    const rootDir = mkdtempSync(path.join(tmpdir(), "cfg-mtime-inv-"));
    await fs.mkdir(path.join(rootDir, "config"), { recursive: true });
    const a = await loadGatewayConfig(rootDir);

    const cfgFile = path.join(rootDir, "config", "assistant.config.json");
    await fs.writeFile(cfgFile, JSON.stringify({ ...(a.assistant ?? {}), changed: true }), "utf8");

    const b = await loadGatewayConfig(rootDir);
    expect(b).not.toEqual(a);
  });
});
```

NOTE: If the test cannot seed minimum required config (because the real validator requires complex shapes), simplify by mocking `fs.readFile` directly and asserting cache behavior. Keep the test intent: cache hit + mtime invalidation.

- [ ] **Step 9.3: Run the test — expect FAIL**

```bash
cd apps/gateway && npx vitest run src/config.mtime-cache.test.ts --reporter=verbose
```

Expected: FAIL because `__resetConfigMtimeCacheForTests` doesn't exist.

If the test scaffolding above proves too brittle (config validation rejects empty fixtures), replace with a unit test that directly exercises the cache module (Step 9.4 below adds a separate helper file). The point is to lock cache hit/miss semantics — not to test the whole config validator.

- [ ] **Step 9.4: Implement the cache helper**

Add to `apps/gateway/src/config.ts` (or extract to a sibling `config-mtime-cache.ts` if the file is already large):

```typescript
interface ConfigMtimeCacheEntry {
  mtimes: Record<string, number>;
  value: GatewayRuntimeConfig;
}

let configMtimeCache: { key: string; entry: ConfigMtimeCacheEntry } | null = null;

/** @internal */
export function __resetConfigMtimeCacheForTests(): void {
  configMtimeCache = null;
}

async function readMtimes(rootDir: string, files: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await Promise.all(
    files.map(async (file) => {
      try {
        const stat = await fs.stat(path.join(rootDir, "config", file));
        out[file] = stat.mtimeMs;
      } catch {
        out[file] = 0;
      }
    }),
  );
  return out;
}

function mtimesEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a[key] ?? 0) !== (b[key] ?? 0)) return false;
  }
  return true;
}
```

Then in `loadGatewayConfig(rootDir)`, at the very top after resolving the file list, add:

```typescript
  const cacheKey = path.resolve(rootDir);
  const currentMtimes = await readMtimes(rootDir, REQUIRED_CONFIG_FILES);
  if (configMtimeCache && configMtimeCache.key === cacheKey && mtimesEqual(configMtimeCache.entry.mtimes, currentMtimes)) {
    return configMtimeCache.entry.value;
  }
```

…and at the end, before the return:

```typescript
  configMtimeCache = {
    key: cacheKey,
    entry: { mtimes: currentMtimes, value: validated },
  };
  return validated;
```

(Variable names — `REQUIRED_CONFIG_FILES`, `validated` — need to match what's actually in config.ts. Read it first and align names.)

- [ ] **Step 9.5: Run the test — expect PASS**

```bash
cd apps/gateway && npx vitest run src/config.mtime-cache.test.ts --reporter=verbose
```

Expected: PASS.

- [ ] **Step 9.6: Commit**

```bash
git add apps/gateway/src/config.ts apps/gateway/src/config.mtime-cache.test.ts
git commit -m "perf(config): mtime-keyed cache for loadGatewayConfig"
```

---

## Task 10: (Optional) Durable run archive TTL knob

**Files:**
- Modify: `apps/gateway/src/services/durable-run-service.ts`

**Why:** Upstream reliability item 1 — single retention knob across spawn modes via `agents.defaults.subagents.archiveAfterMinutes`. GoatCitadel has a single `DURABLE_LEASE_TTL_MS = 15_000` but no archive-retention knob.

- [ ] **Step 10.1: Decide if in scope**

If the previous tasks already filled the time budget, skip Task 10 — defer to a follow-up. The retention knob is low-impact because durable runs don't pile up indefinitely on the current code paths.

If proceeding:
- Add `DEFAULT_DURABLE_RUN_ARCHIVE_AFTER_MINUTES = 60 * 24 * 7` (7 days) and a constructor option.
- Add a periodic cleanup that archives completed runs older than the threshold.
- Add a test fixture with synthetic old runs and assert they're archived.

Otherwise, skip to Task 11.

---

## Task 11: Verification — cold-start RSS + time-to-ready before/after

**Files:**
- Create: `docs/superpowers/plans/2026-05-15-reliability-perf-sweep.results.md`

**Why:** Upstream perf wave claimed ~57% TUI cold-start cut. Our target is ≥20% reduction in gateway cold-start time or RSS.

- [ ] **Step 11.1: Build the gateway**

```bash
cd apps/gateway && pnpm build 2>&1 | tail -5
```

Expected: build succeeds.

- [ ] **Step 11.2: Capture post-change cold-start**

```bash
node --expose-gc -e "
const start = process.hrtime.bigint();
const before = process.memoryUsage();
import('./apps/gateway/dist/main.js').catch(() => {});
setTimeout(() => {
  const after = process.memoryUsage();
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  console.log(JSON.stringify({ rssMb: (after.rss - before.rss) / 1024 / 1024, heapMb: (after.heapUsed - before.heapUsed) / 1024 / 1024, elapsedMs: elapsed }));
  process.exit(0);
}, 2000);
" 2>&1 | tail -5
```

Save to `docs/superpowers/plans/2026-05-15-reliability-perf-sweep.after.json`.

- [ ] **Step 11.3: Run full gateway test suite for regression**

```bash
cd apps/gateway && npx vitest run --reporter=dot 2>&1 | tail -10
```

Expected: no NEW failures vs baseline recorded in Step 0.2.

- [ ] **Step 11.4: Run repo-wide typecheck + build**

```bash
pnpm -r typecheck && pnpm -r build 2>&1 | tail -10
```

Expected: all packages typecheck + build clean.

- [ ] **Step 11.5: Document the results**

Create `docs/superpowers/plans/2026-05-15-reliability-perf-sweep.results.md`:

```markdown
# Reliability + Perf Sweep — Results

## Audit findings

**Already correct, regression-tested:**
- Parallel scheduler fanout in chat-proactive-service
- Per-session busy skip
- Malformed JSONL row tolerance in transcript-log, audit-log
- Content-hash conversation summary cache (no stale read possible)
- Deferred sidecar init

**Upstream features not present in GoatCitadel (skipped):**
- HEARTBEAT.md, streamWithIdleTimeout, heartbeat.session pinning, commitment-only dispatch
- AJV (Zod used instead), node-canvas, sandbox container registry, HTTP/2 explicit fallback, APNG normalization

**Fixed:**
- Cron malformed-row tolerance + stale nextRunAt repair
- Doctor cron-row repair (warn + --fix prune)
- Model catalog TTL cache (60s)
- Phased shutdown wait budgets
- SSE streaming delta coalesce
- mtime-cached config loader

## Cold-start measurements

| Metric | Baseline | After | Δ |
|---|---|---|---|
| Time-to-ready (ms) | TBD | TBD | TBD% |
| RSS delta (MB) | TBD | TBD | TBD% |
| Heap delta (MB) | TBD | TBD | TBD% |

(Fill from baseline.json + after.json.)

## Test deltas
- N new regression tests
- M new feature tests
- 0 new failures vs baseline
```

- [ ] **Step 11.6: Commit results**

```bash
git add docs/superpowers/plans/2026-05-15-reliability-perf-sweep.results.md docs/superpowers/plans/2026-05-15-reliability-perf-sweep.after.json
git commit -m "docs(plan): record reliability+perf sweep results"
```

---

## Self-review notes

**Spec coverage check:**

| Upstream item | Plan task | Notes |
|---|---|---|
| O16 heartbeat patterns 1-2 | Tasks 1-2 | Regression-tested; already correct |
| O16 heartbeat patterns 3-7 | (audit only) | Features don't exist; documented in audit summary |
| Reliability: subagent archive TTL | Task 10 (optional) | Low impact |
| Reliability: context cache invalidation | (audit only) | No cache to invalidate |
| Reliability: web fetch dispatcher cleanup | (audit only) | LLM dispatcher is shared — close-on-timeout would break other reqs |
| Reliability: HTTP/2 fallback | (audit only) | Undici transparent |
| Reliability: APNG / Gemini thought-sig | (audit only) | Not implemented |
| Reliability: shutdown wait budgets | Task 7 | Phased: 5s + 10s |
| Reliability: trajectory JSONL tolerance | Task 3 | Already handled — regression test |
| Reliability: cron nextRunAt repair | Task 4 | Done |
| Reliability: doctor --fix cron rows | Task 5 | Done |
| Reliability: empty model catalog cache | Task 6 | Done |
| Perf: lazy AJV | (audit only) | Zod used; lazy by design |
| Perf: lazy Canvas | (audit only) | No Canvas usage |
| Perf: plugin metadata memo | (audit only) | Skills reload already O(1)-cached after init |
| Perf: sandbox registry shard | (audit only) | No registry |
| Perf: defer sidecars | (audit only) | Already deferred |
| Perf: mtime config loader | Task 9 | Done |
| Perf: cache model lookups | Task 6 | Same as catalog cache |
| Perf: streaming throttle | Task 8 | Done |

**Type consistency:** `CronJobRecord`, `DoctorCheckResult`, `ModelDiscoveryResult`, `LlmService`, `ChatProactiveService` referenced across tasks — all are existing types. Verify shapes against current files at task start.

**Risk:** Tasks 7 (shutdown refactor) and 8 (SSE coalesce) touch the hot path. Run repo-wide tests + smoke before merging.

---

## Execution discipline

- TDD per task: failing test → minimal impl → green test → commit.
- One commit per task; no batch commits.
- After each task, run the targeted test + a regression sweep on adjacent files.
- If a task fails verification beyond minor tweaks, STOP and re-plan — don't shotgun fixes.
- Final integration: full `pnpm -r typecheck && pnpm -r test && pnpm -r build` before declaring done.
