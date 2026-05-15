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
  retryChatTurnStream: vi.fn(async function* () {
    yield {
      type: "status",
      sessionId: "session-1",
      turnId: "turn-1",
      status: "retrying",
    };
  }),
  editChatTurn: vi.fn(async () => ({
    sessionId: "session-1",
    transport: "llm",
    turnId: "turn-edited",
  })),
  editChatTurnStream: vi.fn(async function* () {
    yield {
      type: "status",
      sessionId: "session-1",
      turnId: "turn-edited",
      status: "editing",
    };
  }),
  cancelChatTurn: vi.fn(async () => ({
    sessionId: "session-1",
    turnId: "turn-1",
    cancelled: true,
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
  resumeAgentChatTurnStream: vi.fn(async function* () {}),
}));

import * as chatTurnEntryService from "./chat-turn-entry-service.js";
import { ChatTurnRuntimeService } from "./chat-turn-runtime-service.js";

describe("ChatTurnRuntimeService loop 31 facade coverage", () => {
  it("delegates streaming send, retry, and edit calls through the bounded host", async () => {
    const host = { marker: "runtime-host" } as never;
    const runtime = new ChatTurnRuntimeService(host);
    const streamed = [];

    for await (const chunk of runtime.agentSendChatMessageStream("session-1", { content: "hello" })) {
      streamed.push(chunk);
    }
    for await (const chunk of runtime.retryChatTurnStream("session-1", "turn-1")) {
      streamed.push(chunk);
    }
    for await (const chunk of runtime.editChatTurnStream("session-1", "turn-1", { content: "edited" })) {
      streamed.push(chunk);
    }

    expect(chatTurnEntryService.agentSendChatMessageStream).toHaveBeenCalledWith(host, "session-1", {
      content: "hello",
    });
    expect(chatTurnEntryService.retryChatTurnStream).toHaveBeenCalledWith(host, "session-1", "turn-1", {});
    expect(chatTurnEntryService.editChatTurnStream).toHaveBeenCalledWith(host, "session-1", "turn-1", {
      content: "edited",
    });
    expect(streamed.map((chunk) => chunk.status)).toEqual(["started", "retrying", "editing"]);
  });

  it("delegates edit and cancellation requests without altering caller metadata", async () => {
    const host = { marker: "runtime-host" } as never;
    const runtime = new ChatTurnRuntimeService(host);

    await expect(runtime.editChatTurn("session-1", "turn-1", { content: "replace me" })).resolves.toMatchObject({
      turnId: "turn-edited",
    });
    await expect(runtime.cancelChatTurn("session-1", "turn-1", "operator")).resolves.toMatchObject({
      cancelled: true,
    });

    expect(chatTurnEntryService.editChatTurn).toHaveBeenCalledWith(host, "session-1", "turn-1", {
      content: "replace me",
    });
    expect(chatTurnEntryService.cancelChatTurn).toHaveBeenCalledWith(host, "session-1", "turn-1", "operator");
  });
});
