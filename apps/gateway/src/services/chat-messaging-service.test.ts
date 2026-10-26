import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NotFoundError, type IntegrationConnection, type ChatChannelConversation } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import {
  createChatSession,
  ensureInboundIntegrationChatSession,
  listChatSessions,
  setChatSessionBinding,
  type ChatSessionDependencies,
} from "./chat-session-service.js";
import { listChatMessaging, markChatSessionRead, type ChatMessagingDeps } from "./chat-messaging-service.js";

const OPERATOR = "token:operator-1";

function at(second: number): string {
  return `2026-03-05T01:00:${String(second).padStart(2, "0")}.000Z`;
}

function readMarkerKey(actor: string, sessionId: string): string {
  return `chat.read.v1.${createHash("sha256").update(`${actor}\n${sessionId}`).digest("hex")}`;
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-chat-messaging-"));
  const storage = new Storage({
    dbPath: ":memory:",
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  const asyncStorage = createSqliteAsyncStorage(storage);
  const sessionDeps: ChatSessionDependencies = {
    storage: asyncStorage,
    operatorSummaryCache: { invalidate: vi.fn() },
    normalizeWorkspaceId: (workspaceId?: string) => workspaceId ?? "default",
    ensureChatSessionRuntimeGrants: vi.fn(),
    requireChatSession: vi.fn() as never,
    getSession: (sessionId: string) => asyncStorage.sessions.getBySessionId(sessionId),
    publishRealtime: vi.fn(),
    clearChatTurnWriteLease: vi.fn(),
    removeChatSessionStoredFile: vi.fn(),
    copyChatSessionStoredFile: vi.fn() as never,
    getChatSessionModelDefaults: () => ({
      providerId: undefined,
      model: undefined,
      thinkingLevel: "standard" as const,
    }),
    ensureChatSessionModelDefaults: (_sessionId, prefs) => prefs,
    hydrateChatPrefsWithAutonomy: (_sessionId, prefs) => prefs,
    patchSessionAutonomyPrefs: vi.fn(),
  };
  sessionDeps.requireChatSession = async (sessionId: string) => {
    const workspaceId = storage.chatSessionMeta.get(sessionId)?.workspaceId ?? "default";
    const records = await listChatSessions(sessionDeps, {
      workspaceId,
      scope: "all",
      view: "all",
      includeHidden: true,
      limit: 1000,
    });
    const record = records.find((item) => item.sessionId === sessionId);
    if (!record) {
      throw new NotFoundError({ entity: "Chat session", id: sessionId });
    }
    return record;
  };
  const deps: ChatMessagingDeps = {
    storage: asyncStorage,
    normalizeWorkspaceId: sessionDeps.normalizeWorkspaceId,
    listChatSessions: (query) => listChatSessions(sessionDeps, query),
  };

  let sequence = 0;
  const addConnection = (
    overrides: Partial<
      Pick<IntegrationConnection, "kind" | "key" | "label" | "enabled" | "status" | "config" | "workspaceId">
    > = {},
  ): IntegrationConnection =>
    storage.integrationConnections.create({
      catalogId: `channel.${overrides.key ?? "telegram"}`,
      kind: "channel",
      key: "telegram",
      label: "Telegram",
      enabled: true,
      status: "connected",
      workspaceId: "default",
      config: {},
      ...overrides,
    });

  const addConversation = async (
    connection: IntegrationConnection,
    input: {
      peer?: string;
      room?: string;
      displayName?: string;
      conversation?: ChatChannelConversation;
      activeAt?: string;
    },
  ): Promise<string> => {
    const target = input.room ?? input.peer ?? `chat-${++sequence}`;
    const session = await ensureInboundIntegrationChatSession(sessionDeps, {
      route: {
        channel: connection.key,
        account: connection.connectionId,
        ...(input.room ? { room: input.room } : { peer: input.peer ?? target }),
      },
      connectionId: connection.connectionId,
      target: `${connection.key}:${target}`,
      displayName: input.displayName,
      conversation: input.conversation,
    });
    const activeAt = input.activeAt ?? at(1);
    storage.db
      .prepare("UPDATE sessions SET last_activity_at = ?, updated_at = ? WHERE session_id = ?")
      .run(activeAt, activeAt, session.sessionId);
    return session.sessionId;
  };

  const addMessage = (
    sessionId: string,
    input: { id: string; at: string; authority?: "external_channel" | "operator"; role?: "user" | "assistant" },
  ): void => {
    storage.chatMessages.upsert({
      messageId: input.id,
      sessionId,
      role: input.role ?? "user",
      actorType: input.role === "assistant" ? "agent" : "user",
      actorId: input.role === "assistant" ? "agent" : "person",
      sourceAuthority: input.authority ?? "external_channel",
      content: `message ${input.id}`,
      timestamp: input.at,
    });
  };

  return {
    storage,
    asyncStorage,
    sessionDeps,
    deps,
    addConnection,
    addConversation,
    addMessage,
    cleanup: () => {
      storage.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("chat messaging service", () => {
  it("groups conversations under their connection and marks the operator's own direct conversation", async () => {
    const fixture = createFixture();
    try {
      const telegram = fixture.addConnection({ config: { ownerActorIds: ["42"] } });
      const slack = fixture.addConnection({ key: "slack", label: "Work Slack" });
      const own = await fixture.addConversation(telegram, {
        peer: "42",
        conversation: { kind: "direct", counterpartActorId: "42", title: "Sam Lee" },
        activeAt: at(1),
      });
      const other = await fixture.addConversation(telegram, {
        peer: "77",
        conversation: { kind: "direct", counterpartActorId: "77", title: "Alex Kim" },
        activeAt: at(2),
      });
      const group = await fixture.addConversation(telegram, {
        room: "-100",
        conversation: { kind: "group", title: "Family group" },
        activeAt: at(3),
      });
      const standup = await fixture.addConversation(slack, {
        room: "C1",
        conversation: { kind: "group", title: "#standup" },
        activeAt: at(4),
      });

      const overview = await listChatMessaging(fixture.deps, { workspaceId: "default" });

      expect(overview).toEqual({
        workspaceId: "default",
        channels: [
          {
            connectionId: telegram.connectionId,
            channelKey: "telegram",
            label: "Telegram",
            status: "on",
            conversations: [
              { sessionId: group, title: "Family group", kind: "group", own: false, lastActivityAt: at(3) },
              { sessionId: other, title: "Alex Kim", kind: "direct", own: false, lastActivityAt: at(2) },
              { sessionId: own, title: "Sam Lee", kind: "direct", own: true, lastActivityAt: at(1) },
            ],
          },
          {
            connectionId: slack.connectionId,
            channelKey: "slack",
            label: "Work Slack",
            status: "on",
            conversations: [
              { sessionId: standup, title: "#standup", kind: "group", own: false, lastActivityAt: at(4) },
            ],
          },
        ],
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("never marks a conversation as the operator's own without a matching owner account", async () => {
    const fixture = createFixture();
    try {
      const withoutOwners = fixture.addConnection();
      const withOwners = fixture.addConnection({ key: "signal", label: "Signal", config: { ownerActorIds: [" 42 "] } });
      const noOwnerDirect = await fixture.addConversation(withoutOwners, {
        peer: "42",
        conversation: { kind: "direct", counterpartActorId: "42" },
      });
      const ownerDirect = await fixture.addConversation(withOwners, {
        peer: "42",
        conversation: { kind: "direct", counterpartActorId: "42" },
      });
      const ownerGroup = await fixture.addConversation(withOwners, {
        room: "g-42",
        conversation: { kind: "group", counterpartActorId: "42", title: "Group" },
      });
      const unknownCounterpart = await fixture.addConversation(withOwners, { peer: "99" });

      const overview = await listChatMessaging(fixture.deps, { workspaceId: "default" });
      const own = new Map(
        overview.channels.flatMap((channel) => channel.conversations).map((item) => [item.sessionId, item.own]),
      );

      expect(own.get(noOwnerDirect)).toBe(false);
      expect(own.get(ownerDirect)).toBe(true);
      expect(own.get(ownerGroup)).toBe(false);
      expect(own.get(unknownCounterpart)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it("names a conversation from its details, then its session title, then a generic label", async () => {
    const fixture = createFixture();
    try {
      const connection = fixture.addConnection();
      const detailed = await fixture.addConversation(connection, {
        peer: "1",
        displayName: "Session name",
        conversation: { kind: "direct", counterpartActorId: "1", title: "Sam Lee" },
        activeAt: at(4),
      });
      const sessionTitled = await fixture.addConversation(connection, {
        peer: "2",
        displayName: "Chat with Alex",
        conversation: { kind: "direct", counterpartActorId: "2" },
        activeAt: at(3),
      });
      const genericDirect = await fixture.addConversation(connection, {
        peer: "3",
        conversation: { kind: "direct", counterpartActorId: "3" },
        activeAt: at(2),
      });
      const genericGroup = await fixture.addConversation(connection, {
        room: "-7",
        conversation: { kind: "group" },
        activeAt: at(1),
      });
      // Bound before conversation details were recorded: the kind comes from the session itself.
      const legacyDirect = await fixture.addConversation(connection, { peer: "4", activeAt: at(0) });
      const legacyGroup = await fixture.addConversation(connection, { room: "-8", activeAt: at(0) });

      const overview = await listChatMessaging(fixture.deps, { workspaceId: "default" });
      const byId = new Map(
        overview.channels.flatMap((channel) => channel.conversations).map((item) => [item.sessionId, item]),
      );

      expect(byId.get(detailed)).toMatchObject({ title: "Sam Lee", kind: "direct" });
      expect(byId.get(sessionTitled)).toMatchObject({ title: "Chat with Alex", kind: "direct" });
      expect(byId.get(genericDirect)).toMatchObject({ title: "Direct message", kind: "direct" });
      expect(byId.get(genericGroup)).toMatchObject({ title: "Group conversation", kind: "group" });
      expect(byId.get(legacyDirect)).toMatchObject({ title: "Direct message", kind: "direct", own: false });
      expect(byId.get(legacyGroup)).toMatchObject({ title: "Group conversation", kind: "group", own: false });
    } finally {
      fixture.cleanup();
    }
  });

  it("maps connection state to a channel status and orders channels by status, then label", async () => {
    const fixture = createFixture();
    try {
      const off = fixture.addConnection({ key: "alpha", label: "Alpha (disabled)", enabled: false });
      const paused = fixture.addConnection({ key: "bravo", label: "Bravo (paused)", status: "paused" });
      const disconnected = fixture.addConnection({
        key: "charlie",
        label: "Charlie (disconnected)",
        status: "disconnected",
      });
      const disabledWithError = fixture.addConnection({
        key: "delta",
        label: "Delta (disabled, error)",
        enabled: false,
        status: "error",
      });
      const broken = fixture.addConnection({ key: "echo", label: "echo (error)", status: "error" });
      const healthy = fixture.addConnection({ key: "foxtrot", label: "Foxtrot (on)" });
      const removed = fixture.addConnection({ key: "golf", label: "Golf (removed)" });
      for (const connection of [off, paused, disconnected, disabledWithError, broken, healthy, removed]) {
        await fixture.addConversation(connection, { peer: "1" });
      }
      fixture.storage.integrationConnections.delete(removed.connectionId);

      const overview = await listChatMessaging(fixture.deps, { workspaceId: "default" });

      // Only a switched-off connection is "off": an enabled one that is paused or disconnected needs a look, so the
      // conversation never asks the operator to turn on a channel its page shows as on.
      expect(overview.channels.map((channel) => [channel.channelKey, channel.status])).toEqual([
        ["bravo", "needs_attention"],
        ["charlie", "needs_attention"],
        ["echo", "needs_attention"],
        ["foxtrot", "on"],
        ["alpha", "off"],
        ["delta", "off"],
        ["golf", "removed"],
      ]);
      expect(overview.channels.map((channel) => channel.label).slice(0, 4)).toEqual([
        "Bravo (paused)",
        "Charlie (disconnected)",
        "echo (error)",
        "Foxtrot (on)",
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("counts only channel messages newer than the operator's read marker", async () => {
    const fixture = createFixture();
    try {
      const connection = fixture.addConnection();
      const sessionId = await fixture.addConversation(connection, { peer: "42" });
      fixture.addMessage(sessionId, { id: "c1", at: at(1) });
      fixture.addMessage(sessionId, { id: "c2", at: at(2) });
      fixture.addMessage(sessionId, { id: "c3", at: at(3) });
      fixture.addMessage(sessionId, { id: "o1", at: at(4), authority: "operator" });
      fixture.addMessage(sessionId, { id: "a1", at: at(5), role: "assistant", authority: "operator" });
      const conversationOf = async (actor: string) => {
        const overview = await listChatMessaging(fixture.deps, { workspaceId: "default", actor });
        return overview.channels[0]?.conversations[0];
      };

      // Nothing read yet: every message a person sent is waiting, and there is no read time to show.
      const unread = await conversationOf(OPERATOR);
      expect(unread?.newMessageCount).toBe(3);
      expect(unread).not.toHaveProperty("lastReadAt");

      await expect(
        markChatSessionRead(fixture.deps, { sessionId, workspaceId: "default", actor: OPERATOR, readThrough: at(2) }),
      ).resolves.toEqual({ sessionId, lastReadAt: at(2) });
      expect(await conversationOf(OPERATOR)).toMatchObject({ lastReadAt: at(2), newMessageCount: 1 });

      // Read state belongs to one operator.
      expect(await conversationOf("token:operator-2")).toMatchObject({ newMessageCount: 3 });

      await markChatSessionRead(fixture.deps, {
        sessionId,
        workspaceId: "default",
        actor: OPERATOR,
        readThrough: at(3),
      });
      expect(await conversationOf(OPERATOR)).toMatchObject({ lastReadAt: at(3), newMessageCount: 0 });

      // Stored in system settings under a key that never names the operator or the session.
      const stored = fixture.storage.systemSettings.get<{ at: string }>(readMarkerKey(OPERATOR, sessionId));
      expect(stored?.value).toEqual({ at: at(3) });
    } finally {
      fixture.cleanup();
    }
  });

  it("leaves read state and counts out when there is no operator identity", async () => {
    const fixture = createFixture();
    try {
      const connection = fixture.addConnection();
      const sessionId = await fixture.addConversation(connection, { peer: "42" });
      fixture.addMessage(sessionId, { id: "c1", at: at(1) });
      await markChatSessionRead(fixture.deps, {
        sessionId,
        workspaceId: "default",
        actor: OPERATOR,
        readThrough: at(0),
      });

      const overview = await listChatMessaging(fixture.deps, { workspaceId: "default" });
      const conversation = overview.channels[0]?.conversations[0];

      expect(conversation).toBeDefined();
      expect(conversation?.newMessageCount).toBeUndefined();
      expect(conversation?.lastReadAt).toBeUndefined();
      expect(conversation).not.toHaveProperty("newMessageCount");
      expect(conversation).not.toHaveProperty("lastReadAt");
    } finally {
      fixture.cleanup();
    }
  });

  it("lists conversations of a removed connection under a removed channel", async () => {
    const fixture = createFixture();
    try {
      const telegram = fixture.addConnection();
      const pigeon = fixture.addConnection({ key: "carrier-pigeon", label: "Pigeon post" });
      const telegramSession = await fixture.addConversation(telegram, {
        peer: "42",
        conversation: { kind: "direct", counterpartActorId: "42", title: "Sam Lee" },
      });
      const pigeonSession = await fixture.addConversation(pigeon, { room: "loft" });
      fixture.storage.integrationConnections.delete(telegram.connectionId);
      fixture.storage.integrationConnections.delete(pigeon.connectionId);

      const overview = await listChatMessaging(fixture.deps, { workspaceId: "default" });

      // The catalog names a known channel; an unknown channel key stands in for its own label.
      expect(overview.channels).toEqual([
        {
          connectionId: pigeon.connectionId,
          channelKey: "carrier-pigeon",
          label: "carrier-pigeon",
          status: "removed",
          conversations: [expect.objectContaining({ sessionId: pigeonSession, title: "Group conversation" })],
        },
        {
          connectionId: telegram.connectionId,
          channelKey: "telegram",
          label: "Telegram",
          status: "removed",
          conversations: [expect.objectContaining({ sessionId: telegramSession, title: "Sam Lee", own: false })],
        },
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("never moves a read marker backwards", async () => {
    const fixture = createFixture();
    try {
      const connection = fixture.addConnection();
      const sessionId = await fixture.addConversation(connection, { peer: "42" });
      const mark = (readThrough: string) =>
        markChatSessionRead(fixture.deps, { sessionId, workspaceId: "default", actor: OPERATOR, readThrough });
      const stored = () => fixture.storage.systemSettings.get<{ at: string }>(readMarkerKey(OPERATOR, sessionId));

      await expect(mark(at(10))).resolves.toEqual({ sessionId, lastReadAt: at(10) });
      const settled = stored();

      // An older request answers with the marker that already stands and writes nothing.
      await expect(mark(at(4))).resolves.toEqual({ sessionId, lastReadAt: at(10) });
      await expect(mark(at(10))).resolves.toEqual({ sessionId, lastReadAt: at(10) });
      expect(stored()).toEqual(settled);

      await expect(mark(at(11))).resolves.toEqual({ sessionId, lastReadAt: at(11) });
      expect(stored()?.value).toEqual({ at: at(11) });

      // Offsets and missing milliseconds are normalised to the same instant format messages use.
      await expect(mark("2026-03-05T02:00:00+01:00")).resolves.toEqual({ sessionId, lastReadAt: at(11) });
      await expect(mark("2026-03-05T01:00:20Z")).resolves.toEqual({ sessionId, lastReadAt: at(20) });
    } finally {
      fixture.cleanup();
    }
  });

  it("clamps a readThrough later than now to now before storing it", async () => {
    const fixture = createFixture();
    try {
      const connection = fixture.addConnection();
      const sessionId = await fixture.addConversation(connection, { peer: "42" });
      const before = Date.now();

      const result = await markChatSessionRead(fixture.deps, {
        sessionId,
        workspaceId: "default",
        actor: OPERATOR,
        readThrough: "2999-01-01T00:00:00.000Z",
      });

      const after = Date.now();
      const stored = fixture.storage.systemSettings.get<{ at: string }>(readMarkerKey(OPERATOR, sessionId));
      expect(Date.parse(result.lastReadAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(result.lastReadAt)).toBeLessThanOrEqual(after);
      expect(stored?.value).toEqual({ at: result.lastReadAt });

      // A far-future marker would hide this message; the clamped one does not.
      fixture.addMessage(sessionId, { id: "later", at: new Date(after + 60_000).toISOString() });
      const overview = await listChatMessaging(fixture.deps, { workspaceId: "default", actor: OPERATOR });
      expect(overview.channels[0]?.conversations[0]).toMatchObject({
        lastReadAt: result.lastReadAt,
        newMessageCount: 1,
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("replaces a damaged read marker instead of failing", async () => {
    const fixture = createFixture();
    try {
      const connection = fixture.addConnection();
      const sessionId = await fixture.addConversation(connection, { peer: "42" });
      fixture.addMessage(sessionId, { id: "c1", at: at(1) });
      fixture.storage.systemSettings.set(readMarkerKey(OPERATOR, sessionId), { at: "not a time" });

      const overview = await listChatMessaging(fixture.deps, { workspaceId: "default", actor: OPERATOR });
      expect(overview.channels[0]?.conversations[0]).toMatchObject({ newMessageCount: 1 });
      expect(overview.channels[0]?.conversations[0]).not.toHaveProperty("lastReadAt");

      await expect(
        markChatSessionRead(fixture.deps, { sessionId, workspaceId: "default", actor: OPERATOR, readThrough: at(2) }),
      ).resolves.toEqual({ sessionId, lastReadAt: at(2) });
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses to mark a session that does not exist in the workspace", async () => {
    const fixture = createFixture();
    try {
      const connection = fixture.addConnection({ workspaceId: "other" });
      const foreign = await fixture.addConversation(connection, { peer: "42" });

      await expect(
        markChatSessionRead(fixture.deps, {
          sessionId: "sess_missing",
          workspaceId: "default",
          actor: OPERATOR,
          readThrough: at(1),
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        markChatSessionRead(fixture.deps, {
          sessionId: foreign,
          workspaceId: "default",
          actor: OPERATOR,
          readThrough: at(1),
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        markChatSessionRead(fixture.deps, { sessionId: "sess_missing", actor: OPERATOR, readThrough: at(1) }),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(fixture.storage.systemSettings.get(readMarkerKey(OPERATOR, foreign))).toBeUndefined();

      // The read route names no workspace: the session's own workspace stands in for it.
      await expect(
        markChatSessionRead(fixture.deps, { sessionId: foreign, actor: OPERATOR, readThrough: at(1) }),
      ).resolves.toEqual({ sessionId: foreign, lastReadAt: at(1) });
    } finally {
      fixture.cleanup();
    }
  });

  it("leaves mission sessions bound to a channel out of Messaging", async () => {
    const fixture = createFixture();
    try {
      const connection = fixture.addConnection();
      const channelSession = await fixture.addConversation(connection, {
        peer: "42",
        conversation: { kind: "direct", counterpartActorId: "42", title: "Sam Lee" },
      });
      const mission = await createChatSession(fixture.sessionDeps, {
        workspaceId: "default",
        title: "Bound mission chat",
      });
      await setChatSessionBinding(fixture.sessionDeps, {
        sessionId: mission.sessionId,
        transport: "integration",
        connectionId: connection.connectionId,
        target: "telegram:42",
      });
      const missionOnlyConnection = fixture.addConnection({ key: "slack", label: "Slack" });
      const missionOnly = await createChatSession(fixture.sessionDeps, {
        workspaceId: "default",
        title: "Bound to Slack",
      });
      await setChatSessionBinding(fixture.sessionDeps, {
        sessionId: missionOnly.sessionId,
        transport: "integration",
        connectionId: missionOnlyConnection.connectionId,
        target: "slack:C1",
      });

      const overview = await listChatMessaging(fixture.deps, { workspaceId: "default" });

      // Slack is a connected channel, so it is a row, but the mission chat bound to it is not a conversation.
      expect(overview.channels.map((channel) => [channel.connectionId, channel.conversations.length])).toEqual([
        [missionOnlyConnection.connectionId, 0],
        [connection.connectionId, 1],
      ]);
      expect(overview.channels[1]?.conversations.map((item) => item.sessionId)).toEqual([channelSession]);
    } finally {
      fixture.cleanup();
    }
  });

  it("lists every channel connection of the workspace, with or without conversations", async () => {
    const fixture = createFixture();
    try {
      const withConversation = fixture.addConnection({ label: "Telegram" });
      const session = await fixture.addConversation(withConversation, { peer: "42" });
      const idle = fixture.addConnection({ key: "signal", label: "Signal" });
      const unbound = fixture.addConnection({ key: "matrix", label: "Matrix", workspaceId: undefined });
      const paused = fixture.addConnection({ key: "line", label: "Line", status: "paused" });
      const broken = fixture.addConnection({ key: "discord", label: "Discord", status: "error" });
      const disabled = fixture.addConnection({ key: "wechat", label: "WeChat", enabled: false });
      const elsewhere = fixture.addConnection({ key: "slack", label: "Slack", workspaceId: "other" });
      fixture.addConnection({ kind: "productivity", key: "notion", label: "Notion" });

      const overview = await listChatMessaging(fixture.deps, { workspaceId: "default" });

      expect(overview.channels).toEqual([
        {
          connectionId: broken.connectionId,
          channelKey: "discord",
          label: "Discord",
          status: "needs_attention",
          conversations: [],
        },
        {
          connectionId: paused.connectionId,
          channelKey: "line",
          label: "Line",
          status: "needs_attention",
          conversations: [],
        },
        { connectionId: unbound.connectionId, channelKey: "matrix", label: "Matrix", status: "on", conversations: [] },
        { connectionId: idle.connectionId, channelKey: "signal", label: "Signal", status: "on", conversations: [] },
        {
          connectionId: withConversation.connectionId,
          channelKey: "telegram",
          label: "Telegram",
          status: "on",
          conversations: [expect.objectContaining({ sessionId: session })],
        },
        {
          connectionId: disabled.connectionId,
          channelKey: "wechat",
          label: "WeChat",
          status: "off",
          conversations: [],
        },
      ]);
      // The other workspace's channel is that workspace's row; the connection that names none shows in both.
      const other = await listChatMessaging(fixture.deps, { workspaceId: "other" });
      expect(other.channels.map((channel) => channel.connectionId).sort()).toEqual(
        [elsewhere.connectionId, unbound.connectionId].sort(),
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("leaves the local webchat and terminal surfaces out of Messaging", async () => {
    const fixture = createFixture();
    try {
      const telegram = fixture.addConnection({ label: "Telegram" });
      const telegramChat = await fixture.addConversation(telegram, { peer: "42" });
      const webchat = fixture.addConnection({ key: "webchat", label: "Webchat" });
      fixture.addConnection({ key: "tui", label: "Terminal/TUI" });
      await fixture.addConversation(webchat, { peer: "browser-1" });
      // A removed webchat connection leaves its conversations behind; they are still not a channel row.
      const oldWebchat = fixture.addConnection({ key: "webchat", label: "Old webchat" });
      await fixture.addConversation(oldWebchat, { peer: "browser-2" });
      fixture.storage.integrationConnections.delete(oldWebchat.connectionId);

      const overview = await listChatMessaging(fixture.deps, { workspaceId: "default" });

      expect(overview.channels.map((channel) => channel.channelKey)).toEqual(["telegram"]);
      expect(overview.channels[0]?.conversations.map((conversation) => conversation.sessionId)).toEqual([telegramChat]);
    } finally {
      fixture.cleanup();
    }
  });

  it("only lists the requested workspace and skips archived conversations", async () => {
    const fixture = createFixture();
    try {
      const here = fixture.addConnection();
      const elsewhere = fixture.addConnection({ key: "slack", label: "Slack", workspaceId: "other" });
      const visible = await fixture.addConversation(here, { peer: "1" });
      const archived = await fixture.addConversation(here, { peer: "2" });
      await fixture.addConversation(elsewhere, { room: "C1" });
      fixture.storage.chatSessionMeta.patch(archived, { lifecycleStatus: "archived" });

      const overview = await listChatMessaging(fixture.deps, { workspaceId: "default" });

      expect(overview.workspaceId).toBe("default");
      expect(overview.channels).toHaveLength(1);
      expect(overview.channels[0]?.conversations.map((item) => item.sessionId)).toEqual([visible]);
      expect((await listChatMessaging(fixture.deps, { workspaceId: "nowhere" })).channels).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });
});
