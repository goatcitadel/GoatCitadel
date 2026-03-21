import { describe, expect, it, vi } from "vitest";
import type {
  ChatCitationRecord,
  ChatCompletionResponse,
  ChatSessionPrefsRecord,
} from "@goatcitadel/contracts";
import { executeOrchestrationPlan } from "./engine.js";
import type { OrchestrationPlan, OrchestrationTaskInput } from "./types.js";

const NOW = "2026-03-08T20:15:00.000Z";

function createPrefs(overrides: Partial<ChatSessionPrefsRecord> = {}): ChatSessionPrefsRecord {
  return {
    sessionId: "session-1",
    mode: "cowork",
    planningMode: "off",
    providerId: undefined,
    model: undefined,
    webMode: "auto",
    memoryMode: "auto",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    visionFallbackModel: undefined,
    orchestrationEnabled: true,
    orchestrationIntensity: "balanced",
    orchestrationVisibility: "explicit",
    orchestrationProviderPreference: "balanced",
    orchestrationReviewDepth: "standard",
    orchestrationParallelism: "parallel",
    codeAutoApply: "aggressive_auto",
    proactiveMode: "off",
    autonomyBudget: undefined,
    retrievalMode: "standard",
    reflectionMode: "off",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function createTask(): OrchestrationTaskInput {
  return {
    sessionId: "session-1",
    workspaceId: "workspace-1",
    mode: "cowork",
    objective: "Research options, synthesize a recommendation, and critique the weaknesses.",
    prefs: createPrefs(),
    conversation: [
      {
        messageId: "msg-user-1",
        sessionId: "session-1",
        role: "user",
        actorType: "user",
        actorId: "operator",
        content: "We need a recommendation with tradeoffs.",
        timestamp: NOW,
      },
    ],
    historyMessages: [],
  };
}

function createPlan(): OrchestrationPlan {
  return {
    workflowTemplate: "cowork.research.synthesize.critic",
    summary: "Parallel research, synthesis, and critique workflow.",
    source: "workflow_template",
    routeDecision: {
      modePolicy: "cowork",
      workflowTemplate: "cowork.research.synthesize.critic",
      hidden: false,
      visibility: "explicit",
      intensity: "balanced",
      providerPreference: "balanced",
      reviewDepth: "standard",
      parallelism: "parallel",
      selectedRoles: ["researcher", "researcher", "critic", "synthesizer"],
      selectedProviders: [
        { role: "researcher", providerId: "perplexity", model: "sonar" },
        { role: "researcher", providerId: "openai", model: "gpt-4.1-mini" },
        { role: "critic", providerId: "openai", model: "gpt-4.1-mini" },
        { role: "synthesizer", providerId: "anthropic", model: "claude-sonnet-4-6" },
      ],
      triggerReason: "cowork_explicit_orchestration",
    },
    steps: [
      {
        stepId: "step-1",
        index: 0,
        role: "researcher",
        stage: 1,
        objective: "Gather the strongest current evidence.",
        parallelizable: true,
        providerId: "perplexity",
        model: "sonar",
      },
      {
        stepId: "step-2",
        index: 1,
        role: "researcher",
        stage: 1,
        objective: "Gather a second independent evidence pass.",
        parallelizable: true,
        providerId: "openai",
        model: "gpt-4.1-mini",
      },
      {
        stepId: "step-3",
        index: 2,
        role: "critic",
        stage: 2,
        objective: "Identify the main weaknesses and caveats.",
        parallelizable: false,
        providerId: "openai",
        model: "gpt-4.1-mini",
      },
      {
        stepId: "step-4",
        index: 3,
        role: "synthesizer",
        stage: 3,
        objective: "Merge the evidence into one recommendation.",
        parallelizable: false,
        providerId: "anthropic",
        model: "claude-sonnet-4-6",
      },
    ],
  };
}

function createCompletion(text: string, citations: ChatCitationRecord[] = []): ChatCompletionResponse {
  return {
    model: "mock-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
        },
      },
    ],
    citations,
  } as ChatCompletionResponse;
}

