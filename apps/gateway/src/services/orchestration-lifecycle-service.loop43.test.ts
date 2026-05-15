import { describe, expect, it, vi } from "vitest";
import type { DurableRunRecord, OrchestrationPlan, OrchestrationRun } from "@goatcitadel/contracts";
import type { OrchestrationCheckpoint } from "@goatcitadel/storage";
import {
  approvePhase,
  executeDurableOrchestrationRun,
  listRunCheckpoints,
  parseOrchestrationWorkflowPayload,
  runOrchestrationPlan,
  type OrchestrationLifecycleHost,
  type OrchestrationLifecycleRuntimeDeps,
} from "./orchestration-lifecycle-service.js";

describe("orchestration lifecycle loop43 durable edge behavior", () => {
  it("rejects invalid, mismatched, and aborted durable workflow entries", async () => {
    expect(parseOrchestrationWorkflowPayload(buildDurableRun({ payload: { version: "other" } }))).toBeUndefined();
    expect(
      parseOrchestrationWorkflowPayload(
        buildDurableRun({
          payload: {
            version: "orchestration.plan.execute.v1",
            orchestrationRunId: "run-1",
            planId: "plan-1",
            workspaceId: "default",
          },
        }),
      ),
    ).toBeUndefined();

    await expect(
      executeDurableOrchestrationRun(createHarness().host, createHarness().runtime, buildDurableRun({ payload: {} })),
    ).rejects.toThrow("payload is invalid or incomplete");

    const mismatched = createHarness({
      run: { ...buildRun(), durableRunId: "other-durable-run", executionState: "queued" },
    });
    await expect(
      executeDurableOrchestrationRun(mismatched.host, mismatched.runtime, buildDurableRun()),
    ).rejects.toThrow("is not linked to durable run durable-run-1");

    const controller = new AbortController();
    controller.abort(new Error("operator stopped durable work"));
    await expect(
      executeDurableOrchestrationRun(createHarness().host, createHarness().runtime, buildDurableRun(), {
        signal: controller.signal,
      }),
    ).rejects.toThrow("operator stopped durable work");

    const stringReasonController = new AbortController();
    stringReasonController.abort("operator stopped durable work");
    await expect(
      executeDurableOrchestrationRun(createHarness().host, createHarness().runtime, buildDurableRun(), {
        signal: stringReasonController.signal,
      }),
    ).rejects.toThrow("Durable orchestration workflow aborted.");
  });

  it("applies run hook patches before queueing and surfaces blocked run hooks", async () => {
    const patched = createHarness({
      hooksService: {
        runInlineHooks: vi.fn(async (input) => {
          input.parsePatch?.({ maxIterations: 5 });
          input.mergePatch?.({ maxIterations: 2 }, { maxRuntimeMinutes: 30 });
          return {
            patch: {
              maxIterations: 5,
              maxRuntimeMinutes: 30,
              maxCostUsd: 2.25,
            },
          };
        }),
        enqueueAfterHooks: vi.fn(),
      },
    });

    const result = await runOrchestrationPlan(patched.host, patched.runtime, "plan-1");

    expect(result.executionState).toBe("queued");
    expect(patched.host.orchestrationEngine.validate).toHaveBeenCalledWith(
      expect.objectContaining({
        maxIterations: 5,
        maxRuntimeMinutes: 30,
        maxCostUsd: 2.25,
      }),
    );
    expect(patched.host.storage.orchestration.upsertPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        maxIterations: 5,
        maxRuntimeMinutes: 30,
        maxCostUsd: 2.25,
      }),
    );

    const blocked = createHarness({
      hooksService: {
        runInlineHooks: vi.fn(async () => ({ blockedBy: { reason: "run hook denied queueing" } })),
        enqueueAfterHooks: vi.fn(),
      },
    });

    await expect(runOrchestrationPlan(blocked.host, blocked.runtime, "plan-1")).rejects.toThrow(
      "run hook denied queueing",
    );
    expect(blocked.host.requestDurableRunProcessing).not.toHaveBeenCalled();

    const failedCreate = createHarness({
      runtime: {
        worktrees: {
          allocate: vi.fn(async () => {
            throw new Error("worktree unavailable");
          }),
        },
      },
    });
    const failedRun = await runOrchestrationPlan(failedCreate.host, failedCreate.runtime, "plan-1");
    expect(failedRun.status).toBe("failed");
    expect(failedCreate.host.hooksService.runInlineHooks).not.toHaveBeenCalled();
  });

  it("guards approval resume requests against phase mismatches and phase hook policy failures", async () => {
    const mismatched = createHarness({
      run: {
        ...buildRun(),
        status: "paused",
        executionState: "paused_for_approval",
        currentWaveId: "wave-1",
        currentPhaseId: "phase-other",
        durableRunId: "durable-run-1",
      },
    });

    await expect(approvePhase(mismatched.host, "run-1", "phase-1", "operator")).rejects.toThrow(
      "expected phase phase-other",
    );

    const blocked = createHarness({
      run: {
        ...buildRun(),
        status: "paused",
        executionState: "paused_for_approval",
        currentWaveId: "wave-1",
        currentPhaseId: "phase-1",
        durableRunId: "durable-run-1",
      },
      hooksService: {
        runInlineHooks: vi.fn(async () => ({ blockedBy: { reason: "phase hook denied approval" } })),
        enqueueAfterHooks: vi.fn(),
      },
    });

    await expect(approvePhase(blocked.host, "run-1", "phase-1", "operator")).rejects.toThrow(
      "phase hook denied approval",
    );

    const approvalRemoved = createHarness({
      run: {
        ...buildRun(),
        status: "paused",
        executionState: "paused_for_approval",
        currentWaveId: "wave-1",
        currentPhaseId: "phase-1",
        durableRunId: "durable-run-1",
      },
      hooksService: {
        runInlineHooks: vi.fn(async (input) => {
          input.parsePatch?.({ requiresApproval: false });
          input.mergePatch?.({ requiresApproval: true }, { requiresApproval: false });
          return { patch: { requiresApproval: false } };
        }),
        enqueueAfterHooks: vi.fn(),
      },
    });

    await expect(approvePhase(approvalRemoved.host, "run-1", "phase-1", "operator")).rejects.toThrow(
      "not approval-gated",
    );
    expect(approvalRemoved.host.storage.orchestration.updateRunIfCurrentState).not.toHaveBeenCalled();
  });

  it("resumes durable approval runs and finalizes completed lifecycle state", async () => {
    const harness = createHarness({
      run: {
        ...buildRun(),
        status: "paused",
        executionState: "resume_requested",
        currentWaveId: "wave-1",
        currentPhaseId: "phase-1",
        pendingApprovalPhaseId: "phase-1",
        pendingApprovedBy: "operator",
        pendingCostIncrementUsd: 0.75,
        durableRunId: "durable-run-1",
        worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-1",
        worktreeStatus: "ready",
      },
      engine: {
        approvePhase: vi.fn((plan: OrchestrationPlan, run: OrchestrationRun) => ({
          ...run,
          status: "completed",
          currentWaveId: undefined,
          currentPhaseId: undefined,
          totalIterations: 1,
          totalCostUsd: 0.75,
        })),
      },
    });

    const result = await executeDurableOrchestrationRun(harness.host, harness.runtime, buildDurableRun());

    expect(result.outcome).toBe("completed");
    expect(harness.host.orchestrationEngine.approvePhase).toHaveBeenCalledWith(
      expect.objectContaining({ planId: "plan-1" }),
      expect.objectContaining({ executionState: "resume_requested" }),
      "phase-1",
      { costIncrementUsd: 0.75 },
    );
    expect(harness.host.recordDurableTimelineEvent).toHaveBeenCalledWith(
      "durable-run-1",
      "run_resumed",
      expect.any(Object),
    );
    expect(harness.runtime.worktrees.release).toHaveBeenCalledWith({
      run: expect.objectContaining({ status: "completed" }),
      reason: "completed",
    });
    expect(harness.host.createCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ checkpointKind: "run_completed" }),
    );

    const missingPending = createHarness({
      run: {
        ...buildRun(),
        status: "paused",
        executionState: "resume_requested",
        currentWaveId: "wave-1",
        currentPhaseId: "phase-1",
        durableRunId: "durable-run-1",
      },
    });
    await expect(
      executeDurableOrchestrationRun(missingPending.host, missingPending.runtime, buildDurableRun()),
    ).rejects.toThrow("missing pending approval state");
  });

  it("persists phase failure state and records cleanup failures without hiding the failed outcome", async () => {
    const harness = createHarness({
      run: {
        ...buildRun(),
        durableRunId: "durable-run-1",
        executionState: "queued",
        worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-1",
        worktreeStatus: "ready",
      },
      runtime: {
        worktrees: {
          release: vi.fn(async () => {
            throw new Error("cleanup failed");
          }),
        },
        phaseExecutor: {
          execute: vi.fn(async () => ({
            phaseId: "phase-1",
            ownerAgentId: "agent-1",
            status: "failed" as const,
            startedAt: "2026-05-15T12:00:01.000Z",
            finishedAt: "2026-05-15T12:00:02.000Z",
            outputSummary: "Phase failed",
            error: "model budget exhausted",
            costUsd: 0.4,
          })),
        },
      },
    });

    const result = await executeDurableOrchestrationRun(harness.host, harness.runtime, buildDurableRun());

    expect(result.outcome).toBe("failed");
    expect(harness.host.storage.orchestration.updateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        executionState: "failed",
        lastError: "model budget exhausted",
      }),
    );
    expect(harness.host.createCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ checkpointKind: "run_failed" }),
    );
    expect(harness.host.storage.orchestration.appendRunEvent).toHaveBeenCalledWith(
      "run-1",
      "run.worktree_cleanup_failed",
      expect.objectContaining({
        reason: "failed",
        error: "cleanup failed",
      }),
    );
  });

  it("finalizes stopped-by-limit durable runs with the stopped cleanup reason", async () => {
    const harness = createHarness({
      run: {
        ...buildRun(),
        durableRunId: "durable-run-1",
        executionState: "queued",
        worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-1",
        worktreeStatus: "ready",
      },
      engine: {
        startRun: vi.fn((plan: OrchestrationPlan, run: OrchestrationRun) => ({
          ...run,
          status: "stopped_by_limit",
          currentWaveId: undefined,
          currentPhaseId: undefined,
          totalIterations: 3,
          totalCostUsd: 5,
        })),
      },
    });

    const result = await executeDurableOrchestrationRun(harness.host, harness.runtime, buildDurableRun());

    expect(result.outcome).toBe("completed");
    expect(harness.host.createCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ checkpointKind: "run_stopped" }),
    );
    expect(harness.host.storage.orchestration.appendRunEvent).toHaveBeenCalledWith(
      "run-1",
      "run.stopped",
      expect.objectContaining({
        totalIterations: 3,
        totalCostUsd: 5,
      }),
    );
    expect(harness.runtime.worktrees.release).toHaveBeenCalledWith({
      run: expect.objectContaining({ status: "stopped_by_limit" }),
      reason: "stopped_by_limit",
    });
  });

  it("records wave advancement checkpoints and validates checkpoint workspace access", async () => {
    const harness = createHarness({
      plan: buildTwoWavePlan(),
      run: {
        ...buildRun(),
        durableRunId: "durable-run-1",
        executionState: "queued",
        worktreeStatus: "ready",
      },
      engine: {
        advancePhase: vi.fn((plan: OrchestrationPlan, run: OrchestrationRun, phaseId: string) => {
          if (phaseId === "phase-1") {
            return {
              ...run,
              status: "running",
              currentWaveId: "wave-2",
              currentPhaseId: "phase-2",
              totalIterations: run.totalIterations + 1,
            };
          }
          return {
            ...run,
            status: "paused",
            currentWaveId: "wave-2",
            currentPhaseId: "phase-2",
            totalIterations: run.totalIterations + 1,
          };
        }),
      },
    });

    const result = await executeDurableOrchestrationRun(harness.host, harness.runtime, buildDurableRun());

    expect(result.outcome).toBe("paused");
    expect(harness.host.createCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointKind: "wave_advanced",
        waveId: "wave-2",
        phaseId: "phase-2",
        details: expect.objectContaining({
          fromWave: "wave-1",
          toWave: "wave-2",
        }),
      }),
    );

    const checkpoints = listRunCheckpoints(harness.host, "run-1", " default ");
    expect(checkpoints.length).toBeGreaterThan(0);
    expect(() => listRunCheckpoints(harness.host, "run-1", "bad workspace")).toThrow(
      "workspaceId contains unsupported characters",
    );
  });

  it("fails durable execution when the engine points at a phase outside the plan", async () => {
    const harness = createHarness({
      run: {
        ...buildRun(),
        durableRunId: "durable-run-1",
        executionState: "queued",
        worktreeStatus: "ready",
      },
      engine: {
        startRun: vi.fn((plan: OrchestrationPlan, run: OrchestrationRun) => ({
          ...run,
          status: "running",
          currentWaveId: plan.waves[0]?.waveId,
          currentPhaseId: "missing-phase",
        })),
      },
    });

    await expect(executeDurableOrchestrationRun(harness.host, harness.runtime, buildDurableRun())).rejects.toThrow(
      "Phase missing-phase not found in plan plan-1",
    );
  });
});

