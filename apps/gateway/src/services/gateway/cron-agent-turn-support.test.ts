import { describe, expect, it, vi } from "vitest";
import type { CronJobRecord } from "@goatcitadel/contracts";
import {
  normalizeAgentTurnCronActionConfig,
  runAgentTurnCronJob,
  type AgentTurnCronRunHandler,
} from "./cron-agent-turn-support.js";

function buildAgentTurnJob(overrides: Partial<CronJobRecord> = {}): CronJobRecord {
  return {
    jobId: "agent-turn-job",
    revision: 1,
    name: "Agent turn job",
    action: "agent_turn",
    schedule: "0 12 * * * UTC",
    enabled: true,
    actionConfig: {
      agentTurn: {
        prompt: "Summarize overnight alerts.",
        deliveryChannel: { channelKey: "telegram", target: "123" },
        deliverMode: "always",
      },
    },
    ...overrides,
  };
}

describe("normalizeAgentTurnCronActionConfig", () => {
  it("rejects a missing or empty prompt", () => {
    expect(() => normalizeAgentTurnCronActionConfig({})).toThrow("non-empty actionConfig.agentTurn.prompt");
    expect(() => normalizeAgentTurnCronActionConfig({ agentTurn: {} })).toThrow(
      "non-empty actionConfig.agentTurn.prompt",
    );
    expect(() => normalizeAgentTurnCronActionConfig({ agentTurn: { prompt: "   " } })).toThrow(
      "non-empty actionConfig.agentTurn.prompt",
    );
  });

  it("normalizes prompt, session, delivery channel, and deliver mode", () => {
    const config = normalizeAgentTurnCronActionConfig({
      agentTurn: {
        prompt: "  Check the queue.  ",
        sessionId: "  sess_cron  ",
        deliveryChannel: { channelKey: "  telegram  ", target: "  42  " },
        deliverMode: "on_notify",
        inertInboxFallback: true,
      },
    });
    expect(config).toEqual({
      agentTurn: {
        prompt: "Check the queue.",
        sessionId: "sess_cron",
        deliveryChannel: { channelKey: "telegram", target: "42" },
        deliverMode: "on_notify",
        inertInboxFallback: true,
      },
    });
  });

  it("defaults deliverMode to always and drops empty optional fields", () => {
    const config = normalizeAgentTurnCronActionConfig({
      agentTurn: { prompt: "Do it", deliveryChannel: { channelKey: "telegram" } },
    });
    expect(config).toEqual({
      agentTurn: {
        prompt: "Do it",
        deliveryChannel: { channelKey: "telegram" },
        deliverMode: "always",
      },
    });
  });

  it("preserves schedule.manage creator provenance (P1-F2)", () => {
    const config = normalizeAgentTurnCronActionConfig({
      agentTurn: {
        prompt: "Scheduled work",
        createdBy: {
          operatorId: "  op-1  ",
          authActorId: "  op-1  ",
          permissionProfileId: "  trusted_local_power  ",
          createdByJobId: "  parent-job  ",
          depth: 1,
        },
      },
    });
    expect(config?.agentTurn?.createdBy).toEqual({
      operatorId: "op-1",
      authActorId: "op-1",
      permissionProfileId: "trusted_local_power",
      createdByJobId: "parent-job",
      depth: 1,
    });
  });

  it("drops a creator block with no usable fields", () => {
    const config = normalizeAgentTurnCronActionConfig({
      agentTurn: { prompt: "Scheduled work", createdBy: { operatorId: "   " } },
    });
    expect(config?.agentTurn?.createdBy).toBeUndefined();
  });
});

