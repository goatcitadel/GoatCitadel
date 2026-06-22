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
});

describe("runAgentTurnCronJob", () => {
  it("records success, computes next run, and emits the enqueued realtime event", async () => {
    const job = buildAgentTurnJob();
    const upsertCronJob = vi.fn((next: CronJobRecord) => next);
    const publishRealtime = vi.fn();
    const runHandler: AgentTurnCronRunHandler = vi.fn(async () => ({
      mode: "agent_turn" as const,
      durableRunId: "durable-1",
      sessionId: "sess_cron",
      turnId: "turn-1",
    }));

    const summary = await runAgentTurnCronJob({
      job,
      normalizedJobId: job.jobId,
      runId: "run-1",
      runHandler,
      upsertCronJob,
      persistCronJobsConfig: () => {},
      publishRealtime,
      computeNextCronRunAt: () => "2026-05-15T12:00:00.000Z",
    });

    expect(runHandler).toHaveBeenCalledWith({ job, runId: "run-1", config: job.actionConfig?.agentTurn });
    const savedRecord = upsertCronJob.mock.calls[0]?.[0];
    expect(savedRecord).toMatchObject({ lastRunStatus: "ok", lastRunId: "run-1", failureCount: 0 });
    expect(publishRealtime).toHaveBeenCalledWith(
      "cron_job_run",
      "cron",
      expect.objectContaining({
        type: "cron_agent_turn_enqueued",
        jobId: job.jobId,
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
      durableRunId: "durable-1",
      nextRunAt: "2026-05-15T12:00:00.000Z",
    });
  });

  it("emits a scheduled_task_created event for the inert inbox fallback", async () => {
    const job = buildAgentTurnJob({
      actionConfig: {
        agentTurn: { prompt: "Fallback prompt", inertInboxFallback: true },
      },
    });
    const publishRealtime = vi.fn();
    const runHandler: AgentTurnCronRunHandler = vi.fn(async () => ({
      mode: "inbox" as const,
      taskId: "task-1",
    }));

    const summary = await runAgentTurnCronJob({
      job,
      normalizedJobId: job.jobId,
      runId: "run-2",
      runHandler,
      upsertCronJob: (next) => next,
      persistCronJobsConfig: () => {},
      publishRealtime,
      computeNextCronRunAt: () => undefined,
    });

    expect(publishRealtime).toHaveBeenCalledWith(
      "cron_job_run",
      "cron",
      expect.objectContaining({ type: "scheduled_task_created", taskId: "task-1" }),
    );
    expect(summary).toMatchObject({ mode: "inbox", taskId: "task-1" });
  });

  it("throws when the job is missing an agent_turn prompt", async () => {
    const job = buildAgentTurnJob({ actionConfig: { agentTurn: { prompt: "" } } });
    await expect(
      runAgentTurnCronJob({
        job,
        normalizedJobId: job.jobId,
        runId: "run-3",
        runHandler: vi.fn(),
        upsertCronJob: (next) => next,
        persistCronJobsConfig: () => {},
        publishRealtime: vi.fn(),
        computeNextCronRunAt: () => undefined,
      }),
    ).rejects.toThrow("agent_turn cron job missing prompt");
  });
});
