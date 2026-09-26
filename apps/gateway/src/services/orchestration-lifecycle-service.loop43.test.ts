import { describe, expect, it, vi } from "vitest";
import type { DurableRunRecord, OrchestrationPlan, OrchestrationRun } from "@goatcitadel/contracts";
import { OrchestrationEngine } from "@goatcitadel/orchestration";
import type { OrchestrationCheckpoint } from "@goatcitadel/storage";
import {
  approvePhase,
  cancelOrchestrationRun,
  executeDurableOrchestrationRun,
  failOrchestrationRunForWorkflowError,
  listRunCheckpoints,
  parseOrchestrationWorkflowPayload,
  reconcileTerminalOrchestrationRuns,
  runOrchestrationPlan,
  type OrchestrationLifecycleHost,
  type OrchestrationLifecycleRuntimeDeps,
} from "./orchestration-lifecycle-service.js";

describe("orchestration lifecycle loop43 durable edge behavior", () => {
  it("uses the database-clock lease lock before canonical orchestration commits", async () => {
    const harness = createHarness({ run: { ...buildRun(), durableRunId: "durable-run-1" } });

    await executeDurableOrchestrationRun(harness.host, harness.runtime, harness.getDurableRun());

    expect(harness.host.storage.durableRuns.lockFreshActiveLeaseForUpdate).toHaveBeenCalledWith(
      "durable-run-1",
      "worker-a",
    );
  });

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
      "default",
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
    expect(approvalRemoved.host.storage.orchestration.upsertPlan).not.toHaveBeenCalled();
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
        advancePhase: vi.fn((plan: OrchestrationPlan, run: OrchestrationRun) => ({
          ...run,
          status: "completed",
          currentWaveId: undefined,
          currentPhaseId: undefined,
          totalIterations: 1,
          totalCostUsd: 0.5,
          pendingApprovalPhaseId: undefined,
          pendingApprovedBy: undefined,
        })),
      },
    });

    const result = await executeDurableOrchestrationRun(harness.host, harness.runtime, buildDurableRun());

    expect(result.outcome).toBe("completed");
    expect(harness.host.orchestrationEngine.approvePhase).toHaveBeenCalledWith(
      expect.objectContaining({ planId: "plan-1" }),
      expect.objectContaining({ status: "paused", executionState: "resume_requested" }),
      "phase-1",
    );
    // The approved phase runs; approval no longer skips past it.
    expect(harness.runtime.phaseExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({ phase: expect.objectContaining({ phaseId: "phase-1" }) }),
    );
    expect(harness.host.orchestrationEngine.advancePhase).toHaveBeenCalledWith(
      expect.objectContaining({ planId: "plan-1" }),
      expect.objectContaining({ pendingApprovalPhaseId: "phase-1", pendingApprovedBy: "operator" }),
      "phase-1",
      { costIncrementUsd: 0.5 },
    );
    // The after-phase hook fires once the approved phase has run, not at approval time.
    expect(harness.host.hooksService.enqueueAfterHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "orchestration.phase.after",
        entityId: "run-1:phase-1",
        payload: expect.objectContaining({ phaseId: "phase-1", approvedBy: "operator" }),
      }),
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

  it("surfaces the wave_budget_exceeded stop reason on the run.stopped event", async () => {
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
          stopReason: "wave_budget_exceeded",
          currentWaveId: "wave-1",
          currentPhaseId: "phase-1",
          totalIterations: 1,
          totalCostUsd: 2,
          waveCostUsdByWaveId: { "wave-1": 2 },
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
        totalCostUsd: 2,
        stopReason: "wave_budget_exceeded",
      }),
    );
    expect(harness.runtime.worktrees.release).toHaveBeenCalledWith({
      run: expect.objectContaining({ status: "stopped_by_limit", stopReason: "wave_budget_exceeded" }),
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

    const checkpoints = await listRunCheckpoints(harness.host, "run-1", " default ");
    expect(checkpoints.length).toBeGreaterThan(0);
    await expect(listRunCheckpoints(harness.host, "run-1", "bad workspace")).rejects.toThrow(
      "workspaceId contains unsupported characters",
    );
  });

  it("atomically attaches a child watcher when a real orchestration phase dispatch commits", async () => {
    const harness = createHarness({
      run: {
        ...buildRun(),
        durableRunId: "durable-run-1",
        executionState: "queued",
        worktreeStatus: "ready",
      },
    });
    vi.mocked(harness.runtime.phaseExecutor.execute).mockImplementation(async (input) => {
      await input.onChildDispatched?.({
        phaseId: "phase-1",
        childSessionId: "child-session-1",
        childTurnId: "child-turn-1",
        childRunId: "child-run-1",
      });
      return {
        phaseId: "phase-1",
        ownerAgentId: "agent-1",
        status: "completed",
        startedAt: "2026-05-15T12:00:01.000Z",
        finishedAt: "2026-05-15T12:00:02.000Z",
        outputSummary: "Phase completed",
        costUsd: 0.5,
      };
    });

    await executeDurableOrchestrationRun(harness.host, harness.runtime, buildDurableRun());

    expect(harness.host.watchDurableChildRun).toHaveBeenCalledTimes(1);
    expect(harness.host.watchDurableChildRun).toHaveBeenCalledWith({
      watcherId: "orchestration-child:durable-run-1:phase-1",
      parentRunId: "durable-run-1",
      childRunId: "child-run-1",
      source: "orchestration_phase",
      metadata: {
        orchestrationRunId: "run-1",
        planId: "plan-1",
        phaseId: "phase-1",
        childSessionId: "child-session-1",
        childTurnId: "child-turn-1",
      },
    });
  });

  it("fences a late phase result after durable lease takeover", async () => {
    const harness = createHarness({
      run: {
        ...buildRun(),
        durableRunId: "durable-run-1",
        executionState: "queued",
        worktreeStatus: "ready",
        worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-1",
      },
    });
    let replacement!: DurableRunRecord;
    vi.mocked(harness.runtime.phaseExecutor.execute).mockImplementation(async () => {
      replacement = {
        ...harness.getDurableRun(),
        status: "running",
        leaseOwnerId: "worker-b",
        leaseHeartbeatAt: "2026-05-15T12:00:30.000Z",
        leaseExpiresAt: "2099-12-31T23:59:59.999Z",
        metadata: { replacementWorker: true },
        version: harness.getDurableRun().version + 1,
      };
      harness.setDurableRun(replacement);
      return {
        phaseId: "phase-1",
        ownerAgentId: "agent-1",
        status: "completed",
        startedAt: "2026-05-15T12:00:01.000Z",
        finishedAt: "2026-05-15T12:00:30.000Z",
        outputSummary: "stale worker result",
        costUsd: 0.5,
      };
    });

    await expect(
      executeDurableOrchestrationRun(harness.host, harness.runtime, buildDurableRun()),
    ).rejects.toMatchObject({ name: "DurableWorkerInterruptionError" });

    expect(harness.getDurableRun()).toEqual(replacement);
    expect(harness.getRun()).toMatchObject({
      status: "running",
      executionState: "running",
      currentPhaseId: "phase-1",
    });
    expect(vi.mocked(harness.host.createCheckpoint).mock.calls.map(([input]) => input.checkpointKind)).not.toContain(
      "phase_executed",
    );
    expect(harness.host.pauseDurableRun).not.toHaveBeenCalled();
    expect(harness.host.cancelDurableRun).not.toHaveBeenCalled();
    expect(harness.runtime.worktrees.release).not.toHaveBeenCalled();
  });

  it("fences a child-dispatch breadcrumb after durable lease takeover", async () => {
    const harness = createHarness({
      run: {
        ...buildRun(),
        durableRunId: "durable-run-1",
        executionState: "queued",
        worktreeStatus: "ready",
      },
    });
    let replacement!: DurableRunRecord;
    vi.mocked(harness.runtime.phaseExecutor.execute).mockImplementation(async (input) => {
      replacement = {
        ...harness.getDurableRun(),
        leaseOwnerId: "worker-b",
        leaseHeartbeatAt: "2026-05-15T12:00:05.000Z",
        leaseExpiresAt: "2099-12-31T23:59:59.999Z",
        metadata: { replacementWorker: true },
        version: harness.getDurableRun().version + 1,
      };
      harness.setDurableRun(replacement);
      await input.onChildDispatched?.({
        phaseId: "phase-1",
        childSessionId: "child-session-1",
        childTurnId: "child-turn-1",
        childRunId: "child-run-1",
      });
      throw new Error("unreachable after fenced child dispatch");
    });

    await expect(
      executeDurableOrchestrationRun(harness.host, harness.runtime, buildDurableRun()),
    ).rejects.toMatchObject({ name: "DurableWorkerInterruptionError" });

    expect(harness.getDurableRun()).toEqual(replacement);
    expect(harness.host.storage.orchestration.appendRunEvent).not.toHaveBeenCalledWith(
      "run-1",
      "phase.child_dispatched",
      expect.anything(),
    );
    expect(harness.runtime.worktrees.release).not.toHaveBeenCalled();
  });

  it("rolls back approval-wait state when its durable timeline commit fails", async () => {
    const harness = createHarness({
      run: {
        ...buildRun(),
        durableRunId: "durable-run-1",
        executionState: "queued",
        worktreeStatus: "ready",
      },
    });
    vi.mocked(harness.runtime.phaseExecutor.execute).mockResolvedValue({
      phaseId: "phase-1",
      ownerAgentId: "agent-1",
      status: "waiting",
      startedAt: "2026-05-15T12:00:01.000Z",
      finishedAt: "2026-05-15T12:00:02.000Z",
      outputSummary: "Waiting for approval.",
      childSessionId: "child-session-1",
      childTurnId: "child-turn-1",
      childRunId: "child-run-1",
      approvalId: "approval-1",
      costUsd: 0,
    });
    vi.mocked(harness.host.recordDurableTimelineEvent).mockImplementation((_runId, eventType) => {
      if (eventType === "run_waiting") {
        throw new Error("timeline store unavailable");
      }
    });

    await expect(executeDurableOrchestrationRun(harness.host, harness.runtime, buildDurableRun())).rejects.toThrow(
      "timeline store unavailable",
    );

    expect(harness.getDurableRun()).toMatchObject({ status: "running", leaseOwnerId: "worker-a" });
    expect(harness.getRun()).toMatchObject({
      status: "running",
      executionState: "running",
      currentPhaseId: "phase-1",
    });
    expect(
      harness.host.storage.orchestration.listCheckpoints("run-1").map((item) => item.checkpointKind),
    ).not.toContain("run_paused_for_approval");
    expect(harness.runtime.worktrees.release).not.toHaveBeenCalled();
  });

  it("rolls back run-start state when its durable timeline commit fails", async () => {
    const initialRun: OrchestrationRun = {
      ...buildRun(),
      durableRunId: "durable-run-1",
      executionState: "queued",
      worktreeStatus: "ready",
    };
    const initialDurableRun = buildDurableRun();
    const harness = createHarness({ run: initialRun, durableRun: initialDurableRun });
    vi.mocked(harness.host.recordDurableTimelineEvent).mockImplementation((_runId, eventType) => {
      if (eventType === "run_started") {
        throw new Error("timeline store unavailable");
      }
    });

    await expect(executeDurableOrchestrationRun(harness.host, harness.runtime, initialDurableRun)).rejects.toThrow(
      "timeline store unavailable",
    );

    expect(harness.getRun()).toEqual(initialRun);
    expect(harness.getDurableRun()).toEqual(initialDurableRun);
    expect(
      harness.host.storage.orchestration.listCheckpoints("run-1").map((item) => item.checkpointKind),
    ).not.toContain("run_started");
    expect(harness.runtime.phaseExecutor.execute).not.toHaveBeenCalled();
  });

  it("rolls back approval-resume state when its durable timeline commit fails", async () => {
    const initialRun: OrchestrationRun = {
      ...buildRun(),
      status: "paused",
      executionState: "resume_requested",
      currentWaveId: "wave-1",
      currentPhaseId: "phase-1",
      pendingApprovalPhaseId: "phase-1",
      pendingApprovedBy: "operator",
      pendingCostIncrementUsd: 0.75,
      durableRunId: "durable-run-1",
      worktreeStatus: "ready",
    };
    const initialDurableRun = buildDurableRun();
    const harness = createHarness({ run: initialRun, durableRun: initialDurableRun });
    vi.mocked(harness.host.recordDurableTimelineEvent).mockImplementation((_runId, eventType) => {
      if (eventType === "run_resumed") {
        throw new Error("timeline store unavailable");
      }
    });

    await expect(executeDurableOrchestrationRun(harness.host, harness.runtime, initialDurableRun)).rejects.toThrow(
      "timeline store unavailable",
    );

    expect(harness.getRun()).toEqual(initialRun);
    expect(harness.getDurableRun()).toEqual(initialDurableRun);
    expect(
      harness.host.storage.orchestration.listCheckpoints("run-1").map((item) => item.checkpointKind),
    ).not.toContain("run_resumed");
    expect(harness.runtime.phaseExecutor.execute).not.toHaveBeenCalled();
  });

  it("rolls back child-resume state when its durable timeline commit fails", async () => {
    const initialRun: OrchestrationRun = {
      ...buildRun(),
      status: "running",
      executionState: "running",
      currentWaveId: "wave-1",
      currentPhaseId: "phase-1",
      durableRunId: "durable-run-1",
      worktreeStatus: "ready",
    };
    const initialDurableRun = buildDurableRun({
      metadata: {
        dispatchedPhase: {
          phaseId: "phase-1",
          ownerAgentId: "agent-1",
          dispatchInFlight: true,
          childSessionId: "child-session-1",
          childRunId: "child-run-1",
        },
      },
    });
    const childDurableRun = buildDurableRun({
      runId: "child-run-1",
      workflowKey: "chat.turn.execute",
      status: "completed",
      leaseOwnerId: undefined,
      leaseHeartbeatAt: undefined,
      leaseExpiresAt: undefined,
      finishedAt: "2026-05-15T12:00:02.000Z",
      metadata: { outputSummary: "Recovered child summary" },
    });
    const harness = createHarness({ run: initialRun, durableRun: initialDurableRun });
    vi.mocked(harness.host.getDurableRun).mockImplementation((runId) =>
      runId === childDurableRun.runId ? childDurableRun : harness.getDurableRun(),
    );
    vi.mocked(harness.host.recordDurableTimelineEvent).mockImplementation((_runId, eventType) => {
      if (eventType === "run_resumed") {
        throw new Error("timeline store unavailable");
      }
    });

    await expect(executeDurableOrchestrationRun(harness.host, harness.runtime, initialDurableRun)).rejects.toThrow(
      "timeline store unavailable",
    );

    expect(harness.getRun()).toEqual(initialRun);
    expect(harness.getDurableRun()).toEqual(initialDurableRun);
    expect(
      harness.host.storage.orchestration.listCheckpoints("run-1").map((item) => item.checkpointKind),
    ).not.toContain("run_resumed");
    expect(harness.runtime.phaseExecutor.execute).not.toHaveBeenCalled();
  });

  it("rolls back an unrecoverable child-resume failure when its durable timeline commit fails", async () => {
    const initialRun: OrchestrationRun = {
      ...buildRun(),
      status: "running",
      executionState: "running",
      currentWaveId: "wave-1",
      currentPhaseId: "phase-1",
      durableRunId: "durable-run-1",
      worktreeStatus: "ready",
    };
    const initialDurableRun = buildDurableRun({
      metadata: {
        dispatchedPhase: {
          phaseId: "phase-1",
          ownerAgentId: "agent-1",
          dispatchInFlight: true,
          childSessionId: "child-session-1",
        },
      },
    });
    const harness = createHarness({ run: initialRun, durableRun: initialDurableRun });
    vi.mocked(harness.host.recordDurableTimelineEvent).mockImplementation((_runId, eventType) => {
      if (eventType === "run_failed") {
        throw new Error("timeline store unavailable");
      }
    });

    await expect(executeDurableOrchestrationRun(harness.host, harness.runtime, initialDurableRun)).rejects.toThrow(
      "timeline store unavailable",
    );

    expect(harness.getRun()).toEqual(initialRun);
    expect(harness.getDurableRun()).toEqual(initialDurableRun);
    expect(
      harness.host.storage.orchestration.listCheckpoints("run-1").map((item) => item.checkpointKind),
    ).not.toContain("run_failed");
    expect(harness.runtime.phaseExecutor.execute).not.toHaveBeenCalled();
    expect(harness.runtime.worktrees.release).not.toHaveBeenCalled();
  });

  it("rolls back phase-failure state when its durable timeline commit fails", async () => {
    const initialRun: OrchestrationRun = {
      ...buildRun(),
      durableRunId: "durable-run-1",
      executionState: "queued",
      worktreeStatus: "ready",
    };
    const initialDurableRun = buildDurableRun();
    const harness = createHarness({ run: initialRun, durableRun: initialDurableRun });
    vi.mocked(harness.runtime.phaseExecutor.execute).mockResolvedValue({
      phaseId: "phase-1",
      ownerAgentId: "agent-1",
      status: "failed",
      startedAt: "2026-05-15T12:00:01.000Z",
      finishedAt: "2026-05-15T12:00:02.000Z",
      outputSummary: "Phase failed",
      error: "model budget exhausted",
      costUsd: 0.4,
    });
    vi.mocked(harness.host.recordDurableTimelineEvent).mockImplementation((_runId, eventType) => {
      if (eventType === "run_failed") {
        throw new Error("timeline store unavailable");
      }
    });

    await expect(executeDurableOrchestrationRun(harness.host, harness.runtime, initialDurableRun)).rejects.toThrow(
      "timeline store unavailable",
    );

    expect(harness.getRun()).toMatchObject({
      status: "running",
      executionState: "running",
      currentWaveId: "wave-1",
      currentPhaseId: "phase-1",
    });
    expect(harness.getDurableRun()).toMatchObject({ status: "running", version: initialDurableRun.version + 1 });
    expect(harness.host.storage.orchestration.listCheckpoints("run-1").map((item) => item.checkpointKind)).toEqual(
      expect.arrayContaining(["run_started"]),
    );
    expect(
      harness.host.storage.orchestration.listCheckpoints("run-1").map((item) => item.checkpointKind),
    ).not.toContain("run_failed");
    expect(harness.runtime.worktrees.release).not.toHaveBeenCalled();
  });

  it("rolls back worktree-allocation failure state when its durable timeline commit fails", async () => {
    const harness = createHarness({
      runtime: {
        worktrees: {
          allocate: vi.fn(async () => {
            throw new Error("worktree unavailable");
          }),
        },
      },
    });
    vi.mocked(harness.host.recordDurableTimelineEvent).mockImplementation((_runId, eventType) => {
      if (eventType === "run_failed") {
        throw new Error("timeline store unavailable");
      }
    });

    await expect(runOrchestrationPlan(harness.host, harness.runtime, "plan-1")).rejects.toThrow(
      "timeline store unavailable",
    );

    expect(harness.getRun()).toMatchObject({
      status: "queued",
      executionState: "worktree_allocating",
      worktreeStatus: "allocating",
    });
    expect(harness.getDurableRun()).toMatchObject({ status: "paused" });
    expect(
      harness.host.storage.orchestration.listCheckpoints("run-1").map((item) => item.checkpointKind),
    ).not.toContain("run_failed");
  });

  it("rolls back terminal-winner reconciliation when its checkpoint commit fails", async () => {
    const initialRun: OrchestrationRun = {
      ...buildRun(),
      status: "running",
      executionState: "running",
      currentWaveId: "wave-1",
      currentPhaseId: "phase-1",
      durableRunId: "durable-run-1",
      worktreeStatus: "ready",
    };
    const initialDurableRun = buildDurableRun({
      status: "completed",
      leaseOwnerId: undefined,
      leaseHeartbeatAt: undefined,
      leaseExpiresAt: undefined,
      finishedAt: "2026-05-15T12:00:03.000Z",
      metadata: { terminal: true },
    });
    const harness = createHarness({ run: initialRun, durableRun: initialDurableRun });
    vi.mocked(harness.host.createCheckpoint).mockImplementationOnce(() => {
      throw new Error("checkpoint store unavailable");
    });

    await expect(cancelOrchestrationRun(harness.host, harness.runtime, "run-1", "operator")).rejects.toThrow(
      "checkpoint store unavailable",
    );

    expect(harness.getRun()).toEqual(initialRun);
    expect(harness.getDurableRun()).toEqual(initialDurableRun);
    expect(
      harness.host.storage.orchestration.listCheckpoints("run-1").map((item) => item.checkpointKind),
    ).not.toContain("run_completed");
    expect(harness.runtime.worktrees.release).not.toHaveBeenCalled();
  });

  it("preserves a linked durable completion that wins the cancellation race", async () => {
    const initialRun: OrchestrationRun = {
      ...buildRun(),
      status: "running",
      executionState: "running",
      durableRunId: "durable-run-1",
      worktreeStatus: "ready",
    };
    const harness = createHarness({ run: initialRun, durableRun: buildDurableRun() });
    vi.mocked(harness.host.cancelDurableRun).mockImplementation(() => {
      harness.setDurableRun(
        buildDurableRun({
          status: "completed",
          leaseOwnerId: undefined,
          leaseHeartbeatAt: undefined,
          leaseExpiresAt: undefined,
          finishedAt: "2026-05-15T12:00:03.000Z",
          metadata: { terminal: true },
        }),
      );
      throw new Error("Durable run durable-run-1 is already terminal (completed)");
    });

    const result = await cancelOrchestrationRun(harness.host, harness.runtime, "run-1", "operator");

    expect(result.run).toMatchObject({ status: "completed", executionState: "completed" });
    expect(harness.getRun()).toMatchObject({ status: "completed", executionState: "completed" });
    expect(harness.host.storage.orchestration.listCheckpoints("run-1").map((item) => item.checkpointKind)).toContain(
      "run_completed",
    );
    expect(harness.runtime.worktrees.release).toHaveBeenCalledWith({
      run: expect.objectContaining({ status: "completed" }),
      reason: "completed",
    });
  });

  it("retries active linked cancellation after checkpoint persistence fails", async () => {
    const initialRun: OrchestrationRun = {
      ...buildRun(),
      status: "running",
      executionState: "running",
      durableRunId: "durable-run-1",
      worktreeStatus: "ready",
    };
    const harness = createHarness({ run: initialRun, durableRun: buildDurableRun() });
    vi.mocked(harness.host.createCheckpoint).mockImplementationOnce(() => {
      throw new Error("orchestration checkpoint unavailable");
    });

    await expect(cancelOrchestrationRun(harness.host, harness.runtime, "run-1", "operator")).rejects.toThrow(
      "orchestration checkpoint unavailable",
    );

    expect(harness.getDurableRun()).toMatchObject({ status: "cancelled" });
    expect(harness.getRun()).toEqual(initialRun);

    const retried = await cancelOrchestrationRun(harness.host, harness.runtime, "run-1", "operator");
    expect(retried.run).toMatchObject({ status: "cancelled", executionState: "cancelled" });
    expect(harness.host.storage.orchestration.listCheckpoints("run-1").map((item) => item.checkpointKind)).toContain(
      "run_cancelled",
    );
  });

  it("records durable workflow timeouts as orchestration failures instead of cancellations", async () => {
    const controller = new AbortController();
    const timeout = Object.assign(new Error("Durable workflow durable-run-1 exceeded its 1000ms timeout."), {
      name: "DurableWorkflowTimeoutError",
    });
    const harness = createHarness({
      run: {
        ...buildRun(),
        durableRunId: "durable-run-1",
        executionState: "queued",
        worktreeStatus: "ready",
        worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-1",
      },
    });
    vi.mocked(harness.runtime.phaseExecutor.execute).mockImplementation(async () => {
      controller.abort(timeout);
      throw timeout;
    });

    const result = await executeDurableOrchestrationRun(harness.host, harness.runtime, buildDurableRun(), {
      signal: controller.signal,
    });

    expect(result.outcome).toBe("failed");
    expect(harness.getRun()).toMatchObject({
      status: "failed",
      executionState: "failed",
      lastError: expect.stringContaining("exceeded its 1000ms timeout"),
    });
    expect(harness.host.cancelDurableRun).not.toHaveBeenCalled();
    expect(harness.runtime.worktrees.release).toHaveBeenCalledWith({
      run: expect.objectContaining({ status: "failed" }),
      reason: "failed",
    });
  });

  it("preserves a caught durable interruption when the signal has a generic abort reason", async () => {
    const controller = new AbortController();
    const interruption = Object.assign(new Error("worker lease lost"), {
      name: "DurableWorkerInterruptionError",
    });
    const harness = createHarness({
      run: {
        ...buildRun(),
        durableRunId: "durable-run-1",
        executionState: "queued",
        worktreeStatus: "ready",
      },
    });
    vi.mocked(harness.runtime.phaseExecutor.execute).mockImplementation(async () => {
      controller.abort(new Error("generic abort"));
      throw interruption;
    });

    await expect(
      executeDurableOrchestrationRun(harness.host, harness.runtime, buildDurableRun(), {
        signal: controller.signal,
      }),
    ).rejects.toBe(interruption);
    expect(harness.host.cancelDurableRun).not.toHaveBeenCalled();
  });

  it("preserves a caught durable timeout when the signal has a generic abort reason", async () => {
    const controller = new AbortController();
    const timeout = Object.assign(new Error("durable timeout"), {
      name: "DurableWorkflowTimeoutError",
    });
    const harness = createHarness({
      run: {
        ...buildRun(),
        durableRunId: "durable-run-1",
        executionState: "queued",
        worktreeStatus: "ready",
      },
    });
    vi.mocked(harness.runtime.phaseExecutor.execute).mockImplementation(async () => {
      controller.abort(new Error("generic abort"));
      throw timeout;
    });

    const result = await executeDurableOrchestrationRun(harness.host, harness.runtime, buildDurableRun(), {
      signal: controller.signal,
    });

    expect(result.outcome).toBe("failed");
    expect(harness.getRun()).toMatchObject({ status: "failed", lastError: "durable timeout" });
    expect(harness.host.cancelDurableRun).not.toHaveBeenCalled();
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

describe("orchestration lifecycle approvals with the real engine", () => {
  // The rest of this file mocks the engine; these cases run the real one so the
  // route, durable resume, and engine agree on what approving a phase means.
  function realEngine(): OrchestrationLifecycleHost["orchestrationEngine"] {
    const engine = new OrchestrationEngine();
    return {
      validate: (plan) => engine.validate(plan),
      createRun: (plan) => engine.createRun(plan),
      startRun: (plan, run) => engine.startRun(plan, run),
      approvePhase: (plan, run, phaseId, options) => engine.approvePhase(plan, run, phaseId, options),
      advancePhase: (plan, run, phaseId, options) => engine.advancePhase(plan, run, phaseId, options),
    };
  }

  function twoPhasePlan(mode: OrchestrationPlan["mode"], secondRequiresApproval: boolean): OrchestrationPlan {
    const base = buildPlan();
    const wave = base.waves[0]!;
    return {
      ...base,
      mode,
      waves: [
        {
          ...wave,
          phases: [
            { ...wave.phases[0]!, requiresApproval: false },
            {
              ...wave.phases[0]!,
              phaseId: "phase-2",
              specPath: "phase-2.md",
              requiresApproval: secondRequiresApproval,
            },
          ],
        },
      ],
    };
  }

  function createRealEngineHarness(plan: OrchestrationPlan) {
    return createHarness({
      plan,
      run: {
        ...buildRun(),
        // The real engine checks runtime limits against the wall clock.
        startedAt: new Date().toISOString(),
        durableRunId: "durable-run-1",
        executionState: "queued",
        worktreeStatus: "ready",
      },
      engine: realEngine(),
      runtime: {
        phaseExecutor: {
          execute: vi.fn(async (input) => ({
            phaseId: input.phase.phaseId,
            ownerAgentId: input.phase.ownerAgentId,
            status: "completed" as const,
            startedAt: "2026-05-15T12:00:01.000Z",
            finishedAt: "2026-05-15T12:00:02.000Z",
            outputSummary: `${input.phase.phaseId} done`,
            costUsd: 0.5,
          })),
        },
      },
    });
  }

  function reclaimDurableRun(harness: ReturnType<typeof createHarness>): DurableRunRecord {
    // What the durable worker does when it claims the resumed run.
    harness.setDurableRun({
      ...harness.getDurableRun(),
      status: "running",
      leaseOwnerId: "worker-a",
      leaseExpiresAt: "2099-12-31T23:59:59.999Z",
    });
    return harness.getDurableRun();
  }

  function executedPhaseIds(harness: ReturnType<typeof createHarness>): string[] {
    return vi.mocked(harness.runtime.phaseExecutor.execute).mock.calls.map(([input]) => input.phase.phaseId);
  }

  it("runs an approved gated phase instead of failing or skipping it", async () => {
    const harness = createRealEngineHarness(twoPhasePlan("auto", true));

    const first = await executeDurableOrchestrationRun(harness.host, harness.runtime, harness.getDurableRun());
    expect(first.outcome).toBe("paused");
    expect(executedPhaseIds(harness)).toEqual(["phase-1"]);
    expect(harness.getRun()).toMatchObject({ status: "paused", currentPhaseId: "phase-2" });

    const approval = await approvePhase(harness.host, "run-1", "phase-2", "operator");
    expect(approval.run).toMatchObject({ status: "paused", executionState: "resume_requested" });
    expect(harness.host.hooksService.enqueueAfterHooks).not.toHaveBeenCalled();

    const resumed = await executeDurableOrchestrationRun(harness.host, harness.runtime, reclaimDurableRun(harness));
    expect(resumed.outcome).toBe("completed");
    expect(executedPhaseIds(harness)).toEqual(["phase-1", "phase-2"]);
    expect(harness.getRun()).toMatchObject({
      status: "completed",
      executionState: "completed",
      totalIterations: 2,
      totalCostUsd: 1,
    });
    expect(harness.getRun().pendingApprovalPhaseId).toBeUndefined();
    expect(harness.getRun().pendingApprovedBy).toBeUndefined();
    expect(harness.host.hooksService.enqueueAfterHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "orchestration.phase.after",
        entityId: "run-1:phase-2",
        payload: expect.objectContaining({ phaseId: "phase-2", approvedBy: "operator" }),
      }),
    );
  });

  it("records after-phase hooks that cannot be enqueued without failing the advanced run", async () => {
    const harness = createRealEngineHarness(twoPhasePlan("auto", true));
    await executeDurableOrchestrationRun(harness.host, harness.runtime, harness.getDurableRun());
    await approvePhase(harness.host, "run-1", "phase-2", "operator");
    vi.mocked(harness.host.hooksService.enqueueAfterHooks).mockRejectedValueOnce(new Error("hook store unavailable"));

    const resumed = await executeDurableOrchestrationRun(harness.host, harness.runtime, reclaimDurableRun(harness));

    expect(resumed.outcome).toBe("completed");
    expect(harness.getRun()).toMatchObject({ status: "completed", executionState: "completed", totalIterations: 2 });
    expect(harness.host.storage.orchestration.appendRunEvent).toHaveBeenCalledWith(
      "run-1",
      "phase.after_hooks_failed",
      expect.objectContaining({
        phaseId: "phase-2",
        trigger: "orchestration.phase.after",
        error: "hook store unavailable",
      }),
    );
  });

  it("runs every hitl phase after its approval, including phases not marked requiresApproval", async () => {
    const harness = createRealEngineHarness(twoPhasePlan("hitl", false));

    const first = await executeDurableOrchestrationRun(harness.host, harness.runtime, harness.getDurableRun());
    expect(first.outcome).toBe("paused");
    expect(executedPhaseIds(harness)).toEqual([]);

    await approvePhase(harness.host, "run-1", "phase-1", "operator");
    const second = await executeDurableOrchestrationRun(harness.host, harness.runtime, reclaimDurableRun(harness));
    expect(second.outcome).toBe("paused");
    expect(executedPhaseIds(harness)).toEqual(["phase-1"]);
    expect(harness.getRun()).toMatchObject({ status: "paused", currentPhaseId: "phase-2" });

    await approvePhase(harness.host, "run-1", "phase-2", "operator");
    const third = await executeDurableOrchestrationRun(harness.host, harness.runtime, reclaimDurableRun(harness));
    expect(third.outcome).toBe("completed");
    expect(executedPhaseIds(harness)).toEqual(["phase-1", "phase-2"]);
  });

  it("applies an approval recorded before approvals became intent-only", async () => {
    const harness = createRealEngineHarness(twoPhasePlan("auto", true));
    await executeDurableOrchestrationRun(harness.host, harness.runtime, harness.getDurableRun());
    // Older approvals stored the run as running while the approval waited for the worker.
    vi.mocked(harness.host.storage.orchestration.updateRun)({
      ...harness.getRun(),
      status: "running",
      executionState: "resume_requested",
      pendingApprovalPhaseId: "phase-2",
      pendingApprovedBy: "operator",
    });

    const resumed = await executeDurableOrchestrationRun(harness.host, harness.runtime, reclaimDurableRun(harness));
    expect(resumed.outcome).toBe("completed");
    expect(executedPhaseIds(harness)).toEqual(["phase-1", "phase-2"]);
  });
});

