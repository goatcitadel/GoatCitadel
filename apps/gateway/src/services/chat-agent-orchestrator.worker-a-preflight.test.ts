import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionResponse, ToolInvokeResult } from "@goatcitadel/contracts";
import { ChatAgentOrchestrator } from "./chat-agent-orchestrator.js";
import {
  createMockStorage,
  createToolCatalog,
  namedToolCallCompletion,
} from "./chat-agent-orchestrator-test-fixtures.js";

describe("ChatAgentOrchestrator local and URL preflight inference", () => {
  it("infers file.find quoted search patterns without treating prose as a path", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("file.find", { path: "." }))
      .mockResolvedValueOnce(finalCompletion("Found approval resolution usage."));
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-file-find-inferred",
      result: {
        matches: [{ path: "apps/gateway/src/services/chat-proactive-service.ts", line: 2094 }],
      },
    });
    const orchestrator = createOrchestrator(createChatCompletion, invokeTool, ["file.find"]);

    const result = await orchestrator.run({
      sessionId: "sess-worker-a-file-find",
      turnId: randomUUID(),
      userMessageId: "msg-worker-a-file-find",
      content: "Find the text `approval resolved` across the whole repository.",
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Find the text `approval resolved` across the whole repository." }],
    });

    expect(result.assistantContent).toContain("Found approval resolution usage");
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "file.find",
        args: {
          path: ".",
          pattern: "approval resolved",
        },
      }),
    );
  });

  it("infers directory search roots for code.search_files without treating directories as filenames", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("code.search_files", {}))
      .mockResolvedValueOnce(finalCompletion("Listed matching service files."));
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-code-search-files-directory",
      result: {
        files: ["apps/gateway/src/services/chat-agent-orchestrator.ts"],
      },
    });
    const orchestrator = createOrchestrator(createChatCompletion, invokeTool, ["code.search_files"]);

    await orchestrator.run({
      sessionId: "sess-worker-a-code-search-files",
      turnId: randomUUID(),
      userMessageId: "msg-worker-a-code-search-files",
      content: "Search local folder `apps/gateway/src/services/` for matching files.",
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        { role: "user", content: "Search local folder `apps/gateway/src/services/` for matching files." },
      ],
    });

    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "code.search_files",
        args: {
          path: "apps/gateway/src/services/",
          query: ".",
        },
      }),
    );
  });

  it("infers http.get URLs from prompt text before invoking the tool", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("http.get", {}))
      .mockResolvedValueOnce(finalCompletion("Fetched the requested URL."));
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-http-get-inferred",
      result: {
        status: 200,
        url: "https://example.com/docs",
      },
    });
    const orchestrator = createOrchestrator(createChatCompletion, invokeTool, ["http.get"]);

    await orchestrator.run({
      sessionId: "sess-worker-a-http-get",
      turnId: randomUUID(),
      userMessageId: "msg-worker-a-http-get",
      content: "Fetch https://example.com/docs and summarize the response.",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Fetch https://example.com/docs and summarize the response." }],
    });

    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "http.get",
        args: {
          url: "https://example.com/docs",
        },
      }),
    );
  });

  it("infers file.find grep-style patterns from prose requests", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("file.find", { path: "." }))
      .mockResolvedValueOnce(finalCompletion("Matched routePreflight references."));
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-file-find-grep-pattern",
      result: {
        matches: [{ path: "apps/gateway/src/services/chat-agent-orchestrator.ts", line: 3981 }],
      },
    });
    const orchestrator = createOrchestrator(createChatCompletion, invokeTool, ["file.find"]);

    await orchestrator.run({
      sessionId: "sess-worker-a-file-find-grep",
      turnId: randomUUID(),
      userMessageId: "msg-worker-a-file-find-grep",
      content: "Grep routePreflight across the repository.",
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Grep routePreflight across the repository." }],
    });

    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "file.find",
        args: {
          path: ".",
          pattern: "routePreflight",
        },
      }),
    );
  });

  it("defaults broad code.search_files prompts to repository-wide file listing", async () => {
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(namedToolCallCompletion("code.search_files", {}))
      .mockResolvedValueOnce(finalCompletion("Listed source files."));
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "executed",
      policyReason: "allowed",
      auditEventId: "audit-code-search-files-broad",
      result: {
        files: ["apps/gateway/src/services/chat-agent-orchestrator.ts"],
      },
    });
    const orchestrator = createOrchestrator(createChatCompletion, invokeTool, ["code.search_files"]);

    await orchestrator.run({
      sessionId: "sess-worker-a-code-search-files-broad",
      turnId: randomUUID(),
      userMessageId: "msg-worker-a-code-search-files-broad",
      content: "Search all source files before the refactor.",
      mode: "code",
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "Search all source files before the refactor." }],
    });

    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "code.search_files",
        args: {
          path: ".",
          query: ".",
        },
      }),
    );
  });

  it("persists approval state when deterministic time lookup requires approval", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>();
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValue({
      outcome: "approval_required",
      policyReason: "approval_required",
      auditEventId: "audit-time-now-approval",
      approvalId: "approval-time-now-1",
    });
    const orchestrator = createOrchestrator(createChatCompletion, invokeTool, ["time.now"]);

    const result = await orchestrator.run({
      sessionId: "sess-worker-a-time-approval",
      turnId: randomUUID(),
      userMessageId: "msg-worker-a-time-approval",
      content: "What time is it right now?",
      mode: "chat",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "What time is it right now?" }],
    });

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(invokeTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: "time.now", args: {} }));
    expect(result.requiresApproval).toEqual({
      approvalId: "approval-time-now-1",
      toolName: "time.now",
      reason: "Approval required by policy.",
      expiresAt: "2026-03-22T12:15:00.000Z",
    });
    expect(result.turnTrace).toMatchObject({
      status: "waiting_for_approval",
      failure: expect.objectContaining({ failureClass: "approval_required" }),
    });
  });
});

function createOrchestrator(
  createChatCompletion: () => Promise<ChatCompletionResponse>,
  invokeTool: () => Promise<ToolInvokeResult>,
  toolNames: string[],
): ChatAgentOrchestrator {
  return new ChatAgentOrchestrator({
    storage: createMockStorage() as never,
    listToolCatalog: () => createToolCatalog(toolNames),
    createChatCompletion,
    invokeTool,
  });
}

function finalCompletion(content: string): ChatCompletionResponse {
  return {
    model: "glm-5",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
      },
    ],
  };
}
