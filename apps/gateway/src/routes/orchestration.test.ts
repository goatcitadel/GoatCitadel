import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { orchestrationRoutes } from "./orchestration.js";

describe("orchestration routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("validates orchestration plan creation", async () => {
    const createOrchestrationPlan = vi.fn();
    app = Fastify();
    app.decorate("gateway", { createOrchestrationPlan } as never);
    await app.register(orchestrationRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/orchestration/plans",
      payload: {
        planId: "plan-1",
        goal: "",
        mode: "auto",
        maxIterations: 3,
        maxRuntimeMinutes: 15,
        maxCostUsd: 1,
        waves: [],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(createOrchestrationPlan).not.toHaveBeenCalled();
  });

  it("creates orchestration plans with the enriched run contract", async () => {
    const createOrchestrationPlan = vi.fn(async () => ({
      runId: "run-1",
      planId: "plan-1",
      status: "queued",
      startedAt: "2026-04-19T00:00:00.000Z",
      totalCostUsd: 0,
      totalIterations: 0,
      workspaceId: "default",
      durableRunId: "durable-run-1",
      executionState: "queued",
      worktreePath: "F:/code/personal-ai/.worktrees/orchestration/run-1",
      worktreeStatus: "ready",
      worktreeBaseRef: "main",
    }));
    app = Fastify();
    app.decorate("gateway", { createOrchestrationPlan } as never);
    await app.register(orchestrationRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/orchestration/plans",
      payload: {
        planId: "plan-1",
        goal: "Ship safely",
        mode: "auto",
        maxIterations: 3,
        maxRuntimeMinutes: 15,
        maxCostUsd: 1,
        waves: [
          {
            waveId: "wave-1",
            verify: [],
            budgetUsd: 1,
            ownership: [{ agentId: "agent-1", paths: ["apps/**"] }],
            phases: [
              {
                phaseId: "phase-1",
                ownerAgentId: "agent-1",
                specPath: "spec.md",
                loopMode: "fresh-context",
                requiresApproval: false,
              },
            ],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      runId: "run-1",
      durableRunId: "durable-run-1",
      executionState: "queued",
      worktreeStatus: "ready",
      worktreeBaseRef: "main",
    });
  });

  it("runs plans and exposes checkpoints/context", async () => {
    const runOrchestrationPlan = vi.fn(() => ({ runId: "run-1" }));
    const listRunCheckpoints = vi.fn(() => [{ checkpointId: "cp-1" }]);
    const listRunContexts = vi.fn(() => [{ contextId: "ctx-1" }]);
    app = Fastify();
    app.decorate("gateway", {
      runOrchestrationPlan,
      listRunCheckpoints,
      listRunContexts,
    } as never);
    await app.register(orchestrationRoutes);

    const runResponse = await app.inject({
      method: "POST",
      url: "/api/v1/orchestration/plans/plan-1/run",
    });
    expect(runResponse.statusCode).toBe(200);
    expect(runOrchestrationPlan).toHaveBeenCalledWith("plan-1");

    const checkpoints = await app.inject({
      method: "GET",
      url: "/api/v1/orchestration/runs/run-1/checkpoints",
    });
    expect(checkpoints.statusCode).toBe(200);
    expect(checkpoints.json()).toMatchObject({ items: [{ checkpointId: "cp-1" }] });

    const context = await app.inject({
      method: "GET",
      url: "/api/v1/orchestration/runs/run-1/context",
    });
    expect(context.statusCode).toBe(200);
    expect(context.json()).toMatchObject({ items: [{ contextId: "ctx-1" }] });
  });

  it("records approval resume intent without synchronously advancing the orchestration", async () => {
    const approvePhase = vi.fn(async () => ({
      run: {
        runId: "run-1",
        planId: "plan-1",
        status: "paused",
        startedAt: "2026-04-19T00:00:00.000Z",
        totalCostUsd: 0.5,
        totalIterations: 1,
        durableRunId: "durable-run-1",
        executionState: "resume_requested",
        pendingApprovalPhaseId: "phase-2",
      },
      checkpoints: [{ checkpointId: "cp-1", checkpointKind: "phase_approved" }],
    }));
    app = Fastify();
    app.decorate("gateway", { approvePhase } as never);
    await app.register(orchestrationRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/orchestration/phases/phase-2/approve",
      payload: {
        runId: "run-1",
        approvedBy: "operator",
        costIncrementUsd: 0.5,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(approvePhase).toHaveBeenCalledWith("run-1", "phase-2", "operator", 0.5);
    expect(response.json()).toMatchObject({
      run: {
        executionState: "resume_requested",
        pendingApprovalPhaseId: "phase-2",
      },
      checkpoints: [{ checkpointKind: "phase_approved" }],
    });
  });
});
