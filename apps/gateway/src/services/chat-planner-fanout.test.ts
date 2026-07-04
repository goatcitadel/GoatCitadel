import { describe, expect, it } from "vitest";
import type { OrchestrationPlan } from "../orchestration/types.js";
import { deriveStagesFromDependencies, trimExecutionPlanDraftToPlan } from "./chat-planner-fanout.js";
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

describe("planner-declared fan-out (round-3 R3-7)", () => {
  const expansionInput = {
    advisoryOnly: false,
    mode: "cowork" as const,
    objective: "Research pricing and churn.",
    allowProductionExpansion: true,
  };

  function rawTemplateSteps(templatePlan = createCoworkPlan()) {
    return templatePlan.steps.map((step) => ({
      objective: `${step.objective} (refined)`,
      successCriteria: step.successCriteria,
      expectedOutput: step.expectedOutput,
      parallelizable: step.parallelizable,
      dependsOnStepIds: step.dependsOnStepIds,
      delegatedRole: step.delegatedRole,
    }));
  }

  function extraWorker(objective: string, dependsOnStepIds: string[] = ["step-1"], delegatedRole = "Worker") {
    return {
      objective,
      successCriteria: "Complete section.",
      expectedOutput: "Section handoff.",
      parallelizable: true,
      dependsOnStepIds,
      delegatedRole,
    };
  }

  it("drops extra planner steps when expansion is not allowed (legacy behavior)", () => {
    const templatePlan = createCoworkPlan();
    const draft = coercePlannerExecutionPlanDraft(
      { summary: "s", steps: [...rawTemplateSteps(templatePlan), extraWorker("Extra A"), extraWorker("Extra B")] },
      templatePlan,
      { advisoryOnly: false, mode: "cowork", objective: "Research pricing and churn." },
    );
    expect(draft?.steps).toHaveLength(4);
  });

  it("materializes extra parallel workers when expansion is allowed", () => {
    const templatePlan = createCoworkPlan();
    const draft = coercePlannerExecutionPlanDraft(
      {
        summary: "s",
        steps: [...rawTemplateSteps(templatePlan), extraWorker("Research pricing", ["step-1"], "Pricing")],
      },
      templatePlan,
      expansionInput,
    );
    expect(draft?.steps).toHaveLength(5);
    expect(draft?.steps[4]).toMatchObject({
      stepId: "step-5",
      objective: "Research pricing",
      parallelizable: true,
      dependsOnStepIds: ["step-1"],
      delegatedRole: "Pricing",
      status: "pending",
    });
  });

  it("never expands for chat mode or advisory-only drafts", () => {
    const templatePlan = createCoworkPlan();
    const chatDraft = coercePlannerExecutionPlanDraft(
      { summary: "s", steps: [...rawTemplateSteps(templatePlan), extraWorker("Extra")] },
      templatePlan,
      { ...expansionInput, mode: "chat" as const },
    );
    const advisoryDraft = coercePlannerExecutionPlanDraft(
      { summary: "s", steps: [...rawTemplateSteps(templatePlan), extraWorker("Extra")] },
      templatePlan,
      { ...expansionInput, advisoryOnly: true },
    );
    expect(chatDraft?.steps).toHaveLength(4);
    expect(advisoryDraft?.steps).toHaveLength(4);
  });

  it("holds the production cap and sanitizes a hostile draft", () => {
    const templatePlan = createCoworkPlan();
    const hostileExtras = Array.from({ length: 40 }, (_, index) =>
      extraWorker(`Extra ${index + 1}`, ["nope-404", "step-1", "step-99"], index % 2 === 0 ? "Synthesis" : ""),
    );
    const draft = coercePlannerExecutionPlanDraft(
      { summary: "s", steps: [...rawTemplateSteps(templatePlan), ...hostileExtras] },
      templatePlan,
      expansionInput,
    );
    // Template production = planner + worker (2) ⇒ at most 2 extras materialize.
    expect(draft?.steps).toHaveLength(6);
    for (const extra of draft?.steps.slice(4) ?? []) {
      expect(extra.dependsOnStepIds).toEqual(["step-1"]);
    }
  });

  it("levels stages so independent workers share a stage and control steps follow all production", () => {
    const templatePlan = createCoworkPlan();
    const draft = coercePlannerExecutionPlanDraft(
      {
        summary: "s",
        steps: [
          ...rawTemplateSteps(templatePlan),
          extraWorker("Research pricing", ["step-1"], "Pricing"),
          extraWorker("Research churn", ["step-1"], "Churn"),
        ],
      },
      templatePlan,
      expansionInput,
    );
    expect(draft?.steps).toHaveLength(6);
    const applied = applyExecutionPlanDraftToOrchestrationPlan(templatePlan, draft!);

    const byId = new Map(applied.steps.map((step) => [step.stepId, step]));
    expect(applied.steps).toHaveLength(6);
    expect(byId.get("step-1")?.stage).toBe(1);
    expect(byId.get("step-2")?.stage).toBe(2);
    expect(byId.get("step-5")?.stage).toBe(2);
    expect(byId.get("step-6")?.stage).toBe(2);
    expect(byId.get("step-3")?.stage).toBe(3);
    expect(byId.get("step-4")?.stage).toBe(4);
    // Control steps depend on every production step so synthesis can see all
    // fan-out results.
    expect(byId.get("step-3")?.dependsOnStepIds).toEqual(expect.arrayContaining(["step-2", "step-5", "step-6"]));
    expect(byId.get("step-4")?.dependsOnStepIds).toEqual(expect.arrayContaining(["step-3"]));
    // Materialized steps inherit the worker template's execution wiring.
    expect(byId.get("step-5")).toMatchObject({
      role: "worker",
      label: "Pricing",
      delegatedRole: "Pricing",
    });
  });

  it("applies without extras exactly as before when the draft has no expansion", () => {
    const templatePlan = createCoworkPlan();
    const draft = coercePlannerExecutionPlanDraft(
      { summary: "s", steps: rawTemplateSteps(templatePlan) },
      templatePlan,
      expansionInput,
    );
    const applied = applyExecutionPlanDraftToOrchestrationPlan(templatePlan, draft!);
    expect(applied.steps).toHaveLength(4);
    expect(applied.steps.map((step) => step.stage)).toEqual([1, 2, 3, 4]);
  });
});

