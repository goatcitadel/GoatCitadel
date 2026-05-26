import { describe, expect, it } from "vitest";
import type { OrchestrationPlan, OrchestrationRun } from "@goatcitadel/contracts";
import { OrchestrationEngine } from "./engine.js";

const plan: OrchestrationPlan = {
  planId: "plan-1",
  goal: "test",
  mode: "hitl",
  maxIterations: 2,
  maxRuntimeMinutes: 1000,
  maxCostUsd: 100,
  waves: [
    {
      waveId: "wave-1",
      verify: [],
      budgetUsd: 10,
      ownership: [{ agentId: "agent-a", paths: ["apps/**"] }],
      phases: [
        {
          phaseId: "phase-1",
          ownerAgentId: "agent-a",
          specPath: "phases/1.md",
          loopMode: "fresh-context",
          requiresApproval: true,
        },
        {
          phaseId: "phase-2",
          ownerAgentId: "agent-a",
          specPath: "phases/2.md",
          loopMode: "compaction",
          requiresApproval: true,
        },
      ],
    },
  ],
};

const testNow = "2026-02-27T00:01:00.000Z";

describe("OrchestrationEngine", () => {
  it("rejects duplicate phase ids before a run can advance ambiguously", () => {
    const engine = new OrchestrationEngine();
    const invalidPlan: OrchestrationPlan = {
      ...plan,
      waves: [
        {
          ...plan.waves[0]!,
          phases: [
            plan.waves[0]!.phases[0]!,
            {
              ...plan.waves[0]!.phases[1]!,
              phaseId: "phase-1",
            },
          ],
        },
      ],
    };

    expect(() => engine.validate(invalidPlan)).toThrow("Duplicate phaseId phase-1");
  });

  it("rejects duplicate wave ids before wave lookup becomes ambiguous", () => {
    const engine = new OrchestrationEngine();
    const invalidPlan: OrchestrationPlan = {
      ...plan,
      waves: [
        plan.waves[0]!,
        {
          ...plan.waves[0]!,
          phases: [
            {
              ...plan.waves[0]!.phases[0]!,
              phaseId: "phase-3",
            },
          ],
        },
      ],
    };

    expect(() => engine.validate(invalidPlan)).toThrow("Duplicate waveId wave-1");
  });

  it("rejects phases whose owner is not declared in wave ownership", () => {
    const engine = new OrchestrationEngine();
    const invalidPlan: OrchestrationPlan = {
      ...plan,
      waves: [
        {
          ...plan.waves[0]!,
          phases: [
            {
              ...plan.waves[0]!.phases[0]!,
              ownerAgentId: "agent-missing",
            },
          ],
        },
      ],
    };

    expect(() => engine.validate(invalidPlan)).toThrow(
      "Phase owner agent-missing is not declared in wave wave-1 ownership",
    );
  });

  it("rejects duplicate owner declarations in a wave", () => {
    const engine = new OrchestrationEngine();
    const invalidPlan: OrchestrationPlan = {
      ...plan,
      waves: [
        {
          ...plan.waves[0]!,
          ownership: [
            { agentId: "agent-a", paths: ["apps/**"] },
            { agentId: "agent-a", paths: ["packages/**"] },
          ],
        },
      ],
    };

    expect(() => engine.validate(invalidPlan)).toThrow("Duplicate owner agentId agent-a in wave wave-1");
  });

  it("rejects overlapping ownership across different agents", () => {
    const engine = new OrchestrationEngine();
    const invalidPlan: OrchestrationPlan = {
      ...plan,
      waves: [
        {
          ...plan.waves[0]!,
          ownership: [
            { agentId: "agent-a", paths: ["apps/mission-control-next/**"] },
            { agentId: "agent-b", paths: ["apps/mission-control-next/src"] },
          ],
          phases: [
            plan.waves[0]!.phases[0]!,
            {
              ...plan.waves[0]!.phases[1]!,
              ownerAgentId: "agent-b",
            },
          ],
        },
      ],
    };

    expect(() => engine.validate(invalidPlan)).toThrow(
      "Wave wave-1 ownership conflict: agent-a:apps/mission-control-next overlaps agent-b:apps/mission-control-next/src",
    );
  });

  it("rejects verify entries that do not point at a declared phase", () => {
    const engine = new OrchestrationEngine();
    const invalidPlan: OrchestrationPlan = {
      ...plan,
      waves: [
        {
          ...plan.waves[0]!,
          verify: ["phase-missing"],
        },
      ],
    };

    expect(() => engine.validate(invalidPlan)).toThrow(
      "verify entry phase-missing does not reference any declared phaseId",
    );
  });

  it("rejects verify entries that point at the same or a later wave", () => {
    const engine = new OrchestrationEngine();
    const invalidPlan: OrchestrationPlan = {
      ...plan,
      waves: [
        {
          ...plan.waves[0]!,
          verify: ["phase-1"],
        },
      ],
    };

    expect(() => engine.validate(invalidPlan)).toThrow(
      "verify entry phase-1 must reference a phase from a preceding wave",
    );
  });

  it("accepts verify entries for phases in preceding waves", () => {
    const engine = new OrchestrationEngine();
    const validPlan: OrchestrationPlan = {
      ...plan,
      waves: [
        plan.waves[0]!,
        {
          waveId: "wave-2",
          verify: ["phase-1"],
          budgetUsd: 10,
          ownership: [{ agentId: "agent-b", paths: ["packages/**"] }],
          phases: [
            {
              phaseId: "phase-3",
              ownerAgentId: "agent-b",
              specPath: "phases/3.md",
              loopMode: "fresh-context",
              requiresApproval: false,
            },
          ],
        },
      ],
    };

    expect(() => engine.validate(validPlan)).not.toThrow();
  });

  it("rejects unbounded plan limits and strings", () => {
    const engine = new OrchestrationEngine();
    const invalidPlan: OrchestrationPlan = {
      ...plan,
      goal: "x".repeat(2049),
      maxIterations: Number.POSITIVE_INFINITY,
    };

    expect(() => engine.validate(invalidPlan)).toThrow();
  });

  it("starts hitl runs in paused state and advances phases", () => {
    const engine = new OrchestrationEngine();
    const happyPathPlan = { ...plan, maxIterations: 3 };
    const run = engine.createRun(happyPathPlan);
    expect(run).toMatchObject({
      planId: happyPathPlan.planId,
      status: "queued",
      totalCostUsd: 0,
      totalIterations: 0,
    });

    const started = engine.startRun(happyPathPlan, run);
    expect(started.status).toBe("paused");
    expect(started.currentPhaseId).toBe("phase-1");

    const afterPhase1 = engine.approvePhase(happyPathPlan, started, "phase-1", { now: testNow });
    expect(afterPhase1.status).toBe("paused");
    expect(afterPhase1.currentPhaseId).toBe("phase-2");

    const afterPhase2 = engine.approvePhase(happyPathPlan, afterPhase1, "phase-2", { now: testNow });
    expect(afterPhase2.status).toBe("completed");
    expect(afterPhase2.endedAt).toBe(testNow);
  });

  it("starts auto runs in running state for non-approval phases and pauses only on approval-gated phases", () => {
    const engine = new OrchestrationEngine();
    const autoPlan: OrchestrationPlan = {
      ...plan,
      mode: "auto",
      maxIterations: 10,
      waves: [
        {
          ...plan.waves[0]!,
          phases: [
            {
              ...plan.waves[0]!.phases[0]!,
              phaseId: "phase-1",
              requiresApproval: false,
            },
            {
              ...plan.waves[0]!.phases[1]!,
              phaseId: "phase-2",
              requiresApproval: true,
            },
          ],
        },
      ],
    };
    const run: OrchestrationRun = {
      runId: "run-2",
      planId: autoPlan.planId,
      status: "queued",
      startedAt: "2026-02-27T00:00:00.000Z",
      totalCostUsd: 0,
      totalIterations: 0,
    };

    const started = engine.startRun(autoPlan, run);
    expect(started.status).toBe("running");
    expect(() => engine.approvePhase(autoPlan, started, "phase-1")).toThrow("not waiting for approval");

    const waitingForApproval = {
      ...started,
      status: "paused" as const,
      currentPhaseId: "phase-2",
    };
    const afterApproval = engine.approvePhase(autoPlan, waitingForApproval, "phase-2", { now: testNow });
    expect(afterApproval.status).toBe("completed");

    expect(() =>
      engine.approvePhase(autoPlan, { ...waitingForApproval, currentPhaseId: "phase-1" }, "phase-2"),
    ).toThrow("expected phase phase-1");
    expect(() =>
      engine.approvePhase(autoPlan, { ...waitingForApproval, currentPhaseId: undefined }, "phase-2"),
    ).toThrow("expected phase <none> but received approval for phase-2");
    expect(() =>
      engine.approvePhase(autoPlan, { ...waitingForApproval, currentPhaseId: "phase-1" }, "phase-1"),
    ).toThrow("is not approval-gated");
  });

  it("advances non-approval phases and pauses when the next phase needs approval", () => {
    const engine = new OrchestrationEngine();
    const autoPlan: OrchestrationPlan = {
      ...plan,
      mode: "auto",
      waves: [
        {
          ...plan.waves[0]!,
          phases: [
            {
              ...plan.waves[0]!.phases[0]!,
              phaseId: "phase-1",
              requiresApproval: false,
            },
            {
              ...plan.waves[0]!.phases[1]!,
              phaseId: "phase-2",
              requiresApproval: true,
            },
          ],
        },
      ],
    };
    const started: OrchestrationRun = {
      runId: "run-3",
      planId: autoPlan.planId,
      status: "running",
      startedAt: "2026-02-27T00:00:00.000Z",
      currentWaveId: "wave-1",
      currentPhaseId: "phase-1",
      totalCostUsd: 0,
      totalIterations: 0,
    };

    const advanced = engine.advancePhase(autoPlan, started, "phase-1", { now: testNow });
    expect(advanced.status).toBe("paused");
    expect(advanced.currentPhaseId).toBe("phase-2");
    expect(advanced.totalIterations).toBe(1);

    expect(() => engine.advancePhase(autoPlan, { ...started, status: "paused" }, "phase-1")).toThrow(
      "not actively running",
    );
    expect(() => engine.advancePhase(autoPlan, started, "phase-2")).toThrow("expected phase phase-1");
    expect(() => engine.advancePhase(autoPlan, { ...started, currentPhaseId: undefined }, "phase-1")).toThrow(
      "expected phase <none> but received advancement for phase-1",
    );
  });

  it("rejects advancing approval-gated phases without approval", () => {
    const engine = new OrchestrationEngine();
    const run: OrchestrationRun = {
      runId: "run-4",
      planId: plan.planId,
      status: "running",
      startedAt: "2026-02-27T00:00:00.000Z",
      currentWaveId: "wave-1",
      currentPhaseId: "phase-1",
      totalCostUsd: 0,
      totalIterations: 0,
    };

    expect(() => engine.advancePhase(plan, run, "phase-1")).toThrow("requires approval");
  });

  it("revalidates plans before advancing phases", () => {
    const engine = new OrchestrationEngine();
    const invalidPlan: OrchestrationPlan = {
      ...plan,
      waves: [
        {
          ...plan.waves[0]!,
          phases: [],
        },
      ],
    };
    const run: OrchestrationRun = {
      runId: "run-invalid-plan",
      planId: invalidPlan.planId,
      status: "running",
      startedAt: "2026-02-27T00:00:00.000Z",
      currentWaveId: "wave-1",
      currentPhaseId: "phase-1",
      totalCostUsd: 0,
      totalIterations: 0,
    };

    expect(() => engine.advancePhase(invalidPlan, run, "phase-1")).toThrow();
  });

  it("stops by limit after advancement when the next phase would exceed iteration budget", () => {
    const engine = new OrchestrationEngine();
    const limitedPlan: OrchestrationPlan = {
      ...plan,
      mode: "auto",
      maxIterations: 1,
      waves: [
        {
          ...plan.waves[0]!,
          phases: [
            {
              ...plan.waves[0]!.phases[0]!,
              phaseId: "phase-1",
              requiresApproval: false,
            },
            {
              ...plan.waves[0]!.phases[1]!,
              phaseId: "phase-2",
              requiresApproval: false,
            },
          ],
        },
      ],
    };
    const run: OrchestrationRun = {
      runId: "run-5",
      planId: limitedPlan.planId,
      status: "running",
      startedAt: "2026-02-27T00:00:00.000Z",
      currentWaveId: "wave-1",
      currentPhaseId: "phase-1",
      totalCostUsd: 0,
      totalIterations: 0,
    };

    const advanced = engine.advancePhase(limitedPlan, run, "phase-1");
    expect(advanced.status).toBe("stopped_by_limit");
    expect(advanced.currentPhaseId).toBe("phase-2");
    expect(advanced.endedAt).toBeDefined();
  });

  it("stops by limit after advancement when cost or runtime budgets are reached", () => {
    const engine = new OrchestrationEngine();
    const autoPlan: OrchestrationPlan = {
      ...plan,
      mode: "auto",
      maxIterations: 10,
      maxRuntimeMinutes: 1,
      maxCostUsd: 0.25,
      waves: [
        {
          ...plan.waves[0]!,
          phases: [
            {
              ...plan.waves[0]!.phases[0]!,
              phaseId: "phase-1",
              requiresApproval: false,
            },
            {
              ...plan.waves[0]!.phases[1]!,
              phaseId: "phase-2",
              requiresApproval: false,
            },
          ],
        },
      ],
    };
    const run: OrchestrationRun = {
      runId: "run-limit",
      planId: autoPlan.planId,
      status: "running",
      startedAt: "2026-02-27T00:00:00.000Z",
      currentWaveId: "wave-1",
      currentPhaseId: "phase-1",
      totalCostUsd: 0,
      totalIterations: 0,
    };

    expect(engine.advancePhase(autoPlan, run, "phase-1", { costIncrementUsd: 0.25 }).status).toBe("stopped_by_limit");
    expect(engine.advancePhase(autoPlan, run, "phase-1", { now: "2026-02-27T00:02:00.000Z" }).status).toBe(
      "stopped_by_limit",
    );
  });

  it("refuses to start runs that are not queued", () => {
    const engine = new OrchestrationEngine();
    const run: OrchestrationRun = {
      runId: "run-already-running",
      planId: plan.planId,
      status: "running",
      startedAt: "2026-02-27T00:00:00.000Z",
      currentWaveId: "wave-1",
      currentPhaseId: "phase-1",
      totalCostUsd: 0,
      totalIterations: 0,
    };

    expect(() => engine.startRun(plan, run)).toThrow("cannot be started from status running");
  });

  it("stops by limit when the final phase reaches the cost budget", () => {
    const engine = new OrchestrationEngine();
    const finalPhasePlan: OrchestrationPlan = {
      ...plan,
      mode: "auto",
      maxIterations: 10,
      maxCostUsd: 0.25,
      waves: [
        {
          ...plan.waves[0]!,
          phases: [
            {
              ...plan.waves[0]!.phases[0]!,
              phaseId: "phase-1",
              requiresApproval: false,
            },
          ],
        },
      ],
    };
    const run: OrchestrationRun = {
      runId: "run-final-limit",
      planId: finalPhasePlan.planId,
      status: "running",
      startedAt: "2026-02-27T00:00:00.000Z",
      currentWaveId: "wave-1",
      currentPhaseId: "phase-1",
      totalCostUsd: 0,
      totalIterations: 0,
    };

    const advanced = engine.advancePhase(finalPhasePlan, run, "phase-1", { costIncrementUsd: 0.25 });

    expect(advanced.status).toBe("stopped_by_limit");
    expect(advanced.currentPhaseId).toBeUndefined();
    expect(advanced.endedAt).toBeDefined();
  });

  it("advances across waves and exposes direct limit checks", () => {
    const engine = new OrchestrationEngine();
    const multiWavePlan: OrchestrationPlan = {
      ...plan,
      mode: "auto",
      maxIterations: 10,
      waves: [
        {
          ...plan.waves[0]!,
          phases: [
            {
              ...plan.waves[0]!.phases[0]!,
              requiresApproval: false,
            },
          ],
        },
        {
          waveId: "wave-2",
          verify: ["phase-1"],
          budgetUsd: 5,
          ownership: [{ agentId: "agent-b", paths: ["packages/**"] }],
          phases: [
            {
              phaseId: "phase-3",
              ownerAgentId: "agent-b",
              specPath: "phases/3.md",
              loopMode: "fresh-context",
              requiresApproval: false,
            },
          ],
        },
      ],
    };
    const run: OrchestrationRun = {
      runId: "run-wave",
      planId: multiWavePlan.planId,
      status: "running",
      startedAt: "2026-02-27T00:00:00.000Z",
      currentWaveId: "wave-1",
      currentPhaseId: "phase-1",
      totalCostUsd: 1,
      totalIterations: 1,
    };

    const nextWave = engine.advancePhase(multiWavePlan, run, "phase-1", { costIncrementUsd: 2, now: testNow });
    expect(nextWave).toMatchObject({
      status: "running",
      currentWaveId: "wave-2",
      currentPhaseId: "phase-3",
      totalCostUsd: 3,
      totalIterations: 2,
    });
    expect(engine.shouldStopByLimits(multiWavePlan, { iterations: 9, runtimeMinutes: 0, costUsd: 0 })).toBe(false);
    expect(engine.shouldStopByLimits(multiWavePlan, { iterations: 10, runtimeMinutes: 0, costUsd: 0 })).toBe(true);
    expect(engine.shouldStopByLimits(multiWavePlan, { iterations: 0, runtimeMinutes: 1000, costUsd: 0 })).toBe(true);
    expect(engine.shouldStopByLimits(multiWavePlan, { iterations: 0, runtimeMinutes: 0, costUsd: 100 })).toBe(true);
  });

  it("keeps defensive private helpers explicit for malformed internal calls", () => {
    const engine = new OrchestrationEngine();
    const internals = engine as unknown as {
      nextPhase(input: OrchestrationPlan, phaseId: string): { waveId: string; phaseId: string } | undefined;
    };

    expect(() => internals.nextPhase(plan, "missing-phase")).toThrow("Phase missing-phase not found");
    expect(() =>
      engine.advancePhase(
        plan,
        {
          runId: "run-missing",
          planId: plan.planId,
          status: "running",
          startedAt: "2026-02-27T00:00:00.000Z",
          currentWaveId: "wave-missing",
          currentPhaseId: "missing-phase",
          totalCostUsd: 0,
          totalIterations: 0,
        },
        "missing-phase",
      ),
    ).toThrow("Phase missing-phase not found");
  });
});
