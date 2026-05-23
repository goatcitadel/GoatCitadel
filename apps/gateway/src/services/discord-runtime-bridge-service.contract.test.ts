import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSendMessageResponse, ChatSessionRecord } from "@goatcitadel/contracts";
import {
  ensureDiscordChatSession,
  handleDiscordRuntimeSlashCommand,
  handleDiscordRuntimeInbound,
  resolveDiscordInboundRoute,
  startNewDiscordRouteSession,
  type DiscordRouteSessionRecord,
  type DiscordRuntimeBridgeHost,
} from "./discord-runtime-bridge-service.js";

function createSystemSettingsStore() {
  const values = new Map<string, unknown>();
  return {
    get<T>(key: string): { value: T } | undefined {
      const value = values.get(key);
      return value === undefined ? undefined : { value: value as T };
    },
    set(key: string, value: unknown) {
      values.set(key, value);
    },
  };
}

function createHost(): DiscordRuntimeBridgeHost & {
  diagnostics: ReturnType<typeof vi.fn>;
  updateSessionMock: ReturnType<typeof vi.fn>;
  respondMock: ReturnType<typeof vi.fn>;
  sessionsById: Map<string, ChatSessionRecord>;
} {
  const systemSettings = createSystemSettingsStore();
  const sessionsById = new Map<string, ChatSessionRecord>();
  const sessionProjects = new Map<string, { sessionId: string; projectId: string; assignedAt: string }>();
  let connection = {
    connectionId: "discord-1",
    catalogId: "discord",
    kind: "channel",
    key: "discord",
    label: "Discord",
    enabled: true,
    status: "connected",
    config: {},
    createdAt: "2026-04-08T00:00:00.000Z",
    updatedAt: "2026-04-08T00:00:00.000Z",
  } as DiscordRuntimeBridgeHost["storage"]["integrationConnections"]["get"] extends (id: string) => infer T ? T : never;
  const diagnostics = vi.fn();
  const updateSessionMock = vi.fn();
  const respondMock = vi.fn(
    async (): Promise<ChatSendMessageResponse> => ({
      sessionId: "session-target",
      userMessage: { messageId: "source-1", sessionId: "session-target", role: "user", content: "hi" } as never,
      transport: "integration",
      turnId: "turn-1",
    }),
  );
  const isChatTurnWriteConflict = ((error: unknown): error is never =>
    (error as Error).message === "conflict") as DiscordRuntimeBridgeHost["isChatTurnWriteConflict"];

  return {
    storage: {
      systemSettings: systemSettings as DiscordRuntimeBridgeHost["storage"]["systemSettings"],
      sessions: {
        upsert(record: { sessionId: string; displayName?: string }) {
          const current = sessionsById.get(record.sessionId);
          sessionsById.set(record.sessionId, {
            sessionId: record.sessionId,
            title: current?.title ?? record.displayName ?? `Session ${record.sessionId.slice(-6)}`,
            pinned: false,
            lifecycleStatus: "active",
            scope: "mission",
          } as ChatSessionRecord);
          return {
            sessionId: record.sessionId,
            sessionKey: record.sessionId,
            kind: "room",
            channel: "discord",
            account: "discord-1",
            timestamp: new Date().toISOString(),
          } as unknown as ReturnType<DiscordRuntimeBridgeHost["storage"]["sessions"]["upsert"]>;
        },
      } as DiscordRuntimeBridgeHost["storage"]["sessions"],
      chatSessionMeta: {
        ensure: vi.fn(),
      } as unknown as DiscordRuntimeBridgeHost["storage"]["chatSessionMeta"],
      chatSessionPrefs: {
        ensure: vi.fn(),
      } as unknown as DiscordRuntimeBridgeHost["storage"]["chatSessionPrefs"],
      chatSessionBindings: {
        upsert: vi.fn(),
      } as unknown as DiscordRuntimeBridgeHost["storage"]["chatSessionBindings"],
      chatSessionProjects: {
        get(sessionId: string) {
          return sessionProjects.get(sessionId);
        },
      } as DiscordRuntimeBridgeHost["storage"]["chatSessionProjects"],
      integrationConnections: {
        get() {
          return connection;
        },
        update(_connectionId, input) {
          connection = {
            ...connection,
            ...input,
            config: input.config ?? connection.config,
            lastSyncAt: input.lastSyncAt ?? connection.lastSyncAt,
            lastError: input.lastError === undefined ? connection.lastError : (input.lastError ?? undefined),
          };
          return connection;
        },
      } as DiscordRuntimeBridgeHost["storage"]["integrationConnections"],
    },
    operatorSummaryCache: {
      invalidate: vi.fn(),
    } as unknown as DiscordRuntimeBridgeHost["operatorSummaryCache"],
    ensureChatSessionRuntimeGrants: vi.fn(),
    requireChatSession(sessionId: string) {
      const session = sessionsById.get(sessionId);
      if (!session) {
        throw new Error(`Unknown session ${sessionId}`);
      }
      return session;
    },
    updateChatSession: updateSessionMock,
    cancelLatestActiveChatTurnForSession: vi.fn(async () => ({ status: "no_active_run" })),
    getPersonalityCatalog: () => ({ items: [], defaultPersonalityId: "default" }),
    hasRunningTurn: () => false,
    parseChatCommand: vi.fn(async () => ({
      ok: true,
      command: "/noop",
      args: [],
      message: "ok",
    })) as DiscordRuntimeBridgeHost["parseChatCommand"],
    resolveApprovalWithRemoteToken: vi.fn(async () => ({
      approval: {
        approvalId: "approval-1",
        kind: "tool_call",
        status: "approved",
        riskLevel: "caution",
        payload: {},
        preview: {},
        explanationStatus: "not_requested",
        createdAt: "2026-04-08T00:00:00.000Z",
      },
      effects: [],
      replay: {
        approval: {
          approvalId: "approval-1",
          kind: "tool_call",
          status: "approved",
          riskLevel: "caution",
          payload: {},
          preview: {},
          explanationStatus: "not_requested",
          createdAt: "2026-04-08T00:00:00.000Z",
        },
        events: [],
        effects: [],
      },
    })) as DiscordRuntimeBridgeHost["resolveApprovalWithRemoteToken"],
    ingestChannelMessage: vi.fn(async () => ({
      accepted: true,
      deduped: false,
      session: {
        sessionId: "session-target",
        sessionKey: "session-target",
        kind: "room",
        channel: "discord",
        account: "discord-1",
        timestamp: new Date().toISOString(),
      },
      transcriptOffset: 0,
    })) as unknown as DiscordRuntimeBridgeHost["ingestChannelMessage"],
    setChatSessionBinding: vi.fn(),
    emitChannelActivity: vi.fn(async () => ({ effects: [] })),
    respondToExistingChatMessage: respondMock,
    isChatTurnWriteConflict,
    recordDevDiagnostic: diagnostics,
    getChatSessionPrefs(sessionId: string) {
      return {
        sessionId,
        createdAt: "2026-04-08T00:00:00.000Z",
        updatedAt: "2026-04-08T00:00:00.000Z",
        mode: "chat",
        providerId: "openai",
      } as ReturnType<DiscordRuntimeBridgeHost["getChatSessionPrefs"]>;
    },
    updateChatSessionPrefs: vi.fn(),
    assignChatSessionProject: vi.fn(),
    diagnostics,
    updateSessionMock,
    respondMock,
    sessionsById,
  };
}

