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

const multiWaveBudgetPlan: OrchestrationPlan = {
  planId: "plan-budget",
  goal: "wave budget enforcement",
  mode: "auto",
  maxIterations: 100,
  maxRuntimeMinutes: 1000,
  maxCostUsd: 100,
  waves: [
    {
      waveId: "wave-1",
      verify: [],
      budgetUsd: 1,
      ownership: [{ agentId: "agent-a", paths: ["apps/**"] }],
      phases: [
        {
          phaseId: "phase-1a",
          ownerAgentId: "agent-a",
          specPath: "phases/1a.md",
          loopMode: "fresh-context",
          requiresApproval: false,
        },
        {
          phaseId: "phase-1b",
          ownerAgentId: "agent-a",
          specPath: "phases/1b.md",
          loopMode: "fresh-context",
          requiresApproval: false,
        },
      ],
    },
    {
      waveId: "wave-2",
      verify: [],
      budgetUsd: 1,
      ownership: [{ agentId: "agent-b", paths: ["packages/**"] }],
      phases: [
        {
          phaseId: "phase-2a",
          ownerAgentId: "agent-b",
          specPath: "phases/2a.md",
          loopMode: "fresh-context",
          requiresApproval: false,
        },
      ],
    },
  ],
};

// Fixed clock equal to the run start time so runtime-minute limits never trip in these
// cost-focused tests (the plan allows 1000 runtime minutes).
const BUDGET_NOW = "2026-02-27T00:00:00.000Z";

function runningRun(overrides: Partial<OrchestrationRun> = {}): OrchestrationRun {
  return {
    runId: "run-budget",
    planId: multiWaveBudgetPlan.planId,
    status: "running",
    startedAt: BUDGET_NOW,
    currentWaveId: "wave-1",
    currentPhaseId: "phase-1a",
    totalCostUsd: 0,
    totalIterations: 0,
    ...overrides,
  };
}

describe("OrchestrationEngine plan-level cost cap (characterization)", () => {
  it("stops by limit when the plan-level maxCostUsd is reached and tags the plan_limit reason", () => {
    const engine = new OrchestrationEngine();
    const plan: OrchestrationPlan = { ...multiWaveBudgetPlan, maxCostUsd: 0.25 };

    const advanced = engine.advancePhase(plan, runningRun(), "phase-1a", { costIncrementUsd: 0.25, now: BUDGET_NOW });

    expect(advanced.status).toBe("stopped_by_limit");
    expect(advanced.stopReason).toBe("plan_limit");
    expect(advanced.endedAt).toBeDefined();
  });

  it("does not stop on plan-level cost below maxCostUsd", () => {
    const engine = new OrchestrationEngine();
    const plan: OrchestrationPlan = { ...multiWaveBudgetPlan, maxCostUsd: 100 };

    const advanced = engine.advancePhase(plan, runningRun(), "phase-1a", { costIncrementUsd: 0.5, now: BUDGET_NOW });

    expect(advanced.status).toBe("running");
    expect(advanced.stopReason).toBeUndefined();
    expect(advanced.currentPhaseId).toBe("phase-1b");
  });
});

