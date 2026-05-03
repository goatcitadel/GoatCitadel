import { describe, expect, it, vi } from "vitest";
import type { ChatCitationRecord, ChatCompletionResponse, ChatSessionPrefsRecord } from "@goatcitadel/contracts";
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
      .mockResolvedValueOnce(
        createCompletion("Research angle one", [{ citationId: "c1", url: "https://example.com/1", title: "Source 1" }]),
      )
      .mockResolvedValueOnce(
        createCompletion("Research angle two", [
          { citationId: "c1b", url: "https://example.com/1", title: "Source 1" },
        ]),
      )
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
    expect(result.citations).toEqual([{ citationId: "c1", url: "https://example.com/1", title: "Source 1" }]);
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
    const createChatCompletion = vi.fn().mockRejectedValue(new Error("provider unavailable"));

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

  it("caps default stage concurrency at four steps when no override is provided", async () => {
    let active = 0;
    let maxActive = 0;
    const createChatCompletion = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return createCompletion("bounded result");
    });

    await executeOrchestrationPlan({
      task: createTask(),
      plan: {
        ...createPlan(),
        steps: Array.from({ length: 6 }, (_, index) => ({
          stepId: `step-${index + 1}`,
          index,
          role: "researcher" as const,
          stage: 1,
          objective: `Research pass ${index + 1}`,
          parallelizable: true,
          providerId: "openai",
          model: "gpt-4.1-mini",
        })),
      },
      callbacks: {
        createChatCompletion,
      },
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(6);
    expect(maxActive).toBe(4);
  });

  it("passes expanded labeled handoffs into workstream synthesis and repairs missing sections", async () => {
    const longMenuOutput = `## Menu\n${"Menu detail ".repeat(80)}`;
    const createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce(createCompletion(longMenuOutput))
      .mockResolvedValueOnce(createCompletion("## Atmosphere\nWarm neon hideout."))
      .mockResolvedValueOnce(createCompletion("## Logistics\nPrep timeline."))
      .mockResolvedValueOnce(createCompletion("## Risk Review\nConfirm allergies and keep LED cords safe."))
      .mockResolvedValueOnce(createCompletion("## Logistics\nOnly the logistics survived."))
      .mockResolvedValueOnce(
        createCompletion(
          [
            "## Menu",
            "Night market ramen bar.",
            "## Atmosphere",
            "Warm neon hideout.",
            "## Logistics",
            "Prep timeline.",
            "## Risk Review",
            "Confirm allergies.",
            "## Final Host-Ready Checklist",
            "- Shop.",
          ].join("\n"),
        ),
      );

    const result = await executeOrchestrationPlan({
      task: {
        ...createTask(),
        objective:
          "Plan a cozy cyberpunk dinner party with roles for Menu, Atmosphere, Logistics, and Risk Review, then give a final host-ready checklist.",
      },
      plan: createWorkstreamPlan(),
      callbacks: { createChatCompletion },
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(6);
    const synthesisPrompt = createChatCompletion.mock.calls[4]?.[0].messages.at(-1)?.content ?? "";
    expect(synthesisPrompt).toContain("### Menu (completed)");
    expect(synthesisPrompt).toContain("Menu detail Menu detail");
    expect(synthesisPrompt.length).toBeGreaterThan(1_000);
    expect(result.finalOutput).toContain("## Final Host-Ready Checklist");
    expect(result.finalOutput).toContain("## Risk Review");
    expect(result.integritySignals).toEqual([
      "orchestration_final_synthesis_missing_required_sections",
      "orchestration_final_synthesis_repaired",
    ]);
  });

  it("falls back to preserving completed workstreams when synthesis repair still misses labels", async () => {
    const createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce(createCompletion("## Menu\nRamen bar."))
      .mockResolvedValueOnce(createCompletion("## Atmosphere\nWarm neon."))
      .mockResolvedValueOnce(createCompletion("## Logistics\nPrep timeline."))
      .mockResolvedValueOnce(createCompletion("## Risk Review\nAllergy check."))
      .mockResolvedValueOnce(createCompletion("## Logistics\nOnly logistics."))
      .mockResolvedValueOnce(createCompletion("Still only logistics."));

    const result = await executeOrchestrationPlan({
      task: {
        ...createTask(),
        objective:
          "Plan a cozy cyberpunk dinner party with roles for Menu, Atmosphere, Logistics, and Risk Review, then give a final host-ready checklist.",
      },
      plan: createWorkstreamPlan(),
      callbacks: { createChatCompletion },
    });

    expect(result.finalOutput).toContain("## Synthesis Incomplete");
    expect(result.finalOutput).toContain("## Menu");
    expect(result.finalOutput).toContain("Ramen bar.");
    expect(result.finalOutput).toContain("## Atmosphere");
    expect(result.finalOutput).toContain("## Logistics");
    expect(result.finalOutput).toContain("## Risk Review");
    expect(result.finalOutput).not.toBe("## Logistics\nOnly logistics.");
    expect(result.integritySignals).toEqual([
      "orchestration_final_synthesis_missing_required_sections",
      "orchestration_final_synthesis_fallback",
    ]);
  });

  it("repairs generic Cowork runs when the final synthesis step fails after useful handoffs", async () => {
    const createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce(createCompletion("Prioritized acquisition plan."))
      .mockResolvedValueOnce(createCompletion("Concrete SEO and outreach assets."))
      .mockRejectedValueOnce(new Error("synthesis provider unavailable"))
      .mockResolvedValueOnce(createCompletion("Final beta acquisition plan that merges the plan, assets, and risks."));

    const result = await executeOrchestrationPlan({
      task: {
        ...createTask(),
        objective: "Update SEO and get beta users beyond flyers.",
      },
      plan: createPlanWorkSynthesizePlan(),
      callbacks: { createChatCompletion },
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(4);
    expect(result.finalOutput).toBe("Final beta acquisition plan that merges the plan, assets, and risks.");
    expect(result.finalStep?.role).toBe("synthesizer");
    expect(result.integritySignals).toEqual([
      "orchestration_final_synthesis_missing",
      "orchestration_final_synthesis_role_drift",
      "orchestration_final_synthesis_repaired",
    ]);
    const repairPrompt = createChatCompletion.mock.calls[3]?.[0].messages.at(-1)?.content ?? "";
    expect(repairPrompt).toContain("Prioritized acquisition plan.");
    expect(repairPrompt).toContain("Concrete SEO and outreach assets.");
  });
});

function createWorkstreamPlan(): OrchestrationPlan {
  return {
    workflowTemplate: "cowork.workstreams.synthesize",
    summary: "Explicit workstream plan.",
    source: "workflow_template",
    routeDecision: {
      modePolicy: "cowork",
      workflowTemplate: "cowork.workstreams.synthesize",
      hidden: false,
      visibility: "explicit",
      intensity: "balanced",
      providerPreference: "balanced",
      reviewDepth: "standard",
      parallelism: "parallel",
      selectedRoles: ["Menu", "Atmosphere", "Logistics", "Risk Review", "Synthesis"],
      selectedProviders: [],
      triggerReason: "cowork_explicit_orchestration",
    },
    steps: [
      {
        stepId: "step-1",
        index: 0,
        role: "worker",
        label: "Menu",
        stage: 1,
        objective: "Build the menu.",
        parallelizable: true,
        providerId: "openai",
        model: "gpt-5.5",
      },
      {
        stepId: "step-2",
        index: 1,
        role: "worker",
        label: "Atmosphere",
        stage: 1,
        objective: "Build the atmosphere plan.",
        parallelizable: true,
        providerId: "openai",
        model: "gpt-5.5",
      },
      {
        stepId: "step-3",
        index: 2,
        role: "worker",
        label: "Logistics",
        stage: 1,
        objective: "Build the logistics plan.",
        parallelizable: true,
        providerId: "openai",
        model: "gpt-5.5",
      },
      {
        stepId: "step-4",
        index: 3,
        role: "reviewer",
        label: "Risk Review",
        stage: 2,
        objective: "Review risks.",
        parallelizable: false,
        providerId: "openai",
        model: "gpt-5.5",
      },
      {
        stepId: "step-5",
        index: 4,
        role: "synthesizer",
        label: "Synthesis",
        stage: 3,
        objective: "Merge workstreams.",
        parallelizable: false,
        providerId: "openai",
        model: "gpt-5.5",
      },
    ],
  };
}

function createPlanWorkSynthesizePlan(): OrchestrationPlan {
  return {
    workflowTemplate: "cowork.plan.work.synthesize",
    summary: "Plan, work, synthesize.",
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
      selectedRoles: ["Plan", "Work", "Synthesis"],
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
        objective: "Plan beta acquisition.",
        parallelizable: false,
        providerId: "openai",
        model: "gpt-5.5",
      },
      {
        stepId: "step-2",
        index: 1,
        role: "worker",
        label: "Work",
        stage: 2,
        objective: "Produce assets.",
        parallelizable: false,
        providerId: "openai",
        model: "gpt-5.5",
      },
      {
        stepId: "step-3",
        index: 2,
        role: "synthesizer",
        label: "Synthesis",
        stage: 3,
        objective: "Merge plan and assets.",
        parallelizable: false,
        providerId: "openai",
        model: "gpt-5.5",
      },
    ],
  };
}
