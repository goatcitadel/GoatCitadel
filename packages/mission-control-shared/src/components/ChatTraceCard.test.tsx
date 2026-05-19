import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import type { ChatTurnTraceRecord } from "@goatcitadel/contracts";
import { ChatTraceCard } from "./ChatTraceCard";

function collectText(node: unknown): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => collectText(child)).join(" ");
  }
  if (typeof node === "object" && "children" in node) {
    return ((node as { children?: unknown[] }).children ?? []).map((child) => collectText(child)).join(" ");
  }
  return "";
}

function makeTrace(): ChatTurnTraceRecord {
  return {
    turnId: "turn-1",
    sessionId: "session-1",
    userMessageId: "user-1",
    assistantMessageId: "assistant-1",
    branchKind: "append",
    status: "completed",
    mode: "chat",
    model: "glm-5",
    webMode: "auto",
    memoryMode: "auto",
    thinkingLevel: "standard",
    startedAt: "2026-03-08T00:00:00.000Z",
    finishedAt: "2026-03-08T00:00:05.000Z",
    toolRuns: [
      {
        toolRunId: "tool-1",
        turnId: "turn-1",
        sessionId: "session-1",
        toolName: "browser.navigate",
        status: "failed",
        startedAt: "2026-03-08T00:00:01.000Z",
        finishedAt: "2026-03-08T00:00:02.000Z",
        error: "remote site blocked automation (Cloudflare 403)",
        failureGuidance: "Try the next viable source instead of retrying the blocked host.",
        result: {
          url: "https://www.movieinsider.com/movies",
          finalUrl: "https://www.movieinsider.com/movies",
          status: 403,
          engineTier: "builtin",
          engineLabel: "Built-in browser",
          browserFailureClass: "remote_blocked",
          storedAsArtifact: true,
          virtualized: true,
          artifactId: "artifact-1",
          artifactPath: "tool-artifacts/ab/artifact-1.json",
          artifactSummary: "Stored browser output as an artifact to keep live context compact.",
          originalByteLength: 16384,
          fallbackChain: [
            {
              toolName: "browser.navigate",
              engineTier: "builtin",
              status: "failed",
            },
            {
              toolName: "browser.navigate",
              engineTier: "playwright_mcp",
              status: "failed",
            },
          ],
        },
      },
    ],
    citations: [],
    routing: {
      liveDataIntent: true,
      fallbackUsed: true,
      fallbackReason: "primary blocked by remote site",
      primaryProviderId: "openai",
      primaryModel: "gpt-4.1-mini",
      effectiveProviderId: "glm",
      effectiveModel: "glm-5",
      effectiveApiStyle: "openai-chat-completions",
    },
    failure: {
      failureClass: "tool_blocked",
      message: "A required source blocked automated access.",
      retryable: true,
      recommendedAction: "retry_narrower",
    },
    executionPlan: {
      planId: "plan-1",
      sessionId: "session-1",
      turnId: "turn-1",
      mode: "chat",
      planningMode: "advisory",
      status: "ready",
      source: "planner",
      advisoryOnly: true,
      objective: "Find alternative current-release sources.",
      summary: "Check the top likely sources, skip blocked hosts, and summarize the confirmed release window.",
      steps: [
        {
          stepId: "step-1",
          index: 0,
          objective: "Search likely movie release sources.",
          status: "completed",
          parallelizable: false,
          summary: "Search completed with several viable sources.",
          suggestedTools: ["browser.search"],
        },
        {
          stepId: "step-2",
          index: 1,
          objective: "Open the best unblocked source and confirm release details.",
          status: "pending",
          parallelizable: false,
          durableRunId: "durable-child-2",
          childSessionId: "delegate-session-2",
          childTurnId: "delegate-turn-2",
          childRunId: "legacy-child-2",
          suggestedTools: ["browser.navigate", "browser.extract"],
        },
      ],
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:02.000Z",
    },
    loopGuard: {
      enabled: true,
      historySize: 8,
      events: [
        {
          eventId: "loop-1",
          detector: "repeated_same_call",
          severity: "warning",
          suppressed: false,
          message: "Repeated browser.navigate call detected.",
          repetitionCount: 2,
          historySize: 8,
          createdAt: "2026-03-08T00:00:03.000Z",
        },
      ],
    },
  };
}

