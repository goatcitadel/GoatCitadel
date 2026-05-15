import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ChatCompletionResponse,
  ChatStreamChunkDraft,
  ChatTurnTraceRecord,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import { ChatAgentOrchestrator, type ChatAgentTurnInput } from "./chat-agent-orchestrator.js";
import { createMockStorage, createToolCatalog } from "./chat-agent-orchestrator-test-fixtures.js";

describe("ChatAgentOrchestrator status and approval persistence coverage", () => {
  it("persists Prompt Lab prefetch approval and finishes the stream without a message", async () => {
    const storage = createObservableStorage();
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>();
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "approval_required",
      policyReason: "file read requires operator approval",
      auditEventId: "audit-prefetch-approval",
      approvalId: "approval-prefetch-file-read",
      expiresAt: "2026-03-22T13:00:00.000Z",
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: storage.value as never,
      listToolCatalog: () => createToolCatalog(["file.read_range", "code.search"]),
      createChatCompletion,
      invokeTool,
    });

    const input = turnInput({
      sessionId: "sess-prefetch-approval",
      turnId: randomUUID(),
      userMessageId: "msg-prefetch-approval",
      content: [
        "## Prompt Lab Run Contract",
        "- Mode: cowork",
        "- Tool tier: explicit-tools",
        "- This is an explicit-tools evaluation. Use the tools requested in the prompt.",
        "- Required tool families: file/code tools",
        "",
        "## User Task",
        "Using file/code tools, inspect these local files only:",
        "- `apps/gateway/src/services/durable-run-service.ts`",
        "",
        "Cite the exact files used.",
      ].join("\n"),
      mode: "cowork",
      historyMessages: [],
    });
    input.historyMessages = [{ role: "user", content: input.content }];

    const chunks = await collectStream(orchestrator, input);

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "file.read_range",
        args: expect.objectContaining({
          path: "apps/gateway/src/services/durable-run-service.ts",
        }),
      }),
    );
    expect(storage.patch).toHaveBeenCalledWith(input.turnId, expect.objectContaining({ status: "waiting_for_tool" }));
    expect(storage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-prefetch-file-read",
        sessionId: input.sessionId,
        turnId: input.turnId,
        toolName: "file.read_range",
        status: "pending",
        expiresAt: "2026-03-22T13:00:00.000Z",
      }),
    );
    expect(chunks.some((chunk) => chunk.type === "message_done")).toBe(false);
    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "approval_required",
          approval: expect.objectContaining({
            approvalId: "approval-prefetch-file-read",
            toolName: "file.read_range",
          }),
        }),
      ]),
    );
    expect(finalTrace(chunks)).toMatchObject({
      status: "waiting_for_approval",
      failure: expect.objectContaining({
        failureClass: "approval_required",
        retryable: true,
      }),
    });
  });

  it("persists local filesystem probe approval before provider synthesis", async () => {
    const storage = createObservableStorage();
    const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>();
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "approval_required",
      policyReason: "local directory listing requires approval",
      auditEventId: "audit-local-probe-approval",
      approvalId: "approval-local-fs-list",
      expiresAt: "2026-03-22T13:30:00.000Z",
    });
    const orchestrator = new ChatAgentOrchestrator({
      storage: storage.value as never,
      listToolCatalog: () => createToolCatalog(["fs.list", "file.read_range"]),
      createChatCompletion,
      invokeTool,
    });

    const input = turnInput({
      sessionId: "sess-local-probe-approval",
      turnId: randomUUID(),
      userMessageId: "msg-local-probe-approval",
      content:
        "Can you verify whether you can access my local project files at `apps/gateway/src/services` before reading files?",
      mode: "code",
      historyMessages: [
        {
          role: "user",
          content:
            "Can you verify whether you can access my local project files at `apps/gateway/src/services` before reading files?",
        },
      ],
    });

    const result = await orchestrator.run(input);

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "fs.list",
        args: { path: "apps/gateway/src/services" },
      }),
    );
    expect(storage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-local-fs-list",
        sessionId: input.sessionId,
        turnId: input.turnId,
        toolName: "fs.list",
        status: "pending",
      }),
    );
    expect(result.assistantContent).toBe("");
    expect(result.requiresApproval).toEqual({
      approvalId: "approval-local-fs-list",
      toolName: "fs.list",
      reason: "Approval required by policy.",
      expiresAt: "2026-03-22T13:30:00.000Z",
    });
    expect(result.turnTrace).toMatchObject({
      status: "waiting_for_approval",
      failure: expect.objectContaining({ failureClass: "approval_required" }),
    });
  });
});

function createObservableStorage() {
  const value = createMockStorage() as {
    chatTurnTraces: {
      patch: (turnId: string, patch: Partial<ChatTurnTraceRecord>) => ChatTurnTraceRecord;
    };
    chatInlineApprovals: {
      upsert: (input: Record<string, unknown>) => unknown;
    };
  };
  const originalPatch = value.chatTurnTraces.patch.bind(value.chatTurnTraces);
  const patch = vi.fn((turnId: string, input: Partial<ChatTurnTraceRecord>) => originalPatch(turnId, input));
  const upsert = vi.fn();
  value.chatTurnTraces.patch = patch;
  value.chatInlineApprovals.upsert = upsert;
  return { value, patch, upsert };
}

async function collectStream(orchestrator: ChatAgentOrchestrator, input: ChatAgentTurnInput) {
  const chunks: ChatStreamChunkDraft[] = [];
  for await (const chunk of orchestrator.runStream(input)) {
    chunks.push(chunk);
  }
  return chunks;
}

function finalTrace(chunks: ChatStreamChunkDraft[]) {
  return chunks
    .filter((chunk) => chunk.type === "trace_update")
    .map((chunk) => chunk.trace)
    .at(-1);
}

function turnInput(overrides: Partial<ChatAgentTurnInput>): ChatAgentTurnInput {
  const content = overrides.content ?? "Use the available tool.";
  return {
    sessionId: "sess-status-persistence",
    turnId: "turn-status-persistence",
    userMessageId: "msg-status-persistence",
    content,
    mode: "chat",
    providerId: "glm",
    model: "glm-5",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "extended",
    toolAutonomy: "safe_auto",
    historyMessages: [{ role: "user", content }],
    ...overrides,
  };
}
