import { describe, expect, it, vi } from "vitest";
import type { OrchestrationCheckpoint } from "@goatcitadel/storage";
import type { DurableRunRecord, OrchestrationPlan, OrchestrationRun } from "@goatcitadel/contracts";
import {
  approvePhase,
  createOrchestrationPlan,
  executeDurableOrchestrationRun,
  runOrchestrationPlan,
  type OrchestrationLifecycleHost,
} from "./orchestration-lifecycle-service.js";

function buildPlan(): OrchestrationPlan {
  return {
    planId: "plan-1",
    goal: "Ship safely",
    mode: "auto",
    maxIterations: 3,
    maxRuntimeMinutes: 15,
    maxCostUsd: 5,
    waves: [
      {
        waveId: "wave-1",
        verify: [],
        budgetUsd: 2,
        ownership: [],
        phases: [
          {
            phaseId: "phase-1",
            ownerAgentId: "agent-1",
            specPath: "spec.md",
            loopMode: "fresh-context",
            requiresApproval: true,
          },
        ],
      },
    ],
  };
}

function buildRun(planId = "plan-1"): OrchestrationRun {
  return {
    runId: "run-1",
    planId,
    status: "queued",
    startedAt: "2026-04-12T00:00:00.000Z",
    totalIterations: 0,
    totalCostUsd: 0,
    workspaceId: "default",
    executionState: "created",
    worktreeStatus: "uninitialized",
    worktreeBaseRef: "HEAD",
  };
}

