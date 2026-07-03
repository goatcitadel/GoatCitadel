import { describe, expect, it, vi } from "vitest";
import type { ChatSessionPrefsRecord } from "@goatcitadel/contracts";
import { buildOrchestrationPlan } from "../orchestration/router.js";
import type { OrchestrationRouterInput, ProviderCapabilityRecord } from "../orchestration/types.js";
import {
  generatePreparedExecutionPlanDraft,
  type ChatTurnPrepHost,
  type PreparedAgentChatTurn,
} from "./chat-turn-prep-service.js";

function capability(input: Partial<ProviderCapabilityRecord> & { providerId: string; model: string }) {
  return {
    speedScore: 0.5,
    costScore: 0.5,
    qualityScore: 0.5,
    reliabilityScore: 0.5,
    reasoningScore: 0.5,
    codingScore: 0.5,
    reviewScore: 0.5,
    synthesisScore: 0.5,
    researchScore: 0.5,
    jsonScore: 0.5,
    toolScore: 0.5,
    longContextScore: 0.5,
    ...input,
  } as ProviderCapabilityRecord;
}

const FAST = capability({ providerId: "openai", model: "gpt-5-mini", speedScore: 0.95, costScore: 0.9 });
const HEAVY = capability({ providerId: "anthropic", model: "claude-opus-4-8", qualityScore: 0.95 });

function buildFixture(input: {
  content: string;
  plannerFastPathDisabled?: boolean;
  prefs?: Partial<ChatSessionPrefsRecord>;
}) {
  const prefs = {
    mode: "cowork",
    speedMode: "standard",
    planningMode: "standard",
    orchestrationEnabled: true,
    orchestrationIntensity: "deep",
    orchestrationVisibility: "full",
    orchestrationParallelism: "auto",
    orchestrationProviderPreference: "quality",
    orchestrationReviewDepth: "standard",
    ...input.prefs,
  } as ChatSessionPrefsRecord;
  const routerInput: OrchestrationRouterInput = {
    task: { mode: "cowork", objective: input.content, prefs },
    capabilities: [HEAVY, FAST],
    policy: { maxSteps: 8, allowParallelWorkers: true, maxVisibleVisibility: "full" },
  } as OrchestrationRouterInput;
  const templatePlan = buildOrchestrationPlan(routerInput);
  const createChatCompletion = vi.fn().mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({ summary: "planned", steps: [] }) } }],
  });
  const host = {
    createChatCompletion,
    isFeatureEnabled: vi.fn((flag: string) =>
      flag === "plannerFastPathV1Disabled" ? Boolean(input.plannerFastPathDisabled) : false,
    ),
  } as unknown as ChatTurnPrepHost;
  const prepared = {
    content: input.content,
    prefs,
    normalized: { speedMode: "standard" },
  } as unknown as PreparedAgentChatTurn;
  return { host, prepared, routerInput, templatePlan, createChatCompletion };
}

const TRIVIAL_ASK = "tighten the intro paragraph";
const MULTI_STEP_ASK =
  "Research competitor pricing and then draft a comparison table with recommendations for our pricing page";

