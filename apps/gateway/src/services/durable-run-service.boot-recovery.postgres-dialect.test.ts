import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLog, createDatabase, Storage, TranscriptLog, type DatabaseClient } from "@goatcitadel/storage";
import { DurableRunService } from "./durable-run-service.js";
import type { ServiceContext } from "./service-context.js";

/**
 * Postgres-dialect variant of durable-run-service.boot-recovery.integration.test.ts.
 *
 * The sqlite test proves the FULL boot-recovery scenario (running-run with an
 * expired lease gets reclaimed to "queued" on startWorker(), orphan checkpoints
 * are pruned, and a corrupt session row is quarantined) using raw
 * `storage.db.exec("PRAGMA ...")` / `storage.db.prepare(...)` to seed
 * dialect-specific fixture rows. Those raw seeding calls are themselves
 * sqlite-only (PRAGMA foreign_keys, direct INSERT bypassing the repo layer) and
 * are NOT reproduced here.
 *
 * This file instead:
 *  1) Reuses the postgres-dialect strict-client harness introduced by PR #182
 *     (improvement-service.postgres-dialect.test.ts) to construct a Storage
 *     backed by a client that rejects sqlite-only transaction-control/PRAGMA
 *     SQL the way the real Postgres driver does.
 *  2) Re-runs the dialect-agnostic slice of the sqlite test's recovery-outcome
 *     assertions (an expired-lease "running" run gets reclaimed by
 *     startWorker()'s boot recovery) through that strict client, seeding the
 *     fixture via the normal repository API (createRun/updateRun) instead of
 *     raw SQL so it works on both dialects.
 *  3) Directly pins the regression class PR #182 fixed: boot recovery must
 *     reach terminal/queued status using ONLY driver-aware transaction control
 *     (Storage.runImmediateTransaction -> db.transaction(...)), never a raw
 *     sqlite-only `exec("BEGIN IMMEDIATE"/"PRAGMA ...")` — the strict client's
 *     `exec` throws on any such statement, so if boot recovery reaches it the
 *     test fails loudly instead of silently passing on sqlite alone.
 */

interface Harness {
  rootDir: string;
  storage: Storage;
  service: DurableRunService;
}

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.service.stopWorker();
    harness.storage.close();
    fsSync.rmSync(harness.rootDir, { recursive: true, force: true });
  }
});

/**
 * Mirrors createPostgresDialectStrictDb from
 * improvement-service.postgres-dialect.test.ts (added by PR #182): wraps a
 * fully migrated sqlite client in a postgres-dialect facade whose `exec`
 * rejects transaction-control and PRAGMA statements the way the real Postgres
 * driver does. Data statements (prepare/run/get/all) still execute against
 * sqlite, so the full boot-recovery path runs; only dialect-unsafe raw exec
 * calls blow up.
 */