describe("orchestration engine", () => {
  it("executes staged orchestration, reports step progress, and returns the final completed output", async () => {
    const onStepResult = vi.fn();
    const createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce(createCompletion(
        "Research angle one",
        [{ citationId: "c1", url: "https://example.com/1", title: "Source 1" }],
      ))
      .mockResolvedValueOnce(createCompletion(
        "Research angle two",
        [{ citationId: "c1b", url: "https://example.com/1", title: "Source 1" }],
      ))
      .mockResolvedValueOnce(createCompletion("Critical caveats"))
      .mockResolvedValueOnce(createCompletion("Synthesized recommendation"));

    const result = await executeOrchestrationPlan({
      task: createTask(),
      plan: createPlan(),
      callbacks: {
        createChatCompletion,
        onStepResult,
      },
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(4);
    expect(onStepResult).toHaveBeenCalledTimes(4);
    expect(result.finalOutput).toBe("Synthesized recommendation");
    expect(result.finalSummary).toContain("Synthesized recommendation");
    expect(result.finalStep?.role).toBe("synthesizer");
    expect(result.stepResults).toHaveLength(4);
    expect(result.stepResults.every((step) => step.status === "completed")).toBe(true);
    expect(result.citations).toEqual([
      { citationId: "c1", url: "https://example.com/1", title: "Source 1" },
    ]);
  });

  it("prefers the synthesizer as final output even if a later non-terminal role completed", async () => {
    const result = await executeOrchestrationPlan({
      task: createTask(),
      plan: {
        ...createPlan(),
        steps: [
          {
            stepId: "step-1",
            index: 0,
            role: "answerer",
            stage: 1,
            objective: "Produce the draft answer.",
            parallelizable: false,
            providerId: "openai",
            model: "gpt-4.1-mini",
          },
          {
            stepId: "step-2",
            index: 1,
            role: "synthesizer",
            stage: 2,
            objective: "Produce the final answer.",
            parallelizable: false,
            providerId: "anthropic",
            model: "claude-sonnet-4-6",
          },
          {
            stepId: "step-3",
            index: 2,
            role: "critic",
            stage: 3,
            objective: "Add critique notes after the draft.",
            parallelizable: false,
            providerId: "openai",
            model: "gpt-4.1-mini",
          },
        ],
      },
      callbacks: {
        createChatCompletion: vi
          .fn()
          .mockResolvedValueOnce(createCompletion("Draft answer"))
          .mockResolvedValueOnce(createCompletion("Final answer"))
          .mockResolvedValueOnce(createCompletion("Critic notes")),
      },
    });

    expect(result.finalOutput).toBe("Final answer");
    expect(result.finalStep?.role).toBe("synthesizer");
  });

  it("degrades cleanly when every stage fails", async () => {
    const createChatCompletion = vi.fn().mockRejectedValue(new Error("provider unavailable"));

    const result = await executeOrchestrationPlan({
      task: createTask(),
      plan: {
        ...createPlan(),
        steps: [
          {
            stepId: "step-1",
            index: 0,
            role: "planner",
            stage: 1,
            objective: "Draft a workable plan.",
            parallelizable: false,
            providerId: "openai",
            model: "gpt-4.1-mini",
          },
        ],
      },
      callbacks: {
        createChatCompletion,
      },
    });

    expect(result.stepResults).toHaveLength(1);
    expect(result.stepResults[0]?.status).toBe("failed");
    expect(result.finalOutput).toContain("could not complete the orchestrated workflow");
    expect(result.finalOutput).toContain("Planner");
  });

  it("fails downstream synthesis and review roles when no upstream handoff completed", async () => {
    const createChatCompletion = vi
      .fn()
      .mockRejectedValue(new Error("provider unavailable"));

    const result = await executeOrchestrationPlan({
      task: createTask(),
      plan: createPlan(),
      callbacks: {
        createChatCompletion,
      },
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(2);
    expect(result.stepResults).toHaveLength(4);
    expect(result.stepResults[0]).toMatchObject({
      role: "researcher",
      status: "failed",
      error: "provider unavailable",
    });
    expect(result.stepResults[1]).toMatchObject({
      role: "researcher",
      status: "failed",
      error: "provider unavailable",
    });
    expect(result.stepResults[2]).toMatchObject({
      role: "critic",
      status: "failed",
      summary: "Critic blocked",
      error: "No completed upstream handoffs were available for critic.",
    });
    expect(result.stepResults[3]).toMatchObject({
      role: "synthesizer",
      status: "failed",
      summary: "Synthesizer blocked",
      error: "No completed upstream handoffs were available for synthesizer.",
    });
    expect(result.finalOutput).toContain("Critic");
    expect(result.finalOutput).toContain("Synthesizer");
  });
});