function createHost(overrides: Partial<OrchestrationLifecycleHost> = {}): OrchestrationLifecycleHost {
  const checkpoints: OrchestrationCheckpoint[] = [];
  const plan = buildPlan();
  let run = buildRun();
  let durableRun: DurableRunRecord = {
    runId: "durable-run-1",
    workflowKey: "orchestration.plan.execute",
    status: "queued",
    attemptCount: 0,
    maxAttempts: 3,
    version: 1,
    payload: {
      version: "orchestration.plan.execute.v1",
      orchestrationRunId: "run-1",
      planId: "plan-1",
      workspaceId: "default",
      requestedAt: "2026-04-12T00:00:00.000Z",
    },
    metadata: {},
    createdAt: "2026-04-12T00:00:00.000Z",
    updatedAt: "2026-04-12T00:00:00.000Z",
  };
  const storage = {
    orchestration: {
      upsertPlan: vi.fn(),
      getPlan: vi.fn(() => plan),
      createRun: vi.fn((value: OrchestrationRun) => {
        run = value;
        return value;
      }),
      findLatestRunByPlan: vi.fn(() => undefined),
      updateRun: vi.fn((value: OrchestrationRun) => {
        run = value;
        return value;
      }),
      appendRunEvent: vi.fn(),
      listCheckpoints: vi.fn(() => checkpoints),
      getRun: vi.fn(() => run),
    },
  };

  return {
    config: {
      assistant: {
        memory: {
          enabled: true,
          qmd: {
            applyToOrchestration: true,
          },
        },
      },
    },
    storage,
    orchestrationEngine: {
      createRun: vi.fn(() => run),
      startRun: vi.fn(
        () =>
          ({
            ...run,
            status: "running",
            currentWaveId: "wave-1",
            currentPhaseId: "phase-1",
          }) as OrchestrationRun,
      ),
      approvePhase: vi.fn(
        () =>
          ({
            ...run,
            status: "completed",
            currentWaveId: undefined,
            currentPhaseId: undefined,
            totalIterations: 1,
            totalCostUsd: 0.5,
          }) as OrchestrationRun,
      ),
      advancePhase: vi.fn(
        () =>
          ({
            ...run,
            status: "paused",
            currentWaveId: "wave-1",
            currentPhaseId: "phase-1",
            totalIterations: 1,
          }) as OrchestrationRun,
      ),
    },
    hooksService: {
      runInlineHooks: vi.fn(async () => ({ blockedBy: undefined, patch: undefined })),
      enqueueAfterHooks: vi.fn(),
    },
    createCheckpoint: vi.fn((input) => {
      const checkpoint = {
        checkpointId: `cp-${checkpoints.length + 1}`,
        createdAt: "2026-04-12T00:00:00.000Z",
        gitRef: "abc123",
        ...input,
      } as OrchestrationCheckpoint;
      checkpoints.push(checkpoint);
      return checkpoint;
    }),
    publishRealtime: vi.fn(),
    scheduleOrchestrationMemoryContext: vi.fn(),
    parseOrchestrationRunHookPatch: vi.fn(() => undefined),
    parseOrchestrationPhaseHookPatch: vi.fn(() => undefined),
    applyOrchestrationPhaseHookPatch: vi.fn((currentPlan) => currentPlan),
    createDurableRun: vi.fn(() => durableRun),
    getDurableRun: vi.fn(() => durableRun),
    requestDurableRunProcessing: vi.fn(),
    pauseDurableRun: vi.fn(() => ({
      ...durableRun,
      status: "paused",
    })),
    resumeDurableRun: vi.fn(() => {
      durableRun = {
        ...durableRun,
        status: "queued",
        version: durableRun.version + 1,
        updatedAt: "2026-04-12T00:00:00.000Z",
      };
      return durableRun;
    }),
    updateDurableRunState: vi.fn((input) => {
      durableRun = {
        ...durableRun,
        ...(input.status ? { status: input.status } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
        ...(input.finishedAt !== undefined ? { finishedAt: input.finishedAt } : {}),
        updatedAt: "2026-04-12T00:00:00.000Z",
        version: durableRun.version + 1,
      };
      return durableRun;
    }),
    allocateOrchestrationWorktree: vi.fn(async () => ({
      worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-1",
      worktreeStatus: "ready" as const,
      worktreeBaseRef: "HEAD",
    })),
    recordDurableTimelineEvent: vi.fn(),
    ...overrides,
  };
}

describe("orchestration-lifecycle-service", () => {
  it("creates a run with durable and worktree ownership", async () => {
    const host = createHost();
    const plan = buildPlan();

    const result = await createOrchestrationPlan(host, plan);

    expect(result.runId).toBe("run-1");
    expect(result.durableRunId).toBe("durable-run-1");
    expect(result.worktreeStatus).toBe("ready");
    expect(host.storage.orchestration.upsertPlan).toHaveBeenCalledWith(plan);
    expect(host.createDurableRun).toHaveBeenCalled();
    expect(host.pauseDurableRun).toHaveBeenCalledWith("durable-run-1", "orchestration");
    expect(host.allocateOrchestrationWorktree).toHaveBeenCalled();
    expect(host.createCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        planId: "plan-1",
        checkpointKind: "run_created",
      }),
    );
    expect(host.publishRealtime).toHaveBeenCalledWith(
      "orchestration_event",
      "orchestration",
      expect.objectContaining({
        runId: "run-1",
        event: "run_created",
      }),
      expect.objectContaining({
        eventClass: "domain_fact",
        eventAuthority: "retained_stream",
        links: {
          runId: "run-1",
          workspaceId: "default",
        },
      }),
    );
  });

  it("queues plans for durable execution and schedules orchestration memory context when enabled", async () => {
    const host = createHost();

    const result = await runOrchestrationPlan(host, "plan-1");

    expect(result.status).toBe("queued");
    expect(result.executionState).toBe("queued");
    expect(host.storage.orchestration.findLatestRunByPlan).not.toHaveBeenCalled();
    expect(host.storage.orchestration.createRun).toHaveBeenCalledTimes(1);
    expect(host.orchestrationEngine.startRun).not.toHaveBeenCalled();
    expect(host.resumeDurableRun).toHaveBeenCalledWith("durable-run-1", "orchestration");
    expect(host.requestDurableRunProcessing).toHaveBeenCalledWith("durable-run-1");
    expect(host.scheduleOrchestrationMemoryContext).toHaveBeenCalledWith(
      expect.objectContaining({ planId: "plan-1" }),
      result,
    );
    expect(host.publishRealtime).toHaveBeenCalledWith(
      "orchestration_event",
      "orchestration",
      expect.objectContaining({
        runId: "run-1",
        event: "run_queued",
      }),
      expect.objectContaining({
        eventClass: "domain_fact",
        eventAuthority: "retained_stream",
        links: {
          runId: "run-1",
          workspaceId: "default",
        },
      }),
    );
  });

  it("marks orchestration runs failed when worktree allocation fails", async () => {
    const host = createHost({
      allocateOrchestrationWorktree: vi.fn(async () => {
        throw new Error("worktree allocation unavailable");
      }),
    });

    const result = await createOrchestrationPlan(host, buildPlan());

    expect(result.status).toBe("failed");
    expect(result.executionState).toBe("failed");
    expect(result.worktreeStatus).toBe("blocked");
    expect(result.lastError).toContain("worktree allocation unavailable");
    expect(host.recordDurableTimelineEvent).toHaveBeenCalledWith(
      "durable-run-1",
      "run_failed",
      expect.objectContaining({
        phase: "worktree_allocation",
      }),
    );
    expect(host.createCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointKind: "run_failed",
      }),
    );
  });

  it("approves phases by marking resume intent and requeueing durable execution", async () => {
    const host = createHost({
      storage: {
        orchestration: {
          ...createHost().storage.orchestration,
          getRun: vi.fn(() => ({
            ...buildRun(),
            status: "paused",
            executionState: "paused_for_approval",
            currentWaveId: "wave-1",
            currentPhaseId: "phase-1",
            durableRunId: "durable-run-1",
            worktreeStatus: "ready",
          })),
        },
      } as OrchestrationLifecycleHost["storage"],
    });

    const result = await approvePhase(host, "run-1", "phase-1", "operator", 0.5);

    expect(result.run.status).toBe("paused");
    expect(result.run.executionState).toBe("resume_requested");
    expect(result.run.pendingApprovalPhaseId).toBe("phase-1");
    expect(host.orchestrationEngine.approvePhase).not.toHaveBeenCalled();
    expect(host.resumeDurableRun).toHaveBeenCalledWith("durable-run-1", "orchestration");
    expect(host.requestDurableRunProcessing).toHaveBeenCalledWith("durable-run-1");
    expect(host.createCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointKind: "phase_approved",
        phaseId: "phase-1",
      }),
    );
    expect(host.hooksService.enqueueAfterHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "orchestration.phase.after",
        entityId: "run-1:phase-1",
      }),
    );
    expect(host.publishRealtime).toHaveBeenCalledWith(
      "orchestration_event",
      "orchestration",
      expect.objectContaining({
        runId: "run-1",
        event: "phase_approved",
        phaseId: "phase-1",
      }),
      expect.objectContaining({
        eventClass: "domain_fact",
        eventAuthority: "retained_stream",
        links: {
          runId: "run-1",
          workspaceId: "default",
        },
      }),
    );
  });

  it("rejects approvals when the run is not paused", async () => {
    const host = createHost({
      storage: {
        orchestration: {
          ...createHost().storage.orchestration,
          getRun: vi.fn(() => ({
            ...buildRun(),
            status: "running",
          })),
        },
      } as OrchestrationLifecycleHost["storage"],
    });

    await expect(approvePhase(host, "run-1", "phase-1", "operator", 0.5)).rejects.toThrow("not waiting for approval");
  });

  it("rejects approvals for non-approval phases in auto mode", async () => {
    const plan = {
      ...buildPlan(),
      mode: "auto" as const,
      waves: [
        {
          ...buildPlan().waves[0]!,
          phases: [
            {
              ...buildPlan().waves[0]!.phases[0]!,
              requiresApproval: false,
            },
          ],
        },
      ],
    };
    const host = createHost({
      storage: {
        orchestration: {
          ...createHost().storage.orchestration,
          getPlan: vi.fn(() => plan),
          getRun: vi.fn(() => ({
            ...buildRun(),
            status: "paused",
            currentWaveId: "wave-1",
            currentPhaseId: "phase-1",
          })),
        },
      } as OrchestrationLifecycleHost["storage"],
    });

    await expect(approvePhase(host, "run-1", "phase-1", "operator", 0.5)).rejects.toThrow("not approval-gated");
  });

  it("executes orchestration through the durable workflow path and pauses for approval", async () => {
    const host = createHost({
      storage: {
        orchestration: {
          ...createHost().storage.orchestration,
          getRun: vi.fn(() => ({
            ...buildRun(),
            durableRunId: "durable-run-1",
            executionState: "queued",
            worktreeStatus: "ready",
            worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-1",
          })),
        },
      } as OrchestrationLifecycleHost["storage"],
    });

    const durableRun = host.getDurableRun("durable-run-1");
    const result = await executeDurableOrchestrationRun(host, durableRun);

    expect(result.outcome).toBe("paused");
    expect(host.orchestrationEngine.startRun).toHaveBeenCalled();
    expect(host.orchestrationEngine.advancePhase).toHaveBeenCalledWith(
      expect.objectContaining({ planId: "plan-1" }),
      expect.objectContaining({ currentPhaseId: "phase-1" }),
      "phase-1",
    );
    expect(host.pauseDurableRun).toHaveBeenCalledWith("durable-run-1", "orchestration");
    expect(host.recordDurableTimelineEvent).toHaveBeenCalledWith("durable-run-1", "run_started", expect.any(Object));
  });
});