describe("OrchestrationEngine per-wave budget enforcement", () => {
  it("accumulates per-wave cost attributed to the phase's wave across phases", () => {
    const engine = new OrchestrationEngine();
    const plan: OrchestrationPlan = { ...multiWaveBudgetPlan, maxCostUsd: 100 };

    // wave-1 budget is 1; first phase costs 0.4 -> still under budget, stays in wave-1.
    const afterPhase1a = engine.advancePhase(plan, runningRun(), "phase-1a", {
      costIncrementUsd: 0.4,
      now: BUDGET_NOW,
    });
    expect(afterPhase1a.status).toBe("running");
    expect(afterPhase1a.currentWaveId).toBe("wave-1");
    expect(afterPhase1a.currentPhaseId).toBe("phase-1b");
    expect(afterPhase1a.waveCostUsdByWaveId).toEqual({ "wave-1": 0.4 });
    expect(afterPhase1a.totalCostUsd).toBeCloseTo(0.4, 10);
  });

  it("stops the wave with wave_budget_exceeded when accumulated cost reaches budgetUsd while plan cap is not hit", () => {
    const engine = new OrchestrationEngine();
    const plan: OrchestrationPlan = { ...multiWaveBudgetPlan, maxCostUsd: 100 };

    // First phase already cost 0.6 toward wave-1's budget of 1.
    const afterPhase1a = engine.advancePhase(plan, runningRun(), "phase-1a", {
      costIncrementUsd: 0.6,
      now: BUDGET_NOW,
    });
    expect(afterPhase1a.status).toBe("running");
    expect(afterPhase1a.stopReason).toBeUndefined();

    // Second phase pushes wave-1 to 1.1 >= budget 1, but total 1.1 << plan cap 100.
    const afterPhase1b = engine.advancePhase(plan, afterPhase1a, "phase-1b", {
      costIncrementUsd: 0.5,
      now: BUDGET_NOW,
    });
    expect(afterPhase1b.status).toBe("stopped_by_limit");
    expect(afterPhase1b.stopReason).toBe("wave_budget_exceeded");
    expect(afterPhase1b.currentWaveId).toBe("wave-1");
    expect(afterPhase1b.currentPhaseId).toBe("phase-1b");
    expect(afterPhase1b.endedAt).toBeDefined();
    expect(afterPhase1b.waveCostUsdByWaveId).toEqual({ "wave-1": 1.1 });
    // Plan-level cap stays well below maxCostUsd, proving wave enforcement is independent.
    expect(afterPhase1b.totalCostUsd).toBeLessThan(plan.maxCostUsd);
  });

  it("treats a wave with budgetUsd of 0 as unbounded (no per-wave enforcement)", () => {
    const engine = new OrchestrationEngine();
    const plan: OrchestrationPlan = {
      ...multiWaveBudgetPlan,
      maxCostUsd: 100,
      waves: [{ ...multiWaveBudgetPlan.waves[0]!, budgetUsd: 0 }, multiWaveBudgetPlan.waves[1]!],
    };

    const afterPhase1a = engine.advancePhase(plan, runningRun(), "phase-1a", { costIncrementUsd: 5, now: BUDGET_NOW });
    expect(afterPhase1a.status).toBe("running");
    expect(afterPhase1a.stopReason).toBeUndefined();
    expect(afterPhase1a.currentPhaseId).toBe("phase-1b");

    const afterPhase1b = engine.advancePhase(plan, afterPhase1a, "phase-1b", { costIncrementUsd: 5, now: BUDGET_NOW });
    expect(afterPhase1b.status).toBe("running");
    expect(afterPhase1b.stopReason).toBeUndefined();
    expect(afterPhase1b.currentWaveId).toBe("wave-2");
    expect(afterPhase1b.waveCostUsdByWaveId).toEqual({ "wave-1": 10 });
  });

  it("tracks per-wave cost independently across waves and resets enforcement per wave", () => {
    const engine = new OrchestrationEngine();
    const plan: OrchestrationPlan = { ...multiWaveBudgetPlan, maxCostUsd: 100 };

    // wave-1: two phases at 0.4 each -> 0.8 < budget 1, advances into wave-2.
    const afterPhase1a = engine.advancePhase(plan, runningRun(), "phase-1a", {
      costIncrementUsd: 0.4,
      now: BUDGET_NOW,
    });
    const afterPhase1b = engine.advancePhase(plan, afterPhase1a, "phase-1b", {
      costIncrementUsd: 0.4,
      now: BUDGET_NOW,
    });
    expect(afterPhase1b.status).toBe("running");
    expect(afterPhase1b.currentWaveId).toBe("wave-2");
    expect(afterPhase1b.currentPhaseId).toBe("phase-2a");
    expect(afterPhase1b.waveCostUsdByWaveId).toEqual({ "wave-1": 0.8 });

    // wave-2: single phase at 1.5 >= budget 1 -> stops on wave_budget_exceeded; wave-1 untouched.
    const afterPhase2a = engine.advancePhase(plan, afterPhase1b, "phase-2a", {
      costIncrementUsd: 1.5,
      now: BUDGET_NOW,
    });
    expect(afterPhase2a.status).toBe("stopped_by_limit");
    expect(afterPhase2a.stopReason).toBe("wave_budget_exceeded");
    expect(afterPhase2a.waveCostUsdByWaveId).toEqual({ "wave-1": 0.8, "wave-2": 1.5 });
  });

  it("preserves a persisted accumulator on resume and continues enforcing the wave budget", () => {
    const engine = new OrchestrationEngine();
    const plan: OrchestrationPlan = { ...multiWaveBudgetPlan, maxCostUsd: 100 };

    // Simulate a durable resume: the run was rehydrated with prior wave-1 spend of 0.7.
    const resumed = runningRun({
      currentPhaseId: "phase-1b",
      totalCostUsd: 0.7,
      totalIterations: 1,
      waveCostUsdByWaveId: { "wave-1": 0.7 },
    });

    const afterResume = engine.advancePhase(plan, resumed, "phase-1b", { costIncrementUsd: 0.4, now: BUDGET_NOW });
    expect(afterResume.status).toBe("stopped_by_limit");
    expect(afterResume.stopReason).toBe("wave_budget_exceeded");
    expect(afterResume.waveCostUsdByWaveId).toEqual({ "wave-1": 1.1 });
  });

  it("leaves the accumulator and stop reason absent when no cost is applied", () => {
    const engine = new OrchestrationEngine();
    const plan: OrchestrationPlan = { ...multiWaveBudgetPlan, maxCostUsd: 100 };

    const advanced = engine.advancePhase(plan, runningRun(), "phase-1a", { now: BUDGET_NOW });
    expect(advanced.status).toBe("running");
    expect(advanced.stopReason).toBeUndefined();
    expect(advanced.waveCostUsdByWaveId).toEqual({ "wave-1": 0 });
  });
});
