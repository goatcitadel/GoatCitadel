import { describe, expect, it, vi } from "vitest";
import type { DurableRunRecord } from "@goatcitadel/contracts";
vi.mock("@goatcitadel/storage", () => ({}));
vi.mock("sqlite", () => ({}));
import {
  buildDurableChatTurnResumeContent,
  buildDurableWorkflowExecutors,
  createDurableWorkflowExecutorRegistry,
  type DurableWorkflowExecutorHosts,
} from "./durable-execution-service.js";

function buildRun(): DurableRunRecord {
  return {
    runId: "durable-run-1",
    workflowKey: "orchestration.plan.execute",
    status: "queued",
    attemptCount: 0,
    maxAttempts: 3,
    version: 1,
    payload: {
      version: "orchestration.plan.execute.v1",
      orchestrationRunId: "orch-run-1",
      planId: "plan-1",
      workspaceId: "default",
      requestedAt: "2026-04-19T00:00:00.000Z",
    },
    metadata: {
      orchestrationRunId: "orch-run-1",
      worktreePath: "F:/code/personal-ai/.worktrees/orchestration/orch-run-1",
    },
    createdAt: "2026-04-19T00:00:00.000Z",
    updatedAt: "2026-04-19T00:00:00.000Z",
  };
}

function createHosts(outcome: "paused" | "completed"): {
  hosts: DurableWorkflowExecutorHosts;
  durableRuns: {
    getRun: ReturnType<typeof vi.fn>;
    updateRun: ReturnType<typeof vi.fn>;
    createCheckpoint: ReturnType<typeof vi.fn>;
  };
  publishRealtime: ReturnType<typeof vi.fn>;
  recordDurableTimelineEvent: ReturnType<typeof vi.fn>;
  executeDurableOrchestrationRun: ReturnType<typeof vi.fn>;
} {
  let storedRun = buildRun();
  const durableRuns = {
    getRun: vi.fn((runId: string) => {
      expect(runId).toBe("durable-run-1");
      return storedRun;
    }),
    updateRun: vi.fn((patch: Record<string, unknown>) => {
      storedRun = {
        ...storedRun,
        ...(patch.status ? { status: patch.status as DurableRunRecord["status"] } : {}),
        ...(patch.updatedAt ? { updatedAt: patch.updatedAt as string } : {}),
        ...(patch.finishedAt ? { finishedAt: patch.finishedAt as string } : {}),
        ...(patch.lastError !== undefined ? { lastError: patch.lastError as string | undefined } : {}),
        version: storedRun.version + 1,
      };
      return storedRun;
    }),
    createCheckpoint: vi.fn(),
  };
  const publishRealtime = vi.fn();
  const recordDurableTimelineEvent = vi.fn();
  const executeDurableOrchestrationRun = vi.fn(async () => ({
    outcome,
    checkpointState: {
      orchestrationRunId: "orch-run-1",
      executionState: outcome === "paused" ? "paused_for_approval" : "completed",
      worktreeStatus: "ready",
    },
  }));

  const orchestrationHost = {
    storage: {
      durableRuns,
    },
    publishRealtime,
    recordDurableTimelineEvent,
    executeDurableOrchestrationRun,
    durableRunService: {},
  } as unknown as DurableWorkflowExecutorHosts["orchestration"];

  const inertHost = {} as DurableWorkflowExecutorHosts["memoryMaintenance"];

  return {
    hosts: {
      memoryMaintenance: inertHost,
      chatTurn: {} as DurableWorkflowExecutorHosts["chatTurn"],
      proactiveTick: {} as DurableWorkflowExecutorHosts["proactiveTick"],
      approvalWait: {} as DurableWorkflowExecutorHosts["approvalWait"],
      connectorDelivery: {} as DurableWorkflowExecutorHosts["connectorDelivery"],
      hookDelivery: {} as DurableWorkflowExecutorHosts["hookDelivery"],
      orchestration: orchestrationHost,
    },
    durableRuns,
    publishRealtime,
    recordDurableTimelineEvent,
    executeDurableOrchestrationRun,
  };
}

