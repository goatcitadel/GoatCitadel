import { describe, expect, it, vi } from "vitest";
import { enqueueAgentEndHook, observeBeforeAssistantMessageWrite } from "./chat-turn-stream-events.js";

describe("chat turn stream events", () => {
  it("scopes agent-end delivery idempotency to the semantic turn status", () => {
    const enqueueAfterHooks = vi.fn();
    const host = {
      hooksService: {
        runInlineHooks: vi.fn(),
        enqueueAfterHooks,
      },
    };

    enqueueAgentEndHook(host, {
      workspaceId: "workspace-1",
      sessionId: "session-1",
      turnId: "turn-1",
      status: "waiting_for_approval",
      toolRunCount: 1,
      stream: true,
      repaired: false,
      approvalId: "approval-1",
    });
    enqueueAgentEndHook(host, {
      workspaceId: "workspace-1",
      sessionId: "session-1",
      turnId: "turn-1",
      status: "completed",
      toolRunCount: 1,
      stream: true,
      repaired: false,
    });

    expect(enqueueAfterHooks).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        trigger: "agent_end",
        entityType: "chat_turn",
        entityId: "turn-1",
        idempotencyDiscriminator: "waiting_for_approval",
      }),
    );
    expect(enqueueAfterHooks).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        trigger: "agent_end",
        entityType: "chat_turn",
        entityId: "turn-1",
        idempotencyDiscriminator: "completed",
      }),
    );
  });

  it("stops assistant finalization before a message write when the bounded finalization hook blocks", async () => {
    const runInlineHooks = vi.fn().mockResolvedValue({ blockedBy: { reason: "operator review required" } });
    const host = { hooksService: { runInlineHooks, enqueueAfterHooks: vi.fn() } } as never;

    await expect(
      observeBeforeAssistantMessageWrite(host, {
        workspaceId: "workspace-1",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "message-1",
        content: "Never leave this function as raw hook payload.",
        stream: true,
      }),
    ).rejects.toThrow("Agent finalization stopped by hook: operator review required");

    expect(runInlineHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "agent.finalize.before",
        entityId: "turn-1",
        payload: expect.objectContaining({ contentLength: 46 }),
      }),
    );
    expect(JSON.stringify(runInlineHooks.mock.calls)).not.toContain("Never leave this function as raw hook payload.");
  });
});
