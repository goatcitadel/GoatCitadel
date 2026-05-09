import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionRecord } from "@goatcitadel/contracts";
import {
  handleDiscordRuntimeSlashCommand,
  handleDiscordRuntimeInbound,
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
  const respondMock = vi.fn();
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
});
