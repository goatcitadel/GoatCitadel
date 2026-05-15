import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionResponse, ToolInvokeRequest, ToolInvokeResult } from "@goatcitadel/contracts";
import { ChatAgentOrchestrator } from "./chat-agent-orchestrator.js";
import { createMockStorage, createToolCatalog } from "./chat-agent-orchestrator-test-fixtures.js";

describe("ChatAgentOrchestrator loop35 prompt-lab approval coverage", () => {
  it("persists approval state when prompt-lab repo search prefetch requires approval", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>();
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "approval_required",
      policyReason: "code search requires approval",
      auditEventId: "audit-loop35-search-approval",
      approvalId: "approval-loop35-search",
      expiresAt: "2026-03-22T14:00:00.000Z",
    });
    const orchestrator = createOrchestrator(createChatCompletion, invokeTool);
    const input = promptLabTurnInput(
      "sess-loop35-search-approval",
      [
        "Use file or code tools to inspect the skill import path, overlap detection behavior, and repo-managed skill provenance metadata.",
        "Summarize the concrete evidence an operator can review today and cite the exact files used.",
      ].join(" "),
    );

    const result = await orchestrator.run(input);

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "code.search_files",
        args: expect.objectContaining({ path: "." }),
      }),
    );
    expect(result.requiresApproval).toEqual({
      approvalId: "approval-loop35-search",
      toolName: "code.search_files",
      reason: "Approval required by policy.",
      expiresAt: "2026-03-22T14:00:00.000Z",
    });
    expect(result.turnTrace).toMatchObject({
      status: "waiting_for_approval",
      failure: expect.objectContaining({ failureClass: "approval_required" }),
    });
  });

  it("persists approval state when prompt-lab concrete read prefetch requires approval after search hits", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>();
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-loop35-search-hit",
        result: {
          matches: [
            { path: "apps/gateway/src/services/skill-import-service.ts", name: "skill-import-service.ts" },
            { path: "docs/SKILL_ADOPTION_MATRIX.md", name: "SKILL_ADOPTION_MATRIX.md" },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "approval_required",
        policyReason: "file read requires approval",
        auditEventId: "audit-loop35-read-approval",
        approvalId: "approval-loop35-read",
        expiresAt: "2026-03-22T14:30:00.000Z",
      });
    const orchestrator = createOrchestrator(createChatCompletion, invokeTool);
    const input = promptLabTurnInput(
      "sess-loop35-read-approval",
      [
        "Use file or code tools to inspect the skill import path, overlap detection behavior, and repo-managed skill provenance metadata.",
        "Summarize the concrete evidence an operator can review today and cite the exact files used.",
      ].join(" "),
    );

    const result = await orchestrator.run(input);

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "code.search_files",
      args: expect.objectContaining({ path: "." }),
    });
    expect(invokeTool.mock.calls[1]?.[0]).toMatchObject({
      toolName: "file.read_range",
      args: expect.objectContaining({
        path: "apps/gateway/src/services/skill-import-service.ts",
      }),
    });
    expect(result.requiresApproval).toEqual({
      approvalId: "approval-loop35-read",
      toolName: "file.read_range",
      reason: "Approval required by policy.",
      expiresAt: "2026-03-22T14:30:00.000Z",
    });
    expect(result.turnTrace).toMatchObject({
      status: "waiting_for_approval",
      failure: expect.objectContaining({ failureClass: "approval_required" }),
    });
  });

  it("persists approval state when live-data browser search requires approval", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>();
    const invokeTool = vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "approval_required",
      policyReason: "browser search requires approval",
      auditEventId: "audit-loop35-browser-search-approval",
      approvalId: "approval-loop35-browser-search",
      expiresAt: "2026-03-22T15:00:00.000Z",
    });
    const orchestrator = createOrchestrator(createChatCompletion, invokeTool, ["browser.search", "browser.navigate"]);

    const result = await orchestrator.run({
      sessionId: "sess-loop35-browser-search-approval",
      turnId: randomUUID(),
      userMessageId: "msg-loop35-browser-search-approval",
      content: "What are the latest news headlines today?",
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "What are the latest news headlines today?" }],
    });

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser.search",
        args: expect.objectContaining({ query: "What are the latest news headlines today" }),
      }),
    );
    expect(result.requiresApproval).toEqual({
      approvalId: "approval-loop35-browser-search",
      toolName: "browser.search",
      reason: "Approval required by policy.",
      expiresAt: "2026-03-22T15:00:00.000Z",
    });
    expect(result.turnTrace).toMatchObject({
      status: "waiting_for_approval",
      failure: expect.objectContaining({ failureClass: "approval_required" }),
    });
  });

  it("persists approval state when proactive live-data navigation requires approval after search evidence", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>();
    const invokeTool = vi
      .fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>()
      .mockResolvedValueOnce({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-loop35-browser-search-hit",
        result: {
          results: [
            {
              title: "Latest headlines today",
              url: "https://example.com/news/today",
              snippet: "Current top stories.",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        outcome: "approval_required",
        policyReason: "browser navigate requires approval",
        auditEventId: "audit-loop35-browser-navigate-approval",
        approvalId: "approval-loop35-browser-navigate",
        expiresAt: "2026-03-22T15:30:00.000Z",
      });
    const orchestrator = createOrchestrator(createChatCompletion, invokeTool, ["browser.search", "browser.navigate"]);

    const result = await orchestrator.run({
      sessionId: "sess-loop35-browser-navigate-approval",
      turnId: randomUUID(),
      userMessageId: "msg-loop35-browser-navigate-approval",
      content: "What are the latest news headlines today?",
      mode: "chat",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: "What are the latest news headlines today?" }],
    });

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(invokeTool.mock.calls[0]?.[0]).toMatchObject({
      toolName: "browser.search",
      args: expect.objectContaining({ query: "What are the latest news headlines today" }),
    });
    expect(invokeTool.mock.calls[1]?.[0]).toMatchObject({
      toolName: "browser.navigate",
      args: expect.objectContaining({ url: "https://example.com/news/today" }),
    });
    expect(result.requiresApproval).toEqual({
      approvalId: "approval-loop35-browser-navigate",
      toolName: "browser.navigate",
      reason: "Approval required by policy.",
      expiresAt: "2026-03-22T15:30:00.000Z",
    });
    expect(result.turnTrace).toMatchObject({
      status: "waiting_for_approval",
      failure: expect.objectContaining({ failureClass: "approval_required" }),
    });
  });
});

function createOrchestrator(
  createChatCompletion: () => Promise<ChatCompletionResponse>,
  invokeTool: (request: ToolInvokeRequest) => Promise<ToolInvokeResult>,
  toolNames = ["code.search_files", "file.read_range"],
): ChatAgentOrchestrator {
  return new ChatAgentOrchestrator({
    storage: createMockStorage() as never,
    listToolCatalog: () => createToolCatalog(toolNames),
    createChatCompletion,
    invokeTool,
  });
}

function promptLabTurnInput(sessionId: string, task: string) {
  const content = [
    "## Prompt Lab Run Contract",
    "- Mode: chat",
    "- Tool tier: explicit-tools",
    "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
    "- Required tool families: file/code tools",
    "",
    "## User Task",
    task,
  ].join("\n");
  return {
    sessionId,
    turnId: randomUUID(),
    userMessageId: `${sessionId}-message`,
    content,
    mode: "chat" as const,
    providerId: "openai",
    model: "gpt-5.4",
    webMode: "off" as const,
    memoryMode: "off" as const,
    thinkingLevel: "extended" as const,
    toolAutonomy: "safe_auto" as const,
    normalizationProfile: "prompt_pack_harness" as const,
    historyMessages: [{ role: "user" as const, content }],
  };
}
