import { describe, expect, it, vi } from "vitest";
import { WorkflowRecipeService } from "./workflow-recipe-service.js";

describe("WorkflowRecipeService", () => {
  it("parses YAML recipes into existing orchestration plans", () => {
    const service = createService();

    const preview = service.previewRecipe({
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
    expect(preview.plan.mode).toBe("hitl");
    expect(preview.plan.waves[0]?.phases).toHaveLength(2);
    expect(preview.requiredApprovals).toEqual(["synthesize"]);
    expect(preview.estimatedLimits).toMatchObject({ maxIterations: 2, maxRuntimeMinutes: 20, maxCostUsd: 1.5 });
  });

  it("rejects unknown top-level keys and arbitrary Python-style tools", () => {
    const service = createService();

    expect(() =>
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
    ).toThrow(/Unknown recipe top-level key/);

    expect(() =>
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
    ).toThrow(/arbitrary Python/);
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

  it("drafts advisory automation recipes without creating cron jobs or runs", () => {
    const createOrchestrationPlan = vi.fn();
    const service = createService(createOrchestrationPlan);

    const draft = service.draftAutomationRecipe({
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

  it("exports Activepieces webhook templates as read-only planning artifacts", () => {
    const createOrchestrationPlan = vi.fn();
    const service = createService(createOrchestrationPlan);

    const exported = service.exportActivepiecesTemplate(
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
    expect(JSON.parse(exported.content)).toMatchObject({
      version: "workflow_recipe.activepieces_template_export.v1",
      activepiecesTemplate: { name: "GoatCitadel provider spend review" },
      posture: { sideEffectPosture: "not_executed" },
    });
    expect(exported.warnings.join(" ")).toContain("does not create a flow or trigger a webhook");
  });
});

function createService(createOrchestrationPlan = vi.fn()) {
  return new WorkflowRecipeService({
    listSkills: () => [
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
