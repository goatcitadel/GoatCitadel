import { describe, expect, it } from "vitest";
import type { OrchestrationPlan } from "../orchestration/types.js";
import {
  applyExecutionPlanDraftToOrchestrationPlan,
  coercePlannerExecutionPlanDraft,
} from "./chat-turn-planning-helpers.js";

function createCoworkPlan(): OrchestrationPlan {
  return {
    workflowTemplate: "cowork.plan.work.synthesize",
    summary: "Plan, work, review, synthesize.",
    source: "workflow_template",
    routeDecision: {
      modePolicy: "cowork",
      workflowTemplate: "cowork.plan.work.synthesize",
      hidden: false,
      visibility: "explicit",
      intensity: "balanced",
      providerPreference: "balanced",
      reviewDepth: "standard",
      parallelism: "sequential",
      selectedRoles: ["Plan", "Work", "Review", "Synthesis"],
      selectedProviders: [],
      triggerReason: "cowork_explicit_orchestration",
    },
    steps: [
      {
        stepId: "step-1",
        index: 0,
        role: "planner",
        label: "Plan",
        stage: 1,
        objective: "Define the execution path.",
        successCriteria: "A practical sequence.",
        expectedOutput: "Plan handoff.",
        parallelizable: false,
        dependsOnStepIds: [],
        delegatedRole: "Plan",
      },
      {
        stepId: "step-2",
        index: 1,
        role: "worker",
        label: "Work",
        stage: 2,
        objective: "Produce the main work.",
        successCriteria: "Concrete output.",
        expectedOutput: "Work handoff.",
        parallelizable: false,
        dependsOnStepIds: ["step-1"],
        delegatedRole: "Work",
      },
      {
        stepId: "step-3",
        index: 2,
        role: "reviewer",
        label: "Review",
        stage: 3,
        objective: "Review the work.",
        successCriteria: "Risks called out.",
        expectedOutput: "Review handoff.",
        parallelizable: false,
        dependsOnStepIds: ["step-2"],
        delegatedRole: "Review",
      },
      {
        stepId: "step-4",
        index: 3,
        role: "synthesizer",
        label: "Synthesis",
        stage: 4,
        objective: "Merge all prior handoffs into the final answer.",
        successCriteria: "One final answer.",
        expectedOutput: "Final synthesis.",
        parallelizable: false,
        dependsOnStepIds: ["step-3"],
        delegatedRole: "Synthesis",
      },
    ],
  };
}

