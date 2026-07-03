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
