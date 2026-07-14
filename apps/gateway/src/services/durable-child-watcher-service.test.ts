import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DURABLE_CHILD_WATCHER_LIMITS } from "@goatcitadel/contracts";
import { Storage } from "@goatcitadel/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableRunService } from "./durable-run-service.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

function createHarness() {
  const root = path.join(os.tmpdir(), `goatcitadel-durable-watcher-service-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  const storage = new Storage({
    dbPath: path.join(root, "runtime.db"),
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  cleanups.push(() => {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const publishRealtime = vi.fn();
  const context = {
    storage,
    config: { assistant: { durable: { enabled: true } } },
    publishRealtime,
    requireFeatureEnabled: vi.fn(),
    isFeatureEnabled: vi.fn(() => true),
  } as never;
  const service = new DurableRunService(context);
  storage.durableRuns.createRun({
    runId: "parent-run",
    workflowKey: "chat.turn.execute",
    status: "waiting",
    metadata: {
      waitForEvent: {
        eventKey: "approval_resolved",
        correlationId: "approval-1",
      },
    },
    now: "2026-07-13T00:00:00.000Z",
  });
  storage.durableRuns.createRun({
    runId: "child-run",
    workflowKey: "chat.turn.execute",
    status: "waiting",
    now: "2026-07-13T00:00:00.000Z",
  });
  return { storage, service, publishRealtime, context };
}

describe("DurableRunService child watchers", () => {
  it("catches historical and live child transitions without waking approval-waiting runs", () => {
    const { storage, service, publishRealtime } = createHarness();
    const wakeSpy = vi.spyOn(service, "wakeDurableRun");
    const resumeSpy = vi.spyOn(service, "resumeDurableRun");
    const processSpy = vi.spyOn(service, "requestRunProcessing");
    service.recordDurableTimelineEvent("child-run", "run_started", { phase: "provider" });
    const parentBefore = storage.durableRuns.getRun("parent-run");
    const childBefore = storage.durableRuns.getRun("child-run");

    const watcher = service.watchDurableChildRun({
      parentRunId: "parent-run",
      childRunId: "child-run",
      source: "chat_delegation",
      metadata: { stepId: "step-1" },
    });
    expect(watcher.lastConsumedSequence).toBe(1);
    service.recordDurableTimelineEvent("child-run", "run_waiting", { approvalId: "approval-1" });

    const notices = service
      .listDurableRunTimeline("parent-run")
      .filter((event) => event.eventType === "child_state_changed");
    expect(notices.map((event) => event.payload?.childEventType)).toEqual(["run_started", "run_waiting"]);
    expect(notices.map((event) => event.sequence)).toEqual([1, 2]);
    expect(storage.durableRuns.getRun("parent-run")).toMatchObject({
      status: "waiting",
      version: parentBefore.version,
    });
    expect(storage.durableRuns.getRun("child-run")).toMatchObject({
      status: "waiting",
      version: childBefore.version,
    });
    expect(wakeSpy).not.toHaveBeenCalled();
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(processSpy).not.toHaveBeenCalled();
    expect(publishRealtime).not.toHaveBeenCalled();
  });

  it("defers transitions while detached and returns bounded catch-up evidence on reattach", () => {
    const { service } = createHarness();
    const watcher = service.watchDurableChildRun({ parentRunId: "parent-run", childRunId: "child-run" });
    service.detachDurableChildWatcher(watcher.watcherId);
    service.recordDurableTimelineEvent("child-run", "run_started");
    service.recordDurableTimelineEvent("child-run", "run_completed");
    expect(service.listDurableRunTimeline("parent-run")).toEqual([]);

    const caughtUp = service.reattachDurableChildWatcher(watcher.watcherId);
    expect(caughtUp.consumedCount).toBe(2);
    expect(caughtUp.projectedCount).toBe(2);
    expect(caughtUp.hasMore).toBe(false);
    expect(caughtUp.notices.map((notice) => notice.payload?.childEventType)).toEqual(["run_started", "run_completed"]);
  });

  it("rolls back a new watcher and its parent notice when initial catch-up cannot commit its watermark", () => {
    const { storage, service } = createHarness();
    service.recordDurableTimelineEvent("child-run", "run_started", { phase: "provider" });
    storage.gatewaySql.exec(`
      CREATE TRIGGER fail_initial_child_watcher_watermark
      BEFORE UPDATE OF last_consumed_sequence ON durable_child_watchers
      BEGIN
        SELECT RAISE(ABORT, 'simulated child watcher watermark failure');
      END
    `);

    expect(() =>
      service.watchDurableChildRun({
        parentRunId: "parent-run",
        childRunId: "child-run",
        watcherId: "watcher-atomic-create",
      }),
    ).toThrow("simulated child watcher watermark failure");

    expect(storage.durableChildWatchers.getByPair("parent-run", "child-run")).toBeUndefined();
    expect(storage.durableRunEvents.listByRun("parent-run")).toEqual([]);
  });

  it("fails metadata and lookup bounds before persistence and redacts secret metadata", () => {
    const { storage, service } = createHarness();

    expect(() =>
      service.watchDurableChildRun({
        parentRunId: "parent-run",
        childRunId: "child-run",
        metadata: { value: "x".repeat(DURABLE_CHILD_WATCHER_LIMITS.metadataBytes + 1) },
      }),
    ).toThrow(/metadata exceeds .* bytes/);
    let deep: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth <= DURABLE_CHILD_WATCHER_LIMITS.metadataMaxDepth; depth += 1) {
      deep = { nested: deep };
    }
    expect(() =>
      service.watchDurableChildRun({
        parentRunId: "parent-run",
        childRunId: "child-run",
        metadata: deep,
      }),
    ).toThrow(/metadata exceeds depth/);
    const secretKey = "sk-secret-key-1234567890abcdef1234567890";
    expect(() =>
      service.watchDurableChildRun({
        parentRunId: "parent-run",
        childRunId: "child-run",
        metadata: { [secretKey]: "safe" },
      }),
    ).toThrow(/metadata keys must not contain secret material/);
    expect(() =>
      service.watchDurableChildRun({
        watcherId: secretKey,
        parentRunId: "parent-run",
        childRunId: "child-run",
      }),
    ).toThrow(/watcherId must not contain secret material/);
    expect(() =>
      service.watchDurableChildRun({
        parentRunId: "parent-run",
        childRunId: "child-run",
        source: secretKey,
      }),
    ).toThrow(/source must not contain secret material/);
    expect(storage.durableChildWatchers.getByPair("parent-run", "child-run")).toBeUndefined();

    const watcher = service.watchDurableChildRun({
      parentRunId: "parent-run",
      childRunId: "child-run",
      metadata: { apiToken: "sk-1234567890abcdef1234567890", note: "safe" },
    });
    expect(watcher.metadata).toEqual({ apiToken: "[REDACTED]", note: "safe" });
    expect(JSON.stringify(watcher)).not.toContain("sk-1234567890abcdef1234567890");
    const persistedMetadata = storage.gatewaySql
      .prepare("SELECT metadata_json FROM durable_child_watchers WHERE watcher_id = ?")
      .get<{ metadata_json: string }>(watcher.watcherId);
    expect(persistedMetadata?.metadata_json).not.toContain(secretKey);

    expect(() =>
      service.detachDurableChildWatcher("w".repeat(DURABLE_CHILD_WATCHER_LIMITS.watcherIdBytes + 1)),
    ).toThrow(/watcherId exceeds/);
    expect(() => service.listDurableChildWatchers("r".repeat(DURABLE_CHILD_WATCHER_LIMITS.runIdBytes + 1))).toThrow(
      /runId exceeds/,
    );
  });

  it("reconciles an attached watcher during durable worker startup", async () => {
    const { storage, context } = createHarness();
    const catchUpSpy = vi.spyOn(storage.durableChildWatchers, "catchUpAttached");
    storage.durableChildWatchers.create({
      watcherId: "watcher-boot",
      parentRunId: "parent-run",
      childRunId: "child-run",
    });
    storage.durableRunEvents.append({
      eventId: "child-before-restart",
      runId: "child-run",
      eventType: "run_waiting",
      createdAt: "2026-07-13T00:00:05.000Z",
    });
    expect(storage.durableRunEvents.listByRun("parent-run")).toEqual([]);

    const backgroundTasks = new Set<Promise<void>>();
    const restarted = new DurableRunService(context, {
      backgroundTasks,
      workflowRegistry: {
        executeWorkflow: vi.fn(),
        isWorkflowRecoverable: vi.fn(() => ({ recoverable: true })),
        markWorkflowUnrecoverable: vi.fn(),
      },
    });
    restarted.startWorker();
    await Promise.all([...backgroundTasks]);
    restarted.stopWorker();

    expect(storage.durableRunEvents.listByRun("parent-run")).toHaveLength(1);
    expect(storage.durableChildWatchers.get("watcher-boot").lastConsumedSequence).toBe(1);
    expect(catchUpSpy).toHaveBeenCalledWith({ watcherLimit: 100, eventLimitPerWatcher: 100 });
  });
});