describe("chat turn planning helpers", () => {
  it("allows planner drafts to refine production work while preserving synthesis and review control steps", () => {
    const templatePlan = createCoworkPlan();
    const draft = coercePlannerExecutionPlanDraft(
      {
        summary: "Drafted plan.",
        steps: [
          {
            objective: "Refine the execution path around the user goal.",
            successCriteria: "A clearer sequence.",
            expectedOutput: "Planner handoff.",
            parallelizable: false,
            dependsOnStepIds: [],
            delegatedRole: "Worker",
          },
          {
            objective: "Create concrete outreach assets.",
            successCriteria: "Assets ready for review.",
            expectedOutput: "Asset handoff.",
            parallelizable: false,
            dependsOnStepIds: ["step-1"],
            delegatedRole: "Worker",
          },
          {
            objective: "Rewrite the review as more work.",
            successCriteria: "No review needed.",
            expectedOutput: "More work.",
            parallelizable: true,
            dependsOnStepIds: ["step-1"],
            delegatedRole: "Worker",
          },
          {
            objective: "Create concrete outreach assets instead of synthesizing.",
            successCriteria: "Templates only.",
            expectedOutput: "Outreach assets.",
            parallelizable: true,
            dependsOnStepIds: ["step-1"],
            delegatedRole: "Worker",
          },
        ],
      },
      templatePlan,
      {
        advisoryOnly: false,
        mode: "cowork",
        objective: "Get beta users.",
      },
    );

    expect(draft).toBeDefined();
    expect(draft?.source).toBe("planner_with_template_fallback");
    expect(draft?.steps[0]).toMatchObject({
      objective: "Refine the execution path around the user goal.",
      delegatedRole: "Plan",
    });
    expect(draft?.steps[1]).toMatchObject({
      objective: "Create concrete outreach assets.",
      delegatedRole: "Work",
    });
    expect(draft?.steps[2]).toMatchObject({
      objective: "Review the work.",
      expectedOutput: "Review handoff.",
      parallelizable: false,
      dependsOnStepIds: ["step-2"],
      delegatedRole: "Review",
    });
    expect(draft?.steps[3]).toMatchObject({
      objective: "Merge all prior handoffs into the final answer.",
      expectedOutput: "Final synthesis.",
      parallelizable: false,
      dependsOnStepIds: ["step-3"],
      delegatedRole: "Synthesis",
    });
  });

  it("protects terminal control steps again when applying a draft to the orchestration plan", () => {
    const templatePlan = createCoworkPlan();
    const applied = applyExecutionPlanDraftToOrchestrationPlan(templatePlan, {
      source: "planner",
      advisoryOnly: false,
      objective: "Get beta users.",
      summary: "Planner attempted drift.",
      steps: templatePlan.steps.map((step, index) => ({
        stepId: step.stepId,
        index,
        objective: "Planner override",
        successCriteria: "Override",
        expectedOutput: "Override",
        parallelizable: true,
        dependsOnStepIds: [],
        delegatedRole: "Worker",
        status: "pending",
      })),
    });

    expect(applied.steps[0]).toMatchObject({
      objective: "Planner override",
      delegatedRole: "Worker",
    });
    expect(applied.steps[2]).toMatchObject({
      role: "reviewer",
      objective: "Review the work.",
      delegatedRole: "Review",
      dependsOnStepIds: ["step-2"],
    });
    expect(applied.steps[3]).toMatchObject({
      role: "synthesizer",
      objective: "Merge all prior handoffs into the final answer.",
      delegatedRole: "Synthesis",
      dependsOnStepIds: ["step-3"],
    });
  });

  it("drops planner-proposed dependencies that point to the same or a later stage", () => {
    const templatePlan: OrchestrationPlan = {
      ...createCoworkPlan(),
      steps: [
        {
          ...createCoworkPlan().steps[0]!,
          stepId: "step-1",
          role: "worker",
          label: "Market Plan",
          stage: 1,
          dependsOnStepIds: undefined,
        },
        {
          ...createCoworkPlan().steps[1]!,
          stepId: "step-2",
          role: "worker",
          label: "Website Plan",
          stage: 1,
          dependsOnStepIds: undefined,
        },
        {
          ...createCoworkPlan().steps[3]!,
          stepId: "step-3",
          role: "synthesizer",
          label: "Synthesis",
          stage: 2,
          dependsOnStepIds: ["step-1", "step-2"],
        },
      ],
    };

    const draft = coercePlannerExecutionPlanDraft(
      {
        summary: "Business plan draft.",
        steps: [
          {
            objective: "Produce the market plan.",
            dependsOnStepIds: ["step-2"],
          },
          {
            objective: "Produce the website plan.",
            dependsOnStepIds: ["step-1"],
          },
          {
            objective: "Synthesize.",
            dependsOnStepIds: ["step-1", "step-2"],
          },
        ],
      },
      templatePlan,
      {
        advisoryOnly: false,
        mode: "cowork",
        objective: "Build a business plan.",
      },
    );

    expect(draft?.steps[0]?.dependsOnStepIds).toBeUndefined();
    expect(draft?.steps[1]?.dependsOnStepIds).toBeUndefined();
    expect(draft?.steps[2]?.dependsOnStepIds).toEqual(["step-1", "step-2"]);
  });
});
