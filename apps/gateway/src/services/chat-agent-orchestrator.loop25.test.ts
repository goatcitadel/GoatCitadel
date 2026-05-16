import { describe, expect, it, vi } from "vitest";
import type { ChatToolRunRecord, ToolInvokeRequest, ToolInvokeResult } from "@goatcitadel/contracts";
import type { ChatAgentTurnInput } from "./chat-agent-orchestrator.js";
import { createExecuteToolCallForTest } from "./chat-agent-orchestrator-test-fixtures.js";

describe("ChatAgentOrchestrator loop 25 runtime preflight coverage", () => {
  it("infers fs.stat path arguments from explicit local project prompts", async () => {
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-loop25-fs-stat",
      result: {
        path: "apps/gateway/src/services/chat-agent-orchestrator.ts",
        type: "file",
      },
    });
    const executeToolCall = createExecuteToolCall({ invokeTool });

    const result = await executeToolCall({
      input: turnInput({
        mode: "code",
        content: "Check metadata for `apps/gateway/src/services/chat-agent-orchestrator.ts` before editing.",
      }),
      turnId: "turn-loop25-fs-stat",
      toolName: "fs.stat",
      rawArgs: {},
      localFileIntent: true,
    });

    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "fs.stat",
        args: {
          path: "apps/gateway/src/services/chat-agent-orchestrator.ts",
        },
      }),
    );
    expect(result.record).toMatchObject({
      toolName: "fs.stat",
      status: "executed",
      result: expect.objectContaining({
        type: "file",
      }),
    });
  });

  it("fails fs.copy before invocation when generic required arguments cannot be inferred", async () => {
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>();
    const executeToolCall = createExecuteToolCall({ invokeTool });

    const result = await executeToolCall({
      input: turnInput({
        mode: "code",
        content: "Copy the artifact once the source and destination are known.",
      }),
      turnId: "turn-loop25-fs-copy-missing",
      toolName: "fs.copy",
      rawArgs: {},
      localFileIntent: true,
    });

    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.record).toMatchObject({
      toolName: "fs.copy",
      status: "failed",
      error: "execution error: from is required",
    });
    expect(result.chunk).toMatchObject({
      type: "tool_result",
      toolRun: expect.objectContaining({
        status: "failed",
      }),
    });
  });

  it("promotes repeated live-data browser searches into direct navigation from prior results", async () => {
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-loop25-promoted-navigate",
      result: {
        finalUrl: "https://example.com/goatcitadel/releases",
        title: "GoatCitadel release notes",
      },
    });
    const executeToolCall = createExecuteToolCall({ invokeTool });
    const priorToolRuns: ChatToolRunRecord[] = [
      {
        toolRunId: "prior-search-loop25",
        turnId: "turn-prior-loop25",
        sessionId: "sess-loop25",
        toolName: "browser.search",
        status: "executed",
        args: { query: "latest GoatCitadel release notes" },
        result: {
          results: [
            {
              title: "GoatCitadel release notes",
              url: "https://example.com/goatcitadel/releases",
              snippet: "Latest release notes and installer details.",
            },
          ],
        },
        startedAt: "2026-05-14T12:00:00.000Z",
        finishedAt: "2026-05-14T12:00:01.000Z",
      },
    ];

    const result = await executeToolCall({
      input: turnInput({
        content: "Find the latest GoatCitadel release notes and open the result.",
        webMode: "auto",
      }),
      turnId: "turn-loop25-promoted-search",
      toolName: "browser.search",
      rawArgs: { query: "latest GoatCitadel release notes" },
      priorToolRuns,
    });

    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser.navigate",
        args: {
          url: "https://example.com/goatcitadel/releases",
          maxChars: 6000,
        },
      }),
    );
    expect(result.record).toMatchObject({
      toolName: "browser.navigate",
      status: "executed",
    });
  });

  it("redirects search-result portal navigation to the strongest prior non-portal result", async () => {
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-loop25-redirect-search-portal",
      result: {
        finalUrl: "https://example.com/goatcitadel/runtime",
        title: "GoatCitadel runtime notes",
      },
    });
    const executeToolCall = createExecuteToolCall({ invokeTool });
    const priorToolRuns: ChatToolRunRecord[] = [
      {
        toolRunId: "prior-search-portal-loop25",
        turnId: "turn-prior-portal-loop25",
        sessionId: "sess-loop25",
        toolName: "browser.search",
        status: "executed",
        args: { query: "GoatCitadel runtime notes" },
        result: {
          results: [
            {
              title: "Search portal copy",
              url: "https://www.google.com/search?q=GoatCitadel+runtime+notes",
              snippet: "Search results page.",
            },
            {
              title: "GoatCitadel runtime notes",
              url: "https://example.com/goatcitadel/runtime",
              snippet: "Runtime notes and operator details.",
            },
          ],
        },
        startedAt: "2026-05-14T12:05:00.000Z",
        finishedAt: "2026-05-14T12:05:01.000Z",
      },
    ];

    const result = await executeToolCall({
      input: turnInput({
        content: "Open the GoatCitadel runtime notes result.",
        webMode: "auto",
      }),
      turnId: "turn-loop25-redirect-search-portal",
      toolName: "browser.navigate",
      rawArgs: { url: "https://www.google.com/search?q=GoatCitadel+runtime+notes" },
      priorToolRuns,
    });

    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser.navigate",
        args: {
          url: "https://example.com/goatcitadel/runtime",
        },
      }),
    );
    expect(result.record).toMatchObject({
      toolName: "browser.navigate",
      status: "executed",
    });
  });
});

function createExecuteToolCall(input: { invokeTool: (request: ToolInvokeRequest) => Promise<ToolInvokeResult> }) {
  return createExecuteToolCallForTest({
    invokeTool: input.invokeTool,
    toolNames: ["browser.search", "browser.navigate", "fs.stat", "fs.copy", "time.now"],
  });
}

function turnInput(overrides: Partial<ChatAgentTurnInput> = {}): ChatAgentTurnInput {
  const content = overrides.content ?? "Use the available tool.";
  return {
    sessionId: "sess-loop25",
    turnId: "turn-loop25",
    userMessageId: "msg-loop25",
    content,
    mode: "chat",
    providerId: "glm",
    model: "glm-5",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    historyMessages: [{ role: "user", content }],
    ...overrides,
  };
}