describe("orchestration lifecycle keeps runs in step with their durable runs", () => {
  /** Makes the harness's compare-and-set honour the expected state, like the real repository. */
  function enforceCompareAndSet(harness: ReturnType<typeof createHarness>): void {
    const orchestration = harness.host.storage.orchestration;
    const update = orchestration.updateRun;
    orchestration.updateRunIfCurrentState = vi.fn(async (next: OrchestrationRun, expected) => {
      const current = harness.getRun();
      if (current.status !== expected.status || current.executionState !== expected.executionState) {
        return undefined;
      }
      return await update(next);
    });
  }

  /** What a concurrent cancel commits to the run row. */
  async function cancelConcurrently(harness: ReturnType<typeof createHarness>): Promise<void> {
    await harness.host.storage.orchestration.updateRun({
      ...harness.getRun(),
      status: "cancelled",
      executionState: "cancelled",
      endedAt: "2026-05-15T12:00:05.000Z",
      lastError: "cancelled by operator",
    });
  }

  it("keeps a run cancelled before its durable run was linked, and cancels that durable run", async () => {
    const harness: ReturnType<typeof createHarness> = createHarness();
    enforceCompareAndSet(harness);
    const pauseDurableRun = harness.host.pauseDurableRun;
    harness.host.pauseDurableRun = vi.fn(async (runId: string, actorId?: string) => {
      const paused = await pauseDurableRun(runId, actorId);
      await cancelConcurrently(harness);
      return paused;
    });

    const result = await runOrchestrationPlan(harness.host, harness.runtime, "plan-1");

    expect(result).toMatchObject({ status: "cancelled", executionState: "cancelled" });
    expect(harness.getRun().durableRunId).toBeUndefined();
    expect(harness.host.cancelDurableRun).toHaveBeenCalledWith("durable-run-1", "orchestration");
    expect(harness.runtime.worktrees.allocate).not.toHaveBeenCalled();
    expect(harness.host.resumeDurableRun).not.toHaveBeenCalled();
  });

  it("gives back a worktree allocated for a run that was cancelled meanwhile", async () => {
    const harness: ReturnType<typeof createHarness> = createHarness({
      runtime: {
        worktrees: {
          allocate: vi.fn(async () => {
            await cancelConcurrently(harness);
            return {
              worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-1",
              worktreeStatus: "ready" as const,
              worktreeBaseRef: "HEAD",
              worktreeLeaseOwnerId: "owner-1",
              worktreeLeaseGeneration: 1,
              worktreeLeaseExpiresAt: "2026-05-15T12:05:00.000Z",
            };
          }),
        },
      },
    });
    enforceCompareAndSet(harness);

    const result = await runOrchestrationPlan(harness.host, harness.runtime, "plan-1");

    expect(result).toMatchObject({ status: "cancelled", executionState: "cancelled" });
    expect(harness.getRun()).toMatchObject({ status: "cancelled", executionState: "cancelled" });
    expect(harness.runtime.worktrees.release).toHaveBeenCalledWith({
      run: expect.objectContaining({
        status: "cancelled",
        worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-1",
        worktreeLeaseOwnerId: "owner-1",
        worktreeLeaseGeneration: 1,
      }),
      reason: "cancelled",
    });
    expect(harness.host.resumeDurableRun).not.toHaveBeenCalled();
    expect(harness.host.requestDurableRunProcessing).not.toHaveBeenCalled();
  });

  it("never resumes the durable run of a run cancelled before it was queued", async () => {
    const harness: ReturnType<typeof createHarness> = createHarness({
      hooksService: {
        runInlineHooks: vi.fn(async () => {
          await cancelConcurrently(harness);
          return { blockedBy: undefined, patch: undefined };
        }),
        enqueueAfterHooks: vi.fn(),
      },
    });
    enforceCompareAndSet(harness);

    const result = await runOrchestrationPlan(harness.host, harness.runtime, "plan-1");

    expect(result).toMatchObject({ status: "cancelled" });
    expect(harness.host.resumeDurableRun).not.toHaveBeenCalled();
    expect(harness.host.requestDurableRunProcessing).not.toHaveBeenCalled();
  });

  it("returns the cancelled run when a cancel lands between queueing and resuming", async () => {
    const harness: ReturnType<typeof createHarness> = createHarness();
    enforceCompareAndSet(harness);
    harness.host.resumeDurableRun = vi.fn(async () => {
      await cancelConcurrently(harness);
      throw new Error("Durable run durable-run-1 is already terminal (cancelled)");
    });

    const result = await runOrchestrationPlan(harness.host, harness.runtime, "plan-1");

    expect(result).toMatchObject({ status: "cancelled" });
    expect(harness.host.requestDurableRunProcessing).not.toHaveBeenCalled();
  });

  it("ends a run its run.before hook blocks, cleans up, and reports a conflict", async () => {
    const harness = createHarness({
      hooksService: {
        runInlineHooks: vi.fn(async () => ({ blockedBy: { reason: "change freeze" } })),
        enqueueAfterHooks: vi.fn(),
      },
    });
    enforceCompareAndSet(harness);

    await expect(runOrchestrationPlan(harness.host, harness.runtime, "plan-1")).rejects.toMatchObject({
      name: "ConflictError",
      message: "Blocked by orchestration.run.before hook: change freeze",
    });

    expect(harness.getRun()).toMatchObject({
      status: "failed",
      executionState: "failed",
      lastError: "Blocked by orchestration.run.before hook: change freeze",
    });
    expect(harness.getDurableRun().status).toBe("cancelled");
    expect(harness.runtime.worktrees.release).toHaveBeenCalledWith({
      run: expect.objectContaining({ status: "failed" }),
      reason: "failed",
    });
    expect(harness.host.storage.orchestration.appendRunEvent).toHaveBeenCalledWith(
      "run-1",
      "run.failed",
      expect.objectContaining({ reason: "run_before_hook_blocked" }),
    );
    expect(harness.host.resumeDurableRun).not.toHaveBeenCalled();
    expect(harness.host.requestDurableRunProcessing).not.toHaveBeenCalled();
  });

  it("fails the orchestration run of a workflow that threw, under the durable lease", async () => {
    const harness = createHarness({
      run: {
        ...buildRun(),
        status: "running",
        executionState: "waiting_for_child",
        currentWaveId: "wave-1",
        currentPhaseId: "phase-1",
        durableRunId: "durable-run-1",
        worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-1",
      },
    });
    enforceCompareAndSet(harness);

    await failOrchestrationRunForWorkflowError(
      harness.host,
      harness.runtime,
      harness.getDurableRun(),
      new Error("plan storage unavailable"),
    );

    expect(harness.getRun()).toMatchObject({
      status: "failed",
      executionState: "failed",
      lastError: "Durable orchestration workflow failed: plan storage unavailable",
    });
    expect(harness.runtime.worktrees.release).toHaveBeenCalledWith({
      run: expect.objectContaining({ status: "failed" }),
      reason: "failed",
    });
    expect(harness.host.storage.orchestration.appendRunEvent).toHaveBeenCalledWith(
      "run-1",
      "run.failed",
      expect.objectContaining({ reason: "workflow_error", durableRunId: "durable-run-1" }),
    );
  });

  it("leaves a workflow-error run to the new lease owner when this worker lost the lease", async () => {
    const harness = createHarness({
      run: { ...buildRun(), status: "running", executionState: "running", durableRunId: "durable-run-1" },
    });
    enforceCompareAndSet(harness);
    const claimedByAnotherWorker = { ...harness.getDurableRun(), leaseOwnerId: "worker-b" };
    harness.setDurableRun(claimedByAnotherWorker);

    await failOrchestrationRunForWorkflowError(
      harness.host,
      harness.runtime,
      buildDurableRun({ leaseOwnerId: "worker-a" }),
      new Error("stale worker"),
    );

    expect(harness.getRun()).toMatchObject({ status: "running", executionState: "running" });
    expect(harness.runtime.worktrees.release).not.toHaveBeenCalled();
  });

  it.each([
    ["failed", {}, { status: "failed", executionState: "failed", lastError: "worker crashed" }],
    ["dead_lettered", {}, { status: "failed", executionState: "failed", lastError: "worker crashed" }],
    ["cancelled", {}, { status: "cancelled", executionState: "cancelled", lastError: "worker crashed" }],
    ["completed", { orchestration: { executionState: "stopped_by_limit" } }, { status: "stopped_by_limit" }],
    ["completed", {}, { status: "completed", executionState: "completed", lastError: undefined }],
  ] as const)("settles an active run whose durable run ended as %s", async (durableStatus, metadata, expected) => {
    const harness = createHarness({
      run: {
        ...buildRun(),
        status: "running",
        executionState: "waiting_for_child",
        durableRunId: "durable-run-1",
        worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-1",
      },
      durableRun: buildDurableRun({
        status: durableStatus,
        lastError: "worker crashed",
        finishedAt: "2026-05-15T12:10:00.000Z",
        leaseOwnerId: undefined,
        metadata,
      }),
    });
    enforceCompareAndSet(harness);
    (
      harness.host.storage.orchestration as { listActiveLinkedRuns?: () => Promise<OrchestrationRun[]> }
    ).listActiveLinkedRuns = vi.fn(async () => [harness.getRun()]);

    await reconcileTerminalOrchestrationRuns(harness.host, harness.runtime);

    expect(harness.getRun()).toMatchObject({ ...expected, endedAt: "2026-05-15T12:10:00.000Z" });
    expect(harness.host.storage.orchestration.appendRunEvent).toHaveBeenCalledWith(
      "run-1",
      expect.stringMatching(/^run\./),
      expect.objectContaining({
        reconciledBy: "orchestration_terminal_reconciler",
        durableTerminalStatus: durableStatus,
        terminalWinner: "durable_run",
      }),
    );
    expect(harness.runtime.worktrees.release).toHaveBeenCalledTimes(1);
  });

  it("leaves active runs whose durable run is still going", async () => {
    const harness = createHarness({
      run: { ...buildRun(), status: "paused", executionState: "paused_for_approval", durableRunId: "durable-run-1" },
      durableRun: buildDurableRun({ status: "paused", leaseOwnerId: undefined }),
    });
    enforceCompareAndSet(harness);
    (
      harness.host.storage.orchestration as { listActiveLinkedRuns?: () => Promise<OrchestrationRun[]> }
    ).listActiveLinkedRuns = vi.fn(async () => [harness.getRun()]);

    await reconcileTerminalOrchestrationRuns(harness.host, harness.runtime);

    expect(harness.getRun()).toMatchObject({ status: "paused", executionState: "paused_for_approval" });
    expect(harness.runtime.worktrees.release).not.toHaveBeenCalled();
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
  getRun(): OrchestrationRun;
  getDurableRun(): DurableRunRecord;
  setDurableRun(next: DurableRunRecord): void;
} {
  const checkpoints: OrchestrationCheckpoint[] = [];
  let plan = options.plan ?? buildPlan();
  let run = options.run ?? buildRun();
  let durableRun = options.durableRun ?? buildDurableRun();
  const storage = {
    runImmediateTransaction: vi.fn(async <T>(callback: () => T | Promise<T>): Promise<Awaited<T>> => {
      const runSnapshot = run;
      const durableRunSnapshot = durableRun;
      const checkpointCount = checkpoints.length;
      try {
        return await callback();
      } catch (error) {
        run = runSnapshot;
        durableRun = durableRunSnapshot;
        checkpoints.splice(checkpointCount);
        throw error;
      }
    }),
    durableRuns: {
      lockFreshActiveLeaseForUpdate: vi.fn((runId: string, expectedLeaseOwnerId: string) => {
        if (
          durableRun.runId !== runId ||
          durableRun.status !== "running" ||
          durableRun.leaseOwnerId !== expectedLeaseOwnerId ||
          !durableRun.leaseExpiresAt ||
          Date.parse(durableRun.leaseExpiresAt) <= Date.now()
        ) {
          return undefined;
        }
        return durableRun;
      }),
    },
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
    // Approval gates entry: the approved phase becomes runnable at the same position.
    approvePhase: vi.fn((currentPlan: OrchestrationPlan, currentRun: OrchestrationRun) => ({
      ...currentRun,
      status: "running",
      pendingApprovalPhaseId: currentRun.currentPhaseId,
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
      if (
        input.expectedLeaseOwnerId &&
        (durableRun.status !== "running" ||
          durableRun.leaseOwnerId !== input.expectedLeaseOwnerId ||
          !durableRun.leaseExpiresAt ||
          Date.parse(durableRun.leaseExpiresAt) <= Date.now())
      ) {
        const error = new Error("durable lease lost");
        error.name = "DurableWorkerInterruptionError";
        throw error;
      }
      durableRun = {
        ...durableRun,
        ...(input.status ? { status: input.status } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
        ...(input.clearLastError ? { lastError: undefined } : {}),
        ...(input.finishedAt !== undefined ? { finishedAt: input.finishedAt } : {}),
        ...(input.clearFinishedAt ? { finishedAt: undefined } : {}),
        ...(input.clearLease
          ? { leaseOwnerId: undefined, leaseHeartbeatAt: undefined, leaseExpiresAt: undefined }
          : {}),
        version: durableRun.version + 1,
      };
      return durableRun;
    }),
    recordDurableTimelineEvent: vi.fn(),
    watchDurableChildRun: vi.fn(),
  };
  const runtime: OrchestrationLifecycleRuntimeDeps = {
    worktrees: {
      allocate: vi.fn(async () => ({
        worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-1",
        worktreeStatus: "ready" as const,
        worktreeBaseRef: "HEAD",
      })),
      release: vi.fn(async () => undefined),
      ensureLeaseForExecution: vi.fn((current) => current),
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
  return {
    host,
    runtime,
    getRun: () => run,
    getDurableRun: () => durableRun,
    setDurableRun: (next) => {
      durableRun = next;
    },
  };
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
    status: "running",
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
    leaseOwnerId: "worker-a",
    leaseHeartbeatAt: "2026-05-15T12:00:00.000Z",
    leaseExpiresAt: "2099-12-31T23:59:59.999Z",
    createdAt: "2026-05-15T12:00:00.000Z",
    updatedAt: "2026-05-15T12:00:00.000Z",
    ...overrides,
  };
}
