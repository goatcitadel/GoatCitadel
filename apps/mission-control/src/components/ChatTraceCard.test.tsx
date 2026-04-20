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
      renderer = create(<ChatTraceCard trace={makeTrace()} defaultCollapsed={false} />);
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
      renderer = create(<ChatTraceCard trace={makeTrace()} />);
    });
    const text = collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();

    expect(text).toContain("completed · glm · glm-5");
    expect(text).toContain("Requested openai · gpt-4.1-mini -> Effective glm · glm-5 · primary blocked by remote site");
  });
});