describe("deriveStagesFromDependencies", () => {
  it("levels a linear chain", () => {
    expect(
      deriveStagesFromDependencies([
        { stepId: "a", dependsOnStepIds: [] },
        { stepId: "b", dependsOnStepIds: ["a"] },
        { stepId: "c", dependsOnStepIds: ["b"] },
      ]),
    ).toEqual([1, 2, 3]);
  });

  it("levels a diamond so independent middles share a stage", () => {
    expect(
      deriveStagesFromDependencies([
        { stepId: "a", dependsOnStepIds: [] },
        { stepId: "b", dependsOnStepIds: ["a"] },
        { stepId: "c", dependsOnStepIds: ["a"] },
        { stepId: "d", dependsOnStepIds: ["b", "c"] },
      ]),
    ).toEqual([1, 2, 2, 3]);
  });

  it("returns undefined on a cycle", () => {
    expect(
      deriveStagesFromDependencies([
        { stepId: "a", dependsOnStepIds: ["b"] },
        { stepId: "b", dependsOnStepIds: ["a"] },
      ]),
    ).toBeUndefined();
  });

  it("returns undefined on an unknown dependency", () => {
    expect(deriveStagesFromDependencies([{ stepId: "a", dependsOnStepIds: ["ghost"] }])).toBeUndefined();
  });
});

describe("planner fan-out scan bound", () => {
  it("stops scanning garbage extras after the bounded window even when valid entries follow", () => {
    const templatePlan = createCoworkPlan();
    const garbage = Array.from({ length: 30 }, () => ({ objective: "   " }));
    const draft = coercePlannerExecutionPlanDraft(
      {
        summary: "s",
        steps: [
          ...templatePlan.steps.map((step) => ({ objective: step.objective })),
          ...garbage,
          {
            objective: "Valid but beyond the scan window",
            parallelizable: true,
            dependsOnStepIds: ["step-1"],
            delegatedRole: "Late",
          },
        ],
      },
      templatePlan,
      { advisoryOnly: false, mode: "cowork", objective: "obj", allowProductionExpansion: true },
    );
    // 30 empty entries exceed the scan bound (MAX_PLANNER_PRODUCTION_STEPS * 4
    // = 16), so the late valid entry is never reached.
    expect(draft?.steps).toHaveLength(4);
  });
});

