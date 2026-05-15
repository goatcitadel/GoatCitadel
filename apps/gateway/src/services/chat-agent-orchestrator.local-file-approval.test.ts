import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionRequest, ChatCompletionResponse, ToolInvokeResult } from "@goatcitadel/contracts";
import { ChatAgentOrchestrator } from "./chat-agent-orchestrator.js";
import { createMockStorage, createToolCatalog } from "./chat-agent-orchestrator-test-fixtures.js";

describe("ChatAgentOrchestrator local file approval behavior", () => {
  it("turns local file access follow-ups into an approval-producing filesystem probe", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>();
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "approval_required",
      policyReason: "file access outside trusted roots requires approval",
      auditEventId: "audit-local-file-access-approval-1",
      approvalId: "approval-local-file-access-1",
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["fs.list", "fs.stat", "file.find", "time.now"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-local-file-access-follow-up-1",
      turnId: randomUUID(),
      userMessageId: "msg-local-file-access-follow-up-1",
      content: "What do you need for local file access?",
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content: "I want you to organize the files in C:\\Users\\spurn\\Desktop\\Chrome Downloads",
        },
        {
          role: "assistant",
          content: "I could not actually organize that folder from this environment.",
        },
        {
          role: "user",
          content: "What do you need for local file access?",
        },
      ],
    });

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "fs.list",
        args: {
          path: "C:\\Users\\spurn\\Desktop\\Chrome Downloads",
        },
      }),
    );
    expect(result.turnTrace.status).toBe("waiting_for_approval");
    expect(result.requiresApproval).toMatchObject({
      approvalId: "approval-local-file-access-1",
      toolName: "fs.list",
    });
    expect(result.turnTrace.toolRuns).toEqual([
      expect.objectContaining({
        toolName: "fs.list",
        status: "approval_required",
        approvalId: "approval-local-file-access-1",
      }),
    ]);
  });

  it("answers local file access checks from a successful filesystem probe", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>();
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "executed",
      policyReason: "allowlisted",
      auditEventId: "audit-local-file-access-success-1",
      result: {
        items: [
          { name: "download-a.zip", type: "file" },
          { name: "screenshots", type: "directory" },
        ],
      },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["fs.list", "fs.stat", "file.find", "time.now"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-local-file-access-success-1",
      turnId: randomUUID(),
      userMessageId: "msg-local-file-access-success-1",
      content: "What do you need for local file access to `C:\\Users\\spurn\\Desktop\\Chrome Downloads`?",
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content: "What do you need for local file access to `C:\\Users\\spurn\\Desktop\\Chrome Downloads`?",
        },
      ],
    });

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "fs.list",
        args: {
          path: "C:\\Users\\spurn\\Desktop\\Chrome Downloads",
        },
      }),
    );
    expect(result.assistantContent).toContain(
      "I have local file access to `C:\\Users\\spurn\\Desktop\\Chrome Downloads`",
    );
    expect(result.assistantContent).toContain("I can see 2 items there.");
    expect(result.turnTrace.status).toBe("completed");
    expect(result.turnTrace.toolRuns).toEqual([
      expect.objectContaining({
        toolName: "fs.list",
        status: "executed",
      }),
    ]);
  });

  it("returns a bounded local file probe failure instead of falling into model completion", async () => {
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>();
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "blocked",
      policyReason: "path unavailable",
      auditEventId: "audit-local-file-access-failure-1",
      result: { error: "ENOENT: folder not found" },
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["fs.list", "fs.stat", "file.find", "time.now"]),
      createChatCompletion,
      invokeTool,
    });

    const result = await orchestrator.run({
      sessionId: "sess-local-file-access-failure-1",
      turnId: randomUUID(),
      userMessageId: "msg-local-file-access-failure-1",
      content: "Please verify whether you can access C:\\Users\\spurn\\Desktop\\Missing Folder before organizing it.",
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [
        {
          role: "user",
          content:
            "Please verify whether you can access C:\\Users\\spurn\\Desktop\\Missing Folder before organizing it.",
        },
      ],
    });

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(result.assistantContent).toContain("I tried to check access to `C:\\Users\\spurn\\Desktop\\Missing Folder`");
    expect(result.assistantContent).toContain("path unavailable");
    expect(result.turnTrace.toolRuns).toEqual([
      expect.objectContaining({
        toolName: "fs.list",
        status: "blocked",
        error: "path unavailable",
      }),
    ]);
  });

  it("keeps filesystem tools visible for delegated Cowork steps that contain explicit local paths", async () => {
    const delegatedPrompt = [
      "Delegated role: Worker",
      "",
      "Parent objective: I want you to organize the files in C:\\Users\\spurn\\Desktop\\Chrome Downloads",
      "",
      "Current step objective: Inspect the target folder and propose the safe organization steps.",
      "",
      "Suggested tools: file.find",
      "",
      "Produce only the delegated output for this step.",
    ].join("\n");
    const createChatCompletion = vi.fn(async (request: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
      const tools = JSON.stringify(request.tools ?? []);
      expect(tools).toContain("fs_list");
      expect(tools).toContain("file_find");
      return {
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [
                "## Worker",
                "- I need to list the target folder before moving anything.",
                "",
                "## Synthesis",
                "- The delegated step should start with a filesystem listing.",
              ].join("\n"),
            },
          },
        ],
      };
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: createMockStorage() as never,
      listToolCatalog: () => createToolCatalog(["fs.list", "fs.stat", "file.find", "browser.search", "time.now"]),
      createChatCompletion,
      invokeTool: vi.fn(),
    });

    const result = await orchestrator.run({
      sessionId: "sess-delegated-local-file-tools-1",
      turnId: randomUUID(),
      userMessageId: "msg-delegated-local-file-tools-1",
      content: delegatedPrompt,
      mode: "cowork",
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "off",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      historyMessages: [{ role: "user", content: delegatedPrompt }],
    });

    expect(createChatCompletion).toHaveBeenCalled();
    expect(result.turnTrace.status).toBe("completed");
  });
});
