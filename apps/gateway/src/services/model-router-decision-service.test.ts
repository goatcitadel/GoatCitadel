import { describe, expect, it } from "vitest";
import type { ChatMessageRecord, ChatSessionPrefsRecord, LlmRuntimeConfig } from "@goatcitadel/contracts";
import { buildProviderCapabilityRegistry } from "../orchestration/providers/capability-registry.js";
import { resolveModePolicy } from "../orchestration/router.js";
import type { OrchestrationRouterInput } from "../orchestration/types.js";
import {
  routeWithModelRouter,
  shouldBypassOrchestrationWithModelRouter,
  withModelRouterOrchestrationDecision,
} from "./model-router-decision-service.js";

const NOW = "2026-06-16T00:00:00.000Z";

describe("model-router decision service", () => {
  it("routes simple, risky, coding, and fresh research prompts like model-router's hot path", () => {
    expect(routeWithModelRouter({ prompt: "rewrite this text" })).toMatchObject({
      source: "model-router",
      sourceRepository: "doncazper/hermes-router",
      selectedEngine: "fast_local",
      route: "simple",
      requiresTools: false,
      requiresConfirmation: false,
    });
    expect(routeWithModelRouter({ prompt: "drop the production database" })).toMatchObject({
      selectedEngine: "human_confirm",
      route: "confirmation",
      requiresConfirmation: true,
    });
    expect(routeWithModelRouter({ prompt: "fix the repo and run tests" })).toMatchObject({
      selectedEngine: "code_agent",
      route: "coding",
      requiresTools: true,
      requiresCodeExecution: true,
    });
    expect(routeWithModelRouter({ prompt: "search the web for the latest TypeScript release notes" })).toMatchObject({
      selectedEngine: "web_research",
      route: "research",
      requiresFreshness: true,
      requiresTools: true,
    });
  });

  it("allows direct-chat bypass only for safe simple or balanced chat", () => {
    const direct = routeWithModelRouter({
      prompt: `summarize these notes:\n${"customer note ".repeat(80)}`,
    });

    expect(
      shouldBypassOrchestrationWithModelRouter({
        routerInput: createInput(),
        decision: direct,
        advisoryOnly: false,
      }),
    ).toMatchObject({
      bypass: true,
    });

    const research = routeWithModelRouter({ prompt: "research the latest sqlite release notes" });
    expect(
      shouldBypassOrchestrationWithModelRouter({
        routerInput: createInput(),
        decision: research,
        advisoryOnly: false,
      }),
    ).toMatchObject({
      bypass: false,
    });

    expect(
      shouldBypassOrchestrationWithModelRouter({
        routerInput: createInput({ mode: "cowork", prefs: createPrefs({ mode: "cowork" }) }),
        decision: direct,
        advisoryOnly: false,
      }),
    ).toMatchObject({
      bypass: false,
      reason: "Cowork and Code modes keep governed orchestration routing",
    });

    expect(
      shouldBypassOrchestrationWithModelRouter({
        routerInput: createInput({ prefs: createPrefs({ orchestrationIntensity: "deep" }) }),
        decision: direct,
        advisoryOnly: false,
      }),
    ).toMatchObject({
      bypass: false,
      reason: "deep orchestration intensity was explicitly requested",
    });
  });

  it("classifies live-data prompts as research so the receipt is never a misleading bypass", () => {
    const liveDataPrompts = [
      "what's the latest news on the typescript release",
      "what is the current price of bitcoin",
      "what's the weather today",
    ];
    for (const prompt of liveDataPrompts) {
      const decision = routeWithModelRouter({ prompt });
      expect(decision).toMatchObject({
        route: "research",
        selectedEngine: "web_research",
        requiresFreshness: true,
      });
      expect(
        shouldBypassOrchestrationWithModelRouter({ routerInput: createInput(), decision, advisoryOnly: false }),
      ).toMatchObject({ bypass: false });
    }
  });

  it("routes explicit non-current research to governed web tools without claiming freshness", () => {
    const decision = routeWithModelRouter({
      prompt: "Please do some research on funny jokes and put together a PowerPoint presentation on it.",
    });

    expect(decision).toMatchObject({
      route: "research",
      selectedEngine: "web_research",
      requiresTools: true,
      requiresFreshness: false,
      reasons: expect.arrayContaining(["external research requested"]),
    });
  });

  it("never bypasses orchestration for tool, vision, image, confirmation, reasoning, or attachment turns", () => {
    const blockedInputs = [
      { prompt: "what is in this screenshot" },
      { prompt: "generate an image of a lobster" },
      { prompt: "fix the repo and run tests" },
      { prompt: "delete the production database" },
      { prompt: "design a scalable distributed consensus architecture" },
      { prompt: "summarize this", hasAttachments: true },
    ];
    const wronglyBypassed = blockedInputs.filter(
      (input) =>
        shouldBypassOrchestrationWithModelRouter({
          routerInput: createInput(),
          decision: routeWithModelRouter(input),
          advisoryOnly: false,
        }).bypass,
    );
    expect(wronglyBypassed).toEqual([]);
  });

  it("keeps a safe direct-chat turn governed under advisory planning or explicit web mode", () => {
    const direct = routeWithModelRouter({ prompt: "rewrite this text" });
    expect(
      shouldBypassOrchestrationWithModelRouter({ routerInput: createInput(), decision: direct, advisoryOnly: true }),
    ).toMatchObject({ bypass: false, reason: "planning mode requires an inspectable orchestration plan" });
    expect(
      shouldBypassOrchestrationWithModelRouter({
        routerInput: createInput({ prefs: createPrefs({ webMode: "deep" }) }),
        decision: direct,
        advisoryOnly: false,
      }),
    ).toMatchObject({ bypass: false, reason: "web mode is explicitly enabled" });
  });

  it("records orchestration evidence without mutating the original receipt", () => {
    const decision = routeWithModelRouter({ prompt: "rewrite this text" });
    const annotated = withModelRouterOrchestrationDecision(decision, {
      decision: "bypassed",
      reason: "model-router selected fast_local",
    });

    expect(decision.orchestration).toBeUndefined();
    expect(annotated.orchestration).toEqual({
      decision: "bypassed",
      reason: "model-router selected fast_local",
    });
  });
});

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
    orchestrationVisibility: "summarized",
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
    ],
  };
}

function createInput(overrides: Partial<OrchestrationRouterInput["task"]> = {}): OrchestrationRouterInput {
  const runtime = createRuntime();
  const task = {
    sessionId: "session-1",
    workspaceId: "workspace-1",
    mode: "chat" as const,
    objective: "summarize notes",
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