describe("generatePreparedExecutionPlanDraft planner fast path", () => {
  it("skips the planner LLM for a trivial ask and returns the template draft", async () => {
    const { host, prepared, routerInput, templatePlan, createChatCompletion } = buildFixture({ content: TRIVIAL_ASK });
    const draft = await generatePreparedExecutionPlanDraft(host, prepared, routerInput, templatePlan, false);
    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(draft.source).toBe("workflow_template");
  });

  it("still invokes the planner for a multi-step ask", async () => {
    const { host, prepared, routerInput, templatePlan, createChatCompletion } = buildFixture({
      content: MULTI_STEP_ASK,
    });
    await generatePreparedExecutionPlanDraft(host, prepared, routerInput, templatePlan, false);
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("drafts on the speed-selected model instead of the session default", async () => {
    const { host, prepared, routerInput, templatePlan, createChatCompletion } = buildFixture({
      content: MULTI_STEP_ASK,
    });
    await generatePreparedExecutionPlanDraft(host, prepared, routerInput, templatePlan, false);
    const request = createChatCompletion.mock.calls[0]![0] as { providerId?: string; model?: string };
    expect(request.providerId).toBe("openai");
    expect(request.model).toBe("gpt-5-mini");
  });

  it("keeps legacy behavior when the kill switch is on", async () => {
    const { host, prepared, routerInput, templatePlan, createChatCompletion } = buildFixture({
      content: TRIVIAL_ASK,
      plannerFastPathDisabled: true,
    });
    await generatePreparedExecutionPlanDraft(host, prepared, routerInput, templatePlan, false);
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    const request = createChatCompletion.mock.calls[0]![0] as { providerId?: string; model?: string };
    expect(request.providerId).toBeUndefined();
    expect(request.model).toBeUndefined();
  });

  it("honors an explicit provider pin when drafting", async () => {
    const { host, prepared, routerInput, templatePlan, createChatCompletion } = buildFixture({
      content: MULTI_STEP_ASK,
      prefs: { providerId: "anthropic", model: "claude-opus-4-8" },
    });
    await generatePreparedExecutionPlanDraft(host, prepared, routerInput, templatePlan, false);
    const request = createChatCompletion.mock.calls[0]![0] as { providerId?: string; model?: string };
    expect(request.providerId).toBe("anthropic");
    expect(request.model).toBe("claude-opus-4-8");
  });
});

describe("generatePreparedExecutionPlanDraft planner fan-out", () => {
  const FANOUT_ASK = "Prepare the quarterly business update and then finalize it for the board";

  function plannerPayloadWithExtras(templatePlan: ReturnType<typeof buildOrchestrationPlan>) {
    return {
      summary: "Fan out the independent sections.",
      steps: [
        ...templatePlan.steps.map((step) => ({
          objective: `${step.objective} (refined)`,
          successCriteria: step.successCriteria,
          expectedOutput: step.expectedOutput,
          parallelizable: step.parallelizable,
          dependsOnStepIds: step.dependsOnStepIds,
          delegatedRole: step.delegatedRole ?? null,
        })),
        {
          objective: "Draft the pricing section",
          successCriteria: "Complete pricing section.",
          expectedOutput: "Pricing handoff.",
          parallelizable: true,
          dependsOnStepIds: [templatePlan.steps[0]!.stepId],
          delegatedRole: "Pricing",
        },
        {
          objective: "Draft the churn section",
          successCriteria: "Complete churn section.",
          expectedOutput: "Churn handoff.",
          parallelizable: true,
          dependsOnStepIds: [templatePlan.steps[0]!.stepId],
          delegatedRole: "Churn",
        },
      ],
    };
  }

  it("expands planner extras into same-stage workers on the default cowork template", async () => {
    const fixture = buildFixture({ content: FANOUT_ASK });
    fixture.createChatCompletion.mockImplementation(async () => ({
      choices: [{ message: { content: JSON.stringify(plannerPayloadWithExtras(fixture.templatePlan)) } }],
    }));

    const draft = await generatePreparedExecutionPlanDraft(
      fixture.host,
      fixture.prepared,
      fixture.routerInput,
      fixture.templatePlan,
      false,
    );
    expect(draft.steps).toHaveLength(6);

    const { applyExecutionPlanDraftToOrchestrationPlan } = await import("./chat-turn-planning-helpers.js");
    const applied = applyExecutionPlanDraftToOrchestrationPlan(fixture.templatePlan, draft);
    const byLabel = new Map(applied.steps.map((step) => [step.delegatedRole ?? step.label, step]));

    const worker = applied.steps[1]!;
    const pricing = byLabel.get("Pricing")!;
    const churn = byLabel.get("Churn")!;
    expect(pricing.stage).toBe(worker.stage);
    expect(churn.stage).toBe(worker.stage);
    const synthesizer = applied.steps.find((step) => step.role === "synthesizer")!;
    expect(synthesizer.stage).toBeGreaterThan(pricing.stage);
    expect(synthesizer.dependsOnStepIds).toEqual(expect.arrayContaining([pricing.stepId, churn.stepId]));

    const plannerRequest = fixture.createChatCompletion.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(plannerRequest.messages[0]!.content).toContain("EXTRA worker steps");
  });

  it("drops extras when the fan-out kill switch is on", async () => {
    const fixture = buildFixture({ content: FANOUT_ASK });
    (fixture.host.isFeatureEnabled as ReturnType<typeof vi.fn>).mockImplementation(
      (flag: string) => flag === "plannerFanoutV1Disabled",
    );
    fixture.createChatCompletion.mockImplementation(async () => ({
      choices: [{ message: { content: JSON.stringify(plannerPayloadWithExtras(fixture.templatePlan)) } }],
    }));

    const draft = await generatePreparedExecutionPlanDraft(
      fixture.host,
      fixture.prepared,
      fixture.routerInput,
      fixture.templatePlan,
      false,
    );
    expect(draft.steps).toHaveLength(fixture.templatePlan.steps.length);
    const plannerRequest = fixture.createChatCompletion.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(plannerRequest.messages[0]!.content).not.toContain("EXTRA worker steps");
  });
});
