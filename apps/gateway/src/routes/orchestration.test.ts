import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { NotFoundError } from "@goatcitadel/contracts";
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
    app.decorate("services", { orchestration: { createPlan: createOrchestrationPlan } } as never);
    app.decorate("requireOperatorAuth", vi.fn(async () => undefined) as never);
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

  it("rejects semantically invalid plans before they reach the orchestration service", async () => {
    const createOrchestrationPlan = vi.fn();
    app = Fastify();
    app.decorate("services", { orchestration: { createPlan: createOrchestrationPlan } } as never);
    app.decorate("requireOperatorAuth", vi.fn(async () => undefined) as never);
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
              {
                phaseId: "phase-1",
                ownerAgentId: "agent-missing",
                specPath: "spec-2.md",
                loopMode: "fresh-context",
                requiresApproval: false,
              },
            ],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        fieldErrors: {
          waves: expect.arrayContaining([
            "Duplicate phaseId phase-1.",
            "Phase owner agent-missing is not declared in wave wave-1 ownership.",
          ]),
        },
      },
    });
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
    app.decorateRequest("authActorId", "operator-auth");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("services", { orchestration: { createPlan: createOrchestrationPlan } } as never);
    app.decorate("requireOperatorAuth", vi.fn(async () => undefined) as never);
    await app.register(orchestrationRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/orchestration/plans",
      payload: {
        planId: "plan-1",
        workspaceId: "workspace-a",
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
    expect(createOrchestrationPlan).toHaveBeenCalledWith(
      expect.objectContaining({ planId: "plan-1" }),
      expect.objectContaining({
        operatorId: "operator-auth",
        authActorId: "operator-auth",
        authActorSource: "loopback",
        workspaceId: "workspace-a",
      }),
    );
    expect(response.json()).toMatchObject({
      runId: "run-1",
      durableRunId: "durable-run-1",
      executionState: "queued",
      worktreeStatus: "ready",
      worktreeBaseRef: "main",
    });
  });

  it("previews recipe-generated orchestration plans without running them", async () => {
    const previewRecipe = vi.fn(() => ({
      recipe: {
        name: "Weekly review",
        goal: "Review the week.",
        process: "sequential",
        agents: [{ id: "analyst", role: "Analyst" }],
        steps: [{ id: "review", title: "Review", agent: "analyst", prompt: "Review it." }],
      },
      plan: {
        planId: "recipe-weekly-review-abc",
        goal: "Review the week.",
        mode: "auto",
        maxIterations: 3,
        maxRuntimeMinutes: 30,
        maxCostUsd: 3,
        waves: [
          {
            waveId: "wave-1",
            verify: [],
            budgetUsd: 3,
            ownership: [{ agentId: "analyst", paths: ["workspace"] }],
            phases: [
              {
                phaseId: "review",
                ownerAgentId: "analyst",
                specPath: "recipe://weekly-review/steps/1-review",
                loopMode: "fresh-context",
                requiresApproval: false,
              },
            ],
          },
        ],
      },
      warnings: ["plan only"],
      requiredApprovals: [],
      missingTools: [],
      missingSkills: [],
      estimatedLimits: { maxIterations: 3, maxRuntimeMinutes: 30, maxCostUsd: 3 },
    }));
    app = Fastify();
    app.decorate("services", { orchestration: { previewRecipe } } as never);
    app.decorate("requireOperatorAuth", vi.fn(async () => undefined) as never);
    await app.register(orchestrationRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/orchestration/recipes/preview",
      payload: {
        recipe: {
          name: "Weekly review",
          goal: "Review the week.",
          process: "sequential",
          agents: [{ id: "analyst", role: "Analyst" }],
          steps: [{ title: "Review", agent: "analyst", prompt: "Review it." }],
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(previewRecipe).toHaveBeenCalledTimes(1);
    expect(response.json()).toMatchObject({ plan: { planId: "recipe-weekly-review-abc" } });
  });

  it("drafts automation recipes as advisory previews without creating plans", async () => {
    const draftAutomationRecipe = vi.fn(() => ({
      recipe: {
        name: "Automation: Review updates",
        goal: "Review updates.",
        process: "sequential",
        agents: [{ id: "automation-designer", role: "Automation Designer" }],
        steps: [{ id: "scope-and-triggers", title: "Scope", agent: "automation-designer", prompt: "Review." }],
        scheduleIntent: "weekly",
      },
      plan: { planId: "recipe-automation-review-updates" },
      warnings: ["preview only"],
      requiredApprovals: ["scope-and-triggers"],
      missingTools: [],
      missingSkills: ["automation-workflows"],
      missingCapabilities: ["automation-workflows"],
      estimatedLimits: { maxIterations: 2, maxRuntimeMinutes: 20, maxCostUsd: 1 },
      roiEstimate: {
        timeSavedMinutesPerRun: 15,
        confidence: 0.72,
        notes: ["advisory"],
      },
      proofChecklist: ["Run once manually."],
    }));
    const createPlanFromRecipe = vi.fn();
    app = Fastify();
    app.decorate("services", { orchestration: { createPlanFromRecipe, draftAutomationRecipe } } as never);
    app.decorate("requireOperatorAuth", vi.fn(async () => undefined) as never);
    await app.register(orchestrationRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/orchestration/recipes/draft-automation",
      payload: {
        taskDescription: "Review updates.",
        trigger: "when sources change",
        frequency: "weekly",
        successCriteria: ["report"],
        constraints: ["no cron creation"],
        workspaceId: "default",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(draftAutomationRecipe).toHaveBeenCalledWith({
      taskDescription: "Review updates.",
      trigger: "when sources change",
      frequency: "weekly",
      successCriteria: ["report"],
      constraints: ["no cron creation"],
      workspaceId: "default",
    });
    expect(createPlanFromRecipe).not.toHaveBeenCalled();
    expect(response.json()).toMatchObject({
      recipe: { scheduleIntent: "weekly" },
      missingCapabilities: ["automation-workflows"],
      proofChecklist: ["Run once manually."],
    });
  });

  it("exports Activepieces recipe templates without creating plans or webhooks", async () => {
    const exportActivepiecesTemplate = vi.fn(() => ({
      version: "workflow_recipe.activepieces_template_export.v1",
      generatedAt: "2026-05-31T12:00:00.000Z",
      filename: "weekly-review-activepieces-template.json",
      contentType: "application/json",
      recipe: {
        name: "Weekly review",
        goal: "Review weekly signals.",
        process: "sequential",
        agents: [{ id: "analyst", role: "Analyst" }],
        steps: [{ id: "review", title: "Review", agent: "analyst", prompt: "Review it." }],
      },
      plan: { planId: "recipe-weekly-review-abc" },
      warnings: ["read-only export"],
      requiredApprovals: [],
      missingTools: [],
      missingSkills: [],
      estimatedLimits: { maxIterations: 3, maxRuntimeMinutes: 30, maxCostUsd: 3 },
      activepiecesTemplate: {
        name: "Weekly review flow",
        description: "Review weekly signals.",
        trigger: { type: "webhook", path: "/goatcitadel/weekly-review", method: "POST" },
        steps: [],
        metadata: {
          source: "goatcitadel.workflow_recipe",
          planId: "recipe-weekly-review-abc",
          approvalMode: "none",
        },
      },
      posture: {
        readOnly: true,
        sideEffectPosture: "not_executed",
        importRequired: true,
        execution: "operator_import_required",
      },
      content: '{"version":"workflow_recipe.activepieces_template_export.v1"}',
    }));
    const createPlanFromRecipe = vi.fn();
    app = Fastify();
    app.decorate("services", { orchestration: { createPlanFromRecipe, exportActivepiecesTemplate } } as never);
    app.decorate("requireOperatorAuth", vi.fn(async () => undefined) as never);
    await app.register(orchestrationRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/orchestration/recipes/activepieces-template/export",
      payload: {
        flowName: "Weekly review flow",
        webhookPath: "/goatcitadel/weekly-review",
        recipe: {
          name: "Weekly review",
          goal: "Review weekly signals.",
          process: "sequential",
          agents: [{ id: "analyst", role: "Analyst" }],
          steps: [{ id: "review", title: "Review", agent: "analyst", prompt: "Review it." }],
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(exportActivepiecesTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        flowName: "Weekly review flow",
        webhookPath: "/goatcitadel/weekly-review",
        recipe: expect.objectContaining({ name: "Weekly review" }),
      }),
    );
    expect(createPlanFromRecipe).not.toHaveBeenCalled();
    expect(response.json()).toMatchObject({
      version: "workflow_recipe.activepieces_template_export.v1",
      posture: { sideEffectPosture: "not_executed", importRequired: true },
    });
  });

  it("exports n8n recipe templates without creating plans or webhooks", async () => {
    const exportN8nTemplate = vi.fn(() => ({
      version: "workflow_recipe.n8n_template_export.v1",
      generatedAt: "2026-05-31T12:00:00.000Z",
      filename: "weekly-review-n8n-template.json",
      contentType: "application/json",
      target: "n8n",
      recipe: {
        name: "Weekly review",
        goal: "Review weekly signals.",
        process: "sequential",
        agents: [{ id: "analyst", role: "Analyst" }],
        steps: [{ id: "review", title: "Review", agent: "analyst", prompt: "Review it." }],
      },
      plan: { planId: "recipe-weekly-review-abc" },
      warnings: ["read-only export"],
      requiredApprovals: [],
      missingTools: [],
      missingSkills: [],
      estimatedLimits: { maxIterations: 3, maxRuntimeMinutes: 30, maxCostUsd: 3 },
      n8nWorkflow: {
        name: "Weekly review workflow",
        active: false,
        nodes: [],
        connections: {},
        settings: {},
        meta: {
          source: "goatcitadel.workflow_recipe",
          planId: "recipe-weekly-review-abc",
          approvalMode: "none",
        },
      },
      validation: {
        status: "ready_for_operator_import_review",
        nativeImportCompatibility: "not_verified",
        checks: [],
        notes: [],
      },
      posture: {
        readOnly: true,
        sideEffectPosture: "not_executed",
        importRequired: true,
        execution: "operator_import_required",
      },
      content: '{"version":"workflow_recipe.n8n_template_export.v1"}',
    }));
    const createPlanFromRecipe = vi.fn();
    app = Fastify();
    app.decorate("services", { orchestration: { createPlanFromRecipe, exportN8nTemplate } } as never);
    app.decorate("requireOperatorAuth", vi.fn(async () => undefined) as never);
    await app.register(orchestrationRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/orchestration/recipes/n8n-template/export",
      payload: {
        workflowName: "Weekly review workflow",
        webhookPath: "goatcitadel/weekly-review",
        recipe: {
          name: "Weekly review",
          goal: "Review weekly signals.",
          process: "sequential",
          agents: [{ id: "analyst", role: "Analyst" }],
          steps: [{ id: "review", title: "Review", agent: "analyst", prompt: "Review it." }],
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(exportN8nTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowName: "Weekly review workflow",
        webhookPath: "goatcitadel/weekly-review",
        recipe: expect.objectContaining({ name: "Weekly review" }),
      }),
    );
    expect(createPlanFromRecipe).not.toHaveBeenCalled();
    expect(response.json()).toMatchObject({
      version: "workflow_recipe.n8n_template_export.v1",
      target: "n8n",
      posture: { sideEffectPosture: "not_executed", importRequired: true },
    });
  });

  it("creates recipe plans through the existing plan creation route service", async () => {
    const createPlanFromRecipe = vi.fn(async () => ({
      recipe: {
        name: "Campaign review",
        goal: "Review campaign.",
        process: "parallel",
        agents: [{ id: "analyst", role: "Analyst" }],
        steps: [{ id: "review", title: "Review", agent: "analyst", prompt: "Review it." }],
      },
      plan: { planId: "recipe-campaign-review-abc" },
      run: { runId: "run-1", planId: "recipe-campaign-review-abc", status: "queued" },
      warnings: [],
      requiredApprovals: [],
      missingTools: [],
      missingSkills: [],
      estimatedLimits: { maxIterations: 3, maxRuntimeMinutes: 30, maxCostUsd: 3 },
    }));
    app = Fastify();
    app.decorateRequest("authActorId", "operator-auth");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("services", { orchestration: { createPlanFromRecipe } } as never);
    app.decorate("requireOperatorAuth", vi.fn(async () => undefined) as never);
    await app.register(orchestrationRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/orchestration/recipes/plans",
      payload: {
        source: JSON.stringify({
          name: "Campaign review",
          goal: "Review campaign.",
          process: "parallel",
          agents: [{ id: "analyst", role: "Analyst" }],
          steps: [{ title: "Review", agent: "analyst", prompt: "Review it." }],
        }),
        workspaceId: "workspace-recipe",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(createPlanFromRecipe).toHaveBeenCalledWith(
      expect.objectContaining({ source: expect.any(String) }),
      expect.objectContaining({
        operatorId: "operator-auth",
        authActorId: "operator-auth",
        authActorSource: "loopback",
        workspaceId: "workspace-recipe",
      }),
    );
    expect(response.json()).toMatchObject({ run: { runId: "run-1" } });
  });

  it("runs plans and exposes checkpoints/context", async () => {
    const runOrchestrationPlan = vi.fn(() => ({ runId: "run-1" }));
    const cancelRun = vi.fn(() => ({
      run: { runId: "run-1", status: "cancelled", executionState: "cancelled" },
      checkpoints: [{ checkpointId: "cp-cancel", checkpointKind: "run_cancelled" }],
    }));
    const getRun = vi.fn(() => ({ runId: "run-1", workspaceId: "default" }));
    const listRunCheckpoints = vi.fn(() => [{ checkpointId: "cp-1" }]);
    const getRunTrace = vi.fn(() => ({ decisions: [{ decisionId: "event-1" }] }));
    const listRunContexts = vi.fn(() => [{ contextId: "ctx-1" }]);
    app = Fastify();
    app.decorateRequest("authActorId", "operator-auth");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("services", {
      orchestration: {
        runPlan: runOrchestrationPlan,
        cancelRun,
        getRun,
        listRunCheckpoints,
        getRunTrace,
        listRunContexts,
      },
    } as never);
    app.decorate("requireOperatorAuth", vi.fn(async () => undefined) as never);
    await app.register(orchestrationRoutes);

    const runResponse = await app.inject({
      method: "POST",
      url: "/api/v1/orchestration/plans/plan-1/run",
      payload: {
        permissionProfileId: "trusted-local-power",
        localOperatorOverrideId: "override-1",
        workspaceId: "workspace-a",
      },
    });
    expect(runResponse.statusCode).toBe(200);
    expect(runOrchestrationPlan).toHaveBeenCalledWith(
      "plan-1",
      expect.objectContaining({
        operatorId: "operator-auth",
        authActorId: "operator-auth",
        authActorSource: "loopback",
        permissionProfileId: "trusted-local-power",
        localOperatorOverrideId: "override-1",
        workspaceId: "workspace-a",
      }),
    );

    const cancelResponse = await app.inject({
      method: "POST",
      url: "/api/v1/orchestration/runs/run-1/cancel",
      payload: {
        actorId: "operator-a",
        workspaceId: "workspace-a",
      },
    });
    expect(cancelResponse.statusCode).toBe(202);
    expect(cancelRun).toHaveBeenCalledWith("run-1", "operator-auth", "workspace-a");
    expect(cancelResponse.json()).toMatchObject({
      run: { status: "cancelled", executionState: "cancelled" },
      checkpoints: [{ checkpointKind: "run_cancelled" }],
    });

    const checkpoints = await app.inject({
      method: "GET",
      url: "/api/v1/orchestration/runs/run-1/checkpoints",
    });
    expect(checkpoints.statusCode).toBe(200);
    expect(listRunCheckpoints).toHaveBeenCalledWith("run-1", undefined);
    expect(checkpoints.json()).toMatchObject({ items: [{ checkpointId: "cp-1" }] });

    const trace = await app.inject({
      method: "GET",
      url: "/api/v1/orchestration/runs/run-1/trace",
    });
    expect(trace.statusCode).toBe(200);
    expect(getRunTrace).toHaveBeenCalledWith("run-1", undefined);
    expect(trace.json()).toMatchObject({ decisions: [{ decisionId: "event-1" }] });

    const context = await app.inject({
      method: "GET",
      url: "/api/v1/orchestration/runs/run-1/context",
    });
    expect(context.statusCode).toBe(200);
    expect(getRun).toHaveBeenCalledWith("run-1", undefined);
    expect(context.json()).toMatchObject({ items: [{ contextId: "ctx-1" }] });
  });

  it("passes requested workspace scope to run-specific orchestration reads", async () => {
    const getRun = vi.fn(() => ({ runId: "run-1", workspaceId: "workspace-a" }));
    const listRunCheckpoints = vi.fn(() => [{ checkpointId: "cp-1" }]);
    const getRunTrace = vi.fn(() => ({ decisions: [{ decisionId: "event-1" }] }));
    app = Fastify();
    app.decorate("services", {
      orchestration: {
        getRun,
        listRunCheckpoints,
        getRunTrace,
      },
    } as never);
    app.decorate("requireOperatorAuth", vi.fn(async () => undefined) as never);
    await app.register(orchestrationRoutes);

    const run = await app.inject({
      method: "GET",
      url: "/api/v1/orchestration/runs/run-1?workspaceId=workspace-a",
    });
    const checkpoints = await app.inject({
      method: "GET",
      url: "/api/v1/orchestration/runs/run-1/checkpoints?workspaceId=workspace-a",
    });
    const trace = await app.inject({
      method: "GET",
      url: "/api/v1/orchestration/runs/run-1/trace?workspaceId=workspace-a",
    });

    expect(run.statusCode).toBe(200);
    expect(checkpoints.statusCode).toBe(200);
    expect(trace.statusCode).toBe(200);
    expect(getRun).toHaveBeenCalledWith("run-1", "workspace-a");
    expect(listRunCheckpoints).toHaveBeenCalledWith("run-1", "workspace-a");
    expect(getRunTrace).toHaveBeenCalledWith("run-1", "workspace-a");
  });

  it("maps missing orchestration runs to a 404 instead of a 500", async () => {
    const getRun = vi.fn(() => {
      throw new NotFoundError({ entity: "Orchestration run", id: "run-missing" });
    });
    app = Fastify();
    app.decorate("services", { orchestration: { getRun } } as never);
    app.decorate("requireOperatorAuth", vi.fn(async () => undefined) as never);
    await app.register(orchestrationRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/orchestration/runs/run-missing",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: "Orchestration run run-missing not found",
      code: "ENTITY_NOT_FOUND",
      details: {
        entity: "Orchestration run",
        id: "run-missing",
      },
    });
  });

  it("records approval resume intent without synchronously advancing the orchestration", async () => {
    const approvePhase = vi.fn(async () => ({
      run: {
        runId: "run-1",
        planId: "plan-1",
        status: "running",
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
    app.decorateRequest("authActorId", "operator-auth");
    app.decorate("services", { orchestration: { approvePhase } } as never);
    app.decorate("requireOperatorAuth", vi.fn(async () => undefined) as never);
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

    expect(response.statusCode).toBe(202);
    expect(approvePhase).toHaveBeenCalledWith("run-1", "phase-2", "operator-auth", 0.5, undefined);
    expect(response.json()).toMatchObject({
      run: {
        status: "running",
        executionState: "resume_requested",
        pendingApprovalPhaseId: "phase-2",
      },
      checkpoints: [{ checkpointKind: "phase_approved" }],
    });
  });
});