describe("ChatTraceCard", () => {
  it("renders routing and browser diagnostics", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ChatTraceCard trace={makeTrace()} workspaceId="default" defaultCollapsed={false} />);
    });
    const text = renderer.root
      .findAllByType("p")
      .map((node) => node.children.join(" "))
      .join("\n")
      .replace(/\s+/g, " ")
      .trim();
    const fullText = collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();

    expect(text).toContain("Fallback reason: primary blocked by remote site");
    expect(text).toContain("Upstream API: openai-chat-completions");
    expect(text).toContain("Requested: openai · gpt-4.1-mini");
    expect(text).toContain("Effective: glm · glm-5");
    expect(text).toContain("Engine: Built-in browser (builtin)");
    expect(text).toContain("URL: https://www.movieinsider.com/movies");
    expect(text).toContain("HTTP status: 403");
    expect(text).toContain("Browser failure: remote_blocked");
    expect(text).toContain("Stored browser output as an artifact to keep live context compact.");
    expect(text).toContain("Next step: Retry with a narrower request");
    expect(text).toContain("Try the next viable source instead of retrying the blocked host.");
    expect(text).toContain(
      "Check the top likely sources, skip blocked hosts, and summarize the confirmed release window.",
    );
    expect(text).toContain("Open the best unblocked source and confirm release details.");
    expect(text).toContain("Status: pending");
    expect(text).toContain("Repeated browser.navigate call detected.");
    expect(fullText).toContain(
      "Lineage: durable durable-child-2 | child session delegate-session-2 | child turn delegate-turn-2 | deprecated childRunId legacy-child-2",
    );
    expect(
      renderer.root.findAll(
        (node) => typeof node.props.className === "string" && node.props.className.includes("chat-tool-artifact-badge"),
      ),
    ).toHaveLength(2);
    expect(
      renderer.root.findAllByType("button").some((button) => button.children.join("") === "Inspect raw artifact"),
    ).toBe(true);
  });

  it("surfaces requested versus effective routing in the collapsed header", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ChatTraceCard trace={makeTrace()} workspaceId="default" />);
    });
    const text = collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();

    expect(text).toContain("completed · glm · glm-5");
    expect(text).toContain("Requested openai · gpt-4.1-mini -> Effective glm · glm-5 · primary blocked by remote site");
  });

  it("renders per-turn runtime evidence and provider failure details", async () => {
    const trace = {
      ...makeTrace(),
      completion: {
        status: "complete",
        repaired: false,
        usage: {
          inputTokens: 1234,
          outputTokens: 56,
          cachedInputTokens: 78,
          costUsd: 0.00123,
          costSource: "estimated",
        },
        latencyMs: 987,
        providerCallCount: 2,
      },
      failure: {
        failureClass: "unknown",
        message: "Provider rejected the streamed response.",
        retryable: true,
        provider: {
          code: "rate_limit_exceeded",
          message: "Quota exceeded.",
          status: "failed",
          responseId: "resp-1",
          type: "rate_limit_error",
        },
      },
    } as unknown as ChatTurnTraceRecord;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ChatTraceCard trace={trace} workspaceId="default" defaultCollapsed={false} />);
    });
    const text = collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();

    expect(text).toContain("Provider error: rate_limit_exceeded - Quota exceeded.");
    expect(text).toContain("Runtime evidence");
    expect(text).toContain("Input tokens: 1234");
    expect(text).toContain("Output tokens: 56");
    expect(text).toContain("Cached input tokens: 78");
    expect(text).toContain("Cost: $0.001230 (estimated)");
    expect(text).toContain("Provider latency: 987ms");
    expect(text).toContain("Provider calls: 2");
  });

  it("toggles from a sparse collapsed trace into default routing and time fallbacks", async () => {
    const sparseTrace = {
      ...makeTrace(),
      status: "running",
      model: undefined,
      startedAt: "not-a-date",
      finishedAt: undefined,
      toolRuns: [],
      citations: [],
      routing: {
        liveDataIntent: false,
        fallbackUsed: false,
      },
      failure: undefined,
      executionPlan: undefined,
      loopGuard: undefined,
      orchestration: undefined,
    } as unknown as ChatTurnTraceRecord;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ChatTraceCard trace={sparseTrace} workspaceId="default" />);
    });
    expect(collectText(renderer.toJSON()).replace(/\s+/g, " ").trim()).toContain("running · model n/a · not-a-date");

    await act(async () => {
      renderer.root.findByType("button").props.onClick();
    });
    const text = collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
    expect(text).toContain("Hide trace");
    expect(text).toContain("Started: not-a-date");
    expect(text).toContain("Finished: n/a");
    expect(text).toContain("Live data intent: no");
    expect(text).toContain("Fallback used: no");
    expect(text).toContain("Fallback tiers attempted: none");
    expect(text).toContain("Requested: not recorded");
    expect(text).toContain("Effective: not recorded");
    expect(text).not.toContain("Runtime evidence");
  });

  it("renders citations, orchestration details, final URLs, and non-retry failures", async () => {
    const trace = {
      ...makeTrace(),
      failure: {
        failureClass: "policy_denied",
        message: "Policy stopped the action.",
        retryable: false,
      },
      toolRuns: [
        {
          toolRunId: "tool-final",
          turnId: "turn-1",
          sessionId: "session-1",
          toolName: "browser.open",
          status: "completed",
          startedAt: "2026-03-08T00:00:01.000Z",
          result: {
            url: "https://example.com/start",
            finalUrl: "https://example.com/final",
            engineLabel: "Browser",
            status: "200",
            results: [{ title: "One" }, { title: "Two" }],
          },
        },
      ],
      citations: [
        {
          citationId: "external",
          title: "External source",
          url: "https://example.com/final",
          snippet: "External snippet",
          knowledge: {
            sourceRef: "web:example",
            sectionLabel: "Release notes",
            retrievalMode: "full_text",
          },
        },
        {
          citationId: "local",
          title: undefined,
          url: "workspace://notes",
          snippet: "Local snippet",
          knowledge: {
            sourceRef: "workspace:notes",
            retrievalMode: "semantic",
          },
        },
      ],
      orchestration: {
        workflowTemplate: "review-loop",
        visibility: "operator_visible",
        status: "completed",
        finalSummary: "All delegated work finished.",
        routeDecision: {
          selectedRoles: ["Researcher", "QA"],
          specialistCandidates: [{ title: "Security reviewer", baseRole: "QA" }],
        },
        steps: [
          {
            stepId: "step-1",
            role: "Researcher",
            providerId: undefined,
            model: "glm-5",
            status: "completed",
            specialistTitle: "Evidence collector",
            specialistRole: undefined,
          },
        ],
      },
    } as unknown as ChatTurnTraceRecord;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ChatTraceCard trace={trace} workspaceId="default" defaultCollapsed={false} />);
    });
    const text = collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();

    expect(text).toContain("Failure class: policy_denied");
    expect(text).toContain("Retryable: no");
    expect(text).toContain("Final URL: https://example.com/final");
    expect(text).toContain("HTTP status: 200");
    expect(text).toContain("2 results returned.");
    expect(text).toContain("External source");
    expect(text).toContain("web:example · Release notes · full text");
    expect(text).toContain("source");
    expect(text).toContain("workspace:notes · retrieval");
    expect(text).toContain("review-loop · operator_visible · completed");
    expect(text).toContain("Researcher -> QA");
    expect(text).toContain("Specialists: Security reviewer (QA)");
    expect(text).toContain("All delegated work finished.");
    expect(text).toContain("provider auto · glm-5");
    expect(text).toContain("Specialist: Evidence collector");
    expect(text).toContain("specialist");
    expect(renderer.root.findByType("a").props.href).toBe("https://example.com/final");
  });

  it("keeps sparse citations and orchestration metadata readable without optional fields", async () => {
    const trace = {
      ...makeTrace(),
      model: undefined,
      routing: {
        liveDataIntent: false,
        fallbackUsed: true,
      },
      failure: {
        failureClass: "unknown",
        message: "No retry metadata was attached.",
      },
      toolRuns: [
        {
          toolRunId: "tool-sparse",
          turnId: "turn-1",
          sessionId: "session-1",
          toolName: "browser.open",
          status: "completed",
          startedAt: undefined,
          result: {
            url: "https://example.com/same",
            finalUrl: "https://example.com/same",
            engineLabel: "Browser",
            engineTier: "",
          },
        },
      ],
      citations: [
        {
          citationId: "citation-sparse",
        },
      ],
      orchestration: {
        workflowTemplate: "solo",
        visibility: "hidden",
        status: "running",
        routeDecision: {
          selectedRoles: [],
        },
        steps: [
          {
            stepId: "step-sparse",
            role: "Coder",
            status: "pending",
          },
        ],
      },
    } as unknown as ChatTurnTraceRecord;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ChatTraceCard trace={trace} workspaceId="default" defaultCollapsed={false} />);
    });
    const text = collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();

    expect(text).toContain("Requested auto -> Effective not recorded");
    expect(text).toContain("Retryable: yes");
    expect(text).toContain("source");
    expect(text).toContain("solo · hidden · running");
    expect(text).toContain("provider auto");
    expect(text).not.toContain("Final URL: https://example.com/same");
    expect(text).not.toContain("Specialists:");
  });
});