describe("durable-execution-service orchestration workflow", () => {
  it("merges answered user-input prompts into resumed chat content", () => {
    expect(
      buildDurableChatTurnResumeContent("Ship it", [
        {
          promptId: "prompt-1",
          kind: "single_select",
          title: "Choose target",
          question: "Which environment should we deploy to?",
          answeredAt: "2026-04-19T00:00:00.000Z",
          response: { kind: "single_select", optionId: "prod" },
          selectedOption: {
            optionId: "prod",
            label: "Production",
            description: "Deploy to the live environment.",
          },
        },
        {
          promptId: "prompt-2",
          kind: "text",
          question: "Anything else to keep in mind?",
          answeredAt: "2026-04-19T00:00:01.000Z",
          response: { kind: "text", text: "Hold until the migration window opens." },
        },
      ]),
    ).toContain("Resume context from answered blocking prompts:");
    expect(
      buildDurableChatTurnResumeContent("Ship it", [
        {
          promptId: "prompt-1",
          kind: "single_select",
          title: "Choose target",
          question: "Which environment should we deploy to?",
          answeredAt: "2026-04-19T00:00:00.000Z",
          response: { kind: "single_select", optionId: "prod" },
          selectedOption: {
            optionId: "prod",
            label: "Production",
            description: "Deploy to the live environment.",
          },
        },
      ]),
    ).toContain("Answer: Production");
    expect(
      buildDurableChatTurnResumeContent("Ship it", [
        {
          promptId: "prompt-2",
          kind: "text",
          question: "Anything else to keep in mind?",
          answeredAt: "2026-04-19T00:00:01.000Z",
          response: { kind: "text", text: "Hold until the migration window opens." },
        },
      ]),
    ).toContain("Answer: Hold until the migration window opens.");
  });

  it("registers orchestration.plan.execute and leaves paused runs open", async () => {
    const { hosts, durableRuns, executeDurableOrchestrationRun } = createHosts("paused");
    const registry = createDurableWorkflowExecutorRegistry(buildDurableWorkflowExecutors(hosts));
    const run = buildRun();

    await registry.executeWorkflow(run);

    expect(executeDurableOrchestrationRun).toHaveBeenCalledWith(run, undefined);
    expect(durableRuns.updateRun).not.toHaveBeenCalled();
    expect(durableRuns.createCheckpoint).not.toHaveBeenCalled();
  });

  it("completes orchestration.plan.execute runs through the durable registry", async () => {
    const { hosts, durableRuns, publishRealtime, recordDurableTimelineEvent, executeDurableOrchestrationRun } =
      createHosts("completed");
    const registry = createDurableWorkflowExecutorRegistry(buildDurableWorkflowExecutors(hosts));
    const run = buildRun();

    await registry.executeWorkflow(run);

    expect(executeDurableOrchestrationRun).toHaveBeenCalledWith(run, undefined);
    expect(durableRuns.updateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "durable-run-1",
        status: "completed",
        clearLease: true,
      }),
    );
    expect(durableRuns.createCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "durable-run-1",
        checkpointKind: "run_completed",
      }),
    );
    expect(recordDurableTimelineEvent).toHaveBeenCalledWith(
      "durable-run-1",
      "run_completed",
      expect.objectContaining({
        orchestrationRunId: "orch-run-1",
      }),
    );
    expect(publishRealtime).toHaveBeenCalledWith(
      "system",
      "durable",
      expect.objectContaining({
        type: "durable_run_completed",
        runId: "durable-run-1",
      }),
      expect.objectContaining({
        eventClass: "domain_fact",
        eventAuthority: "retained_stream",
        links: expect.objectContaining({
          runId: "durable-run-1",
        }),
      }),
    );
  });
});