type HarnessOptions = {
  plan?: OrchestrationPlan;
  run?: OrchestrationRun;
  durableRun?: DurableRunRecord;
  engine?: Partial<OrchestrationLifecycleHost["orchestrationEngine"]>;
  hooksService?: Partial<OrchestrationLifecycleHost["hooksService"]>;
  runtime?: {
    worktrees?: Partial<OrchestrationLifecycleRuntimeDeps["worktrees"]>;
    phaseExecutor?: Partial<OrchestrationLifecycleRuntimeDeps["phaseExecutor"]>;
  };
};

function createHarness(options: HarnessOptions = {}): {
  host: OrchestrationLifecycleHost;
  runtime: OrchestrationLifecycleRuntimeDeps;
} {
  const checkpoints: OrchestrationCheckpoint[] = [];
  let plan = options.plan ?? buildPlan();
  let run = options.run ?? buildRun();
  let durableRun = options.durableRun ?? buildDurableRun();
  const storage = {
    orchestration: {
      upsertPlan: vi.fn((next: OrchestrationPlan) => {
        plan = next;
      }),
      getPlan: vi.fn(() => plan),
      createRun: vi.fn((next: OrchestrationRun) => {
        run = next;
        return next;
      }),
      findLatestRunByPlan: vi.fn(() => undefined),
      findActiveRunByPlan: vi.fn(() => undefined),
      updateRun: vi.fn((next: OrchestrationRun) => {
        run = next;
        return next;
      }),
      updateRunIfCurrentState: vi.fn((next: OrchestrationRun) => {
        run = next;
        return next;
      }),
      appendRunEvent: vi.fn(),
      listCheckpoints: vi.fn(() => checkpoints),
      getRun: vi.fn(() => run),
    },
  };
  const engine: OrchestrationLifecycleHost["orchestrationEngine"] = {
    validate: vi.fn(),
    createRun: vi.fn(() => run),
    startRun: vi.fn((currentPlan: OrchestrationPlan, currentRun: OrchestrationRun) => ({
      ...currentRun,
      status: "running",
      currentWaveId: currentPlan.waves[0]?.waveId,
      currentPhaseId: currentPlan.waves[0]?.phases[0]?.phaseId,
    })),
    approvePhase: vi.fn((currentPlan: OrchestrationPlan, currentRun: OrchestrationRun) => ({
      ...currentRun,
      status: "completed",
      currentWaveId: undefined,
      currentPhaseId: undefined,
      totalIterations: currentRun.totalIterations + 1,
      totalCostUsd: currentRun.totalCostUsd,
    })),
    advancePhase: vi.fn((currentPlan: OrchestrationPlan, currentRun: OrchestrationRun) => ({
      ...currentRun,
      status: "paused",
      currentWaveId: currentPlan.waves[0]?.waveId,
      currentPhaseId: currentPlan.waves[0]?.phases[0]?.phaseId,
      totalIterations: currentRun.totalIterations + 1,
    })),
    ...options.engine,
  };
  const host: OrchestrationLifecycleHost = {
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
    orchestrationEngine: engine,
    hooksService: {
      runInlineHooks: vi.fn(async () => ({ blockedBy: undefined, patch: undefined })),
      enqueueAfterHooks: vi.fn(),
      ...options.hooksService,
    },
    createCheckpoint: vi.fn((input) => {
      const checkpoint = {
        checkpointId: `cp-${checkpoints.length + 1}`,
        createdAt: "2026-05-15T12:00:00.000Z",
        gitRef: "abc123",
        ...input,
      } as OrchestrationCheckpoint;
      checkpoints.push(checkpoint);
      return checkpoint;
    }),
    publishRealtime: vi.fn(),
    scheduleOrchestrationMemoryContext: vi.fn(),
    createDurableRun: vi.fn(() => durableRun),
    getDurableRun: vi.fn(() => durableRun),
    requestDurableRunProcessing: vi.fn(),
    pauseDurableRun: vi.fn(() => {
      durableRun = { ...durableRun, status: "paused", version: durableRun.version + 1 };
      return durableRun;
    }),
    resumeDurableRun: vi.fn(() => {
      durableRun = { ...durableRun, status: "queued", version: durableRun.version + 1 };
      return durableRun;
    }),
    cancelDurableRun: vi.fn(() => {
      durableRun = { ...durableRun, status: "cancelled", version: durableRun.version + 1 };
      return durableRun;
    }),
    updateDurableRunState: vi.fn((input) => {
      durableRun = {
        ...durableRun,
        ...(input.status ? { status: input.status } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
        ...(input.clearLastError ? { lastError: undefined } : {}),
        ...(input.finishedAt !== undefined ? { finishedAt: input.finishedAt } : {}),
        ...(input.clearFinishedAt ? { finishedAt: undefined } : {}),
        version: durableRun.version + 1,
      };
      return durableRun;
    }),
    recordDurableTimelineEvent: vi.fn(),
  };
  const runtime: OrchestrationLifecycleRuntimeDeps = {
    worktrees: {
      allocate: vi.fn(async () => ({
        worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-1",
        worktreeStatus: "ready" as const,
        worktreeBaseRef: "HEAD",
      })),
      release: vi.fn(async () => undefined),
      ...options.runtime?.worktrees,
    },
    phaseExecutor: {
      execute: vi.fn(async () => ({
        phaseId: "phase-1",
        ownerAgentId: "agent-1",
        status: "completed" as const,
        startedAt: "2026-05-15T12:00:01.000Z",
        finishedAt: "2026-05-15T12:00:02.000Z",
        outputSummary: "Phase completed",
        costUsd: 0.5,
      })),
      ...options.runtime?.phaseExecutor,
    },
  };
  return { host, runtime };
}

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
        ownership: [{ agentId: "agent-1", paths: ["apps/**"] }],
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

function buildTwoWavePlan(): OrchestrationPlan {
  return {
    ...buildPlan(),
    waves: [
      buildPlan().waves[0]!,
      {
        waveId: "wave-2",
        verify: [],
        budgetUsd: 2,
        ownership: [{ agentId: "agent-2", paths: ["packages/**"] }],
        phases: [
          {
            phaseId: "phase-2",
            ownerAgentId: "agent-2",
            specPath: "phase-2.md",
            loopMode: "fresh-context",
            requiresApproval: true,
          },
        ],
      },
    ],
  };
}

function buildRun(): OrchestrationRun {
  return {
    runId: "run-1",
    planId: "plan-1",
    status: "queued",
    startedAt: "2026-05-15T12:00:00.000Z",
    totalIterations: 0,
    totalCostUsd: 0,
    workspaceId: "default",
    executionState: "created",
    worktreeStatus: "uninitialized",
    worktreeBaseRef: "HEAD",
  };
}

function buildDurableRun(overrides: Partial<DurableRunRecord> = {}): DurableRunRecord {
  return {
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
      requestedAt: "2026-05-15T12:00:00.000Z",
    },
    metadata: {},
    createdAt: "2026-05-15T12:00:00.000Z",
    updatedAt: "2026-05-15T12:00:00.000Z",
    ...overrides,
  };
}
