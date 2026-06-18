import { describe, expect, it, vi } from "vitest";
import type {
  ChatCitationRecord,
  ChatCompletionRequest,
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
    expect(result.stepResults[0]?.prompt).toEqual({
      promptId: "orchestration.turn.step.execute",
      promptVersion: "v1",
      promptHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
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

  it("skips downstream stages when no upstream handoff completed", async () => {
    const createChatCompletion = vi.fn().mockRejectedValue(new Error("provider unavailable"));

    const result = await executeOrchestrationPlan({
      task: createTask(),
      plan: createPlan(),
      callbacks: {
        createChatCompletion,
      },
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(2);
    expect(result.stepResults).toHaveLength(2);
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
    expect(result.finalOutput).toContain("Researcher");
    expect(result.finalOutput).not.toContain("Critic blocked");
  });

  it("rejects orchestration plans with same-stage dependency violations before execution", async () => {
    const plan = createPlan();
    const createChatCompletion = vi.fn();

    await expect(
      executeOrchestrationPlan({
        task: createTask(),
        plan: {
          ...plan,
          steps: plan.steps.map((step) =>
            step.stepId === "step-2" ? { ...step, dependsOnStepIds: ["step-1"] } : step,
          ),
        },
        callbacks: { createChatCompletion },
      }),
    ).rejects.toThrow(/same or a later stage/i);
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it("rejects orchestration plans with dependency cycles before execution", async () => {
    const plan = createPlan();

    await expect(
      executeOrchestrationPlan({
        task: createTask(),
        plan: {
          ...plan,
          steps: plan.steps.map((step) =>
            step.stepId === "step-1"
              ? { ...step, dependsOnStepIds: ["step-3"] }
              : step.stepId === "step-3"
                ? { ...step, dependsOnStepIds: ["step-1"] }
                : step,
          ),
        },
        callbacks: { createChatCompletion: vi.fn() },
      }),
    ).rejects.toThrow(/same or a later stage|cycle/i);
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

  it("waits for every parallel stage handoff before starting the downstream synthesis stage", async () => {
    const started: string[] = [];
    let resolveFirst: ((response: ChatCompletionResponse) => void) | undefined;
    let resolveSecond: ((response: ChatCompletionResponse) => void) | undefined;
    const createChatCompletion = vi.fn((request: ChatCompletionRequest) => {
      const userPrompt = String(request.messages.at(-1)?.content ?? "");
      if (userPrompt.includes("First independent branch")) {
        started.push("first");
        return new Promise<ChatCompletionResponse>((resolve) => {
          resolveFirst = resolve;
        });
      }
      if (userPrompt.includes("Second independent branch")) {
        started.push("second");
        return new Promise<ChatCompletionResponse>((resolve) => {
          resolveSecond = resolve;
        });
      }
      started.push("synthesis");
      return Promise.resolve(createCompletion("Merged synthesis"));
    });

    const execution = executeOrchestrationPlan({
      task: createTask(),
      plan: {
        ...createPlan(),
        workflowTemplate: "cowork.plan.work.synthesize",
        steps: [
          {
            stepId: "step-1",
            index: 0,
            role: "worker",
            label: "First",
            stage: 1,
            objective: "First independent branch",
            parallelizable: true,
            providerId: "openai",
            model: "gpt-4.1-mini",
          },
          {
            stepId: "step-2",
            index: 1,
            role: "worker",
            label: "Second",
            stage: 1,
            objective: "Second independent branch",
            parallelizable: true,
            providerId: "anthropic",
            model: "claude-sonnet-4-6",
          },
          {
            stepId: "step-3",
            index: 2,
            role: "synthesizer",
            label: "Synthesis",
            stage: 2,
            objective: "Merge upstream handoffs",
            parallelizable: false,
            dependsOnStepIds: ["step-1", "step-2"],
            providerId: "openai",
            model: "gpt-4.1-mini",
          },
        ],
      },
      callbacks: {
        createChatCompletion,
      },
      concurrency: 2,
    });

    await Promise.resolve();
    expect(started).toEqual(["first", "second"]);

    resolveFirst?.(createCompletion("First branch complete"));
    await Promise.resolve();
    expect(started).toEqual(["first", "second"]);

    resolveSecond?.(createCompletion("Second branch complete"));
    const result = await execution;

    expect(started).toEqual(["first", "second", "synthesis"]);
    expect(result.finalOutput).toBe("Merged synthesis");
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
      .mockRejectedValueOnce(new Error("synthesis output empty"))
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
    expect(result.finalStep?.stepId).toBe("repair-step-3");
    expect(result.finalStep?.label).toBe("Synthesis repair");
    expect(result.finalStep?.repairedFromStepId).toBe("step-3");
    expect(result.finalStep?.prompt).toEqual({
      promptId: "orchestration.turn.final_synthesis.repair",
      promptVersion: "v1",
      promptHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(result.integritySignals).toEqual([
      "orchestration_final_synthesis_missing",
      "orchestration_final_synthesis_role_drift",
      "orchestration_final_synthesis_repaired",
    ]);
    const repairPrompt = createChatCompletion.mock.calls[3]?.[0].messages.at(-1)?.content ?? "";
    expect(repairPrompt).toContain("Prioritized acquisition plan.");
    expect(repairPrompt).toContain("Concrete SEO and outreach assets.");
  });

  it("does not retry the same synthesizer provider after a provider outage", async () => {
    const createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce(createCompletion("Prioritized acquisition plan."))
      .mockResolvedValueOnce(createCompletion("Concrete SEO and outreach assets."))
      .mockRejectedValueOnce(new Error("provider unavailable"));

    const result = await executeOrchestrationPlan({
      task: {
        ...createTask(),
        objective: "Update SEO and get beta users beyond flyers.",
      },
      plan: createPlanWorkSynthesizePlan(),
      callbacks: { createChatCompletion },
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(3);
    expect(result.integritySignals).toContain("orchestration_final_synthesis_fallback");
    expect(result.finalOutput).toContain("Synthesis Incomplete");
  });

  it("marks failed child budget steps as partial continuation integrity", async () => {
    const plan: OrchestrationPlan = {
      ...createPlan(),
      workflowTemplate: "cowork.research",
      summary: "Delegated research.",
      steps: [
        {
          stepId: "step-child",
          index: 0,
          role: "researcher",
          stage: 1,
          objective: "Find local stores and verify contact fields.",
          parallelizable: false,
          delegatedRole: "researcher",
        },
      ],
    };

    const result = await executeOrchestrationPlan({
      task: createTask(),
      plan,
      callbacks: {
        createChatCompletion: vi.fn(),
        executeDelegatedStep: vi.fn(async () => ({
          stepId: "step-child",
          role: "researcher",
          index: 0,
          startedAt: NOW,
          finishedAt: NOW,
          status: "failed",
          output: "Strong leads so far: Store A and Store B.",
          summary: "Research hit budget.",
          error: "Tool run budget exceeded for this turn after 7 tool calls.",
          failureGuidance: "Continue from gathered leads.",
          childSessionId: "child-1",
          childTurnId: "turn-child-1",
          citations: [],
        })),
      },
    });

    expect(result.finalOutput).toContain("Synthesis Incomplete");
    expect(result.finalOutput).toContain("Strong leads so far");
    expect(result.integritySignals).toEqual([
      "orchestration_child_failure",
      "orchestration_child_tool_budget",
      "orchestration_partial_needs_continuation",
      "orchestration_final_synthesis_fallback",
    ]);
  });

  it("marks failed child allowlist steps as incomplete continuation work", async () => {
    const plan: OrchestrationPlan = {
      ...createPlan(),
      workflowTemplate: "cowork.research",
      summary: "Delegated research.",
      steps: [
        {
          stepId: "step-child",
          index: 0,
          role: "researcher",
          stage: 1,
          objective: "Find local stores and verify contact fields.",
          parallelizable: false,
          delegatedRole: "researcher",
        },
      ],
    };

    const result = await executeOrchestrationPlan({
      task: createTask(),
      plan,
      callbacks: {
        createChatCompletion: vi.fn(),
        executeDelegatedStep: vi.fn(async () => ({
          stepId: "step-child",
          role: "researcher",
          index: 0,
          startedAt: NOW,
          finishedAt: NOW,
          status: "failed",
          output: "Strong leads so far: Store A and Store B.",
          summary: "Research hit a blocked host.",
          error: "Repeated tool failure for browser.navigate (2 attempts): blocked: Host is not yet allowlisted.",
          failureGuidance: "Continue from gathered leads and use alternate current sources.",
          childSessionId: "child-1",
          childTurnId: "turn-child-1",
          citations: [],
        })),
      },
    });

    expect(result.finalOutput).toContain("Synthesis Incomplete");
    expect(result.finalOutput).toContain("Host is not yet allowlisted");
    expect(result.integritySignals).toEqual([
      "orchestration_child_failure",
      "orchestration_child_tool_blocked",
      "orchestration_partial_needs_continuation",
      "orchestration_final_synthesis_fallback",
    ]);
  });

  it("marks synthesizer with degradedHandoffStepIds when a failed researcher output was used", async () => {
    const plan: OrchestrationPlan = {
      ...createPlan(),
      workflowTemplate: "cowork.research",
      summary: "Delegated research with degraded handoff.",
      steps: [
        {
          stepId: "step-researcher",
          index: 0,
          role: "researcher",
          stage: 1,
          objective: "Gather evidence.",
          parallelizable: false,
          delegatedRole: "researcher",
        },
        {
          stepId: "step-synthesizer",
          index: 1,
          role: "synthesizer",
          stage: 2,
          objective: "Synthesize the final answer.",
          parallelizable: false,
          delegatedRole: "synthesizer",
        },
      ],
    };

    const executeDelegatedStep = vi.fn(async (input: { step: { stepId: string; role: string } }) => {
      if (input.step.role === "researcher") {
        return {
          stepId: input.step.stepId,
          role: "researcher",
          index: 0,
          startedAt: NOW,
          finishedAt: NOW,
          status: "failed" as const,
          output: "Gathered evidence: EPA guidance covers HEPA filtration and CADR sizing.",
          summary: "Research hit the tool budget after gathering evidence.",
          error: "Tool run budget exceeded for this turn after 7 tool calls.",
          failureGuidance: "Continue from gathered evidence.",
          childSessionId: "child-researcher",
          childTurnId: "turn-researcher",
          citations: [],
        };
      }
      return {
        stepId: input.step.stepId,
        role: "synthesizer",
        index: 1,
        startedAt: NOW,
        finishedAt: NOW,
        status: "completed" as const,
        output: "Final recommendation synthesized from the degraded research handoff.",
        summary: "Synthesis complete.",
        childSessionId: "child-synthesizer",
        childTurnId: "turn-synthesizer",
        citations: [],
      };
    });

    const result = await executeOrchestrationPlan({
      task: createTask(),
      plan,
      callbacks: {
        createChatCompletion: vi.fn(),
        executeDelegatedStep: executeDelegatedStep as never,
      },
    });

    const synthesizerCall = executeDelegatedStep.mock.calls.find(
      (call) => (call[0] as { step: { role: string } }).step.role === "synthesizer",
    );
    expect(synthesizerCall).toBeDefined();
    expect(result.stepResults.find((step) => step.stepId === "step-synthesizer")?.degradedHandoffStepIds).toEqual([
      "step-researcher",
    ]);
    expect(result.integritySignals).toContain("orchestration_synthesis_from_degraded_handoffs");
    expect(result.finalOutput).toContain("Final recommendation synthesized");
    expect(result.finalOutput).not.toContain("Synthesis Incomplete");
  });

  it("blocks the synthesizer when failed steps only carry their failure message as output", async () => {
    const failureText = "Provider request failed: upstream timeout.";
    const plan: OrchestrationPlan = {
      ...createPlan(),
      workflowTemplate: "cowork.research",
      summary: "Delegated research with no usable handoff.",
      steps: [
        {
          stepId: "step-researcher",
          index: 0,
          role: "researcher",
          stage: 1,
          objective: "Gather evidence.",
          parallelizable: false,
          delegatedRole: "researcher",
        },
        {
          stepId: "step-synthesizer",
          index: 1,
          role: "synthesizer",
          stage: 2,
          objective: "Synthesize the final answer.",
          parallelizable: false,
          delegatedRole: "synthesizer",
        },
      ],
    };

    const executeDelegatedStep = vi.fn(async (input: { step: { stepId: string; role: string } }) => ({
      stepId: input.step.stepId,
      role: input.step.role,
      index: 0,
      startedAt: NOW,
      finishedAt: NOW,
      status: "failed" as const,
      // Delegated steps copy the failure message into output when the model
      // produced nothing; that must not count as a usable handoff.
      output: failureText,
      summary: "Research failed.",
      error: failureText,
      childSessionId: `child-${input.step.stepId}`,
      childTurnId: `turn-${input.step.stepId}`,
      citations: [],
    }));

    const result = await executeOrchestrationPlan({
      task: createTask(),
      plan,
      callbacks: {
        createChatCompletion: vi.fn(),
        executeDelegatedStep: executeDelegatedStep as never,
      },
    });

    const synthesizerCall = executeDelegatedStep.mock.calls.find(
      (call) => (call[0] as { step: { role: string } }).step.role === "synthesizer",
    );
    expect(synthesizerCall).toBeUndefined();
    expect(result.finalOutput).toContain("Synthesis Incomplete");
  });

  it("blocks downstream synthesis until every declared dependency has a usable handoff", async () => {
    const failureText = "Provider request failed: upstream timeout.";
    const plan: OrchestrationPlan = {
      ...createPlan(),
      workflowTemplate: "cowork.research",
      summary: "Delegated research with explicit fan-in dependencies.",
      steps: [
        {
          stepId: "step-researcher-good",
          index: 0,
          role: "researcher",
          stage: 1,
          objective: "Gather usable evidence.",
          parallelizable: true,
          delegatedRole: "researcher",
        },
        {
          stepId: "step-researcher-empty",
          index: 1,
          role: "researcher",
          stage: 1,
          objective: "Gather the second evidence stream.",
          parallelizable: true,
          delegatedRole: "researcher",
        },
        {
          stepId: "step-synthesizer",
          index: 2,
          role: "synthesizer",
          stage: 2,
          objective: "Synthesize only when both upstream handoffs are usable.",
          parallelizable: false,
          delegatedRole: "synthesizer",
          dependsOnStepIds: ["step-researcher-good", "step-researcher-empty"],
        },
      ],
    };

    const executeDelegatedStep = vi.fn(async (input: { step: { stepId: string; role: string } }) => {
      if (input.step.stepId === "step-researcher-good") {
        return {
          stepId: input.step.stepId,
          role: "researcher",
          index: 0,
          startedAt: NOW,
          finishedAt: NOW,
          status: "completed" as const,
          output: "Gathered evidence: the first workstream completed with usable findings.",
          summary: "Research complete.",
          childSessionId: "child-researcher-good",
          childTurnId: "turn-researcher-good",
          citations: [],
        };
      }
      return {
        stepId: input.step.stepId,
        role: input.step.role,
        index: 1,
        startedAt: NOW,
        finishedAt: NOW,
        status: "failed" as const,
        output: failureText,
        summary: "Research failed.",
        error: failureText,
        childSessionId: `child-${input.step.stepId}`,
        childTurnId: `turn-${input.step.stepId}`,
        citations: [],
      };
    });

    const result = await executeOrchestrationPlan({
      task: createTask(),
      plan,
      callbacks: {
        createChatCompletion: vi.fn(),
        executeDelegatedStep: executeDelegatedStep as never,
      },
    });

    const synthesizerCall = executeDelegatedStep.mock.calls.find(
      (call) => (call[0] as { step: { role: string } }).step.role === "synthesizer",
    );
    const synthesizerStep = result.stepResults.find((step) => step.stepId === "step-synthesizer");
    expect(synthesizerCall).toBeUndefined();
    expect(synthesizerStep?.status).toBe("failed");
    expect(synthesizerStep?.error).toContain("No completed upstream handoffs");
    expect(result.finalOutput).toContain("Synthesis Incomplete");
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
