import { describe, expect, it } from "vitest";
import type { ChatMessageRecord, ChatSessionPrefsRecord, LlmRuntimeConfig } from "@goatcitadel/contracts";
import { buildProviderCapabilityRegistry } from "./providers/capability-registry.js";
import { buildOrchestrationPlan, resolveModePolicy, shouldUseModeOrchestration } from "./router.js";
import type { OrchestrationRouterInput } from "./types.js";

const NOW = "2026-03-08T20:00:00.000Z";

function createPrefs(overrides: Partial<ChatSessionPrefsRecord> = {}): ChatSessionPrefsRecord {
  return {
    sessionId: "session-1",
    mode: "chat",
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
    orchestrationParallelism: "auto",
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

function createRuntime(): LlmRuntimeConfig {
  return {
    activeProviderId: "openai",
    activeModel: "gpt-4.1-mini",
    providers: [
      {
        providerId: "openai",
        label: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        apiStyle: "openai-chat-completions",
        defaultModel: "gpt-4.1-mini",
        hasApiKey: true,
        apiKeySource: "env",
      },
      {
        providerId: "anthropic",
        label: "Anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        apiStyle: "openai-chat-completions",
        defaultModel: "claude-sonnet-4-6",
        hasApiKey: true,
        apiKeySource: "env",
      },
      {
        providerId: "perplexity",
        label: "Perplexity",
        baseUrl: "https://api.perplexity.ai",
        apiStyle: "openai-chat-completions",
        defaultModel: "sonar",
        hasApiKey: true,
        apiKeySource: "env",
      },
      {
        providerId: "moonshot",
        label: "Moonshot",
        baseUrl: "https://api.moonshot.ai/v1",
        apiStyle: "openai-chat-completions",
        defaultModel: "kimi-k2.6",
        hasApiKey: true,
        apiKeySource: "env",
      },
    ],
  };
}

function createInput(overrides: Partial<OrchestrationRouterInput["task"]> = {}): OrchestrationRouterInput {
  const runtime = createRuntime();
  const task = {
    sessionId: "session-1",
    workspaceId: "workspace-1",
    mode: "chat" as const,
    objective: "Help me answer this question simply.",
    prefs: createPrefs(),
    conversation: [] as ChatMessageRecord[],
    historyMessages: [],
    ...overrides,
  };
  return {
    task,
    runtime,
    capabilities: buildProviderCapabilityRegistry(runtime),
    policy: resolveModePolicy(task.mode),
  };
}

describe("orchestration router", () => {
  it("keeps simple chat requests on the single-agent path by default", () => {
    const input = createInput({
      mode: "chat",
      objective: "What is the capital of France?",
      prefs: createPrefs({
        mode: "chat",
        orchestrationIntensity: "balanced",
      }),
    });

    expect(shouldUseModeOrchestration(input)).toBe(false);
  });

  it("enables orchestration for research-heavy chat prompts", () => {
    const input = createInput({
      mode: "chat",
      objective: "Compare OpenClaw features, critique the tradeoffs, and recommend the strongest option.",
      prefs: createPrefs({
        mode: "chat",
        orchestrationIntensity: "balanced",
      }),
    });

    expect(shouldUseModeOrchestration(input)).toBe(true);
    const plan = buildOrchestrationPlan(input);
    expect(plan.workflowTemplate).toBe("chat.answer.review");
    expect(plan.routeDecision.visibility).toBe("summarized");
    expect(plan.steps.map((step) => step.role)).toEqual(["answerer", "reviewer", "synthesizer"]);
  });

  it("keeps explicit web lookups on the tool-backed single-agent path", () => {
    const input = createInput({
      mode: "chat",
      objective: "Look online and tell me the 5 most interesting things that happened today.",
      prefs: createPrefs({
        mode: "chat",
        webMode: "quick",
        orchestrationIntensity: "balanced",
      }),
    });

    expect(shouldUseModeOrchestration(input)).toBe(false);
  });

  it("keeps live-data chat prompts off orchestration when web access is available", () => {
    const input = createInput({
      mode: "chat",
      objective: "What are the latest news headlines about OpenAI today?",
      prefs: createPrefs({
        mode: "chat",
        webMode: "auto",
        orchestrationIntensity: "balanced",
      }),
    });

    expect(shouldUseModeOrchestration(input)).toBe(false);
  });

  it("keeps explicit web search phrases off orchestration", () => {
    for (const phrase of ["web search for recent AI breakthroughs", "use internet to find the top news"]) {
      const input = createInput({
        mode: "chat",
        objective: phrase,
        prefs: createPrefs({
          mode: "chat",
          webMode: "auto",
          orchestrationIntensity: "balanced",
        }),
      });
      expect(shouldUseModeOrchestration(input)).toBe(false);
    }
  });

  it("does not let web mode suppress orchestration for normal research prompts", () => {
    const input = createInput({
      mode: "chat",
      objective: "Compare React and Vue tradeoffs for a small internal tool and recommend one.",
      prefs: createPrefs({
        mode: "chat",
        webMode: "quick",
        orchestrationIntensity: "balanced",
      }),
    });

    expect(shouldUseModeOrchestration(input)).toBe(true);
  });

  it("does not treat generic current-state prompts as live web requests", () => {
    const input = createInput({
      mode: "chat",
      objective: "Summarize the current architecture of the app.",
      prefs: createPrefs({
        mode: "chat",
        webMode: "auto",
        orchestrationIntensity: "balanced",
      }),
    });

    expect(shouldUseModeOrchestration(input)).toBe(false);
  });

  it("keeps live-data prompts off orchestration even when webMode is off", () => {
    const input = createInput({
      mode: "chat",
      objective: "What are the latest news headlines about OpenAI today?",
      prefs: createPrefs({
        mode: "chat",
        webMode: "off",
        orchestrationIntensity: "balanced",
      }),
    });

    expect(shouldUseModeOrchestration(input)).toBe(false);
  });

  it("routes cowork research to parallel researchers with explicit visibility", () => {
    const input = createInput({
      mode: "cowork",
      objective: "Research the market, compare the strongest options, and synthesize a recommendation.",
      prefs: createPrefs({
        mode: "cowork",
        orchestrationVisibility: "explicit",
        orchestrationParallelism: "parallel",
      }),
    });
    input.policy = resolveModePolicy("cowork");

    expect(shouldUseModeOrchestration(input)).toBe(true);
    const plan = buildOrchestrationPlan(input);
    expect(plan.workflowTemplate).toBe("cowork.research.synthesize.critic");
    expect(plan.routeDecision.visibility).toBe("explicit");
    expect(plan.steps.map((step) => step.role)).toEqual(["researcher", "researcher", "critic", "synthesizer"]);
    expect(plan.steps.filter((step) => step.role === "researcher")).toHaveLength(2);
    expect(plan.steps.filter((step) => step.role === "researcher").every((step) => step.stage === 1)).toBe(true);
    expect(plan.steps.find((step) => step.role === "critic")?.dependsOnStepIds).toEqual(["orch-step-1", "orch-step-2"]);
    expectPlanDependenciesValid(plan);
  });

  it("suggests presentation creation for Cowork deck deliverables", () => {
    const input = createInput({
      mode: "cowork",
      objective: "Research the top 10 things to do near me, then put it together in a PowerPoint presentation format.",
      prefs: createPrefs({
        mode: "cowork",
        orchestrationVisibility: "explicit",
      }),
    });
    input.policy = resolveModePolicy("cowork");

    const plan = buildOrchestrationPlan(input);
    const synthesisStep = plan.steps.find((step) => step.role === "synthesizer");

    expect(plan.workflowTemplate).toBe("cowork.research.synthesize.critic");
    expect(synthesisStep?.suggestedTools).toContain("presentations.create");
    expect(
      plan.steps.filter((step) => step.role === "researcher").flatMap((step) => step.suggestedTools ?? []),
    ).not.toContain("presentations.create");
  });

  it("suggests document creation for Cowork file deliverables", () => {
    const input = createInput({
      mode: "cowork",
      objective: "Turn the recommendations into a real PDF report file.",
      prefs: createPrefs({
        mode: "cowork",
        orchestrationVisibility: "explicit",
      }),
    });
    input.policy = resolveModePolicy("cowork");

    const plan = buildOrchestrationPlan(input);
    const synthesisStep = plan.steps.find((step) => step.role === "synthesizer");

    expect(synthesisStep?.suggestedTools).toContain("documents.create");
    expect(synthesisStep?.suggestedTools).not.toContain("presentations.create");
    expect(
      plan.steps.filter((step) => step.role === "researcher").flatMap((step) => step.suggestedTools ?? []),
    ).not.toContain("documents.create");
  });

  it("suggests document creation for designed proposal and Google Doc deliverables", () => {
    const input = createInput({
      mode: "cowork",
      objective: "Write a polished proposal brochure and deliver it as a Google Doc file.",
      prefs: createPrefs({
        mode: "cowork",
        orchestrationVisibility: "explicit",
      }),
    });
    input.policy = resolveModePolicy("cowork");

    const plan = buildOrchestrationPlan(input);
    const synthesisStep = plan.steps.find((step) => step.role === "synthesizer");

    expect(synthesisStep?.suggestedTools).toContain("documents.create");
    expect(synthesisStep?.suggestedTools).not.toContain("presentations.create");
  });

  it("does not select artifact tools for plain chat output", () => {
    const input = createInput({
      mode: "cowork",
      objective: "Return plain JSON in the chat only; do not create or save a file.",
      prefs: createPrefs({
        mode: "cowork",
        orchestrationVisibility: "explicit",
      }),
    });
    input.policy = resolveModePolicy("cowork");

    const plan = buildOrchestrationPlan(input);
    const suggestedTools = plan.steps.flatMap((step) => step.suggestedTools ?? []);

    expect(suggestedTools).not.toContain("documents.create");
    expect(suggestedTools).not.toContain("presentations.create");
  });

  it("preserves explicit Cowork workstreams for final synthesis", () => {
    const input = createInput({
      mode: "cowork",
      objective:
        "Use Cowork to plan a cozy cyberpunk-themed dinner party for six friends, with roles for Menu, Atmosphere, Logistics, and Risk Review, then give me a final host-ready checklist.",
      prefs: createPrefs({
        mode: "cowork",
        orchestrationVisibility: "explicit",
        orchestrationParallelism: "parallel",
      }),
    });
    input.policy = resolveModePolicy("cowork");

    const plan = buildOrchestrationPlan(input);
    expect(plan.workflowTemplate).toBe("cowork.workstreams.synthesize");
    expect(plan.routeDecision.selectedRoles).toEqual(["Menu", "Atmosphere", "Logistics", "Risk Review", "Synthesis"]);
    expect(plan.steps.map((step) => step.label)).toEqual([
      "Menu",
      "Atmosphere",
      "Logistics",
      "Risk Review",
      "Synthesis",
    ]);
    expect(plan.steps.map((step) => step.role)).toEqual(["worker", "worker", "worker", "reviewer", "synthesizer"]);
    expect(plan.steps.find((step) => step.label === "Risk Review")?.stage).toBe(2);
    expect(plan.steps.at(-1)).toMatchObject({
      role: "synthesizer",
      label: "Synthesis",
      stage: 3,
      dependsOnStepIds: ["orch-step-1", "orch-step-2", "orch-step-3", "orch-step-4"],
    });
    expectPlanDependenciesValid(plan);
  });

  it("does not link same-stage review workstreams together", () => {
    const input = createInput({
      mode: "cowork",
      objective:
        "Use Cowork to prepare a business plan with roles for Market Plan, Website Plan, Risk Review, and Quality Review, then give me a final recommendation.",
      prefs: createPrefs({
        mode: "cowork",
        orchestrationVisibility: "explicit",
        orchestrationParallelism: "parallel",
      }),
    });
    input.policy = resolveModePolicy("cowork");

    const plan = buildOrchestrationPlan(input);
    const reviewSteps = plan.steps.filter((step) => step.role === "reviewer");

    expect(reviewSteps.map((step) => step.stage)).toEqual([2, 2]);
    expect(reviewSteps.map((step) => step.dependsOnStepIds)).toEqual([
      ["orch-step-1", "orch-step-2"],
      ["orch-step-1", "orch-step-2"],
    ]);
    expectPlanDependenciesValid(plan);
  });

  it("keeps generic Cowork planning on the existing plan-work-synthesize route", () => {
    const input = createInput({
      mode: "cowork",
      objective: "Plan a low-stress birthday weekend and give me a concise recommendation.",
      prefs: createPrefs({
        mode: "cowork",
        orchestrationVisibility: "explicit",
      }),
    });
    input.policy = resolveModePolicy("cowork");

    const plan = buildOrchestrationPlan(input);
    expect(plan.workflowTemplate).toBe("cowork.plan.work.synthesize");
    expect(plan.steps.map((step) => step.role)).toEqual(["planner", "worker", "reviewer", "synthesizer"]);
  });

  it("suggests web research tools for Cowork local-business list review work", () => {
    const input = createInput({
      mode: "cowork",
      objective:
        "can you find boardgame and tabletop game stores within 10 miles of 91303 and put a list together, of the store, address, hours, and email address",
      prefs: createPrefs({
        mode: "cowork",
        orchestrationVisibility: "explicit",
      }),
    });
    input.policy = resolveModePolicy("cowork");

    const plan = buildOrchestrationPlan(input);
    const workerStep = plan.steps.find((step) => step.role === "worker");
    const reviewerStep = plan.steps.find((step) => step.role === "reviewer");

    expect(plan.workflowTemplate).toBe("cowork.plan.work.synthesize");
    expect(workerStep?.suggestedTools).toEqual(["browser.search", "browser.navigate", "browser.extract", "http.get"]);
    expect(reviewerStep?.suggestedTools).toEqual(["browser.search", "browser.navigate", "browser.extract", "http.get"]);
  });

  it("pins the requested provider and code workflow when code mode is selected", () => {
    const input = createInput({
      mode: "code",
      objective: "Inspect the repository, plan the patch, implement it, review it, and validate edge cases.",
      prefs: createPrefs({
        mode: "code",
        providerId: "moonshot",
        model: "kimi-k2.6",
        orchestrationVisibility: "explicit",
      }),
    });
    input.policy = resolveModePolicy("code");

    const plan = buildOrchestrationPlan(input);
    expect(plan.workflowTemplate).toBe("code.plan.code.review.qa");
    expect(plan.steps.map((step) => step.role)).toEqual([
      "planner",
      "coder",
      "reviewer",
      "qa-validator",
      "synthesizer",
    ]);
    expect(plan.routeDecision.selectedProviders.every((selection) => selection.providerId === "moonshot")).toBe(true);
    expect(plan.routeDecision.selectedProviders.every((selection) => selection.model === "kimi-k2.6")).toBe(true);
  });

  it("keeps dependencies valid after maxSteps truncation", () => {
    const input = createInput({
      mode: "code",
      objective: "Inspect the repository, plan the patch, implement it, review it, and validate edge cases.",
      prefs: createPrefs({
        mode: "code",
        orchestrationVisibility: "explicit",
      }),
    });
    input.policy = {
      ...resolveModePolicy("code"),
      maxSteps: 3,
    };

    const plan = buildOrchestrationPlan(input);

    expect(plan.steps).toHaveLength(3);
    expectPlanDependenciesValid(plan);
  });
});

function expectPlanDependenciesValid(plan: ReturnType<typeof buildOrchestrationPlan>): void {
  const byId = new Map(plan.steps.map((step) => [step.stepId, step]));
  for (const step of plan.steps) {
    for (const dependencyId of step.dependsOnStepIds ?? []) {
      const dependency = byId.get(dependencyId);
      expect(dependency, `${step.stepId} dependency ${dependencyId} should exist`).toBeDefined();
      expect(dependency?.stage, `${step.stepId} dependency ${dependencyId} should be in an earlier stage`).toBeLessThan(
        step.stage,
      );
    }
  }
}
