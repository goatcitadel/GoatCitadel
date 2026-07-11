import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage } from "@goatcitadel/storage";
import { DurableRunService } from "./durable-run-service.js";
import type { ServiceContext } from "./service-context.js";

const createdRoots: string[] = [];
const openStorages: Storage[] = [];

afterEach(() => {
  for (const storage of openStorages.splice(0)) {
    try {
      storage.close();
    } catch {
      // ignore
    }
  }
  for (const root of createdRoots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("DurableRunService boot recovery integration", () => {
  it("resumes interrupted runs, prunes orphan checkpoints, and quarantines corrupt session rows", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-boot-recovery-"));
    createdRoots.push(root);
    const dataDir = path.join(root, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const transcriptsDir = path.join(dataDir, "transcripts");
    const auditDir = path.join(dataDir, "audit");
    fs.mkdirSync(transcriptsDir, { recursive: true });
    fs.mkdirSync(auditDir, { recursive: true });
    const dbPath = path.join(dataDir, "goatcitadel.db");

    const storage = new Storage({ dbPath, transcriptsDir, auditDir });
    openStorages.push(storage);

    // 1) Seed an interrupted durable run with an expired lease
    const interrupted = storage.durableRuns.createRun({
      workflowKey: "chat.turn.execute",
      status: "running",
      leaseOwnerId: "worker-old",
      leaseHeartbeatAt: "2026-05-14T23:55:00.000Z",
      leaseExpiresAt: "2026-05-14T23:56:00.000Z",
    });

    // 2) Seed an orphan checkpoint (bypass FK via PRAGMA since run_id doesn't exist)
    storage.db.exec("PRAGMA foreign_keys = OFF");
    storage.db
      .prepare(
        "INSERT INTO durable_checkpoints (checkpoint_id, run_id, checkpoint_kind, state_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("orphan-cp-1", "no-such-run", "run_created", "{}", "2026-05-15T00:00:00.000Z");
    storage.db.exec("PRAGMA foreign_keys = ON");

    // 3) Seed a session with corrupted routing_hints_json
    storage.sessions.upsert({
      sessionId: "session-corrupt",
      sessionKey: "key-corrupt",
      kind: "dm",
      channel: "chat",
      account: "user",
      timestamp: "2026-05-15T00:00:00.000Z",
    });
    storage.db
      .prepare("UPDATE sessions SET routing_hints_json = ? WHERE session_id = ?")
      .run("{not json", "session-corrupt");

    // 4) Build a ServiceContext pointing to the real storage
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

    // 5) Construct DurableRunService with a mock workflow registry
    // executeWorkflow must mark the run completed — otherwise the finally block in
    // drainQueuedRuns sees status=running and marks it failed.
    const service = new DurableRunService(ctx, {
      backgroundTasks: new Set(),
      workflowRegistry: {
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

    // 6) Start the worker — this triggers boot recovery (reconcile + pruneCheckpoints)
    service.startWorker();

    // 7) Poll until lastBootRecovery is populated (boot recovery completes asynchronously)
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (service.getDurableDiagnostics().lastBootRecovery) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    // 8) Explicitly read the corrupt session to trigger quarantine recording
    storage.sessions.getBySessionId("session-corrupt");

    // 9) Assertions

    // "resumed after restart" info log was emitted
    const resumeLog = infoLogs.find((entry) => entry.msg.includes("resumed after restart"));
    expect(resumeLog, "expected info log containing 'resumed after restart'").toBeDefined();

    const diag = service.getDurableDiagnostics();
    expect(diag.lastBootRecovery?.resumedCount).toBe(1);
    expect(diag.lastBootRecovery?.prunedOrphanCheckpoints).toBeGreaterThanOrEqual(1);

    // Corrupt session was quarantined
    expect(storage.stateValidationQuarantine.count()).toBeGreaterThanOrEqual(1);

    // The interrupted run was reclaimed from stale "running" + expired lease.
    // Boot recovery sets it to "queued", then the poll loop immediately picks it up
    // and the mock workflow completes it. Accept either "queued" or "completed" as
    // evidence that the run was successfully reclaimed (not stuck in failed/running).
    const reclaimed = storage.durableRuns.getRun(interrupted.runId);
    expect(["queued", "completed"]).toContain(reclaimed.status);

    service.stopWorker();
  }, 30_000);
});
