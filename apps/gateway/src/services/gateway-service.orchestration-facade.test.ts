import { describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

vi.mock("./orchestration-lifecycle-service.js", () => ({
  createOrchestrationPlan: vi.fn(async () => ({ runId: "run-created" })),
  runOrchestrationPlan: vi.fn(async () => ({ runId: "run-started" })),
  approvePhase: vi.fn(async () => ({ runId: "run-approved" })),
  getRun: vi.fn(() => ({ runId: "run-read" })),
  listRunCheckpoints: vi.fn(() => [{ checkpointId: "checkpoint-1" }]),
  executeDurableOrchestrationRun: vi.fn(async () => ({
    outcome: "completed",
    checkpointState: { ok: true },
  })),
}));

import { GatewayService } from "./gateway-service.js";
import * as orchestrationLifecycleService from "./orchestration-lifecycle-service.js";

function createGatewayFacadeHarness() {
  const gateway = Object.create(GatewayService.prototype) as GatewayService & {
    orchestrationWorktreeService: { name: string };
    orchestrationPhaseExecutionService: { name: string };
  };
  gateway.orchestrationWorktreeService = { name: "worktrees" };
  gateway.orchestrationPhaseExecutionService = { name: "phase-executor" };
  return gateway;
}

describe("GatewayService orchestration facade delegation", () => {
  it("passes lifecycle runtime deps through plan creation and execution", async () => {
    const gateway = createGatewayFacadeHarness();
    const plan = { planId: "plan-1" };

    await expect(GatewayService.prototype.createOrchestrationPlan.call(gateway, plan as never)).resolves.toEqual({
      runId: "run-created",
    });
    await expect(GatewayService.prototype.runOrchestrationPlan.call(gateway, "plan-1")).resolves.toEqual({
      runId: "run-started",
    });

    const runtimeDeps = {
      worktrees: gateway.orchestrationWorktreeService,
      phaseExecutor: gateway.orchestrationPhaseExecutionService,
    };
    expect(orchestrationLifecycleService.createOrchestrationPlan).toHaveBeenCalledWith(
      gateway,
      runtimeDeps,
      plan,
      undefined,
    );
    expect(orchestrationLifecycleService.runOrchestrationPlan).toHaveBeenCalledWith(
      gateway,
      runtimeDeps,
      "plan-1",
      undefined,
    );
  });

  it("keeps read and approval facade calls on the legacy host-only path", async () => {
    const gateway = createGatewayFacadeHarness();

    await expect(
      GatewayService.prototype.approvePhase.call(gateway, "run-1", "phase-1", "operator", 0.25, "workspace-1"),
    ).resolves.toEqual({ runId: "run-approved" });
    expect(GatewayService.prototype.getRun.call(gateway, "run-1", "workspace-1")).toEqual({
      runId: "run-read",
    });
    expect(GatewayService.prototype.listRunCheckpoints.call(gateway, "run-1", "workspace-1")).toEqual([
      { checkpointId: "checkpoint-1" },
    ]);

    expect(orchestrationLifecycleService.approvePhase).toHaveBeenCalledWith(
      gateway,
      "run-1",
      "phase-1",
      "operator",
      0.25,
      "workspace-1",
    );
    expect(orchestrationLifecycleService.getRun).toHaveBeenCalledWith(gateway, "run-1", "workspace-1");
    expect(orchestrationLifecycleService.listRunCheckpoints).toHaveBeenCalledWith(gateway, "run-1", "workspace-1");
  });

  it("delegates durable orchestration execution with the extracted runtime services", async () => {
    const gateway = createGatewayFacadeHarness();
    const durableRun = { runId: "durable-1" };
    const context = { signal: new AbortController().signal };

    await expect(
      GatewayService.prototype.executeDurableOrchestrationRun.call(gateway, durableRun as never, context as never),
    ).resolves.toEqual({
      outcome: "completed",
      checkpointState: { ok: true },
    });

    expect(orchestrationLifecycleService.executeDurableOrchestrationRun).toHaveBeenCalledWith(
      gateway,
      {
        worktrees: gateway.orchestrationWorktreeService,
        phaseExecutor: gateway.orchestrationPhaseExecutionService,
      },
      durableRun,
      context,
    );
  });
});