describe("discord-runtime-bridge-service contract behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("creates a new logical route session and clones chat context into it", () => {
    const host = createHost();
    host.storage.chatSessionProjects.get = vi.fn((sessionId: string) =>
      sessionId === [...host.sessionsById.keys()][0]
        ? { sessionId, projectId: "project-1", assignedAt: "2026-04-08T00:00:00.000Z" }
        : undefined,
    );

    const session = startNewDiscordRouteSession(host, {
      connectionId: "discord-1",
      target: "dm_1",
      title: "Fresh thread",
    });

    const routeRecords =
      host.storage.systemSettings.get<DiscordRouteSessionRecord[]>("discord_route_sessions_v1")?.value ?? [];
    expect(routeRecords).toHaveLength(1);
    expect(routeRecords[0]).toMatchObject({
      connectionId: "discord-1",
      target: "dm_1",
      sessionId: session.sessionId,
    });
    expect(routeRecords[0]?.logicalSessionKey).toHaveLength(12);
    expect(host.sessionsById.size).toBe(2);
    expect(host.updateChatSessionPrefs).toHaveBeenCalledTimes(1);
    expect(host.assignChatSessionProject).toHaveBeenCalledWith(session.sessionId, "project-1");
    expect(host.updateSessionMock).toHaveBeenCalledWith(session.sessionId, { title: "Fresh thread" });
  });

  it("ensures Discord chat sessions, bindings, and route-session thread isolation", () => {
    const host = createHost();

    const first = ensureDiscordChatSession(host, {
      connectionId: "discord-1",
      target: "channel-1",
      displayName: "Ops Channel",
    });

    expect(first.sessionId).toMatch(/^sess_/);
    expect(host.operatorSummaryCache.invalidate).toHaveBeenCalled();
    expect(host.ensureChatSessionRuntimeGrants).toHaveBeenCalledWith(first.sessionId);
    expect(host.storage.chatSessionBindings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: first.sessionId,
        workspaceId: "default",
        transport: "integration",
        connectionId: "discord-1",
        target: "channel-1",
        writable: true,
      }),
      expect.any(String),
    );

    host.storage.systemSettings.set("discord_route_sessions_v1", [
      {
        connectionId: "discord-1",
        target: "channel-1",
        logicalSessionKey: "logical123",
        sessionId: first.sessionId,
        createdAt: "2026-04-08T00:00:00.000Z",
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
    ]);

    expect(
      resolveDiscordInboundRoute(host, {
        connectionId: "discord-1",
        target: "channel-1",
        room: "room-1",
        threadId: "thread-1",
      }),
    ).toEqual({
      room: "room-1",
      threadId: "discord_thread-1_logical123",
    });
    expect(
      resolveDiscordInboundRoute(host, {
        connectionId: "discord-1",
        target: "other-channel",
        peer: "user-1",
      }),
    ).toEqual({ peer: "user-1", room: "other-channel", threadId: undefined });
  });

  it("resolves Discord approval commands with remote action token semantics", async () => {
    const host = createHost();

    const response = await handleDiscordRuntimeSlashCommand(host, {
      connectionId: "discord-1",
      target: "dm_1",
      actorId: "user-1",
      commandText: "/approve grat_secret",
      sourceCommandId: "interaction-1",
    });

    expect(host.resolveApprovalWithRemoteToken).toHaveBeenCalledWith({
      token: "grat_secret",
      decision: "approve",
      resolvedBy: "discord:user-1",
    });
    expect(host.parseChatCommand).not.toHaveBeenCalled();
    expect(response).toContain("Approved approval-1");
  });

  it("passes Discord actor provenance into chat command fallback handling", async () => {
    const host = createHost();

    await handleDiscordRuntimeSlashCommand(host, {
      connectionId: "discord-1",
      target: "channel-1",
      actorId: "user-1",
      commandText: "/model gpt-5.4",
      sourceCommandId: "cmd-model",
    });

    expect(host.parseChatCommand).toHaveBeenCalledWith(expect.any(String), "/model gpt-5.4", {
      channelContext: { account: "discord-1", actorId: "user-1", platform: "discord" },
      resolvedBy: "discord:user-1",
      source: "channel",
    });
  });

  it("renders shared Discord command views and updates home/personality settings for operator-allowlisted actor (codex #4)", async () => {
    const host = createHost();
    host.getPersonalityCatalog = undefined;
    host.storage.integrationConnections.update("discord-1", {
      config: {
        // SECURITY (codex finding #4): /sethome now requires the actor
        // to be in the per-connection Discord operator allowlist.
        discordOperatorActors: ["user-1"],
        channelSkillBindings: [
          { skillId: "researcher", alias: "Researcher", enabled: true },
          { skillId: "hidden", alias: "Hidden", enabled: false },
        ],
      },
    });

    await expect(
      handleDiscordRuntimeSlashCommand(host, {
        connectionId: "discord-1",
        target: "channel-1",
        actorId: "user-1",
        commandText: "/sethome",
        sourceCommandId: "cmd-home",
      }),
    ).resolves.toContain("Home channel set");

    await expect(
      handleDiscordRuntimeSlashCommand(host, {
        connectionId: "discord-1",
        target: "channel-1",
        actorId: "user-1",
        commandText: "/status",
        sourceCommandId: "cmd-status",
      }),
    ).resolves.toContain("Home channel: this channel");

    await expect(
      handleDiscordRuntimeSlashCommand(host, {
        connectionId: "discord-1",
        target: "channel-1",
        actorId: "user-1",
        commandText: "/skills",
        sourceCommandId: "cmd-skills",
      }),
    ).resolves.toContain("Researcher: researcher");
    await expect(
      handleDiscordRuntimeSlashCommand(host, {
        connectionId: "discord-1",
        target: "channel-1",
        actorId: "user-1",
        commandText: "/skill Researcher",
        sourceCommandId: "cmd-skill",
      }),
    ).resolves.toContain('Skill "Researcher" is available');
    await expect(
      handleDiscordRuntimeSlashCommand(host, {
        connectionId: "discord-1",
        target: "channel-1",
        actorId: "user-1",
        commandText: "/tools",
        sourceCommandId: "cmd-tools",
      }),
    ).resolves.toContain("Channel tool posture");
    await expect(
      handleDiscordRuntimeSlashCommand(host, {
        connectionId: "discord-1",
        target: "channel-1",
        actorId: "user-1",
        commandText: "/personality concise",
        sourceCommandId: "cmd-personality",
      }),
    ).resolves.toContain("Personality set");
    await expect(
      handleDiscordRuntimeSlashCommand(host, {
        connectionId: "discord-1",
        target: "channel-1",
        actorId: "user-1",
        commandText: "/personality none",
        sourceCommandId: "cmd-personality-clear",
      }),
    ).resolves.toContain("Personality cleared");
  });

  it("blocks Discord slash work when an active run is already bound to the channel", async () => {
    const host = createHost();
    host.hasRunningTurn = vi.fn(() => true);

    const response = await handleDiscordRuntimeSlashCommand(host, {
      connectionId: "discord-1",
      target: "channel-1",
      actorId: "user-1",
      commandText: "/model gpt-5.4",
      sourceCommandId: "cmd-model",
    });

    expect(response).toContain("already active");
    expect(host.parseChatCommand).not.toHaveBeenCalled();
  });

  it("records a conflict diagnostic after exhausting reply retries for an inbound discord message", async () => {
    const host = createHost();
    host.respondMock.mockRejectedValue(new Error("conflict"));

    const promise = handleDiscordRuntimeInbound(host, {
      connectionId: "discord-1",
      target: "dm_1",
      actorId: "user-1",
      content: "hello",
      sourceMessageId: "msg-1",
    });

    await vi.runAllTimersAsync();
    await promise;

    expect(host.respondMock).toHaveBeenCalledTimes(3);
    expect(host.diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "discord.gateway.reply_conflict",
        level: "warn",
        context: expect.objectContaining({
          connectionId: "discord-1",
          sourceMessageId: "msg-1",
          attempt: 3,
        }),
      }),
    );
  });

  it("records active-run guard diagnostics for deduped-safe Discord inbound messages", async () => {
    const host = createHost();
    host.hasRunningTurn = vi.fn(() => true);

    await handleDiscordRuntimeInbound(host, {
      connectionId: "discord-1",
      target: "dm_1",
      actorId: "user-1",
      content: "hello while running",
      sourceMessageId: "msg-active",
    });

    expect(host.respondMock).not.toHaveBeenCalled();
    expect(host.diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "discord.gateway.active_run_guard",
        context: expect.objectContaining({
          connectionId: "discord-1",
          sourceMessageId: "msg-active",
        }),
      }),
    );
  });
});