function createPostgresDialectStrictDb(rootDir: string): DatabaseClient {
  const inner = createDatabase({ dbPath: path.join(rootDir, "backing.sqlite") });
  return {
    dialect: "postgres",
    prepare: (sql) => {
      let stmt: ReturnType<DatabaseClient["prepare"]> | undefined;
      const resolve = () => (stmt ??= inner.prepare(translateBootRecoveryPostgresSqlForSqlite(sql)));
      return {
        run: (...params: unknown[]) => resolve().run(...params),
        get: (...params: unknown[]) => resolve().get(...params),
        all: (...params: unknown[]) => resolve().all(...params),
      };
    },
    exec: (sql) => {
      const leadingKeyword =
        sql
          .trim()
          .split(/[\s;(]+/, 1)[0]
          ?.toUpperCase() ?? "";
      if (["BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "PRAGMA", "END"].includes(leadingKeyword)) {
        throw new Error(
          `syntax error at or near "${sql.trim().split(/\s+/)[1] ?? leadingKeyword}" — ` +
            `sqlite-dialect exec reached the postgres driver; use the driver-aware transaction helper ` +
            `(runImmediateTransaction / db.transaction) instead of raw "${sql.trim().slice(0, 40)}"`,
        );
      }
      inner.exec(sql);
    },
    close: () => inner.close(),
    transaction: (mode, callback) => inner.transaction(mode, callback),
  };
}

/**
 * This harness is intentionally a transaction-control probe, not a Postgres
 * parser. Boot recovery now delegates expiry comparison and row locking to
 * Postgres-specific repository statements, so translate only those statements
 * exercised by this sqlite-backed facade. Real Postgres coverage owns their
 * native SQL semantics; this test continues to prove the service never emits
 * raw sqlite transaction control on the Postgres code path.
 */
function translateBootRecoveryPostgresSqlForSqlite(sql: string): string {
  return sql
    .replace(/\bFOR UPDATE(?:\s+SKIP LOCKED)?\b/giu, "")
    .replace(/gc_try_parse_timestamptz\(([^)]+)\)\s*<=\s*clock_timestamp\(\)/giu, "julianday($1) <= julianday('now')")
    .replace(/OCTET_LENGTH\(state_json\)/giu, "LENGTH(CAST(state_json AS BLOB))");
}

function createHarness(): Harness {
  const rootDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "gc-durable-boot-recovery-pg-dialect-"));
  const transcriptsDir = path.join(rootDir, "transcripts");
  const auditDir = path.join(rootDir, "audit");
  fsSync.mkdirSync(transcriptsDir, { recursive: true });
  fsSync.mkdirSync(auditDir, { recursive: true });

  const storage = new Storage({
    db: createPostgresDialectStrictDb(rootDir),
    transcriptsDir,
    auditDir,
    // Keep the file-based logs so the sqlite-backed facade never has to serve
    // the postgres transcript/audit SQL variants (mirrors
    // improvement-service.postgres-dialect.test.ts).
    transcripts: new TranscriptLog(transcriptsDir),
    audit: new AuditLog(auditDir),
  });

  const infoLogs: Array<{ data: unknown; msg: string }> = [];
  const ctx = {
    storage,
    config: {
      assistant: {
        durable: {
          enabled: true,
          workflowTimeoutMs: 30_000,
        },
        mesh: {
          nodeId: "test-node",
        },
      },
    },
    publishRealtime: () => {},
    requireFeatureEnabled: () => {},
    isFeatureEnabled: () => true,
    normalizeWorkspaceId: (workspaceId?: string) => workspaceId ?? "default",
    gatewaySql: storage.gatewaySql,
    llmService: {},
    policyEngine: {},
    logger: {
      info: (data: unknown, msg: string) => infoLogs.push({ data, msg }),
      debug: () => {},
      warn: () => {},
      error: () => {},
    },
  } as unknown as ServiceContext;

  const service = new DurableRunService(ctx, {
    backgroundTasks: new Set(),
    workflowRegistry: {
      // Marks the run completed — otherwise the finally block in
      // drainQueuedRuns sees status=running and marks it failed (mirrors the
      // sqlite integration test's mock workflow registry).
      executeWorkflow: vi.fn(async (run) => {
        const current = storage.durableRuns.getRun(run.runId);
        storage.durableRuns.updateRun({
          runId: run.runId,
          status: "completed",
          finishedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          expectedVersion: current.version,
        });
      }),
      isWorkflowRecoverable: () => ({ recoverable: true }),
      markWorkflowUnrecoverable: vi.fn(),
    },
  });

  const harness = { rootDir, storage, service, infoLogs } as Harness & {
    infoLogs: Array<{ data: unknown; msg: string }>;
  };
  harnesses.push(harness);
  return harness;
}

