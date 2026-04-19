import { describe, expect, it, vi } from "vitest";
import type { OrchestrationCheckpoint } from "@goatcitadel/storage";
import type { OrchestrationPlan, OrchestrationRun } from "@goatcitadel/contracts";
import {
  approvePhase,
  createOrchestrationPlan,
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
    status: "paused",
    startedAt: "2026-04-12T00:00:00.000Z",
    currentWaveId: "wave-1",
    currentPhaseId: "phase-1",
    totalIterations: 0,
    totalCostUsd: 0,
  } as unknown as OrchestrationRun;
}

function createHost(overrides: Partial<OrchestrationLifecycleHost> = {}): OrchestrationLifecycleHost {
  const checkpoints: OrchestrationCheckpoint[] = [];
  const plan = buildPlan();
  const run = buildRun();
  const storage = {
    orchestration: {
      upsertPlan: vi.fn(),
      getPlan: vi.fn(() => plan),
      createRun: vi.fn((value: OrchestrationRun) => value),
      findLatestRunByPlan: vi.fn(() => undefined),
      updateRun: vi.fn((value: OrchestrationRun) => value),
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
      startRun: vi.fn(() => ({ ...run, status: "paused" }) as OrchestrationRun),
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
    ...overrides,
  };
}

describe("orchestration-lifecycle-service", () => {
  it("creates a run and records checkpoint, event, and realtime output", () => {
    const host = createHost();
    const plan = buildPlan();

    const result = createOrchestrationPlan(host, plan);

    expect(result.runId).toBe("run-1");
    expect(host.storage.orchestration.upsertPlan).toHaveBeenCalledWith(plan);
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
        },
      }),
    );
  });

  it("starts plans as fresh runs and schedules orchestration memory context when enabled", async () => {
    const host = createHost();

    const result = await runOrchestrationPlan(host, "plan-1");

    expect(result.status).toBe("paused");
    expect(host.storage.orchestration.findLatestRunByPlan).not.toHaveBeenCalled();
    expect(host.storage.orchestration.createRun).toHaveBeenCalledTimes(1);
    expect(host.orchestrationEngine.startRun).toHaveBeenCalled();
    expect(host.scheduleOrchestrationMemoryContext).toHaveBeenCalledWith(
      expect.objectContaining({ planId: "plan-1" }),
      result,
    );
    expect(host.publishRealtime).toHaveBeenCalledWith(
      "orchestration_event",
      "orchestration",
      expect.objectContaining({
        runId: "run-1",
        event: "run_started",
        phaseId: "phase-1",
        waveId: "wave-1",
      }),
      expect.objectContaining({
        eventClass: "domain_fact",
        eventAuthority: "retained_stream",
        links: {
          runId: "run-1",
        },
      }),
    );
  });

  it("approves phases, records completion checkpoints, and enqueues after hooks", async () => {
    const host = createHost();

    const result = await approvePhase(host, "run-1", "phase-1", "operator", 0.5);

    expect(result.run.status).toBe("completed");
    expect(host.createCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointKind: "phase_approved",
        phaseId: "phase-1",
      }),
    );
    expect(host.createCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointKind: "run_completed",
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

    await expect(approvePhase(host, "run-1", "phase-1", "operator", 0.5)).rejects.toThrow(
      "not waiting for approval",
    );
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
        },
      } as OrchestrationLifecycleHost["storage"],
    });

    await expect(approvePhase(host, "run-1", "phase-1", "operator", 0.5)).rejects.toThrow(
      "not approval-gated",
    );
  });
});
