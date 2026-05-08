import { describe, expect, it } from "vitest";
import type { OrchestrationPlan, OrchestrationRun } from "@goatcitadel/contracts";
import { OrchestrationEngine } from "./engine.js";

const plan: OrchestrationPlan = {
  planId: "plan-1",
  goal: "test",
  mode: "hitl",
  maxIterations: 2,
  maxRuntimeMinutes: 100000,
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

  it("starts hitl runs in paused state and advances phases", () => {
    const engine = new OrchestrationEngine();
    const run: OrchestrationRun = {
      runId: "run-1",
      planId: plan.planId,
      status: "queued",
      startedAt: "2026-02-27T00:00:00.000Z",
      totalCostUsd: 0,
      totalIterations: 0,
    };

    const started = engine.startRun(plan, run);
    expect(started.status).toBe("paused");
    expect(started.currentPhaseId).toBe("phase-1");

    const afterPhase1 = engine.approvePhase(plan, started, "phase-1", { now: testNow });
    expect(afterPhase1.status).toBe("paused");
    expect(afterPhase1.currentPhaseId).toBe("phase-2");

    const afterPhase2 = engine.approvePhase(plan, afterPhase1, "phase-2", { now: testNow });
    expect(afterPhase2.status).toBe("completed");
  });

  it("starts auto runs in running state for non-approval phases and pauses only on approval-gated phases", () => {
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
});
