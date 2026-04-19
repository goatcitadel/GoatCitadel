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

describe("OrchestrationEngine", () => {
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

    const afterPhase1 = engine.approvePhase(plan, started, "phase-1");
    expect(afterPhase1.status).toBe("paused");
    expect(afterPhase1.currentPhaseId).toBe("phase-2");

    const afterPhase2 = engine.approvePhase(plan, afterPhase1, "phase-2");
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
    const afterApproval = engine.approvePhase(autoPlan, waitingForApproval, "phase-2");
    expect(afterApproval.status).toBe("completed");
  });
});