describe("DurableRunService boot recovery on the postgres dialect", () => {
  it("reclaims an expired-lease running run via startWorker() boot recovery without sqlite-only transaction control", async () => {
    // Regression class fixed by PR #182 (BEGIN IMMEDIATE Postgres fix,
    // 2026-07-06): sqlite-only raw `exec("BEGIN IMMEDIATE"/"PRAGMA ...")`
    // calls broke boot-recovery-adjacent flows (weekly improvement replay,
    // cron retry) on Postgres. Boot recovery for durable runs already routes
    // mutations through Storage.runImmediateTransaction (driver-aware:
    // db.transaction("immediate", ...)), never raw exec — this test pins
    // that fact against the strict postgres-dialect client, which throws if
    // ANY sqlite-only BEGIN/COMMIT/ROLLBACK/PRAGMA statement is issued via
    // exec() during the recovery path.
    const harness = createHarness();
    const { storage, service } = harness;

    // 1) Seed an interrupted durable run with an expired lease via the
    // normal repository API (createRun + updateRun), NOT raw SQL — this
    // works identically regardless of dialect, unlike the sqlite test's
    // direct `storage.db.prepare(...).run(...)` checkpoint/session seeding.
    const created = storage.durableRuns.createRun({
      workflowKey: "chat.turn.execute",
      status: "running",
      leaseOwnerId: "worker-old",
      leaseHeartbeatAt: "2026-05-14T23:55:00.000Z",
      leaseExpiresAt: "2026-05-14T23:56:00.000Z",
    });
    // createRun always creates as queued/waiting per its own status
    // normalization on some code paths — force the run to the "running"
    // status with an expired lease the same way the sqlite test's seed
    // intends, going through updateRun (repository API, dialect-agnostic).
    const interrupted = storage.durableRuns.updateRun({
      runId: created.runId,
      status: "running",
      leaseOwnerId: "worker-old",
      leaseHeartbeatAt: "2026-05-14T23:55:00.000Z",
      leaseExpiresAt: "2026-05-14T23:56:00.000Z",
      updatedAt: new Date().toISOString(),
      expectedVersion: created.version,
    });
    expect(interrupted.status).toBe("running");

    // 2) Start the worker — this triggers boot recovery
    // (reconcileRecoverableRuns + pruneCheckpoints) exactly like the sqlite
    // test. If any step here issued a raw sqlite-only BEGIN/PRAGMA against
    // the strict client, this call would reject and the awaited background
    // task's rejection would surface as an unhandled rejection / failed
    // assertion below.
    service.startWorker();

    // 3) Poll until lastBootRecovery is populated (boot recovery completes
    // asynchronously), same polling approach as the sqlite integration test.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (service.getDurableDiagnostics().lastBootRecovery) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const diag = service.getDurableDiagnostics();
    expect(diag.lastBootRecovery, "expected boot recovery to complete without throwing").toBeDefined();
    expect(diag.lastBootRecovery?.resumedCount).toBe(1);

    // The interrupted run was reclaimed from stale "running" + expired
    // lease. Boot recovery sets it to "queued", then the poll loop
    // immediately picks it up and the mock workflow completes it. Accept
    // either "queued" or "completed" as evidence of successful reclaim (same
    // dialect-agnostic outcome assertion as the sqlite test).
    const reclaimed = storage.durableRuns.getRun(interrupted.runId);
    expect(["queued", "completed"]).toContain(reclaimed.status);

    // Dialect-agnostic recovery-log assertion mirrored from the sqlite test.
    const resumeLog = (harness as unknown as { infoLogs: Array<{ msg: string }> }).infoLogs.find((entry) =>
      entry.msg.includes("resumed after restart"),
    );
    expect(resumeLog, "expected info log containing 'resumed after restart'").toBeDefined();

    service.stopWorker();
  }, 30_000);

  it("never routes durable-run mutations through raw sqlite-only exec (BEGIN/COMMIT/ROLLBACK/PRAGMA)", async () => {
    // Direct pin of the PR #182 regression class, independent of the async
    // boot-recovery timing above: exercise the same mutation surface boot
    // recovery uses (runImmediateTransaction-wrapped updateRun, plus
    // createCheckpoint) against the strict client and assert it completes
    // without the strict exec() guard firing.
    const harness = createHarness();
    const { storage } = harness;

    const run = storage.durableRuns.createRun({
      workflowKey: "chat.turn.execute",
      status: "queued",
    });

    expect(() =>
      storage.runImmediateTransaction(() => {
        storage.durableRuns.updateRun({
          runId: run.runId,
          status: "paused",
          startedAt: new Date().toISOString(),
          clearFinishedAt: true,
          clearLastError: true,
          clearLease: true,
          updatedAt: new Date().toISOString(),
          expectedVersion: run.version,
        });
      }),
    ).not.toThrow();

    const paused = storage.durableRuns.getRun(run.runId);
    expect(paused.status).toBe("paused");
  });
});
