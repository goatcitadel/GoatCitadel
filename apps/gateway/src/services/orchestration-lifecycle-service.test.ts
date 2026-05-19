import { describe, expect, it, vi } from "vitest";
import type { OrchestrationCheckpoint } from "@goatcitadel/storage";
import type { DurableRunRecord, OrchestrationPlan, OrchestrationRun } from "@goatcitadel/contracts";
import {
  approvePhase,
  createOrchestrationPlan,
  executeDurableOrchestrationRun,
  getRun as getOrchestrationRun,
  runOrchestrationPlan,
  cancelOrchestrationRun,
  type OrchestrationLifecycleHost,
  type OrchestrationLifecycleRuntimeDeps,
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
      findActiveRunByPlan: vi.fn(() => undefined),
      updateRun: vi.fn((value: OrchestrationRun) => {
        run = value;
        return value;
      }),
      updateRunIfCurrentState: vi.fn((value: OrchestrationRun) => {
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
      validate: vi.fn(),
      createRun: vi.fn(() => run),
      startRun: vi.fn(
        (_currentPlan, currentRun) =>
          ({
            ...currentRun,
            status: "running",
            currentWaveId: "wave-1",
            currentPhaseId: "phase-1",
          }) as OrchestrationRun,
      ),
      approvePhase: vi.fn(
        (_currentPlan, currentRun) =>
          ({
            ...currentRun,
            status: "completed",
            currentWaveId: undefined,
            currentPhaseId: undefined,
            totalIterations: 1,
            totalCostUsd: 0.5,
          }) as OrchestrationRun,
      ),
      advancePhase: vi.fn(
        (_currentPlan, currentRun) =>
          ({
            ...currentRun,
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
    cancelDurableRun: vi.fn(() => {
      durableRun = {
        ...durableRun,
        status: "cancelled",
        finishedAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
        version: durableRun.version + 1,
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
    recordDurableTimelineEvent: vi.fn(),
    ...overrides,
  };
}

type RuntimeDepsOverrides = {
  worktrees?: Partial<OrchestrationLifecycleRuntimeDeps["worktrees"]>;
  phaseExecutor?: Partial<OrchestrationLifecycleRuntimeDeps["phaseExecutor"]>;
};

function createRuntimeDeps(overrides: RuntimeDepsOverrides = {}): OrchestrationLifecycleRuntimeDeps {
  return {
    worktrees: {
      allocate: vi.fn(async () => ({
        worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-1",
        worktreeStatus: "ready" as const,
        worktreeBaseRef: "HEAD",
      })),
      release: vi.fn(async () => undefined),
      ...overrides.worktrees,
    },
    phaseExecutor: {
      execute: vi.fn(async () => ({
        phaseId: "phase-1",
        ownerAgentId: "agent-1",
        status: "completed" as const,
        startedAt: "2026-04-12T00:00:01.000Z",
        finishedAt: "2026-04-12T00:00:02.000Z",
        outputSummary: "Phase completed",
        outputText: "Phase completed",
        childSessionId: "sess_phase",
        childTurnId: "turn_phase",
        costUsd: 0.5,
        inputTokens: 10,
        outputTokens: 20,
      })),
      ...overrides.phaseExecutor,
    },
  };
}

describe("orchestration-lifecycle-service", () => {
  it("creates a run with durable and worktree ownership", async () => {
    const host = createHost();
    const runtime = createRuntimeDeps();
    const plan = buildPlan();

    const result = await createOrchestrationPlan(host, runtime, plan, {
      operatorId: "operator-1",
      authActorId: "auth-operator-1",
      authActorSource: "loopback",
      permissionProfileId: "trusted-local-power",
      localOperatorOverrideId: "override-1",
    });

    expect(result.runId).toBe("run-1");
    expect(result.durableRunId).toBe("durable-run-1");
    expect(result.worktreeStatus).toBe("ready");
    expect(result).toMatchObject({
      operatorId: "operator-1",
      authActorId: "auth-operator-1",
      authActorSource: "loopback",
      permissionProfileId: "trusted-local-power",
      localOperatorOverrideId: "override-1",
    });
    expect(host.storage.orchestration.upsertPlan).toHaveBeenCalledWith(plan);
    expect(host.storage.orchestration.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: "operator-1",
        authActorId: "auth-operator-1",
        authActorSource: "loopback",
        permissionProfileId: "trusted-local-power",
        localOperatorOverrideId: "override-1",
      }),
    );
    expect(host.createDurableRun).toHaveBeenCalled();
    expect(host.createDurableRun).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          operatorId: "operator-1",
          authActorId: "auth-operator-1",
          authActorSource: "loopback",
          permissionProfileId: "trusted-local-power",
          localOperatorOverrideId: "override-1",
        }),
      }),
    );
    expect(host.pauseDurableRun).toHaveBeenCalledWith("durable-run-1", "orchestration");
    expect(runtime.worktrees.allocate).toHaveBeenCalled();
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
    const runtime = createRuntimeDeps();

    const result = await runOrchestrationPlan(host, runtime, "plan-1");

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

  it("returns the active run for a plan instead of creating duplicate active orchestration runs", async () => {
    const activeRun: OrchestrationRun = {
      ...buildRun(),
      runId: "run-active",
      durableRunId: "durable-active",
      executionState: "queued",
    };
    const base = createHost();
    const host = createHost({
      storage: {
        orchestration: {
          ...base.storage.orchestration,
          findActiveRunByPlan: vi.fn(() => activeRun),
        },
      } as OrchestrationLifecycleHost["storage"],
    });
    const runtime = createRuntimeDeps();

    const result = await runOrchestrationPlan(host, runtime, "plan-1");

    expect(result).toBe(activeRun);
    expect(host.storage.orchestration.createRun).not.toHaveBeenCalled();
    expect(runtime.worktrees.allocate).not.toHaveBeenCalled();
    expect(host.requestDurableRunProcessing).toHaveBeenCalledWith("durable-active");
  });

  it("queues an active worktree-ready run instead of leaving it paused forever", async () => {
    const activeRun: OrchestrationRun = {
      ...buildRun(),
      runId: "run-active",
      durableRunId: "durable-active",
      executionState: "worktree_ready",
      worktreeStatus: "ready",
      worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-active",
    };
    const base = createHost();
    const host = createHost({
      storage: {
        orchestration: {
          ...base.storage.orchestration,
          findActiveRunByPlan: vi.fn(() => activeRun),
        },
      } as OrchestrationLifecycleHost["storage"],
    });
    const runtime = createRuntimeDeps();

    const result = await runOrchestrationPlan(host, runtime, "plan-1");

    expect(result.runId).toBe("run-active");
    expect(result.executionState).toBe("queued");
    expect(host.storage.orchestration.createRun).not.toHaveBeenCalled();
    expect(runtime.worktrees.allocate).not.toHaveBeenCalled();
    expect(host.resumeDurableRun).toHaveBeenCalledWith("durable-active", "orchestration");
    expect(host.requestDurableRunProcessing).toHaveBeenCalledWith("durable-active");
  });

  it("marks orchestration runs failed when worktree allocation fails", async () => {
    const host = createHost();
    const runtime = createRuntimeDeps({
      worktrees: {
        allocate: vi.fn(async () => {
          throw new Error("worktree allocation unavailable");
        }),
      },
    });

    const result = await createOrchestrationPlan(host, runtime, buildPlan());

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
    expect(host.storage.orchestration.updateRunIfCurrentState).toHaveBeenCalledWith(
      expect.objectContaining({
        executionState: "resume_requested",
        pendingApprovalPhaseId: "phase-1",
      }),
      { status: "paused", executionState: "paused_for_approval" },
    );
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

  it("rejects phase hook patches that make the orchestration plan invalid", async () => {
    const base = createHost();
    const validationError = new Error("Phase owner agent-missing is not declared in wave wave-1 ownership.");
    const host = createHost({
      storage: {
        orchestration: {
          ...base.storage.orchestration,
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
      orchestrationEngine: {
        ...base.orchestrationEngine,
        validate: vi.fn((currentPlan: OrchestrationPlan) => {
          const owner = currentPlan.waves[0]?.phases[0]?.ownerAgentId;
          if (owner === "agent-missing") {
            throw validationError;
          }
        }),
      },
      hooksService: {
        runInlineHooks: vi.fn(async () => ({
          blockedBy: undefined,
          patch: { ownerAgentId: "agent-missing" },
        })),
        enqueueAfterHooks: vi.fn(),
      },
    });

    await expect(approvePhase(host, "run-1", "phase-1", "operator", 0.5)).rejects.toThrow(validationError.message);

    expect(host.orchestrationEngine.validate).toHaveBeenCalledWith(
      expect.objectContaining({
        waves: [
          expect.objectContaining({
            phases: [expect.objectContaining({ ownerAgentId: "agent-missing" })],
          }),
        ],
      }),
    );
    expect(host.storage.orchestration.upsertPlan).not.toHaveBeenCalled();
    expect(host.storage.orchestration.updateRun).not.toHaveBeenCalled();
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

  it("returns a conflict when approval resume intent loses the state race", async () => {
    const base = createHost();
    const host = createHost({
      storage: {
        orchestration: {
          ...base.storage.orchestration,
          getRun: vi.fn(() => ({
            ...buildRun(),
            status: "paused",
            executionState: "paused_for_approval",
            currentWaveId: "wave-1",
            currentPhaseId: "phase-1",
            durableRunId: "durable-run-1",
          })),
          updateRunIfCurrentState: vi.fn(() => undefined),
        },
      } as OrchestrationLifecycleHost["storage"],
    });

    await expect(approvePhase(host, "run-1", "phase-1", "operator", 0.5)).rejects.toMatchObject({
      code: "STATE_CONFLICT",
      httpStatus: 409,
    });
    expect(host.resumeDurableRun).not.toHaveBeenCalled();
    expect(host.requestDurableRunProcessing).not.toHaveBeenCalled();
  });

  it("hides orchestration runs outside the requested workspace scope", () => {
    const host = createHost({
      storage: {
        orchestration: {
          ...createHost().storage.orchestration,
          getRun: vi.fn(() => ({
            ...buildRun(),
            workspaceId: "workspace-a",
          })),
        },
      } as OrchestrationLifecycleHost["storage"],
    });

    expect(() => getOrchestrationRun(host, "run-1", "workspace-b")).toThrow("Orchestration run run-1 not found");
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
            operatorId: "operator-1",
            authActorId: "auth-operator-1",
            authActorSource: "loopback",
            permissionProfileId: "trusted-local-power",
            localOperatorOverrideId: "override-1",
          })),
        },
      } as OrchestrationLifecycleHost["storage"],
    });
    const runtime = createRuntimeDeps();

    const durableRun = host.getDurableRun("durable-run-1");
    const result = await executeDurableOrchestrationRun(host, runtime, durableRun);

    expect(result.outcome).toBe("paused");
    expect(host.orchestrationEngine.startRun).toHaveBeenCalled();
    expect(runtime.phaseExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: expect.objectContaining({ phaseId: "phase-1" }),
        run: expect.objectContaining({ currentPhaseId: "phase-1" }),
        durableRun: expect.objectContaining({ runId: "durable-run-1" }),
        policyContext: expect.objectContaining({
          operatorId: "operator-1",
          authActorId: "auth-operator-1",
          authActorSource: "loopback",
          permissionProfileId: "trusted-local-power",
          localOperatorOverrideId: "override-1",
        }),
      }),
    );
    expect(host.orchestrationEngine.advancePhase).toHaveBeenCalledWith(
      expect.objectContaining({ planId: "plan-1" }),
      expect.objectContaining({ currentPhaseId: "phase-1" }),
      "phase-1",
      expect.objectContaining({ costIncrementUsd: 0.5 }),
    );
    expect(host.pauseDurableRun).toHaveBeenCalledWith("durable-run-1", "orchestration");
    expect(host.recordDurableTimelineEvent).toHaveBeenCalledWith("durable-run-1", "run_started", expect.any(Object));
  });

  it("pauses orchestration when a child phase turn is waiting instead of failing the phase", async () => {
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
    const runtime = createRuntimeDeps({
      phaseExecutor: {
        execute: vi.fn(async () => ({
          phaseId: "phase-1",
          ownerAgentId: "agent-1",
          status: "waiting" as const,
          startedAt: "2026-04-12T00:00:01.000Z",
          finishedAt: "2026-04-12T00:00:02.000Z",
          outputSummary: "Waiting for operator approval.",
          childSessionId: "sess_phase",
          childTurnId: "turn_phase",
          childRunId: "durable-child-1",
        })),
      },
    });

    const result = await executeDurableOrchestrationRun(host, runtime, host.getDurableRun("durable-run-1"));

    expect(result.outcome).toBe("paused");
    expect(host.orchestrationEngine.advancePhase).not.toHaveBeenCalled();
    expect(host.pauseDurableRun).toHaveBeenCalledWith("durable-run-1", "orchestration");
    expect(host.storage.orchestration.updateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "paused",
        executionState: "paused_for_approval",
      }),
    );
    expect(host.storage.orchestration.appendRunEvent).toHaveBeenCalledWith(
      "run-1",
      "phase.waiting",
      expect.objectContaining({
        childRunId: "durable-child-1",
      }),
    );
  });

  it("cancels orchestration runs with durable, checkpoint, realtime, and worktree cleanup truth", async () => {
    const base = createHost();
    const host = createHost({
      storage: {
        orchestration: {
          ...base.storage.orchestration,
          getRun: vi.fn(() => ({
            ...buildRun(),
            status: "running",
            executionState: "running",
            currentWaveId: "wave-1",
            currentPhaseId: "phase-1",
            durableRunId: "durable-run-1",
            worktreeStatus: "ready",
            worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-1",
          })),
        },
      } as OrchestrationLifecycleHost["storage"],
    });
    const runtime = createRuntimeDeps();

    const result = await cancelOrchestrationRun(host, runtime, "run-1", "operator-a");

    expect(result.run.status).toBe("cancelled");
    expect(result.run.executionState).toBe("cancelled");
    expect(host.cancelDurableRun).toHaveBeenCalledWith("durable-run-1", "operator-a");
    expect(host.updateDurableRunState).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "durable-run-1",
        metadata: expect.objectContaining({
          orchestration: expect.objectContaining({
            lifecycleState: "cancelled",
            runId: "run-1",
          }),
        }),
      }),
    );
    expect(runtime.worktrees.release).toHaveBeenCalledWith({
      run: expect.objectContaining({ status: "cancelled" }),
      reason: "cancelled",
    });
    expect(host.createCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointKind: "run_cancelled",
      }),
    );
    expect(host.publishRealtime).toHaveBeenCalledWith(
      "orchestration_event",
      "orchestration",
      expect.objectContaining({
        event: "run_cancelled",
        status: "cancelled",
      }),
      expect.any(Object),
    );
  });

  it("does not classify ordinary phase failures mentioning cancelled as workflow aborts", async () => {
    const base = createHost();
    const host = createHost({
      storage: {
        orchestration: {
          ...base.storage.orchestration,
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
    const runtime = createRuntimeDeps({
      phaseExecutor: {
        execute: vi.fn(async () => {
          throw new Error("provider cancelled request upstream");
        }),
      },
    });

    await expect(executeDurableOrchestrationRun(host, runtime, host.getDurableRun("durable-run-1"))).rejects.toThrow(
      "provider cancelled request upstream",
    );
    expect(host.cancelDurableRun).not.toHaveBeenCalled();
  });

  it("marks durable orchestration execution cancelled when the workflow aborts during a phase", async () => {
    const base = createHost();
    const abortController = new AbortController();
    const host = createHost({
      storage: {
        orchestration: {
          ...base.storage.orchestration,
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
    const runtime = createRuntimeDeps({
      phaseExecutor: {
        execute: vi.fn(async () => {
          abortController.abort(new Error("operator cancelled"));
          throw new Error("operator cancelled");
        }),
      },
    });

    const result = await executeDurableOrchestrationRun(host, runtime, host.getDurableRun("durable-run-1"), {
      signal: abortController.signal,
    });

    expect(result.outcome).toBe("cancelled");
    expect(host.cancelDurableRun).toHaveBeenCalledWith("durable-run-1", "durable-worker");
    expect(runtime.worktrees.release).toHaveBeenCalledWith({
      run: expect.objectContaining({ status: "cancelled" }),
      reason: "cancelled",
    });
  });
});