describe("runAgentTurnCronJob", () => {
  it("passes the execution token, attaches exact child linkage, and emits a non-terminal admitted event", async () => {
    const job = buildAgentTurnJob();
    const cronRun = { runId: "run-1", jobId: job.jobId, executionGeneration: 4 };
    const attachDeterministicChild = vi.fn((_token, linkage) => ({
      ...cronRun,
      admissionKey: "manual:run-1",
      trigger: "manual" as const,
      jobRevision: 1,
      action: "agent_turn" as const,
      actionSnapshot: {},
      scheduledFor: "2026-05-14T12:00:00.000Z",
      status: "admitted" as const,
      phase: "chat_execution" as const,
      ...linkage,
      createdAt: "2026-05-14T12:00:00.000Z",
      updatedAt: "2026-05-14T12:00:00.000Z",
    }));
    const publishRealtime = vi.fn();
    const runHandler: AgentTurnCronRunHandler = vi.fn(async () => ({
      mode: "agent_turn" as const,
      durableRunId: "durable-1",
      sessionId: "sess_cron",
      turnId: "turn-1",
      userMessageId: "message-user-1",
      assistantMessageId: "message-assistant-1",
    }));

    const summary = await runAgentTurnCronJob({
      job,
      normalizedJobId: job.jobId,
      runId: "run-1",
      cronRun,
      runHandler,
      attachDeterministicChild,
      publishRealtime,
    });

    expect(runHandler).toHaveBeenCalledWith({
      job,
      runId: "run-1",
      config: job.actionConfig?.agentTurn,
      cronRun,
    });
    expect(attachDeterministicChild).toHaveBeenCalledWith(
      cronRun,
      {
        childSessionId: "sess_cron",
        childMessageId: "message-user-1",
        childTurnId: "turn-1",
        childAssistantMessageId: "message-assistant-1",
        childDurableRunId: "durable-1",
      },
      expect.any(String),
    );
    expect(publishRealtime).toHaveBeenCalledWith(
      "cron_job_run",
      "cron",
      expect.objectContaining({
        type: "cron_agent_turn_admitted",
        jobId: job.jobId,
        executionGeneration: 4,
        durableRunId: "durable-1",
        sessionId: "sess_cron",
        turnId: "turn-1",
        deliveryChannel: { channelKey: "telegram", target: "123" },
      }),
    );
    expect(summary).toMatchObject({
      action: "agent_turn",
      runId: "run-1",
      mode: "agent_turn",
      status: "admitted",
      durableRunId: "durable-1",
    });
  });

  it("emits a scheduled_task_created event for the inert inbox fallback", async () => {
    const job = buildAgentTurnJob({
      actionConfig: {
        agentTurn: { prompt: "Fallback prompt", inertInboxFallback: true },
      },
    });
    const publishRealtime = vi.fn();
    const cronRun = { runId: "run-2", jobId: job.jobId, executionGeneration: 1 };
    const attachDeterministicChild = vi.fn();
    const runHandler: AgentTurnCronRunHandler = vi.fn(async () => ({
      mode: "inbox" as const,
      taskId: "task-1",
    }));

    const summary = await runAgentTurnCronJob({
      job,
      normalizedJobId: job.jobId,
      runId: "run-2",
      cronRun,
      runHandler,
      attachDeterministicChild,
      publishRealtime,
    });

    expect(attachDeterministicChild).not.toHaveBeenCalled();
    expect(publishRealtime).toHaveBeenCalledWith(
      "cron_job_run",
      "cron",
      expect.objectContaining({ type: "scheduled_task_created", taskId: "task-1" }),
    );
    expect(summary).toMatchObject({ mode: "inbox", status: "inbox_created", taskId: "task-1" });
  });

  it("fails closed when the deterministic child omits canonical linkage", async () => {
    const job = buildAgentTurnJob();
    const cronRun = { runId: "run-missing", jobId: job.jobId, executionGeneration: 2 };
    await expect(
      runAgentTurnCronJob({
        job,
        normalizedJobId: job.jobId,
        runId: cronRun.runId,
        cronRun,
        runHandler: vi.fn(async () => ({
          mode: "agent_turn" as const,
          durableRunId: "durable-missing",
          sessionId: "session-missing",
          turnId: "turn-missing",
        })),
        attachDeterministicChild: vi.fn(),
        publishRealtime: vi.fn(),
      }),
    ).rejects.toThrow("missing required linkage");
  });

  it("fails closed when exact-generation child attachment loses ownership", async () => {
    const job = buildAgentTurnJob();
    const cronRun = { runId: "run-stale", jobId: job.jobId, executionGeneration: 2 };
    await expect(
      runAgentTurnCronJob({
        job,
        normalizedJobId: job.jobId,
        runId: cronRun.runId,
        cronRun,
        runHandler: vi.fn(async () => ({
          mode: "agent_turn" as const,
          durableRunId: "durable-stale",
          sessionId: "session-stale",
          turnId: "turn-stale",
          userMessageId: "message-user-stale",
          assistantMessageId: "message-assistant-stale",
        })),
        attachDeterministicChild: vi.fn(() => undefined),
        publishRealtime: vi.fn(),
      }),
    ).rejects.toThrow("lost execution ownership");
  });

  it("rejects an execution token that does not own the invoked job/run", async () => {
    const job = buildAgentTurnJob();
    const runHandler = vi.fn();
    await expect(
      runAgentTurnCronJob({
        job,
        normalizedJobId: job.jobId,
        runId: "run-owned",
        cronRun: { runId: "run-other", jobId: job.jobId, executionGeneration: 1 },
        runHandler,
        attachDeterministicChild: vi.fn(),
        publishRealtime: vi.fn(),
      }),
    ).rejects.toThrow("does not own");
    expect(runHandler).not.toHaveBeenCalled();
  });

  it("throws when the job is missing an agent_turn prompt", async () => {
    const job = buildAgentTurnJob({ actionConfig: { agentTurn: { prompt: "" } } });
    await expect(
      runAgentTurnCronJob({
        job,
        normalizedJobId: job.jobId,
        runId: "run-3",
        cronRun: { runId: "run-3", jobId: job.jobId, executionGeneration: 1 },
        runHandler: vi.fn(),
        attachDeterministicChild: vi.fn(),
        publishRealtime: vi.fn(),
      }),
    ).rejects.toThrow("agent_turn cron job missing prompt");
  });
});
