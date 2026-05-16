import { describe, expect, it, vi } from "vitest";

vi.mock("./chat-turn-entry-service.js", () => ({
  agentSendChatMessage: vi.fn(async () => ({
    sessionId: "session-1",
    transport: "llm",
  })),
  agentSendChatMessageStream: vi.fn(async function* () {
    yield {
      type: "status",
      sessionId: "session-1",
      turnId: "turn-1",
      status: "started",
    };
  }),
  retryChatTurn: vi.fn(async () => ({
    sessionId: "session-1",
    transport: "llm",
  })),
  retryChatTurnStream: vi.fn(async function* () {}),
  editChatTurn: vi.fn(async () => ({
    sessionId: "session-1",
    transport: "llm",
  })),
  editChatTurnStream: vi.fn(async function* () {}),
  cancelChatTurn: vi.fn(async () => ({
    sessionId: "session-1",
    turnId: "turn-1",
    cancelled: true,
    trace: {
      turnId: "turn-1",
      sessionId: "session-1",
      status: "cancelled",
    },
  })),
  routePreflight: vi.fn(async () => ({
    selectionSource: "global",
    fallbackPolicy: "off",
    fallbackResult: "not_applicable",
    runtimeReachability: "not_checked",
    runtimeClass: "cloud",
    decision: {
      action: "send",
      issuedAt: "2026-04-24T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      selectionSource: "global",
      fallbackPolicy: "off",
      fallbackResult: "not_applicable",
      runtimeReachability: "not_checked",
      runtimeClass: "cloud",
      fingerprint: "route-fingerprint",
    },
  })),
  resumeAgentChatTurnStream: vi.fn(async function* () {
    yield {
      type: "status",
      sessionId: "session-1",
      turnId: "turn-1",
      status: "resumed",
    };
  }),
}));

import * as chatTurnEntryService from "./chat-turn-entry-service.js";
import { ChatTurnRuntimeService } from "./chat-turn-runtime-service.js";

describe("ChatTurnRuntimeService", () => {
  it("delegates send and retry operations through chat-turn entry helpers", async () => {
    const runtime = new ChatTurnRuntimeService({} as never);

    await runtime.agentSendChatMessage("session-1", { content: "hello" });
    await runtime.retryChatTurn("session-1", "turn-1", { content: "retry" });
    await runtime.routePreflight("session-1", { action: "send" });

    expect(chatTurnEntryService.agentSendChatMessage).toHaveBeenCalledWith(
      expect.anything(),
      "session-1",
      { content: "hello" },
      undefined,
    );
    expect(chatTurnEntryService.retryChatTurn).toHaveBeenCalledWith(expect.anything(), "session-1", "turn-1", {
      content: "retry",
    });
    expect(chatTurnEntryService.routePreflight).toHaveBeenCalledWith(expect.anything(), "session-1", {
      action: "send",
    });
  });

  it("delegates streaming resume through the runtime facade", async () => {
    const runtime = new ChatTurnRuntimeService({} as never);
    const chunks: Array<unknown> = [];

    for await (const chunk of runtime.resumeAgentChatTurnStream("session-1", "turn-1", "event-1")) {
      chunks.push(chunk);
    }

    expect(chatTurnEntryService.resumeAgentChatTurnStream).toHaveBeenCalledWith(
      expect.anything(),
      "session-1",
      "turn-1",
      "event-1",
    );
    expect(chunks).toEqual([
      expect.objectContaining({
        type: "status",
        sessionId: "session-1",
        turnId: "turn-1",
      }),
    ]);
  });
});
