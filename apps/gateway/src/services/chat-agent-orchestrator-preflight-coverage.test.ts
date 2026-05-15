import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionResponse, ToolInvokeResult } from "@goatcitadel/contracts";
import { ChatAgentOrchestrator, type ChatAgentTurnInput } from "./chat-agent-orchestrator.js";
import { createMockStorage, createToolCatalog } from "./chat-agent-orchestrator-test-fixtures.js";

describe("ChatAgentOrchestrator tool preflight coverage", () => {
  it("persists blocked web tools without invoking runtime tools when web mode is off", async () => {
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const executeToolCall = createExecuteToolCall({ invokeTool });

    const result = await executeToolCall({
      input: turnInput({
        content: "Fetch https://example.com/latest and summarize it.",
        webMode: "off",
      }),
      turnId: "turn-web-off-preflight",
      toolName: "http.get",
      rawArgs: { url: "https://example.com/latest" },
    });

    expect(invokeTool).not.toHaveBeenCalled();
    expect(result.record).toMatchObject({
      toolName: "http.get",
      status: "blocked",
      error: "execution skipped: live web access is disabled because Web is set to Off for this chat",
    });
    expect(result.record.failureGuidance).toContain("Retry get");
    expect(result.chunk).toMatchObject({
      type: "tool_result",
      toolRun: expect.objectContaining({
        status: "blocked",
      }),
    });
  });

  it("blocks memory writes without explicit consent and infers safe memory lookup queries", async () => {
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-memory-search-1",
      result: { matches: [{ title: "Onboarding preference", content: "prefers concise status updates" }] },
    });
    const executeToolCall = createExecuteToolCall({ invokeTool });

    const blockedWrite = await executeToolCall({
      input: turnInput({
        content: "My preference is concise status updates.",
        memoryMode: "on",
      }),
      turnId: "turn-memory-write-blocked",
      toolName: "memory.write",
      rawArgs: {
        namespace: "preferences",
        title: "Status updates",
        content: "Prefers concise updates",
      },
    });

    expect(blockedWrite.record).toMatchObject({
      toolName: "memory.write",
      status: "blocked",
      error: "memory persistence requires explicit user consent; ask before saving long-term memory",
    });
    expect(invokeTool).not.toHaveBeenCalled();

    const lookup = await executeToolCall({
      input: turnInput({
        content: "What do you remember about my onboarding preference?",
        memoryMode: "on",
      }),
      turnId: "turn-memory-search-inferred",
      toolName: "memory.search",
      rawArgs: {},
    });

    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "memory.search",
        args: expect.objectContaining({
          query: expect.stringContaining("onboarding preference"),
        }),
      }),
    );
    expect(lookup.record).toMatchObject({
      toolName: "memory.search",
      status: "executed",
      result: expect.objectContaining({
        matches: expect.any(Array),
      }),
    });
  });

  it("distinguishes invalid local paths from missing generic required arguments", async () => {
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>();
    const executeToolCall = createExecuteToolCall({ invokeTool });

    const unsafePath = await executeToolCall({
      input: turnInput({
        content: "Search the code for config references.",
        mode: "code",
      }),
      turnId: "turn-unsafe-path",
      toolName: "code.search",
      rawArgs: { path: "code.search", query: "config" },
    });

    expect(unsafePath.record.status).toBe("blocked");
    expect(unsafePath.record.error).toContain("path was not a safe repository path");
    expect(unsafePath.record.failureGuidance).toContain("Retry search");

    const missingUrl = await executeToolCall({
      input: turnInput({
        content: "POST the status update.",
        webMode: "auto",
      }),
      turnId: "turn-missing-http-url",
      toolName: "http.post",
      rawArgs: {},
    });

    expect(missingUrl.record).toMatchObject({
      toolName: "http.post",
      status: "failed",
      error: "execution error: url is required",
    });
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("resolves approval expiry from storage when the tool result omits expiresAt", async () => {
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "approval_required",
      policyReason: "approval required",
      auditEventId: "audit-shell-approval-1",
      approvalId: "approval-shell-preflight-1",
    });
    const executeToolCall = createExecuteToolCall({ invokeTool });

    const result = await executeToolCall({
      input: turnInput({
        content: "Run a harmless shell command after approval.",
        mode: "code",
      }),
      turnId: "turn-approval-expiry",
      toolName: "shell.exec",
      rawArgs: { command: "pnpm --version" },
    });

    expect(result.approvalExpiresAt).toBe("2026-03-22T12:15:00.000Z");
    expect(result.record).toMatchObject({
      toolName: "shell.exec",
      status: "approval_required",
      approvalId: "approval-shell-preflight-1",
    });
  });
});

function createExecuteToolCall(input: { invokeTool: ReturnType<typeof vi.fn<() => Promise<ToolInvokeResult>>> }) {
  const orchestrator = new ChatAgentOrchestrator({
    storage: createMockStorage() as never,
    listToolCatalog: () => createToolCatalog(["browser.search", "http.get", "memory.search", "memory.write"]),
    createChatCompletion: vi.fn<() => Promise<ChatCompletionResponse>>(),
    invokeTool: input.invokeTool,
  });
  return (
    orchestrator as unknown as {
      executeToolCall(input: {
        input: ChatAgentTurnInput;
        turnId: string;
        toolName: string;
        rawArgs: Record<string, unknown>;
      }): Promise<{
        record: {
          toolName: string;
          status: string;
          error?: string;
          failureGuidance?: string;
          result?: Record<string, unknown>;
          approvalId?: string;
        };
        approvalExpiresAt?: string;
        chunk?: Record<string, unknown>;
      }>;
    }
  ).executeToolCall.bind(orchestrator);
}

function turnInput(overrides: Partial<ChatAgentTurnInput> = {}): ChatAgentTurnInput {
  const content = overrides.content ?? "Use the available tool.";
  return {
    sessionId: "sess-preflight-coverage",
    turnId: "turn-preflight-coverage",
    userMessageId: "msg-preflight-coverage",
    content,
    mode: "chat",
    providerId: "glm",
    model: "glm-5",
    webMode: "auto",
    memoryMode: "off",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    historyMessages: [{ role: "user", content }],
    ...overrides,
  };
}
