import { describe, expect, it, vi } from "vitest";
import { enqueueAgentEndHook } from "./chat-turn-stream-events.js";

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
});
