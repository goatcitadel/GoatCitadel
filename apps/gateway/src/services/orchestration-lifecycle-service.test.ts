import { describe, expect, it, vi } from "vitest";
import type { OrchestrationCheckpoint } from "@goatcitadel/storage";
import {
  NotFoundError,
  type DurableRunRecord,
  type OrchestrationPlan,
  type OrchestrationRun,
} from "@goatcitadel/contracts";
import {
  approvePhase,
  createOrchestrationPlan,
  executeDurableOrchestrationRun,
  getRun as getOrchestrationRun,
  getRunTrace,
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

let createRunSeq = 0;

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
    runImmediateTransaction: vi.fn(<T>(callback: () => T): T => callback()),
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

/**
 * Stateful store that models the ORCH-001 concurrency contract.
 *
 * The optimistic OUTER read of findActiveRunByPlan always misses (returns
 * undefined) — this represents the race window where two callers both observe
 * "no active run" before either has committed. The serialization point is the
 * synchronous runImmediateTransaction: the active-run re-check performed INSIDE
 * the transaction sees committed state, exactly like SQLite IMMEDIATE
 * transactions, so only the first caller inserts and the second observes the
 * committed run.
 */
function createRaceStore(): {
  createdRuns: OrchestrationRun[];
  runImmediateTransaction: <T>(callback: () => T) => T;
  findActiveRunByPlan: (planId: string, workspaceId?: string) => OrchestrationRun | undefined;
  createRun: (run: OrchestrationRun) => OrchestrationRun;
} {
  const createdRuns: OrchestrationRun[] = [];
  const activeByKey = new Map<string, OrchestrationRun>();
  let insideTransaction = false;
  const keyFor = (planId: string, workspaceId = "default"): string => `${planId}::${workspaceId}`;

  return {
    createdRuns,
    runImmediateTransaction: vi.fn(<T>(callback: () => T): T => {
      insideTransaction = true;
      try {
        return callback();
      } finally {
        insideTransaction = false;
      }
    }),
    findActiveRunByPlan: vi.fn((planId: string, workspaceId = "default") => {
      if (!insideTransaction) {
        return undefined;
      }
      return activeByKey.get(keyFor(planId, workspaceId));
    }),
    createRun: vi.fn((run: OrchestrationRun) => {
      createdRuns.push(run);
      activeByKey.set(keyFor(run.planId, run.workspaceId), run);
      return run;
    }),
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
    expect(host.storage.orchestration.upsertPlan).toHaveBeenCalledWith(plan, "default");
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

  it("creates and recovers active runs inside the requested workspace scope", async () => {
    const host = createHost();
    const runtime = createRuntimeDeps();
    const plan = buildPlan();

    const created = await createOrchestrationPlan(host, runtime, plan, {
      workspaceId: "workspace-a",
      operatorId: "operator-1",
    });

    expect(created.workspaceId).toBe("workspace-a");
    expect(host.storage.orchestration.upsertPlan).toHaveBeenCalledWith(plan, "workspace-a");
    expect(host.storage.orchestration.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-a",
        operatorId: "operator-1",
      }),
    );

    const activeRun: OrchestrationRun = {
      ...buildRun(),
      runId: "run-active-workspace-a",
      durableRunId: "durable-active-workspace-a",
      workspaceId: "workspace-a",
      executionState: "queued",
    };
    const base = createHost();
    const scopedHost = createHost({
      storage: {
        orchestration: {
          ...base.storage.orchestration,
          findActiveRunByPlan: vi.fn((_planId: string, workspaceId?: string) =>
            workspaceId === "workspace-a" ? activeRun : undefined,
          ),
        },
      } as OrchestrationLifecycleHost["storage"],
    });

    const recovered = await runOrchestrationPlan(scopedHost, runtime, "plan-1", { workspaceId: "workspace-a" });

    expect(recovered).toBe(activeRun);
    expect(scopedHost.storage.orchestration.getPlan).toHaveBeenCalledWith("plan-1", "workspace-a");
    expect(scopedHost.storage.orchestration.findActiveRunByPlan).toHaveBeenCalledWith("plan-1", "workspace-a");
    expect(scopedHost.storage.orchestration.createRun).not.toHaveBeenCalled();
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

  it("creates exactly one run when two runOrchestrationPlan calls race the same plan", async () => {
    // Models the ORCH-001 race window: both callers observe "no active run" on
    // the initial (outer) read, then both attempt to create concurrently. The
    // atomic guard re-checks findActiveRunByPlan AND inserts the run row inside
    // a single runImmediateTransaction, so the second caller must observe the
    // run inserted by the first and return it idempotently — never creating a
    // duplicate (which would mean two worktrees / doubled cost).
    const store = createRaceStore();
    const host = createHost({
      storage: {
        runImmediateTransaction: store.runImmediateTransaction,
        orchestration: {
          ...createHost().storage.orchestration,
          findActiveRunByPlan: store.findActiveRunByPlan,
          createRun: store.createRun,
          getPlan: vi.fn(() => buildPlan()),
        },
      } as OrchestrationLifecycleHost["storage"],
      orchestrationEngine: {
        ...createHost().orchestrationEngine,
        createRun: vi.fn((currentPlan: OrchestrationPlan) => ({
          ...buildRun(currentPlan.planId),
          runId: `run-${currentPlan.planId}-${createRunSeq++}`,
        })),
      },
    });
    const runtimeA = createRuntimeDeps();
    const runtimeB = createRuntimeDeps();

    const [resultA, resultB] = await Promise.all([
      runOrchestrationPlan(host, runtimeA, "plan-1"),
      runOrchestrationPlan(host, runtimeB, "plan-1"),
    ]);

    expect(host.storage.orchestration.createRun).toHaveBeenCalledTimes(1);
    expect(store.createdRuns).toHaveLength(1);
    const createdRunId = store.createdRuns[0]!.runId;
    expect(resultA.runId).toBe(createdRunId);
    expect(resultB.runId).toBe(createdRunId);
    // Worktree allocation (and thus durable-run setup) must happen only once.
    const totalAllocations =
      vi.mocked(runtimeA.worktrees.allocate).mock.calls.length +
      vi.mocked(runtimeB.worktrees.allocate).mock.calls.length;
    expect(totalAllocations).toBe(1);
  });

  it("creates two runs when two runOrchestrationPlan calls target different plans", async () => {
    const store = createRaceStore();
    const host = createHost({
      storage: {
        runImmediateTransaction: store.runImmediateTransaction,
        orchestration: {
          ...createHost().storage.orchestration,
          findActiveRunByPlan: store.findActiveRunByPlan,
          createRun: store.createRun,
          getPlan: vi.fn((planId: string) => ({ ...buildPlan(), planId })),
        },
      } as OrchestrationLifecycleHost["storage"],
      orchestrationEngine: {
        ...createHost().orchestrationEngine,
        createRun: vi.fn((currentPlan: OrchestrationPlan) => ({
          ...buildRun(currentPlan.planId),
          runId: `run-${currentPlan.planId}-${createRunSeq++}`,
        })),
      },
    });
    const runtimeA = createRuntimeDeps();
    const runtimeB = createRuntimeDeps();

    const [resultA, resultB] = await Promise.all([
      runOrchestrationPlan(host, runtimeA, "plan-1"),
      runOrchestrationPlan(host, runtimeB, "plan-2"),
    ]);

    expect(host.storage.orchestration.createRun).toHaveBeenCalledTimes(2);
    expect(store.createdRuns).toHaveLength(2);
    expect(new Set(store.createdRuns.map((entry) => entry.planId))).toEqual(new Set(["plan-1", "plan-2"]));
    expect(resultA.planId).toBe("plan-1");
    expect(resultB.planId).toBe("plan-2");
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

  it("projects orchestration checkpoints and run events into a sanitized decision trace", () => {
    const base = createHost();
    const host = createHost({
      storage: {
        orchestration: {
          ...base.storage.orchestration,
          getRun: vi.fn(() => ({
            ...buildRun(),
            workspaceId: "workspace-a",
          })),
          listCheckpoints: vi.fn(() => [
            {
              checkpointId: "cp-1",
              runId: "run-1",
              planId: "plan-1",
              checkpointKind: "run_started",
              details: { apiKey: "secret-value", status: "running" },
              createdAt: "2026-04-12T00:00:01.000Z",
            },
          ]),
          listRunEvents: vi.fn(() => [
            {
              eventId: "event-1",
              runId: "run-1",
              eventType: "phase.completed",
              payload: {
                phaseId: "phase-1",
                model: "fast-model",
                outputText: "x".repeat(700),
              },
              createdAt: "2026-04-12T00:00:02.000Z",
            },
          ]),
        },
      } as OrchestrationLifecycleHost["storage"],
    });

    const trace = getRunTrace(host, "run-1", "workspace-a");

    expect(trace.decisions.map((decision) => decision.kind)).toEqual(["run_started", "phase_completed"]);
    expect(trace.checkpoints[0]?.details.apiKey).toBe("[redacted]");
    expect(trace.runEvents[0]?.payload.outputText).toContain("[truncated]");
    expect(trace.decisions[1]?.summary).toContain("phase phase-1");
  });

  it("denies trace reads for a run owned by another workspace", () => {
    const base = createHost();
    const host = createHost({
      storage: {
        orchestration: {
          ...base.storage.orchestration,
          getRun: vi.fn(() => ({
            ...buildRun(),
            workspaceId: "workspace-a",
          })),
        },
      } as OrchestrationLifecycleHost["storage"],
    });

    expect(() => getRunTrace(host, "run-1", "workspace-b")).toThrow("Orchestration run run-1 not found");
  });

  it("caps the run lastError text included in the trace", () => {
    const base = createHost();
    const host = createHost({
      storage: {
        orchestration: {
          ...base.storage.orchestration,
          getRun: vi.fn(() => ({
            ...buildRun(),
            workspaceId: "workspace-a",
            lastError: "e".repeat(700),
          })),
        },
      } as OrchestrationLifecycleHost["storage"],
    });

    const trace = getRunTrace(host, "run-1", "workspace-a");

    expect(trace.run.lastError).toContain("[truncated]");
    expect(trace.run.lastError?.length ?? 0).toBeLessThan(700);
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

  it("records durable execution checkpoints and run events in lifecycle order", async () => {
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
    const runtime = createRuntimeDeps();

    const result = await executeDurableOrchestrationRun(host, runtime, host.getDurableRun("durable-run-1"));

    expect(result.outcome).toBe("paused");
    expect(vi.mocked(host.createCheckpoint).mock.calls.map(([input]) => input.checkpointKind)).toEqual([
      "run_started",
      "phase_executed",
      "run_paused_for_approval",
    ]);
    expect(vi.mocked(host.storage.orchestration.appendRunEvent).mock.calls.map(([, eventType]) => eventType)).toEqual([
      "run.started",
      "phase.started",
      "phase.executed",
      "phase.advanced",
      "run.paused_for_approval",
    ]);
    expect(vi.mocked(host.recordDurableTimelineEvent).mock.calls.map(([, eventType]) => eventType)).toEqual([
      "run_started",
    ]);
  });

  it("rejects durable orchestration payloads that point at a different workspace than the run", async () => {
    const base = createHost();
    const getPlan = vi.fn(() => buildPlan());
    const host = createHost({
      storage: {
        orchestration: {
          ...base.storage.orchestration,
          getPlan,
          getRun: vi.fn(() => ({
            ...buildRun(),
            durableRunId: "durable-run-1",
            workspaceId: "workspace-a",
            worktreeStatus: "ready",
            worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-1",
          })),
        },
      } as OrchestrationLifecycleHost["storage"],
    });
    const runtime = createRuntimeDeps();

    const result = await executeDurableOrchestrationRun(host, runtime, host.getDurableRun("durable-run-1"));

    expect(result).toMatchObject({
      outcome: "failed",
      checkpointState: {
        error: "Durable orchestration payload workspace default does not match run run-1 workspace workspace-a.",
        payloadWorkspaceId: "default",
        runWorkspaceId: "workspace-a",
        reason: "workspace_mismatch",
      },
    });
    expect(getPlan).not.toHaveBeenCalled();
    expect(host.storage.orchestration.updateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        status: "failed",
        executionState: "failed",
        lastError: "Durable orchestration payload workspace default does not match run run-1 workspace workspace-a.",
      }),
    );
    expect(host.storage.orchestration.appendRunEvent).toHaveBeenCalledWith(
      "run-1",
      "run.workspace_mismatch",
      expect.objectContaining({
        durableRunId: "durable-run-1",
        payloadWorkspaceId: "default",
        runWorkspaceId: "workspace-a",
      }),
    );
    expect(runtime.worktrees.release).toHaveBeenCalledWith({
      run: expect.objectContaining({
        runId: "run-1",
        status: "failed",
        worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-1",
      }),
      reason: "failed",
    });
  });

  it("checks durable run ownership before failing workspace mismatch cleanup", async () => {
    const base = createHost();
    const getPlan = vi.fn(() => buildPlan());
    const updateRun = vi.fn((value: OrchestrationRun) => value);
    const host = createHost({
      storage: {
        orchestration: {
          ...base.storage.orchestration,
          getPlan,
          updateRun,
          getRun: vi.fn(() => ({
            ...buildRun(),
            durableRunId: "different-durable-run",
            workspaceId: "workspace-a",
            worktreeStatus: "ready",
            worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-1",
          })),
        },
      } as OrchestrationLifecycleHost["storage"],
    });
    const runtime = createRuntimeDeps();

    await expect(executeDurableOrchestrationRun(host, runtime, host.getDurableRun("durable-run-1"))).rejects.toThrow(
      "Orchestration run run-1 is not linked to durable run durable-run-1.",
    );

    expect(getPlan).not.toHaveBeenCalled();
    expect(updateRun).not.toHaveBeenCalled();
    expect(runtime.worktrees.release).not.toHaveBeenCalled();
  });

  it("records and cleans up malformed durable orchestration payload workspace ids", async () => {
    const base = createHost();
    const getPlan = vi.fn(() => buildPlan());
    const host = createHost({
      storage: {
        orchestration: {
          ...base.storage.orchestration,
          getPlan,
          getRun: vi.fn(() => ({
            ...buildRun(),
            durableRunId: "durable-run-1",
            worktreeStatus: "ready",
            worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-1",
          })),
        },
      } as OrchestrationLifecycleHost["storage"],
    });
    const runtime = createRuntimeDeps();
    const durableRun = {
      ...host.getDurableRun("durable-run-1"),
      payload: {
        ...(host.getDurableRun("durable-run-1").payload ?? {}),
        workspaceId: "../bad workspace",
      },
    } as DurableRunRecord;

    const result = await executeDurableOrchestrationRun(host, runtime, durableRun);

    expect(result).toMatchObject({
      outcome: "failed",
      checkpointState: {
        payloadWorkspaceId: "../bad workspace",
        runWorkspaceId: "default",
        reason: "workspace_mismatch",
      },
    });
    expect(String(result.checkpointState.error)).toContain("workspaceId contains unsupported characters");
    expect(getPlan).not.toHaveBeenCalled();
    expect(host.storage.orchestration.updateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        executionState: "failed",
        lastError: expect.stringContaining("workspaceId contains unsupported characters"),
      }),
    );
    expect(host.storage.orchestration.appendRunEvent).toHaveBeenCalledWith(
      "run-1",
      "run.workspace_mismatch",
      expect.objectContaining({
        payloadWorkspaceId: "../bad workspace",
        runWorkspaceId: "default",
      }),
    );
    expect(runtime.worktrees.release).toHaveBeenCalledWith({
      run: expect.objectContaining({
        runId: "run-1",
        status: "failed",
        worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-1",
      }),
      reason: "failed",
    });
  });

  it("records and cleans up non-string durable orchestration payload workspace ids", async () => {
    const base = createHost();
    const getPlan = vi.fn(() => buildPlan());
    const host = createHost({
      storage: {
        orchestration: {
          ...base.storage.orchestration,
          getPlan,
          getRun: vi.fn(() => ({
            ...buildRun(),
            durableRunId: "durable-run-1",
            worktreeStatus: "ready",
            worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-1",
          })),
        },
      } as OrchestrationLifecycleHost["storage"],
    });
    const runtime = createRuntimeDeps();
    const durableRun = {
      ...host.getDurableRun("durable-run-1"),
      payload: {
        ...(host.getDurableRun("durable-run-1").payload ?? {}),
        workspaceId: 42,
      },
    } as DurableRunRecord;

    const result = await executeDurableOrchestrationRun(host, runtime, durableRun);

    expect(result).toMatchObject({
      outcome: "failed",
      checkpointState: {
        payloadWorkspaceId: "42",
        runWorkspaceId: "default",
        reason: "workspace_mismatch",
      },
    });
    expect(String(result.checkpointState.error)).toContain("workspaceId must be a string");
    expect(getPlan).not.toHaveBeenCalled();
    expect(host.storage.orchestration.updateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        executionState: "failed",
        lastError: expect.stringContaining("workspaceId must be a string"),
      }),
    );
    expect(host.storage.orchestration.appendRunEvent).toHaveBeenCalledWith(
      "run-1",
      "run.workspace_mismatch",
      expect.objectContaining({
        payloadWorkspaceId: "42",
        runWorkspaceId: "default",
      }),
    );
    expect(runtime.worktrees.release).toHaveBeenCalledWith({
      run: expect.objectContaining({
        runId: "run-1",
        status: "failed",
        worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-1",
      }),
      reason: "failed",
    });
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
          approvalId: "approval-phase-1",
        })),
      },
    });

    const result = await executeDurableOrchestrationRun(host, runtime, host.getDurableRun("durable-run-1"));

    expect(result.outcome).toBe("paused");
    expect(host.orchestrationEngine.advancePhase).not.toHaveBeenCalled();
    expect(host.pauseDurableRun).not.toHaveBeenCalled();
    expect(host.storage.orchestration.updateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "running",
        executionState: "paused_for_approval",
      }),
    );
    expect(host.updateDurableRunState).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "durable-run-1",
        status: "waiting",
        metadata: expect.objectContaining({
          waitForEvent: {
            eventKey: "approval.resolved",
            correlationId: "approval-phase-1",
          },
        }),
      }),
    );
    expect(host.storage.orchestration.appendRunEvent).toHaveBeenCalledWith(
      "run-1",
      "phase.waiting",
      expect.objectContaining({
        childRunId: "durable-child-1",
        approvalId: "approval-phase-1",
      }),
    );
  });

  it("fails child wait results that cannot be resumed by approval correlation", async () => {
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
          outputSummary: "Waiting for user input.",
          childSessionId: "sess_phase",
          childTurnId: "turn_phase",
          childRunId: "durable-child-1",
        })),
      },
    });

    const result = await executeDurableOrchestrationRun(host, runtime, host.getDurableRun("durable-run-1"));

    expect(result.outcome).toBe("failed");
    expect(host.orchestrationEngine.advancePhase).not.toHaveBeenCalled();
    expect(host.updateDurableRunState).not.toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "durable-run-1",
        status: "waiting",
      }),
    );
    expect(host.storage.orchestration.updateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        executionState: "failed",
        lastError:
          "Phase child turn entered a wait state without an approval id; durable orchestration only supports approval-correlated child waits.",
      }),
    );
    expect(host.storage.orchestration.appendRunEvent).toHaveBeenCalledWith(
      "run-1",
      "phase.failed",
      expect.objectContaining({
        childRunId: "durable-child-1",
        error:
          "Phase child turn entered a wait state without an approval id; durable orchestration only supports approval-correlated child waits.",
      }),
    );
  });

  it("fails approval-correlated child waits that do not include a child durable run id", async () => {
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
          approvalId: "approval-phase-1",
        })),
      },
    });

    const result = await executeDurableOrchestrationRun(host, runtime, host.getDurableRun("durable-run-1"));

    expect(result.outcome).toBe("failed");
    expect(host.updateDurableRunState).not.toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "durable-run-1",
        status: "waiting",
      }),
    );
    expect(host.storage.orchestration.updateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        executionState: "failed",
        lastError:
          "Phase child turn entered a wait state without a child durable run id; durable orchestration cannot resume an unlinked child wait.",
      }),
    );
    expect(host.storage.orchestration.appendRunEvent).toHaveBeenCalledWith(
      "run-1",
      "phase.failed",
      expect.objectContaining({
        approvalId: "approval-phase-1",
        error:
          "Phase child turn entered a wait state without a child durable run id; durable orchestration cannot resume an unlinked child wait.",
      }),
    );
    expect(runtime.worktrees.release).toHaveBeenCalledWith({
      run: expect.objectContaining({ status: "failed" }),
      reason: "failed",
    });
  });

  it("harvests the completed child phase instead of re-running it after approval wake", async () => {
    const autoPlan: OrchestrationPlan = {
      ...buildPlan(),
      waves: [
        {
          ...buildPlan().waves[0]!,
          phases: [{ ...buildPlan().waves[0]!.phases[0]!, requiresApproval: false }],
        },
      ],
    };
    let run: OrchestrationRun = {
      ...buildRun(),
      durableRunId: "durable-run-1",
      executionState: "queued",
      worktreeStatus: "ready",
      worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-1",
    };
    let childDurableRun: DurableRunRecord = {
      runId: "durable-child-1",
      workflowKey: "chat.turn.execute",
      status: "waiting",
      attemptCount: 0,
      maxAttempts: 3,
      version: 1,
      payload: {},
      metadata: {},
      createdAt: "2026-04-12T00:00:01.000Z",
      updatedAt: "2026-04-12T00:00:02.000Z",
    };
    const base = createHost();
    const host = createHost({
      storage: {
        orchestration: {
          ...base.storage.orchestration,
          getPlan: vi.fn(() => autoPlan),
          getRun: vi.fn(() => run),
          updateRun: vi.fn((value: OrchestrationRun) => {
            run = value;
            return value;
          }),
        },
      } as OrchestrationLifecycleHost["storage"],
      orchestrationEngine: {
        ...base.orchestrationEngine,
        advancePhase: vi.fn(
          (_currentPlan, currentRun) =>
            ({
              ...currentRun,
              status: "completed",
              currentWaveId: undefined,
              currentPhaseId: undefined,
              totalIterations: currentRun.totalIterations + 1,
            }) as OrchestrationRun,
        ),
      },
    });
    const getParentDurableRun = host.getDurableRun;
    (host as unknown as { getDurableRun: OrchestrationLifecycleHost["getDurableRun"] }).getDurableRun = vi.fn(
      (runId: string) => (runId === "durable-child-1" ? childDurableRun : getParentDurableRun(runId)),
    );
    const execute = vi.fn().mockResolvedValueOnce({
      phaseId: "phase-1",
      ownerAgentId: "agent-1",
      status: "waiting" as const,
      startedAt: "2026-04-12T00:00:01.000Z",
      finishedAt: "2026-04-12T00:00:02.000Z",
      outputSummary: "Waiting for operator approval.",
      outputText: "Waiting with preserved child context.",
      childSessionId: "sess_phase",
      childTurnId: "turn_phase",
      childRunId: "durable-child-1",
      approvalId: "approval-phase-1",
    });
    const runtime = createRuntimeDeps({ phaseExecutor: { execute } });

    const first = await executeDurableOrchestrationRun(host, runtime, host.getDurableRun("durable-run-1"));
    expect(first.outcome).toBe("paused");
    expect(host.getDurableRun("durable-run-1").status).toBe("waiting");
    expect(host.getDurableRun("durable-run-1").metadata?.waitingPhase).toMatchObject({
      outputText: "Waiting with preserved child context.",
    });

    host.updateDurableRunState({
      runId: "durable-run-1",
      status: "queued",
      metadata: host.getDurableRun("durable-run-1").metadata,
      clearFinishedAt: true,
      clearLastError: true,
    });
    childDurableRun = {
      ...childDurableRun,
      status: "completed",
      metadata: {
        outputSummary: "Approved child summary",
        outputText: "Approved child final text",
      },
      finishedAt: "2026-04-12T00:01:02.000Z",
      updatedAt: "2026-04-12T00:01:02.000Z",
    };
    const second = await executeDurableOrchestrationRun(host, runtime, host.getDurableRun("durable-run-1"));

    expect(second.outcome).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(host.orchestrationEngine.startRun).toHaveBeenCalledTimes(1);
    expect(host.orchestrationEngine.advancePhase).toHaveBeenCalledWith(
      autoPlan,
      expect.objectContaining({ executionState: "running", currentPhaseId: "phase-1" }),
      "phase-1",
      expect.any(Object),
    );
    expect(host.storage.orchestration.appendRunEvent).toHaveBeenCalledWith(
      "run-1",
      "phase.executed",
      expect.objectContaining({
        outputSummary: "Approved child summary",
        outputText: "Approved child final text",
      }),
    );
  });

  it("does not re-run a parent phase while the original child durable run is still live", async () => {
    const autoPlan: OrchestrationPlan = {
      ...buildPlan(),
      waves: [
        {
          ...buildPlan().waves[0]!,
          phases: [{ ...buildPlan().waves[0]!.phases[0]!, requiresApproval: false }],
        },
      ],
    };
    let run: OrchestrationRun = {
      ...buildRun(),
      durableRunId: "durable-run-1",
      executionState: "queued",
      worktreeStatus: "ready",
      worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-1",
    };
    const childDurableRun: DurableRunRecord = {
      runId: "durable-child-1",
      workflowKey: "chat.turn.execute",
      status: "running",
      attemptCount: 1,
      maxAttempts: 3,
      version: 2,
      payload: {},
      metadata: {},
      createdAt: "2026-04-12T00:00:01.000Z",
      updatedAt: "2026-04-12T00:00:02.000Z",
    };
    const base = createHost();
    const host = createHost({
      storage: {
        orchestration: {
          ...base.storage.orchestration,
          getPlan: vi.fn(() => autoPlan),
          getRun: vi.fn(() => run),
          updateRun: vi.fn((value: OrchestrationRun) => {
            run = value;
            return value;
          }),
        },
      } as OrchestrationLifecycleHost["storage"],
    });
    const getParentDurableRun = host.getDurableRun;
    (host as unknown as { getDurableRun: OrchestrationLifecycleHost["getDurableRun"] }).getDurableRun = vi.fn(
      (runId: string) => (runId === "durable-child-1" ? childDurableRun : getParentDurableRun(runId)),
    );
    const execute = vi.fn().mockResolvedValueOnce({
      phaseId: "phase-1",
      ownerAgentId: "agent-1",
      status: "waiting" as const,
      startedAt: "2026-04-12T00:00:01.000Z",
      finishedAt: "2026-04-12T00:00:02.000Z",
      outputSummary: "Waiting for operator approval.",
      childSessionId: "sess_phase",
      childTurnId: "turn_phase",
      childRunId: "durable-child-1",
      approvalId: "approval-phase-1",
    });
    const runtime = createRuntimeDeps({ phaseExecutor: { execute } });

    const first = await executeDurableOrchestrationRun(host, runtime, host.getDurableRun("durable-run-1"));
    expect(first.outcome).toBe("paused");

    host.updateDurableRunState({
      runId: "durable-run-1",
      status: "queued",
      metadata: host.getDurableRun("durable-run-1").metadata,
      clearFinishedAt: true,
      clearLastError: true,
    });
    const second = await executeDurableOrchestrationRun(host, runtime, host.getDurableRun("durable-run-1"));

    expect(second.outcome).toBe("paused");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(host.requestDurableRunProcessing).toHaveBeenCalledWith("durable-child-1");
    expect(host.orchestrationEngine.advancePhase).not.toHaveBeenCalled();
  });

  it("fails instead of duplicating a parent phase when the waiting child durable run is missing", async () => {
    const autoPlan: OrchestrationPlan = {
      ...buildPlan(),
      waves: [
        {
          ...buildPlan().waves[0]!,
          phases: [{ ...buildPlan().waves[0]!.phases[0]!, requiresApproval: false }],
        },
      ],
    };
    let run: OrchestrationRun = {
      ...buildRun(),
      durableRunId: "durable-run-1",
      executionState: "queued",
      worktreeStatus: "ready",
      worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-1",
    };
    const base = createHost();
    const host = createHost({
      storage: {
        orchestration: {
          ...base.storage.orchestration,
          getPlan: vi.fn(() => autoPlan),
          getRun: vi.fn(() => run),
          updateRun: vi.fn((value: OrchestrationRun) => {
            run = value;
            return value;
          }),
        },
      } as OrchestrationLifecycleHost["storage"],
    });
    const getParentDurableRun = host.getDurableRun;
    (host as unknown as { getDurableRun: OrchestrationLifecycleHost["getDurableRun"] }).getDurableRun = vi.fn(
      (runId: string) => {
        if (runId === "durable-child-1") {
          throw new NotFoundError({ entity: "Durable run", id: runId });
        }
        return getParentDurableRun(runId);
      },
    );
    const execute = vi.fn().mockResolvedValueOnce({
      phaseId: "phase-1",
      ownerAgentId: "agent-1",
      status: "waiting" as const,
      startedAt: "2026-04-12T00:00:01.000Z",
      finishedAt: "2026-04-12T00:00:02.000Z",
      outputSummary: "Waiting for operator approval.",
      childSessionId: "sess_phase",
      childTurnId: "turn_phase",
      childRunId: "durable-child-1",
      approvalId: "approval-phase-1",
    });
    const runtime = createRuntimeDeps({ phaseExecutor: { execute } });

    const first = await executeDurableOrchestrationRun(host, runtime, host.getDurableRun("durable-run-1"));
    expect(first.outcome).toBe("paused");

    host.updateDurableRunState({
      runId: "durable-run-1",
      status: "queued",
      metadata: host.getDurableRun("durable-run-1").metadata,
      clearFinishedAt: true,
      clearLastError: true,
    });
    const second = await executeDurableOrchestrationRun(host, runtime, host.getDurableRun("durable-run-1"));

    expect(second.outcome).toBe("failed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(host.storage.orchestration.updateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        executionState: "failed",
        lastError: expect.stringContaining("Child durable run durable-child-1 is missing"),
      }),
    );
    expect(host.storage.orchestration.appendRunEvent).toHaveBeenCalledWith(
      "run-1",
      "run.child_durable_missing",
      expect.objectContaining({
        childRunId: "durable-child-1",
      }),
    );
    expect(host.updateDurableRunState).not.toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "durable-run-1",
        status: "failed",
      }),
    );
    expect(runtime.worktrees.release).toHaveBeenCalledWith(
      expect.objectContaining({
        run: expect.objectContaining({
          runId: "run-1",
          status: "failed",
        }),
        reason: "failed",
      }),
    );
  });

  it("does not convert non-missing child durable store errors into terminal child-missing failures", async () => {
    const autoPlan: OrchestrationPlan = {
      ...buildPlan(),
      waves: [
        {
          ...buildPlan().waves[0]!,
          phases: [{ ...buildPlan().waves[0]!.phases[0]!, requiresApproval: false }],
        },
      ],
    };
    let run: OrchestrationRun = {
      ...buildRun(),
      durableRunId: "durable-run-1",
      executionState: "queued",
      worktreeStatus: "ready",
      worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-1",
    };
    const base = createHost();
    const host = createHost({
      storage: {
        orchestration: {
          ...base.storage.orchestration,
          getPlan: vi.fn(() => autoPlan),
          getRun: vi.fn(() => run),
          updateRun: vi.fn((value: OrchestrationRun) => {
            run = value;
            return value;
          }),
        },
      } as OrchestrationLifecycleHost["storage"],
    });
    const getParentDurableRun = host.getDurableRun;
    (host as unknown as { getDurableRun: OrchestrationLifecycleHost["getDurableRun"] }).getDurableRun = vi.fn(
      (runId: string) => {
        if (runId === "durable-child-1") {
          throw new Error("durable store unavailable");
        }
        return getParentDurableRun(runId);
      },
    );
    const execute = vi.fn().mockResolvedValueOnce({
      phaseId: "phase-1",
      ownerAgentId: "agent-1",
      status: "waiting" as const,
      startedAt: "2026-04-12T00:00:01.000Z",
      finishedAt: "2026-04-12T00:00:02.000Z",
      outputSummary: "Waiting for operator approval.",
      childSessionId: "sess_phase",
      childTurnId: "turn_phase",
      childRunId: "durable-child-1",
      approvalId: "approval-phase-1",
    });
    const runtime = createRuntimeDeps({ phaseExecutor: { execute } });

    const first = await executeDurableOrchestrationRun(host, runtime, host.getDurableRun("durable-run-1"));
    expect(first.outcome).toBe("paused");

    host.updateDurableRunState({
      runId: "durable-run-1",
      status: "queued",
      metadata: host.getDurableRun("durable-run-1").metadata,
      clearFinishedAt: true,
      clearLastError: true,
    });
    vi.mocked(host.storage.orchestration.updateRun).mockClear();

    await expect(executeDurableOrchestrationRun(host, runtime, host.getDurableRun("durable-run-1"))).rejects.toThrow(
      "durable store unavailable",
    );
    expect(host.storage.orchestration.updateRun).not.toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        executionState: "failed",
        lastError: expect.stringContaining("Child durable run durable-child-1 is missing"),
      }),
    );
    expect(runtime.worktrees.release).not.toHaveBeenCalledWith(expect.objectContaining({ reason: "failed" }));
  });

  it("harvests a crashed in-flight non-approval phase from its dispatched child instead of re-dispatching it", async () => {
    // ORCH-002: a normal (non-approval) phase crashed mid-execution. The run row
    // is still `running` with `currentPhaseId`, and the durable metadata carries
    // the dispatched-child linkage breadcrumb written at dispatch time. Resume
    // MUST harvest the existing child and advance, never re-dispatch the phase.
    const autoPlan: OrchestrationPlan = {
      ...buildPlan(),
      waves: [
        {
          ...buildPlan().waves[0]!,
          phases: [{ ...buildPlan().waves[0]!.phases[0]!, requiresApproval: false }],
        },
      ],
    };
    let run: OrchestrationRun = {
      ...buildRun(),
      status: "running",
      executionState: "running",
      currentWaveId: "wave-1",
      currentPhaseId: "phase-1",
      durableRunId: "durable-run-1",
      worktreeStatus: "ready",
      worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-1",
    };
    const childDurableRun: DurableRunRecord = {
      runId: "durable-child-1",
      workflowKey: "chat.turn.execute",
      status: "completed",
      attemptCount: 1,
      maxAttempts: 3,
      version: 3,
      payload: {},
      metadata: {
        outputSummary: "Recovered child summary",
        outputText: "Recovered child final text",
      },
      finishedAt: "2026-04-12T00:01:02.000Z",
      createdAt: "2026-04-12T00:00:01.000Z",
      updatedAt: "2026-04-12T00:01:02.000Z",
    };
    // Parent durable run carries the dispatched-child breadcrumb (no waitingPhase
    // because this phase never required approval).
    const parentDurableRun: DurableRunRecord = {
      runId: "durable-run-1",
      workflowKey: "orchestration.plan.execute",
      status: "queued",
      attemptCount: 1,
      maxAttempts: 3,
      version: 5,
      payload: {
        version: "orchestration.plan.execute.v1",
        orchestrationRunId: "run-1",
        planId: "plan-1",
        workspaceId: "default",
        requestedAt: "2026-04-12T00:00:00.000Z",
      },
      metadata: {
        dispatchedPhase: {
          phaseId: "phase-1",
          ownerAgentId: "agent-1",
          dispatchInFlight: true,
          childSessionId: "sess_phase",
          childRunId: "durable-child-1",
        },
      },
      createdAt: "2026-04-12T00:00:00.000Z",
      updatedAt: "2026-04-12T00:00:30.000Z",
    };
    const base = createHost();
    const host = createHost({
      storage: {
        orchestration: {
          ...base.storage.orchestration,
          getPlan: vi.fn(() => autoPlan),
          getRun: vi.fn(() => run),
          updateRun: vi.fn((value: OrchestrationRun) => {
            run = value;
            return value;
          }),
        },
      } as OrchestrationLifecycleHost["storage"],
      getDurableRun: vi.fn((runId: string) => (runId === "durable-child-1" ? childDurableRun : parentDurableRun)),
      orchestrationEngine: {
        ...base.orchestrationEngine,
        advancePhase: vi.fn(
          (_currentPlan, currentRun) =>
            ({
              ...currentRun,
              status: "completed",
              currentWaveId: undefined,
              currentPhaseId: undefined,
              totalIterations: currentRun.totalIterations + 1,
            }) as OrchestrationRun,
        ),
      },
    });
    const execute = vi.fn();
    const runtime = createRuntimeDeps({ phaseExecutor: { execute } });

    const result = await executeDurableOrchestrationRun(host, runtime, parentDurableRun);

    expect(result.outcome).toBe("completed");
    // Hard invariant: the phase executor is never invoked on resume.
    expect(execute).not.toHaveBeenCalled();
    expect(host.orchestrationEngine.startRun).not.toHaveBeenCalled();
    // The phase advances from the harvested child outcome.
    expect(host.orchestrationEngine.advancePhase).toHaveBeenCalledWith(
      autoPlan,
      expect.objectContaining({ executionState: "running", currentPhaseId: "phase-1" }),
      "phase-1",
      expect.any(Object),
    );
    expect(host.storage.orchestration.appendRunEvent).toHaveBeenCalledWith(
      "run-1",
      "phase.executed",
      expect.objectContaining({
        outputSummary: "Recovered child summary",
        outputText: "Recovered child final text",
        childRunId: "durable-child-1",
      }),
    );
  });

  it("reattaches to a still-running dispatched child on resume instead of re-dispatching the phase", async () => {
    const autoPlan: OrchestrationPlan = {
      ...buildPlan(),
      waves: [
        {
          ...buildPlan().waves[0]!,
          phases: [{ ...buildPlan().waves[0]!.phases[0]!, requiresApproval: false }],
        },
      ],
    };
    let run: OrchestrationRun = {
      ...buildRun(),
      status: "running",
      executionState: "running",
      currentWaveId: "wave-1",
      currentPhaseId: "phase-1",
      durableRunId: "durable-run-1",
      worktreeStatus: "ready",
      worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-1",
    };
    const childDurableRun: DurableRunRecord = {
      runId: "durable-child-1",
      workflowKey: "chat.turn.execute",
      status: "running",
      attemptCount: 1,
      maxAttempts: 3,
      version: 2,
      payload: {},
      metadata: {},
      createdAt: "2026-04-12T00:00:01.000Z",
      updatedAt: "2026-04-12T00:00:02.000Z",
    };
    const parentDurableRun: DurableRunRecord = {
      runId: "durable-run-1",
      workflowKey: "orchestration.plan.execute",
      status: "queued",
      attemptCount: 1,
      maxAttempts: 3,
      version: 5,
      payload: {
        version: "orchestration.plan.execute.v1",
        orchestrationRunId: "run-1",
        planId: "plan-1",
        workspaceId: "default",
        requestedAt: "2026-04-12T00:00:00.000Z",
      },
      metadata: {
        dispatchedPhase: {
          phaseId: "phase-1",
          ownerAgentId: "agent-1",
          dispatchInFlight: true,
          childSessionId: "sess_phase",
          childRunId: "durable-child-1",
        },
      },
      createdAt: "2026-04-12T00:00:00.000Z",
      updatedAt: "2026-04-12T00:00:30.000Z",
    };
    const base = createHost();
    const host = createHost({
      storage: {
        orchestration: {
          ...base.storage.orchestration,
          getPlan: vi.fn(() => autoPlan),
          getRun: vi.fn(() => run),
          updateRun: vi.fn((value: OrchestrationRun) => {
            run = value;
            return value;
          }),
        },
      } as OrchestrationLifecycleHost["storage"],
      getDurableRun: vi.fn((runId: string) => (runId === "durable-child-1" ? childDurableRun : parentDurableRun)),
    });
    const execute = vi.fn();
    const runtime = createRuntimeDeps({ phaseExecutor: { execute } });

    const result = await executeDurableOrchestrationRun(host, runtime, parentDurableRun);

    expect(result.outcome).toBe("paused");
    expect(execute).not.toHaveBeenCalled();
    expect(host.orchestrationEngine.advancePhase).not.toHaveBeenCalled();
    expect(host.requestDurableRunProcessing).toHaveBeenCalledWith("durable-child-1");
    expect(host.storage.orchestration.appendRunEvent).toHaveBeenCalledWith(
      "run-1",
      "run.waiting_for_child",
      expect.objectContaining({ childRunId: "durable-child-1", childStatus: "running" }),
    );
  });

  it("fails a resumed phase recoverably when its dispatched child has no durable run id", async () => {
    const autoPlan: OrchestrationPlan = {
      ...buildPlan(),
      waves: [
        {
          ...buildPlan().waves[0]!,
          phases: [{ ...buildPlan().waves[0]!.phases[0]!, requiresApproval: false }],
        },
      ],
    };
    let run: OrchestrationRun = {
      ...buildRun(),
      status: "running",
      executionState: "running",
      currentWaveId: "wave-1",
      currentPhaseId: "phase-1",
      durableRunId: "durable-run-1",
      worktreeStatus: "ready",
      worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-1",
    };
    const parentDurableRun: DurableRunRecord = {
      runId: "durable-run-1",
      workflowKey: "orchestration.plan.execute",
      status: "queued",
      attemptCount: 1,
      maxAttempts: 3,
      version: 5,
      payload: {
        version: "orchestration.plan.execute.v1",
        orchestrationRunId: "run-1",
        planId: "plan-1",
        workspaceId: "default",
        requestedAt: "2026-04-12T00:00:00.000Z",
      },
      metadata: {
        // Breadcrumb without a child durable run id (child ran inline / durable
        // execution disabled): we cannot harvest it, so fail recoverably.
        dispatchedPhase: {
          phaseId: "phase-1",
          ownerAgentId: "agent-1",
          dispatchInFlight: true,
          childSessionId: "sess_phase",
        },
      },
      createdAt: "2026-04-12T00:00:00.000Z",
      updatedAt: "2026-04-12T00:00:30.000Z",
    };
    const base = createHost();
    const host = createHost({
      storage: {
        orchestration: {
          ...base.storage.orchestration,
          getPlan: vi.fn(() => autoPlan),
          getRun: vi.fn(() => run),
          updateRun: vi.fn((value: OrchestrationRun) => {
            run = value;
            return value;
          }),
        },
      } as OrchestrationLifecycleHost["storage"],
      getDurableRun: vi.fn(() => parentDurableRun),
    });
    const execute = vi.fn();
    const runtime = createRuntimeDeps({ phaseExecutor: { execute } });

    const result = await executeDurableOrchestrationRun(host, runtime, parentDurableRun);

    expect(result.outcome).toBe("failed");
    expect(execute).not.toHaveBeenCalled();
    expect(host.orchestrationEngine.advancePhase).not.toHaveBeenCalled();
    expect(host.storage.orchestration.updateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        executionState: "failed",
        lastError: expect.stringContaining("dispatched a child without a durable run id"),
      }),
    );
    expect(runtime.worktrees.release).toHaveBeenCalledWith(
      expect.objectContaining({ run: expect.objectContaining({ status: "failed" }), reason: "failed" }),
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
