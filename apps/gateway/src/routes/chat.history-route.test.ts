import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { NotFoundError, type ChatMessageRecord } from "@goatcitadel/contracts";

import { registerChatMessageRoutes } from "./chat.messages.js";

function captureHistoryHandler(services: Record<string, unknown>) {
  const getHandlers = new Map<string, (request: any, reply: any) => Promise<unknown>>();
  const fastify = {
    services,
    // Routes may register with an access-class options object before the
    // handler (`fastify.get(url, options, handler)`); capture the last argument.
    get: vi.fn((path: string, ...rest: Array<(request: any, reply: any) => Promise<unknown>>) => {
      getHandlers.set(path, rest[rest.length - 1]);
    }),
    post: vi.fn(),
  };
  registerChatMessageRoutes(fastify as never);
  return getHandlers.get("/api/v1/chat/sessions/:sessionId/history")!;
}

function replyHarness() {
  const state = { statusCode: 200, headers: {} as Record<string, string>, body: undefined as unknown };
  const reply = {
    header: vi.fn((name: string, value: string) => {
      state.headers[name] = value;
      return reply;
    }),
    code: vi.fn((statusCode: number) => {
      state.statusCode = statusCode;
      return reply;
    }),
    send: vi.fn((body: unknown) => {
      state.body = body;
      return body;
    }),
  };
  return { reply, state };
}

function message(messageId: string, content: string): ChatMessageRecord {
  return {
    messageId,
    sessionId: "session-1",
    role: "assistant",
    actorType: "agent",
    actorId: "assistant",
    content,
    parts: [{ type: "text", text: "Bearer abcdefghijklmnopqrstuvwxyz" }],
    timestamp: "2026-07-13T00:00:00.000Z",
  };
}

