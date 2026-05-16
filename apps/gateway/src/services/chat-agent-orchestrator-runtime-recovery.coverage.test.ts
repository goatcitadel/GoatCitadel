import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionResponse, ToolInvokeRequest, ToolInvokeResult } from "@goatcitadel/contracts";
import {
  ChatAgentOrchestrator,
  type ChatAgentOrchestratorDeps,
  type ChatAgentTurnInput,
} from "./chat-agent-orchestrator.js";
import {
  createExecuteToolCallForTest,
  createMockStorage,
  createToolCatalog,
} from "./chat-agent-orchestrator-test-fixtures.js";

describe("ChatAgentOrchestrator runtime recovery coverage", () => {
  it("returns deterministic partial extraction output when final synthesis fails after tool evidence", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce({
        model: "glm-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
            },
          },
        ],
      })
      .mockRejectedValue(new Error("synthesis timeout"));
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-extraction-search-1",
      result: {
        results: [
          {
            title: "GoatCitadel release notes",
            url: "https://example.com/goatcitadel/releases",
            snippet: "Release notes and installer details.",
          },
        ],
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["browser.search"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run(
      turnInput({
        sessionId: "sess-extraction-fallback-1",
        content: "Use web lookup to extract a JSON array with title and URL for the latest GoatCitadel release notes.",
        webMode: "auto",
      }),
    );

    expect(result.assistantContent).toContain("Recovered items (partial)");
    expect(result.assistantContent).toContain("https://example.com/goatcitadel/releases");
    expect(result.turnTrace.status).toBe("completed");
  });

  it("infers code.search_files path and query from an explicit file prompt", async () => {
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-search-files-inference-1",
      result: { files: ["apps/gateway/src/routes/chat.messages.ts"] },
    });
    const executeToolCall = createExecuteToolCall({ invokeTool });

    const result = await executeToolCall({
      input: turnInput({
        mode: "code",
        content: "Find files near `apps/gateway/src/routes/chat.messages.ts` before editing route coverage.",
      }),
      turnId: "turn-search-files-inference",
      toolName: "code.search_files",
      rawArgs: {},
      localFileIntent: true,
    });

    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "code.search_files",
        args: {
          path: "apps/gateway/src/routes",
          query: "chat.messages.ts",
        },
      }),
    );
    expect(result.record.status).toBe("executed");
  });

  it("surfaces approval when the safe write fallback path also requires approval", async () => {
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "blocked",
        policyReason: "outside write jail",
        auditEventId: "audit-write-original-blocked",
        result: { blocked: true },
      })
      .mockResolvedValueOnce({
        outcome: "approval_required",
        policyReason: "fallback path requires approval",
        auditEventId: "audit-write-fallback-approval",
        approvalId: "approval-safe-write-fallback-1",
        expiresAt: "2026-03-22T12:30:00.000Z",
      });
    const executeToolCall = createExecuteToolCall({ invokeTool });

    const result = await executeToolCall({
      input: turnInput({
        sessionId: "sess-write-approval",
        mode: "code",
        content: "Save Draft.md in the local workspace.",
      }),
      turnId: "turn-write-approval",
      toolName: "fs.write",
      rawArgs: { path: "Draft.md", content: "hello" },
      localFileIntent: true,
    });

    expect(result.record.status).toBe("approval_required");
    expect(result.record.approvalId).toBe("approval-safe-write-fallback-1");
    expect(result.record.result).toMatchObject({
      fallbackPath: "./workspace/goatcitadel_out/draft-sess-write-approval.md",
    });
    expect(result.approvalExpiresAt).toBe("2026-03-22T12:30:00.000Z");
  });

  it("keeps the original write blocked when fallback write also fails", async () => {
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "blocked",
        policyReason: "outside write jail",
        auditEventId: "audit-write-original-denied",
        result: { blocked: true },
      })
      .mockResolvedValueOnce({
        outcome: "blocked",
        policyReason: "fallback path denied",
        auditEventId: "audit-write-fallback-denied",
        result: { denied: true },
      });
    const executeToolCall = createExecuteToolCall({ invokeTool });

    const result = await executeToolCall({
      input: turnInput({
        sessionId: "sess-write-denied",
        mode: "code",
        content: "Save Draft.md in the local workspace.",
      }),
      turnId: "turn-write-denied",
      toolName: "fs.write",
      rawArgs: { path: "Draft.md", content: "hello" },
      localFileIntent: true,
    });

    expect(result.record.status).toBe("blocked");
    expect(result.record.error).toContain("outside write jail");
    expect(result.record.error).toContain(
      "fallback path attempted: ./workspace/goatcitadel_out/draft-sess-write-denied.md",
    );
    expect(result.record.error).toContain("fallback path denied");
    expect(result.record.result).toEqual({ denied: true });
  });

  it("persists oversized tool output artifacts before storing the compact turn result", async () => {
    const largeText = "artifact text ".repeat(1_100);
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-large-browser-output",
      result: {
        url: "https://example.com/report",
        text: largeText,
      },
    });
    const persistToolArtifact = vi.fn<NonNullable<ChatAgentOrchestratorDeps["persistToolArtifact"]>>(async (input) => ({
      artifactId: "artifact-large-browser-output",
      storageRelPath: "artifacts/chat/large-browser-output.txt",
      byteLength: input.content.length,
      contentType: input.contentType,
      snippet: input.snippet,
    }));
    const executeToolCall = createExecuteToolCall({ invokeTool, persistToolArtifact });

    const result = await executeToolCall({
      input: turnInput({
        content: "Interact with https://example.com/report and summarize the page.",
        webMode: "auto",
      }),
      turnId: "turn-large-browser-output",
      toolName: "browser.interact",
      rawArgs: { url: "https://example.com/report", steps: [{ action: "extractText" }] },
    });

    expect(persistToolArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser.interact",
        content: largeText,
        contentType: "text/plain; charset=utf-8",
      }),
    );
    expect(result.record.result).toMatchObject({
      artifactId: "artifact-large-browser-output",
      artifactPath: "artifacts/chat/large-browser-output.txt",
      storedAsArtifact: true,
      virtualized: true,
    });
    expect(String((result.record.result as { text?: string }).text).length).toBeLessThan(largeText.length);
  });
});

function createExecuteToolCall(input: {
  invokeTool: (request: ToolInvokeRequest) => Promise<ToolInvokeResult>;
  persistToolArtifact?: NonNullable<ChatAgentOrchestratorDeps["persistToolArtifact"]>;
}) {
  return createExecuteToolCallForTest({
    invokeTool: input.invokeTool,
    toolNames: ["browser.search", "browser.interact", "code.search_files", "fs.write", "time.now"],
    persistToolArtifact: input.persistToolArtifact,
  });
}

function turnInput(overrides: Partial<ChatAgentTurnInput> = {}): ChatAgentTurnInput {
  const content = overrides.content ?? "Use the available tool.";
  return {
    sessionId: "sess-runtime-recovery",
    turnId: randomUUID(),
    userMessageId: "msg-runtime-recovery",
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
