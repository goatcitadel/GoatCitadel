import { OrchestrationEngine } from "@goatcitadel/orchestration";
import { describe, expect, it, vi } from "vitest";
import { WorkflowRecipeService } from "./workflow-recipe-service.js";

describe("WorkflowRecipeService", () => {
  it("parses YAML recipes into existing orchestration plans", async () => {
    const service = createService();

    const preview = await service.previewRecipe({
      source: `
name: Weekly business review
goal: Summarize this week and recommend next actions.
process: sequential
agents:
  - id: coordinator
    role: Coordinator
  - id: analyst
    role: Analyst
steps:
  - id: gather
    title: Gather context
    agent: analyst
    prompt: Review the week.
  - id: synthesize
    title: Synthesize actions
    agent: coordinator
    prompt: Draft priorities.
approval:
  mode: on_sensitive_steps
  requiredBeforeSteps: [synthesize]
limits:
  maxIterations: 2
  maxRuntimeMinutes: 20
  maxCostUsd: 1.5
`,
    });

    expect(preview.recipe.process).toBe("sequential");
    // Only the listed step waits for approval; hitl would gate every step.
    expect(preview.plan.mode).toBe("auto");
    expect(preview.plan.waves.flatMap((wave) => wave.phases)).toEqual([
      expect.objectContaining({ phaseId: "gather", ownerAgentId: "analyst", requiresApproval: false }),
      expect.objectContaining({ phaseId: "synthesize", ownerAgentId: "coordinator", requiresApproval: true }),
    ]);
    // Each step gets its own wave owned by its agent, so two agents never collide on the shared path.
    expect(preview.plan.waves.map((wave) => wave.ownership)).toEqual([
      [{ agentId: "analyst", paths: ["workspace"] }],
      [{ agentId: "coordinator", paths: ["workspace"] }],
    ]);
    expect(() => new OrchestrationEngine().validate(preview.plan)).not.toThrow();
    expect(preview.requiredApprovals).toEqual(["synthesize"]);
    expect(preview.estimatedLimits).toMatchObject({ maxIterations: 2, maxRuntimeMinutes: 20, maxCostUsd: 1.5 });
  });

  it("builds runnable plans for every shipped template and the automation draft", async () => {
    const service = createService();
    const engine = new OrchestrationEngine();

    const templates = service.listTemplates();
    expect(templates.length).toBeGreaterThan(0);
    for (const template of templates) {
      const preview = await service.previewRecipe({ recipe: template.recipe });
      expect(() => engine.validate(preview.plan), template.templateId).not.toThrow();
      expect(preview.warnings.some((warning) => warning.startsWith("Run creation would reject"))).toBe(false);
    }

    const draft = await service.draftAutomationRecipe({
      taskDescription: "Summarize open support tickets every Monday",
    });
    expect(draft.recipe.agents.length).toBeGreaterThan(1);
    expect(() => engine.validate(draft.plan)).not.toThrow();
  });

  it("keeps hierarchical coordinator phases in their own waves around the steps", async () => {
    const service = createService();

    const preview = await service.previewRecipe({
      recipe: {
        name: "Hierarchical review",
        goal: "Coordinate a review.",
        process: "hierarchical",
        agents: [
          { id: "coordinator", role: "Coordinator" },
          { id: "analyst", role: "Analyst" },
        ],
        steps: [{ id: "review", title: "Review", agent: "analyst", prompt: "Review evidence." }],
      },
    });

    expect(preview.plan.waves.map((wave) => wave.phases.map((phase) => phase.phaseId))).toEqual([
      ["coordinator-brief"],
      ["review"],
      ["coordinator-synthesis"],
    ]);
    expect(() => new OrchestrationEngine().validate(preview.plan)).not.toThrow();
  });

  it("reports an unrunnable recipe plan in preview and refuses to create it", async () => {
    const createOrchestrationPlan = vi.fn();
    const service = createService(createOrchestrationPlan);
    const recipe = {
      name: "Duplicate steps",
      goal: "Show an unrunnable plan.",
      process: "sequential" as const,
      agents: [{ id: "analyst", role: "Analyst" }],
      steps: [
        { id: "review", title: "Review", agent: "analyst", prompt: "Review evidence." },
        { id: "review", title: "Summarize", agent: "analyst", prompt: "Summarize evidence." },
      ],
    };

    const preview = await service.previewRecipe({ recipe });
    expect(preview.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Run creation would reject this plan: Duplicate phaseId review."),
      ]),
    );

    await expect(service.createPlanFromRecipe({ recipe })).rejects.toMatchObject({
      httpStatus: 400,
      message: expect.stringContaining("Recipe does not produce a runnable orchestration plan"),
    });
    expect(createOrchestrationPlan).not.toHaveBeenCalled();
  });

  it("rejects unknown top-level keys and arbitrary Python-style tools", async () => {
    const service = createService();

    await expect(
      service.previewRecipe({
        recipe: {
          name: "Bad",
          goal: "Nope",
          process: "sequential",
          runtime: "praison",
          agents: [{ id: "a", role: "Agent" }],
          steps: [{ title: "Do it", agent: "a", prompt: "Run it" }],
        },
      }),
    ).rejects.toThrow(/Unknown recipe top-level key/);

    await expect(
      service.previewRecipe({
        recipe: {
          name: "Bad tool",
          goal: "Nope",
          process: "sequential",
          agents: [{ id: "a", role: "Agent" }],
          tools: ["python:custom"],
          steps: [{ title: "Do it", agent: "a", prompt: "Run it" }],
        },
      }),
    ).rejects.toThrow(/arbitrary Python/);
  });

  it("creates plans through the existing orchestration lifecycle", async () => {
    const createOrchestrationPlan = vi.fn(async (plan) => ({
      runId: "run-1",
      planId: plan.planId,
      status: "queued",
      startedAt: "2026-05-04T00:00:00.000Z",
      totalCostUsd: 0,
      totalIterations: 0,
    }));
    const service = createService(createOrchestrationPlan);

    const response = await service.createPlanFromRecipe({
      recipe: {
        name: "Campaign review",
        goal: "Review campaign output.",
        process: "parallel",
        agents: [{ id: "analyst", role: "Analyst" }],
        steps: [{ id: "review", title: "Review", agent: "analyst", prompt: "Review the campaign." }],
      },
    });

    expect(createOrchestrationPlan).toHaveBeenCalledWith(response.plan);
    expect(response.run.planId).toBe(response.plan.planId);
    expect(response.warnings.join(" ")).toContain("orchestration plan only");
  });

  it("drafts advisory automation recipes without creating cron jobs or runs", async () => {
    const createOrchestrationPlan = vi.fn();
    const service = createService(createOrchestrationPlan);

    const draft = await service.draftAutomationRecipe({
      taskDescription: "Review ClawHub skills for native GoatCitadel overlap",
      trigger: "When a source list changes",
      frequency: "weekly",
      successCriteria: ["Report new ideas", "List proof lanes"],
      constraints: ["No raw skill installs", "No cron creation"],
      workspaceId: "goatcitadel",
    });

    expect(createOrchestrationPlan).not.toHaveBeenCalled();
    expect(draft.recipe).toMatchObject({
      process: "sequential",
      scheduleIntent: "weekly · When a source list changes",
      memory: ["workspace:goatcitadel"],
      approval: { mode: "before_each_step" },
    });
    expect(draft.requiredApprovals).toEqual(["scope-and-triggers", "proof-plan"]);
    expect(draft.roiEstimate.notes.join(" ")).toContain("does not create an automation");
    expect(draft.proofChecklist.join(" ")).toContain("Only then create or enable");
    expect(draft.missingCapabilities).toContain("automation-workflows");
  });

  it("includes governed operator workflow starter templates", () => {
    const service = createService();
    const templates = service.listTemplates().map((item) => item.templateId);

    expect(templates).toEqual(
      expect.arrayContaining([
        "deep-research-brief",
        "scheduled-monitor-review",
        "morning-operator-digest",
        "code-assistant-proof-loop",
      ]),
    );
  });

  it("exports Activepieces webhook templates as read-only planning artifacts", async () => {
    const createOrchestrationPlan = vi.fn();
    const service = createService(createOrchestrationPlan);

    const exported = await service.exportActivepiecesTemplate(
      {
        flowName: "GoatCitadel provider spend review",
        webhookPath: "/goatcitadel/provider-spend-review",
        recipe: {
          name: "Provider spend review",
          goal: "Review provider spend and draft an operator note.",
          process: "sequential",
          agents: [{ id: "analyst", role: "Analyst" }],
          steps: [
            {
              id: "review-spend",
              title: "Review spend",
              agent: "analyst",
              prompt: "Review provider spend evidence.",
              requiresApproval: true,
            },
          ],
          scheduleIntent: "weekday 9am",
        },
      },
      "2026-05-31T12:00:00.000Z",
    );

    expect(createOrchestrationPlan).not.toHaveBeenCalled();
    expect(exported.version).toBe("workflow_recipe.activepieces_template_export.v1");
    expect(exported.posture).toMatchObject({
      readOnly: true,
      sideEffectPosture: "not_executed",
      importRequired: true,
    });
    expect(exported.activepiecesTemplate).toMatchObject({
      name: "GoatCitadel provider spend review",
      trigger: { type: "webhook", path: "/goatcitadel/provider-spend-review", method: "POST" },
      metadata: {
        source: "goatcitadel.workflow_recipe",
        approvalMode: "human_in_the_loop",
        scheduleIntent: "weekday 9am",
      },
    });
    expect(exported.activepiecesTemplate.steps[0]).toMatchObject({
      id: "review-spend",
      requiresApproval: true,
    });
    expect(exported.validation).toMatchObject({
      status: "ready_for_operator_import_review",
      nativeImportCompatibility: "not_verified",
      checks: expect.arrayContaining([
        expect.objectContaining({ id: "webhook-trigger", status: "passed" }),
        expect.objectContaining({ id: "step-graph", status: "passed" }),
        expect.objectContaining({ id: "execution-posture", status: "passed" }),
        expect.objectContaining({ id: "native-activepieces-import", status: "warning" }),
      ]),
    });
    expect(JSON.parse(exported.content)).toMatchObject({
      version: "workflow_recipe.activepieces_template_export.v1",
      activepiecesTemplate: { name: "GoatCitadel provider spend review" },
      validation: {
        status: "ready_for_operator_import_review",
        nativeImportCompatibility: "not_verified",
      },
      posture: { sideEffectPosture: "not_executed" },
    });
    expect(exported.warnings.join(" ")).toContain("does not create a flow or trigger a webhook");
  });

  it("blocks Activepieces template import readiness when the exported step graph is invalid", async () => {
    const service = createService();

    const exported = await service.exportActivepiecesTemplate({
      recipe: {
        name: "Broken dependency review",
        goal: "Show invalid template graph evidence.",
        process: "sequential",
        agents: [{ id: "analyst", role: "Analyst" }],
        steps: [
          {
            id: "review",
            title: "Review",
            agent: "analyst",
            prompt: "Review evidence.",
          },
          {
            id: "review",
            title: "Summarize",
            agent: "analyst",
            prompt: "Summarize evidence.",
            dependsOn: ["missing-step"],
          },
        ],
      },
    });

    expect(exported.validation.status).toBe("blocked");
    expect(exported.validation.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "step-graph",
          status: "blocked",
          detail: expect.stringContaining("Duplicate step IDs: review."),
        }),
      ]),
    );
    expect(exported.validation.checks.find((check) => check.id === "step-graph")?.detail).toContain(
      "Dangling dependencies: review->missing-step.",
    );
    expect(JSON.parse(exported.content)).toMatchObject({
      validation: {
        status: "blocked",
        checks: expect.arrayContaining([expect.objectContaining({ id: "step-graph", status: "blocked" })]),
      },
    });
  });

  it("exports n8n templates as disabled read-only planning artifacts", async () => {
    const createOrchestrationPlan = vi.fn();
    const service = createService(createOrchestrationPlan);

    const exported = await service.exportN8nTemplate(
      {
        workflowName: "GoatCitadel provider spend review",
        webhookPath: "goatcitadel/provider-spend-review",
        recipe: {
          name: "Provider spend review",
          goal: "Review provider spend and draft an operator note.",
          process: "sequential",
          agents: [{ id: "analyst", role: "Analyst" }],
          steps: [
            {
              id: "review-spend",
              title: "Review spend",
              agent: "analyst",
              prompt: "Review provider spend evidence.",
              requiresApproval: true,
            },
          ],
          scheduleIntent: "weekday 9am",
        },
      },
      "2026-05-31T12:00:00.000Z",
    );

    expect(createOrchestrationPlan).not.toHaveBeenCalled();
    expect(exported.version).toBe("workflow_recipe.n8n_template_export.v1");
    expect(exported.target).toBe("n8n");
    expect(exported.n8nWorkflow).toMatchObject({
      name: "GoatCitadel provider spend review",
      active: false,
      meta: {
        source: "goatcitadel.workflow_recipe",
        approvalMode: "human_in_the_loop",
        scheduleIntent: "weekday 9am",
      },
    });
    expect(exported.n8nWorkflow.nodes[0]).toMatchObject({
      type: "n8n-nodes-base.webhook",
      parameters: { httpMethod: "POST", path: "goatcitadel/provider-spend-review" },
    });
    expect(exported.validation).toMatchObject({
      status: "ready_for_operator_import_review",
      nativeImportCompatibility: "not_verified",
      checks: expect.arrayContaining([
        expect.objectContaining({ id: "webhook-trigger", status: "passed" }),
        expect.objectContaining({ id: "step-graph", status: "passed" }),
        expect.objectContaining({ id: "execution-posture", status: "passed" }),
        expect.objectContaining({ id: "native-n8n-import", status: "warning" }),
      ]),
    });
    expect(JSON.parse(exported.content)).toMatchObject({
      version: "workflow_recipe.n8n_template_export.v1",
      target: "n8n",
      posture: { sideEffectPosture: "not_executed" },
    });
    expect(exported.warnings.join(" ")).toContain("does not create a workflow");
  });
});

function createService(createOrchestrationPlan = vi.fn()) {
  return new WorkflowRecipeService({
    listSkills: async () => [
      {
        skillId: "research",
        name: "Research",
        instructionBody: "",
        declaredTools: [],
        requires: [],
        keywords: [],
        mtime: "",
        dir: "",
        source: "managed",
        state: "enabled",
      },
    ],
    listToolNames: () => ["browser.search"],
    createOrchestrationPlan,
  });
}