describe("planner fan-out dependency hygiene", () => {
  it("re-anchors an extra that depends on a control step onto the first production step", () => {
    const templatePlan = createCoworkPlan();
    const draft = coercePlannerExecutionPlanDraft(
      {
        summary: "s",
        steps: [
          ...templatePlan.steps.map((step) => ({ objective: step.objective })),
          {
            objective: "Extra that tries to depend on synthesis",
            parallelizable: true,
            dependsOnStepIds: ["step-4"],
            delegatedRole: "Late Worker",
          },
        ],
      },
      templatePlan,
      { advisoryOnly: false, mode: "cowork", objective: "obj", allowProductionExpansion: true },
    );
    expect(draft?.steps).toHaveLength(5);
    // step-4 is the synthesizer (control); the dep is filtered and re-anchored
    // so control-step widening cannot form a cycle that drops the expansion.
    expect(draft?.steps[4]?.dependsOnStepIds).toEqual(["step-1"]);

    const applied = applyExecutionPlanDraftToOrchestrationPlan(templatePlan, draft!);
    expect(applied.steps).toHaveLength(5);
    const extra = applied.steps.find((step) => step.delegatedRole === "Late Worker");
    expect(extra?.stage).toBe(2);
  });
});

describe("execution-plan draft trim (round-3 review M3)", () => {
  it("returns the same draft reference when every draft step survives into the applied plan", () => {
    const templatePlan = createCoworkPlan();
    const draft = coercePlannerExecutionPlanDraft(
      {
        summary: "s",
        steps: [
          ...templatePlan.steps.map((step) => ({ objective: step.objective })),
          {
            objective: "Research pricing",
            parallelizable: true,
            dependsOnStepIds: ["step-1"],
            delegatedRole: "Pricing",
          },
        ],
      },
      templatePlan,
      { advisoryOnly: false, mode: "cowork", objective: "obj", allowProductionExpansion: true },
    );
    const applied = applyExecutionPlanDraftToOrchestrationPlan(templatePlan, draft!);
    expect(applied.steps).toHaveLength(5);
    expect(trimExecutionPlanDraftToPlan(draft!, applied)).toBe(draft);
  });

  it("drops draft extras the applied plan discarded on stage-leveling fallback", () => {
    const templatePlan = createCoworkPlan();
    // Hand-built draft whose extra references an unknown dependency: stage
    // leveling fails, so applying falls back to the template-shaped steps and
    // the extra must not survive into the persisted draft either.
    const draft = {
      source: "planner" as const,
      advisoryOnly: false,
      objective: "obj",
      summary: "s",
      steps: [
        ...templatePlan.steps.map((step, index) => ({
          stepId: step.stepId,
          index,
          objective: step.objective,
          successCriteria: step.successCriteria,
          parallelizable: step.parallelizable,
          dependsOnStepIds: step.dependsOnStepIds,
          delegatedRole: step.delegatedRole,
          status: "pending" as const,
        })),
        {
          stepId: "step-5",
          index: 4,
          objective: "Extra whose dependency does not exist",
          parallelizable: true,
          dependsOnStepIds: ["ghost"],
          delegatedRole: "Late Worker",
          status: "pending" as const,
        },
      ],
    };
    const applied = applyExecutionPlanDraftToOrchestrationPlan(templatePlan, draft);
    // Leveling failed ⇒ the extra is dropped from the executed plan.
    expect(applied.steps).toHaveLength(4);

    const trimmed = trimExecutionPlanDraftToPlan(draft, applied);
    expect(trimmed.steps).toHaveLength(4);
    expect(trimmed.steps.map((step) => step.stepId)).toEqual(["step-1", "step-2", "step-3", "step-4"]);
    // The input draft is left untouched.
    expect(draft.steps).toHaveLength(5);
  });
});
