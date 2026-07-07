import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ChatCompletionResponse,
  ChatStreamChunkDraft,
  ChatTurnTraceRecord,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import { ChatTurnAgentRunner, type ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import {
  createMockStorage,
  createToolCatalog,
  namedToolCallCompletion,
} from "./chat-turn-agent-runner-test-fixtures.js";

describe("ChatTurnAgentRunner status and approval persistence coverage", () => {
  it("soft-fails approval-required tool runs on Prompt Lab eval turns and completes with the model's answer", async () => {
    const storage = createObservableStorage();
    const modelAnswer =
      "The read of `apps/gateway/src/services/durable-run-service.ts` was approval-gated, so I could not inspect its contents directly. No file evidence is available for this turn.";
    const createChatCompletion = vi
      .fn<() => Promise<ChatCompletionResponse>>()
      .mockResolvedValueOnce(
        namedToolCallCompletion("file.read_range", {
          path: "apps/gateway/src/services/durable-run-service.ts",
          startLine: 1,
          endLine: 40,
        }),
      )
      .mockResolvedValue({
        model: "glm-5",
        choices: [{ index: 0, message: { role: "assistant", content: modelAnswer } }],
      });
    const invokeTool = vi.fn<() => Promise<ToolInvokeResult>>().mockResolvedValueOnce({
      outcome: "approval_required",
      policyReason: "file read requires operator approval",
      auditEventId: "audit-prefetch-approval",
      approvalId: "approval-prefetch-file-read",
      expiresAt: "2026-03-22T13:00:00.000Z",
    });
    const orchestrator = new ChatTurnAgentRunner({
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
      normalizationProfile: "prompt_pack_harness",
      historyMessages: [],
    });
    input.historyMessages = [{ role: "user", content: input.content }];

    const chunks = await collectStream(orchestrator, input);

    // Tool runs are model-initiated only: the single invocation comes from the
    // model's own tool call, not a forced prefetch on the model's behalf.
    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "file.read_range",
        args: expect.objectContaining({
          path: "apps/gateway/src/services/durable-run-service.ts",
        }),
      }),
    );
    // Approvals never park eval turns: nothing is persisted as pending and the
    // stream does not surface an approval_required pause.
    expect(storage.upsert).not.toHaveBeenCalled();
    expect(chunks.some((chunk) => chunk.type === "approval_required")).toBe(false);
    // The turn completes with the model's own text passed through verbatim.
    expect(chunks.some((chunk) => chunk.type === "message_done" && chunk.content === modelAnswer)).toBe(true);
    const trace = finalTrace(chunks);
    expect(trace?.status).not.toBe("waiting_for_approval");
    expect(trace).toMatchObject({ status: "completed" });
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
    const orchestrator = new ChatTurnAgentRunner({
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

async function collectStream(orchestrator: ChatTurnAgentRunner, input: ChatTurnAgentRunnerInput) {
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

function turnInput(overrides: Partial<ChatTurnAgentRunnerInput>): ChatTurnAgentRunnerInput {
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
