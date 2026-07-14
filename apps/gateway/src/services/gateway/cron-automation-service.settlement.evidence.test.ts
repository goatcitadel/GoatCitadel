import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CronRunExecutionToken, DurableRunRecord, DurableRunStatus } from "@goatcitadel/contracts";
import { Storage } from "@goatcitadel/storage";
import { buildCronChatAdmissionIdentity } from "../chat-autonomous-turn-service.js";
import { CronAutomationService, type CronAutomationServiceDeps } from "./cron-automation-service.js";
import { createTestCronSpecOwner } from "./cron-spec-owner.test-utils.js";

function createStorage(root: string): Storage {
  return new Storage({
    dbPath: path.join(root, "gateway.db"),
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
}

function seedAgentTurnJob(storage: Storage, jobId: string): void {
  storage.cronJobs.createSpec({
    jobId,
    name: jobId,
    action: "agent_turn",
    actionConfig: { agentTurn: { prompt: `Run ${jobId}` } },
    schedule: "0 12 * * * UTC",
    enabled: true,
  });
}

function getDurableRun(storage: Storage, runId: string): DurableRunRecord | undefined {
  try {
    return storage.durableRuns.getRun(runId);
  } catch {
    return undefined;
  }
}

function ensureDeterministicChild(storage: Storage, token: CronRunExecutionToken): DurableRunRecord {
  const identity = buildCronChatAdmissionIdentity(token);
  const existing = getDurableRun(storage, identity.durableRunId);
  if (existing) return existing;
  return storage.durableRuns.createRun({
    runId: identity.durableRunId,
    workflowKey: "chat.turn.execute",
    status: "queued",
    payload: { cronAdmission: identity },
    metadata: {
      cronRunId: token.runId,
      cronJobId: token.jobId,
      cronExecutionGeneration: token.executionGeneration,
      cronAdmission: identity,
      autonomous: { profilePosture: "scheduled_restricted" },
    },
  });
}

function createAgentHandler(
  storage: Storage,
  beforeChild?: () => Promise<void>,
): CronAutomationServiceDeps["runHandlers"]["agentTurn"] {
  return vi.fn(async ({ cronRun }) => {
    await beforeChild?.();
    const child = ensureDeterministicChild(storage, cronRun);
    const identity = buildCronChatAdmissionIdentity(cronRun);
    return {
      mode: "agent_turn" as const,
      durableRunId: child.runId,
      sessionId: `session-${cronRun.jobId}`,
      turnId: identity.turnId,
      userMessageId: identity.userMessageId,
      assistantMessageId: identity.assistantMessageId,
      profilePosture: "scheduled_restricted" as const,
    };
  });
}

function createService(
  storage: Storage,
  agentTurn = createAgentHandler(storage),
  recordEvidenceEnvelope: NonNullable<CronAutomationServiceDeps["recordEvidenceEnvelope"]> = (input) => ({
    envelopeId: `evidence-${input.runId}`,
  }),
): CronAutomationService {
  return new CronAutomationService({
    storage,
    specOwner: createTestCronSpecOwner(storage.cronJobs),
    publishRealtime: vi.fn(),
    requireFeatureEnabled: vi.fn(),
    isFeatureEnabled: (flag) => flag === "cronEvidenceV1Enabled",
    recordEvidenceEnvelope,
    runHandlers: {
      task: async () => ({ taskId: "task" }),
      improvement: async () => {},
      backup: async () => {},
      memoryFlush: async () => {},
      memoryConsolidation: async () => {},
      costReport: async () => {},
      updateReview: async () => {},
      curator: async () => {},
      watchdog: async () => ({ status: "ok", checkId: "runtime_health", summary: "healthy" }),
      noAgent: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
      agentTurn,
    },
  });
}

function updateDurableRun(
  storage: Storage,
  runId: string,
  status: DurableRunStatus,
  metadata: Record<string, unknown>,
  lastError?: string,
): DurableRunRecord {
  const current = storage.durableRuns.getRun(runId);
  return storage.durableRuns.updateRun({
    runId,
    status,
    metadata,
    ...(lastError ? { lastError } : {}),
    ...(status === "completed" || status === "failed" || status === "cancelled" || status === "dead_lettered"
      ? { finishedAt: new Date().toISOString() }
      : {}),
    expectedVersion: current.version,
  });
}

describe("HX-204 canonical cron settlement evidence", () => {
  it("begins before launch and coalesces concurrent admission without reporting success", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-cron-coalesce-"));
    const storage = createStorage(root);
    try {
      seedAgentTurnJob(storage, "coalesced-agent");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const observedOwners: string[] = [];
      const handler = createAgentHandler(storage, async () => {
        const active = storage.cronJobs.get("coalesced-agent")?.activeRunId;
        if (active && storage.cronRuns.get(active)?.status === "admitting") observedOwners.push(active);
        await gate;
      });
      const service = createService(storage, handler);
      const options = {
        reason: "scheduled_due",
        scheduledFor: "2026-07-13T12:00:00.000Z",
        admissionKey: "scheduled:2026-07-13T12:00:00.000Z",
      };
      const first = service.runCronJobNow("coalesced-agent", options);
      const second = service.runCronJobNow("coalesced-agent", options);
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
      release();
      const [left, right] = await Promise.all([first, second]);

      expect(left.runId).toBe(right.runId);
      expect(left.status).toBe("pending");
      expect(observedOwners).toEqual([left.runId]);
      expect(storage.cronRuns.listByJob("coalesced-agent")).toHaveLength(1);
      expect(storage.cronRuns.get(left.runId)).toMatchObject({ status: "admitted", phase: "chat_execution" });
      expect(storage.cronJobs.get("coalesced-agent")).toMatchObject({
        activeRunId: left.runId,
        lastRunId: left.runId,
        nextRunAt: "2026-07-14T12:00:00.000Z",
      });
      expect(storage.cronJobs.get("coalesced-agent")?.lastRunStatus).toBeUndefined();
    } finally {
      storage.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers restart crashes both before child launch and after child creation before attachment", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-cron-restart-"));
    let storage = createStorage(root);
    try {
      seedAgentTurnJob(storage, "crash-before-launch");
      seedAgentTurnJob(storage, "crash-after-child");
      const before = storage.cronRuns.beginAdmission({
        runId: "cron-before-launch",
        jobId: "crash-before-launch",
        admissionKey: "scheduled:before",
        scheduledFor: "2026-07-13T12:00:00.000Z",
      });
      const after = storage.cronRuns.beginAdmission({
        runId: "cron-after-child",
        jobId: "crash-after-child",
        admissionKey: "scheduled:after",
        scheduledFor: "2026-07-13T12:00:00.000Z",
      });
      expect(before.outcome).toBe("begun");
      expect(after.outcome).toBe("begun");
      if (after.outcome === "begun") {
        const orphanedChild = ensureDeterministicChild(storage, after.run);
        updateDurableRun(storage, orphanedChild.runId, "completed", {
          ...(orphanedChild.metadata ?? {}),
          autonomousChatPostCommit: { delivery: { status: "skipped", reason: "delivery_not_configured" } },
        });
      }
      storage.close();

      storage = createStorage(root);
      const handler = createAgentHandler(storage);
      const service = createService(storage, handler);
      const recovered = await service.recoverPendingAgentTurnCronRuns();

      expect(recovered).toMatchObject({ checkedCount: 2, launchedCount: 2, settledCount: 1, errors: [] });
      expect(handler).toHaveBeenCalledTimes(2);
      expect(storage.cronRuns.get("cron-before-launch")).toMatchObject({ status: "admitted" });
      expect(storage.cronRuns.get("cron-after-child")).toMatchObject({ status: "completed" });
      expect(storage.durableRuns.listRuns(20).filter((run) => run.workflowKey === "chat.turn.execute")).toHaveLength(2);
    } finally {
      storage.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("terminalizes the inert inbox fallback and releases the canonical active-run lease", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-cron-inbox-"));
    const storage = createStorage(root);
    try {
      seedAgentTurnJob(storage, "inbox-fallback");
      const handler = vi.fn(async () => ({
        mode: "inbox" as const,
        taskId: "task-inbox-fallback",
        profilePosture: "creator_profile_missing" as const,
        profileWarning: "creator profile missing",
      }));
      const service = createService(storage, handler);
      const result = await service.runCronJobNow("inbox-fallback");

      expect(result.status).toBe("ok");
      expect(storage.cronRuns.get(result.runId)).toMatchObject({
        status: "completed",
        phase: "settlement",
        outcome: expect.objectContaining({
          mode: "inbox",
          status: "inbox_created",
          taskId: "task-inbox-fallback",
        }),
      });
      expect(storage.cronJobs.get("inbox-fallback")).toMatchObject({
        activeRunId: undefined,
        lastRunStatus: "ok",
        lastRunId: result.runId,
      });
    } finally {
      storage.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("tracks running/waiting/post-commit truth and settles only after the canonical receipt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-cron-postcommit-"));
    const storage = createStorage(root);
    try {
      seedAgentTurnJob(storage, "postcommit-agent");
      const evidence = vi.fn((input) => ({ envelopeId: `evidence-${input.runId}` }));
      const service = createService(storage, createAgentHandler(storage), evidence);
      const admitted = await service.runCronJobNow("postcommit-agent");
      const cronRun = storage.cronRuns.get(admitted.runId)!;
      const childRunId = cronRun.childDurableRunId!;
      const child = storage.durableRuns.getRun(childRunId);

      updateDurableRun(storage, childRunId, "running", child.metadata ?? {});
      await service.recoverPendingAgentTurnCronRuns();
      expect(storage.cronRuns.get(admitted.runId)?.status).toBe("running");

      updateDurableRun(storage, childRunId, "waiting", child.metadata ?? {});
      await service.recoverPendingAgentTurnCronRuns();
      expect(storage.cronRuns.get(admitted.runId)?.status).toBe("waiting");

      updateDurableRun(storage, childRunId, "completed", {
        ...(child.metadata ?? {}),
        autonomousChatPostCommitPending: { version: 1, requestedAt: "2026-07-13T12:00:01.000Z" },
      });
      await service.recoverPendingAgentTurnCronRuns();
      expect(storage.cronRuns.get(admitted.runId)).toMatchObject({
        status: "running",
        phase: "autonomous_post_commit",
      });
      expect(storage.cronJobs.get("postcommit-agent")?.lastRunStatus).toBeUndefined();

      const pending = storage.durableRuns.getRun(childRunId);
      const completedMetadata = { ...(pending.metadata ?? {}) };
      delete completedMetadata.autonomousChatPostCommitPending;
      completedMetadata.autonomousChatPostCommit = {
        delivery: { status: "skipped", reason: "delivery_not_configured" },
      };
      updateDurableRun(storage, childRunId, "completed", completedMetadata);
      const settled = await service.recoverPendingAgentTurnCronRuns();

      expect(settled).toMatchObject({ settledCount: 1, reconciliationCount: 0, errors: [] });
      expect(storage.cronRuns.get(admitted.runId)).toMatchObject({
        status: "completed",
        phase: "settlement",
        evidenceEnvelopeId: `evidence-${admitted.runId}`,
      });
      expect(storage.cronJobs.get("postcommit-agent")).toMatchObject({
        activeRunId: undefined,
        lastRunStatus: "ok",
        lastRunEvidenceEnvelopeId: `evidence-${admitted.runId}`,
      });
      expect(evidence).toHaveBeenCalledTimes(1);
      expect(service.findCronRunById(admitted.runId)).toMatchObject({ status: "ok", finishedAt: expect.any(String) });
    } finally {
      storage.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("waits for delivery terminal truth and quarantines unknown-after-send outcomes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-cron-delivery-"));
    const storage = createStorage(root);
    try {
      seedAgentTurnJob(storage, "delivery-success");
      seedAgentTurnJob(storage, "delivery-ambiguous");
      const service = createService(storage);

      for (const [jobId, deliveryRunId] of [
        ["delivery-success", "delivery-success-run"],
        ["delivery-ambiguous", "delivery-ambiguous-run"],
      ] as const) {
        const admitted = await service.runCronJobNow(jobId);
        const cronRun = storage.cronRuns.get(admitted.runId)!;
        const child = storage.durableRuns.getRun(cronRun.childDurableRunId!);
        storage.durableRuns.createRun({
          runId: deliveryRunId,
          workflowKey: "connector.delivery",
          status: "queued",
          payload: { runId: child.runId },
          metadata: {
            deliveryKind: "autonomous.assistant_message",
            sourceRunId: child.runId,
          },
        });
        updateDurableRun(storage, child.runId, "completed", {
          ...(child.metadata ?? {}),
          autonomousChatPostCommit: { delivery: { status: "enqueued", runId: deliveryRunId } },
        });
        await service.recoverPendingAgentTurnCronRuns();
        expect(storage.cronRuns.get(admitted.runId)).toMatchObject({
          phase: "delivery",
          deliveryRunId,
        });
        expect(storage.cronJobs.get(jobId)?.lastRunStatus).toBeUndefined();

        if (jobId === "delivery-success") {
          updateDurableRun(
            storage,
            deliveryRunId,
            "completed",
            storage.durableRuns.getRun(deliveryRunId).metadata ?? {},
          );
          await service.recoverPendingAgentTurnCronRuns();
          expect(storage.cronRuns.get(admitted.runId)?.status).toBe("completed");
          expect(storage.cronJobs.get(jobId)?.lastRunStatus).toBe("ok");
        } else {
          updateDurableRun(
            storage,
            deliveryRunId,
            "failed",
            storage.durableRuns.getRun(deliveryRunId).metadata ?? {},
            "unknown_after_send: provider acknowledgement was lost",
          );
          const recovered = await service.recoverPendingAgentTurnCronRuns();
          expect(recovered.reconciliationCount).toBe(1);
          expect(storage.cronRuns.get(admitted.runId)).toMatchObject({
            status: "manual_reconciliation_required",
            reconciliationReason: expect.stringContaining("unknown external outcome"),
          });
          expect(storage.cronJobs.get(jobId)).toMatchObject({
            activeRunId: admitted.runId,
            lastRunStatus: "failed",
          });
        }
      }
    } finally {
      storage.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