describe("GET chat history route", () => {
  it("dispatches exact anchor identity, redacts before capping, and forbids caching", async () => {
    const readChatHistoryWindow = vi.fn(async () => ({
      anchor: {
        workspaceId: "workspace-1",
        sessionId: "session-1",
        messageId: "message-7",
        sequence: 7,
        state: "found" as const,
      },
      items: [
        {
          sequence: 7,
          message: message("message-7", "Bearer abcdefghijklmnopqrstuvwxyz"),
          isAnchor: true,
        },
      ],
      snapshotMaxSequence: 10,
      hasOlder: false,
      hasNewer: false,
    }));
    const handler = captureHistoryHandler({ chatMessages: { readChatHistoryWindow } });
    const { reply, state } = replyHarness();

    await handler(
      {
        params: { sessionId: "session-1" },
        query: {
          workspaceId: "workspace-1",
          messageId: "message-7",
          sequence: "7",
          maxBytes: "4096",
        },
      },
      reply,
    );

    expect(readChatHistoryWindow).toHaveBeenCalledWith(
      { workspaceId: "workspace-1", sessionId: "session-1", messageId: "message-7", sequence: 7 },
      21,
    );
    expect(state.headers).toMatchObject({ "cache-control": "private, no-store", pragma: "no-cache" });
    expect(JSON.stringify(state.body)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(state.body).toMatchObject({ anchor: { state: "found" }, items: [{ isAnchor: true }] });
  });

  it("dispatches exact continuation identity and caps the returned page", async () => {
    const readChatHistoryContinuation = vi.fn(async () => ({
      direction: "newer" as const,
      cursorState: "valid" as const,
      items: [
        { sequence: 8, message: message("message-8", "😀".repeat(6_000)), isAnchor: false },
        { sequence: 9, message: message("message-9", "later"), isAnchor: false },
      ],
      snapshotMaxSequence: 10,
      hasMore: false,
    }));
    const handler = captureHistoryHandler({ chatMessages: { readChatHistoryContinuation } });
    const { reply, state } = replyHarness();

    await handler(
      {
        params: { sessionId: "session-1" },
        query: {
          workspaceId: "workspace-1",
          direction: "newer",
          cursor: "message-7",
          cursorSequence: "7",
          snapshotMaxSequence: "10",
          maxBytes: "2048",
        },
      },
      reply,
    );

    expect(readChatHistoryContinuation).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      direction: "newer",
      cursorMessageId: "message-7",
      cursorSequence: 7,
      snapshotMaxSequence: 10,
      limit: 21,
    });
    expect(state.body).toMatchObject({ truncated: true, contentTruncated: true, hasMore: true });
    expect(Buffer.byteLength(JSON.stringify((state.body as any).items), "utf8")).toBeLessThanOrEqual(2_048);
  });

  it("returns the same 404 boundary for an unauthorized or missing session", async () => {
    const readChatHistoryWindow = vi.fn(async () => {
      throw new NotFoundError({ entity: "Chat session", id: "session-foreign" });
    });
    const handler = captureHistoryHandler({ chatMessages: { readChatHistoryWindow } });
    const { reply, state } = replyHarness();
    await handler(
      {
        params: { sessionId: "session-foreign" },
        query: { workspaceId: "workspace-1", messageId: "message-1", sequence: "1" },
      },
      reply,
    );
    expect(state.statusCode).toBe(404);
    expect(state.headers["cache-control"]).toBe("private, no-store");
  });

  it("rejects mixed anchor and cursor parameters before dispatch", async () => {
    const readChatHistoryWindow = vi.fn();
    const handler = captureHistoryHandler({ chatMessages: { readChatHistoryWindow } });
    const { reply, state } = replyHarness();
    await handler(
      {
        params: { sessionId: "session-1" },
        query: {
          workspaceId: "workspace-1",
          messageId: "message-1",
          sequence: "1",
          cursor: "message-0",
        },
      },
      reply,
    );
    expect(state.statusCode).toBe(400);
    expect(readChatHistoryWindow).not.toHaveBeenCalled();
  });

  it("rejects a byte budget below the documented 1024-byte minimum", async () => {
    const readChatHistoryWindow = vi.fn();
    const handler = captureHistoryHandler({ chatMessages: { readChatHistoryWindow } });
    const { reply, state } = replyHarness();
    await handler(
      {
        params: { sessionId: "session-1" },
        query: {
          workspaceId: "workspace-1",
          messageId: "message-1",
          sequence: "1",
          maxBytes: "512",
        },
      },
      reply,
    );
    expect(state.statusCode).toBe(400);
    expect(readChatHistoryWindow).not.toHaveBeenCalled();
  });

  it("rejects an anchored legacy row whose minimal identity cannot fit the byte budget", async () => {
    const oversizedMessageId = "m".repeat(1_500);
    const readChatHistoryWindow = vi.fn(async () => ({
      anchor: {
        workspaceId: "workspace-1",
        sessionId: "session-1",
        messageId: oversizedMessageId,
        sequence: 1,
        state: "found" as const,
      },
      items: [{ sequence: 1, message: message(oversizedMessageId, "legacy content"), isAnchor: true }],
      snapshotMaxSequence: 1,
      hasOlder: false,
      hasNewer: false,
    }));
    const handler = captureHistoryHandler({ chatMessages: { readChatHistoryWindow } });
    const { reply, state } = replyHarness();

    await handler(
      {
        params: { sessionId: "session-1" },
        query: {
          workspaceId: "workspace-1",
          messageId: oversizedMessageId,
          sequence: "1",
          maxBytes: "1024",
        },
      },
      reply,
    );

    expect(state.statusCode).toBe(400);
    expect(state.body).toMatchObject({ error: expect.stringMatching(/identity metadata exceeds maxBytes/) });
  });

  it("rejects a continuation legacy row whose minimal identity cannot fit the byte budget", async () => {
    const oversizedMessageId = "m".repeat(1_500);
    const readChatHistoryContinuation = vi.fn(async () => ({
      direction: "newer" as const,
      cursorState: "valid" as const,
      items: [{ sequence: 2, message: message(oversizedMessageId, "legacy content"), isAnchor: false }],
      snapshotMaxSequence: 2,
      hasMore: false,
    }));
    const handler = captureHistoryHandler({ chatMessages: { readChatHistoryContinuation } });
    const { reply, state } = replyHarness();

    await handler(
      {
        params: { sessionId: "session-1" },
        query: {
          workspaceId: "workspace-1",
          direction: "newer",
          cursor: "message-1",
          cursorSequence: "1",
          snapshotMaxSequence: "2",
          maxBytes: "1024",
        },
      },
      reply,
    );

    expect(state.statusCode).toBe(400);
    expect(state.body).toMatchObject({ error: expect.stringMatching(/identity metadata exceeds maxBytes/) });
  });
});
