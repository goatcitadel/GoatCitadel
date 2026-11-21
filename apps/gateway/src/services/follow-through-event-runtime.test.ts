import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { Storage, createLocalAsyncStorage } from "@goatcitadel/storage";
import { canonicalJsonString, computeEffectiveChatTurnRequestMaterialSha256 } from "@goatcitadel/contracts";
import {
  followThroughEventCursorKey,
  runFollowThroughEventSweep,
  validateFollowThroughEventSource,
} from "./follow-through-event-runtime.js";
const hash = (value: unknown) => createHash("sha256").update(canonicalJsonString(value)).digest("hex");
it("persists scoped progress through quiet hours and restart, retaining one canonical occurrence after an unknown outcome", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-event-wake-"));
  expect(path.dirname(path.resolve(root))).toBe(path.resolve(os.tmpdir()));
  expect(path.basename(root)).toMatch(/^gc-event-wake-/u);
  const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(root, "t"),
      auditDir: path.join(root, "a"),
    }),
    store = createLocalAsyncStorage(storage);
  try {
    const job = storage.cronJobs.upsert({
      jobId: "event-job",
      name: "Inspect a finished subagent",
      action: "agent_turn",
      enabled: true,
      schedule: "* * * * * UTC",
      actionConfig: {
        agentTurn: {
          sessionId: "s",
          prompt: "Report only a changed result",
          deliverMode: "on_notify",
          createdBy: { operatorId: "operator", authActorId: "operator", permissionProfileId: "profile", depth: 0 },
          eventWake: {
            version: 1,
            eventType: "subagent.end",
            hookId: "h",
            workspaceId: "default",
            sourceSessionId: "s",
            notBefore: "2026-11-19T00:00:00.000Z",
            timezone: "UTC",
          },
        },
      },
    });
    storage.cronJobs.bindCreatorAuthority(job.jobId, job.revision, {
      actorId: "operator",
      source: "authenticated_operator",
    });
    const event = storage.hookRuns.create(
      {
        hookId: "h",
        workspaceId: "default",
        trigger: "subagent.end",
        entityType: "chat_subagent",
        entityId: "child",
        mode: "observe",
        status: "completed",
        idempotencyKey: "event",
        attemptCount: 1,
        requestPayload: {
          parentSessionId: "s",
          childSessionId: "child",
          delegationRunId: "delegation",
          stepId: "step",
          status: "completed",
        },
        completedAt: "2026-11-19T01:00:00.000Z",
      },
      "2026-11-19T01:00:00.000Z",
    );
    const request = { content: "Inspect the supplied result" },
      admissionMaterialSha256 = hash({ version: 2, request });
    const payload = {
      version: "chat.turn.execute.v2",
      admissionId: "admission",
      sessionIncarnationId: "incarnation",
      admissionMaterialSha256,
      workspaceId: "default",
      admissionAggregateRevision: 1,
      admissionControllerGeneration: 1,
      effectiveRequestMaterialSha256: computeEffectiveChatTurnRequestMaterialSha256(admissionMaterialSha256, request),
      policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId: "parent" },
      requestActor: { actorKind: "operator", actorId: "operator", authActorId: "operator" },
      sessionId: "s",
      turnId: "parent-turn",
      userMessageId: "u",
      assistantMessageId: "a",
      branchKind: "send",
      threadEventType: "message_sent",
      request,
    };
    const meta = {
        workspaceId: "default",
        origin: "operator",
        lifecycleStatus: "active",
        lifecycleIntentId: "incarnation",
      },
      message = { sessionId: "s", role: "user", actorType: "user", sourceAuthority: "operator" };
    const runtimeStorage = {
      systemSettings: store.systemSettings,
      cronJobs: store.cronJobs,
      cronRuns: store.cronRuns,
      hookRuns: store.hookRuns,
      workspaceHooks: { get: async () => ({ enabled: true, trigger: "subagent.end", mode: "observe" }) },
      chatSessionMeta: { get: async () => meta },
      sessions: { getBySessionId: async () => ({ kind: "dm" }) },
      chatDelegationRuns: { get: async () => ({ runId: "delegation", parentRunId: "parent", sessionId: "s" }) },
      chatDelegationSteps: {
        get: async () => ({
          runId: "delegation",
          stepId: "step",
          status: "completed",
          childSessionId: "child",
          finishedAt: event.completedAt,
        }),
      },
      durableRuns: { getRun: async () => ({ runId: "parent", workflowKey: "chat.turn.execute", payload }) },
      chatTurnTraces: { get: async () => ({ turnId: "parent-turn", sessionId: "s", userMessageId: "u" }) },
      chatMessages: { get: async () => message },
      sessionAutonomyPrefs: { get: async () => ({ activeHours: { start: 8, end: 22, tz: "UTC" } }) },
    } as never;
    const run = vi.fn(async (jobId: string, options: any) => {
      const result = await store.cronRuns.beginAdmission({
        jobId,
        admissionKey: options.admissionKey,
        scheduledFor: options.scheduledFor,
        expectedJobRevision: options.expectedRevision,
        eventSource: options.eventSource,
        trigger: "manual",
      });
      return {
        jobId,
        runId: result.outcome === "blocked" ? result.activeRun.runId : result.run.runId,
        status: "pending" as const,
      };
    });
    const cron = { listCronJobs: () => store.cronJobs.list(), runCronJobNow: run };
    const quiet = await runFollowThroughEventSweep({
      storage: runtimeStorage,
      cron,
      isEnabled: async () => true,
      now: () => new Date("2026-11-19T02:00:00Z"),
    });
    expect(quiet).toMatchObject({ scanned: 1, queued: 0, blocked: 1 });
    expect(run).not.toHaveBeenCalled();
    expect(storage.systemSettings.get(followThroughEventCursorKey(job))).toBeUndefined();
    const active = await runFollowThroughEventSweep({
      storage: runtimeStorage,
      cron,
      isEnabled: async () => true,
      now: () => new Date("2026-11-19T09:00:00Z"),
    });
    expect(active.queued).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
    const admitted = storage.cronRuns.listByJob(job.jobId)[0]!;
    storage.cronRuns.requireReconciliation(
      { runId: admitted.runId, jobId: admitted.jobId, executionGeneration: admitted.executionGeneration },
      { reason: "synthetic_unknown_external_send" },
    );
    const restarted = await runFollowThroughEventSweep({
      storage: runtimeStorage,
      cron,
      isEnabled: async () => true,
      now: () => new Date("2026-11-19T10:00:00Z"),
    });
    expect(restarted.scanned).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(storage.cronRuns.listByJob(job.jobId)).toHaveLength(1);
    const currentJob = storage.cronJobs.get(job.jobId)!;
    expect(await validateFollowThroughEventSource(runtimeStorage, currentJob, event)).toBe(true);
    message.sourceAuthority = "external_user";
    expect(await validateFollowThroughEventSource(runtimeStorage, currentJob, event)).toBe(false);
    message.sourceAuthority = "operator";
    meta.lifecycleStatus = "archived";
    expect(await validateFollowThroughEventSource(runtimeStorage, currentJob, event)).toBe(false);
  } finally {
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
