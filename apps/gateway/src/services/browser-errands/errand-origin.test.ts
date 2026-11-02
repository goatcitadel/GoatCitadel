import type { ChatSessionBindingRecord, DiscordPairingRecord } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import {
  createErrandOriginDeps,
  resolveErrandOrigin,
  resolveOwnedErrandOrigin,
  type ErrandOriginDeps,
} from "./errand-origin.js";

const OWNER = "1001";

function binding(overrides: Partial<ChatSessionBindingRecord> = {}): ChatSessionBindingRecord {
  return {
    sessionId: "session-1",
    transport: "integration",
    connectionId: "conn-1",
    target: "chat-1001",
    conversation: { kind: "direct", counterpartActorId: OWNER },
    writable: true,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

function pairing(
  status: DiscordPairingRecord["status"],
  userId = OWNER,
  connectionId = "conn-1",
): DiscordPairingRecord {
  return {
    pairingId: `p-${status}-${userId}`,
    connectionId,
    userId,
    code: "ABC123",
    status,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
}

function deps(overrides: Partial<ErrandOriginDeps> = {}): ErrandOriginDeps {
  return {
    sessionChannel: async () => "telegram",
    binding: async () => binding(),
    turnActorId: async () => OWNER,
    connection: async () => ({
      key: "telegram",
      config: {
        inboundAccessMode: "pairing",
        ownerActorIds: [OWNER],
        telegramPairing: { approved: [{ actorId: OWNER, approvedAt: "2026-11-01T00:00:00.000Z" }], pending: [] },
      },
    }),
    readDiscordPairings: async () => [],
    ...overrides,
  };
}

describe("resolveErrandOrigin", () => {
  it("resolves a Mission Control session to the PC", async () => {
    await expect(
      resolveErrandOrigin(deps({ sessionChannel: async () => "mission" }), "session-1", "turn-1"),
    ).resolves.toEqual({
      kind: "pc",
    });
  });

  it("resolves a channel session from its binding and the turn's sender", async () => {
    await expect(resolveErrandOrigin(deps(), "session-1", "turn-1")).resolves.toEqual({
      kind: "channel",
      connectionId: "conn-1",
      channelKey: "telegram",
      target: "chat-1001",
      conversation: "direct",
      actorId: OWNER,
    });
  });

  it("treats a conversation with no recorded kind as a group", async () => {
    const origin = await resolveErrandOrigin(
      deps({ binding: async () => binding({ conversation: undefined }) }),
      "session-1",
      "turn-1",
    );
    expect(origin).toMatchObject({ kind: "channel", conversation: "group" });
  });

  it.each([
    ["the session can't be read", { sessionChannel: async () => Promise.reject(new Error("missing")) }],
    ["the session has no channel", { sessionChannel: async () => undefined }],
    ["the channel session has no binding", { binding: async () => undefined }],
    ["the binding is local", { binding: async () => binding({ transport: "local" }) }],
    ["the binding has no connection", { binding: async () => binding({ connectionId: undefined }) }],
    ["the binding has no target", { binding: async () => binding({ target: " " }) }],
    ["the turn's sender can't be read", { turnActorId: async () => Promise.reject(new Error("no trace")) }],
    ["the turn has no sender", { turnActorId: async () => undefined }],
  ] as Array<[string, Partial<ErrandOriginDeps>]>)("resolves nothing when %s", async (_name, overrides) => {
    await expect(resolveErrandOrigin(deps(overrides), "session-1", "turn-1")).resolves.toBeUndefined();
  });
});

describe("resolveOwnedErrandOrigin", () => {
  it("keeps the PC origin without reading any connection", async () => {
    let read = false;
    const origin = await resolveOwnedErrandOrigin(
      deps({
        sessionChannel: async () => "mission",
        connection: async () => {
          read = true;
          return undefined;
        },
      }),
      "session-1",
      "turn-1",
    );
    expect(origin).toEqual({ kind: "pc" });
    expect(read).toBe(false);
  });

  it("lets a Telegram owner with an approved pairing start", async () => {
    await expect(resolveOwnedErrandOrigin(deps(), "session-1", "turn-1")).resolves.toMatchObject({
      kind: "channel",
      actorId: OWNER,
    });
  });

  it("refuses a paired Telegram sender who is not the owner", async () => {
    await expect(
      resolveOwnedErrandOrigin(deps({ turnActorId: async () => "2002" }), "session-1", "turn-1"),
    ).resolves.toBeUndefined();
  });

  it("refuses when the connection can't be read", async () => {
    await expect(
      resolveOwnedErrandOrigin(
        deps({ connection: async () => Promise.reject(new Error("gone")) }),
        "session-1",
        "turn-1",
      ),
    ).resolves.toBeUndefined();
  });

  it("uses only this connection's approved Discord pairings", async () => {
    const discord = (records: DiscordPairingRecord[]): Partial<ErrandOriginDeps> => ({
      sessionChannel: async () => "discord",
      connection: async () => ({ key: "discord", config: { inboundAccessMode: "pairing", ownerActorIds: [OWNER] } }),
      readDiscordPairings: async () => records,
    });
    await expect(resolveOwnedErrandOrigin(deps(discord([pairing("approved")])), "s", "t")).resolves.toMatchObject({
      kind: "channel",
      channelKey: "discord",
    });
    await expect(resolveOwnedErrandOrigin(deps(discord([pairing("revoked")])), "s", "t")).resolves.toBeUndefined();
    await expect(
      resolveOwnedErrandOrigin(deps(discord([pairing("approved", OWNER, "conn-other")])), "s", "t"),
    ).resolves.toBeUndefined();
    await expect(
      resolveOwnedErrandOrigin(
        deps({ ...discord([]), readDiscordPairings: async () => Promise.reject(new Error("unreadable")) }),
        "s",
        "t",
      ),
    ).resolves.toBeUndefined();
  });
});

describe("createErrandOriginDeps", () => {
  function storageWith(messages: Record<string, { sessionId: string; role: string; actorId: string }>) {
    const traces: Record<string, { sessionId: string; userMessageId: string }> = {
      "turn-1": { sessionId: "session-1", userMessageId: "msg-1" },
      "turn-other": { sessionId: "session-2", userMessageId: "msg-1" },
      "turn-2": { sessionId: "session-1", userMessageId: "msg-2" },
      "turn-missing": { sessionId: "session-1", userMessageId: "msg-gone" },
    };
    return {
      sessions: { getBySessionId: async () => ({ channel: "telegram" }) },
      chatSessionBindings: { get: async () => binding() },
      chatTurnTraces: { get: async (turnId: string) => traces[turnId] },
      chatMessages: { get: async (messageId: string) => messages[messageId] },
      integrationConnections: { get: async () => ({ key: "telegram", config: { ownerActorIds: [OWNER] } }) },
    } as never;
  }

  it("reads the sender only from this session's user message for the turn", async () => {
    const readers = createErrandOriginDeps({
      storage: storageWith({
        "msg-1": { sessionId: "session-1", role: "user", actorId: OWNER },
        "msg-2": { sessionId: "session-1", role: "assistant", actorId: "assistant" },
      }),
      readDiscordPairings: async () => [pairing("approved")],
    });
    await expect(readers.turnActorId("session-1", "turn-1")).resolves.toBe(OWNER);
    // A turn from another session, an assistant message, or a missing message gives no sender.
    await expect(readers.turnActorId("session-1", "turn-other")).resolves.toBeUndefined();
    await expect(readers.turnActorId("session-1", "turn-2")).resolves.toBeUndefined();
    await expect(readers.turnActorId("session-1", "turn-missing")).resolves.toBeUndefined();
    await expect(readers.sessionChannel("session-1")).resolves.toBe("telegram");
    await expect(readers.connection("conn-1")).resolves.toEqual({
      key: "telegram",
      config: { ownerActorIds: [OWNER] },
    });
    await expect(readers.readDiscordPairings()).resolves.toHaveLength(1);
  });
});
