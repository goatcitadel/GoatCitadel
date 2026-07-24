import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSendMessageResponse, ChatSessionRecord } from "@goatcitadel/contracts";
import {
  acceptDiscordRuntimeSlashCommand,
  awaitDiscordRuntimeSlashCommandResult,
  ensureDiscordChatSession,
  executeDiscordRuntimeInboundCommand,
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
  acceptMock: ReturnType<typeof vi.fn>;
  awaitCommandMock: ReturnType<typeof vi.fn>;
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
  const acceptMock = vi.fn(async (input: Parameters<DiscordRuntimeBridgeHost["acceptInboundChannelEvent"]>[0]) => ({
    accepted: true as const,
    durableAccepted: true as const,
    deduped: false,
    replied: false as const,
    queued: true,
    eventType: input.eventType,
    inboundEventId: `inbound-${input.message.eventId}`,
  }));
  const awaitCommandMock = vi.fn(async () => ({
    status: "completed" as const,
    resultText: "Persisted command result.",
  }));
  const isChatTurnWriteConflict = ((error: unknown): error is never =>
    (error as Error).message === "conflict") as DiscordRuntimeBridgeHost["isChatTurnWriteConflict"];

  return {
    storage: {
      runImmediateTransaction<T>(callback: () => T): T {
        return callback();
      },
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
        get: vi.fn(() => undefined),
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
    resolveApprovalWithRemoteTokenId: vi.fn(async () => ({
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
    })) as DiscordRuntimeBridgeHost["resolveApprovalWithRemoteTokenId"],
    acceptInboundChannelEvent: acceptMock,
    awaitInboundChannelCommandResult: awaitCommandMock,
    findRemoteActionTokenId: vi.fn(() => "opaque-action-1"),
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
    acceptMock,
    awaitCommandMock,
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

  it("rejects a cross-workspace stable Discord identity before any session mutation", () => {
    const host = createHost();
    vi.mocked(host.storage.chatSessionMeta.get).mockReturnValue({ workspaceId: "other-workspace" });

    expect(() =>
      ensureDiscordChatSession(host, {
        connectionId: "discord-1",
        target: "channel-1",
        displayName: "Ops Channel",
      }),
    ).toThrow("stable Discord session key already belongs to another workspace");
    expect(host.sessionsById.size).toBe(0);
    expect(host.storage.chatSessionMeta.ensure).not.toHaveBeenCalled();
    expect(host.storage.chatSessionBindings.upsert).not.toHaveBeenCalled();
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
      connectorId: "integration:discord-1",
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

  it("durably accepts Discord gateway messages without running the legacy synchronous reply path", async () => {
    const host = createHost();
    await handleDiscordRuntimeInbound(host, {
      connectionId: "discord-1",
      target: "dm_1",
      actorId: "user-1",
      content: "hello",
      sourceMessageId: "msg-1",
      peer: "user-1",
      room: "dm_1",
      metadata: { runtimeMode: "gateway" },
    });

    expect(host.acceptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        connectionId: "discord-1",
        idempotencyKey: "discord:discord-1:msg-1",
        eventType: "discord-gateway-message",
        bindingTarget: "dm_1",
        dispatchKind: "agent_turn",
        message: expect.objectContaining({
          eventId: "msg-1",
          actorId: "user-1",
          actorType: "user",
          content: "hello",
        }),
      }),
    );
    expect(host.ingestChannelMessage).not.toHaveBeenCalled();
    expect(host.respondMock).not.toHaveBeenCalled();
  });

  it("propagates Discord durable acceptance failures before any legacy dispatch", async () => {
    const host = createHost();
    host.acceptMock.mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(
      handleDiscordRuntimeInbound(host, {
        connectionId: "discord-1",
        target: "dm_1",
        actorId: "user-1",
        content: "hello while storage is unavailable",
        sourceMessageId: "msg-failed",
      }),
    ).rejects.toThrow("storage unavailable");

    expect(host.ingestChannelMessage).not.toHaveBeenCalled();
    expect(host.respondMock).not.toHaveBeenCalled();
  });

  it("accepts Discord slash commands for durable execution before provider acknowledgement", async () => {
    const host = createHost();
    await acceptDiscordRuntimeSlashCommand(host, {
      connectionId: "discord-1",
      target: "channel-1",
      actorId: "user-1",
      commandText: "/status",
      sourceCommandId: "interaction-1",
      room: "channel-1",
      metadata: { interaction: true },
    });

    expect(host.acceptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "discord:discord-1:interaction:interaction-1",
        eventType: "discord-gateway-slash-command",
        dispatchKind: "command",
        message: expect.objectContaining({
          eventId: "interaction-1",
          content: "/status",
          actorType: "user",
        }),
      }),
    );
  });

  it("replaces raw approval bearer values with an opaque action id before durable acceptance", async () => {
    const host = createHost();
    await acceptDiscordRuntimeSlashCommand(host, {
      connectionId: "discord-1",
      target: "channel-1",
      actorId: "user-1",
      commandText: "/approve grat_super_secret",
      sourceCommandId: "interaction-approval-1",
      room: "channel-1",
      metadata: { interaction: true },
    });

    const acceptedInput = host.acceptMock.mock.calls[0]?.[0];
    expect(acceptedInput).toBeDefined();
    expect(JSON.stringify(acceptedInput)).not.toContain("grat_super_secret");
    expect(acceptedInput.message.content).toBe("/approve");
    expect(acceptedInput.message.metadata).toMatchObject({
      discordApprovalVersion: 1,
      discordApprovalDecision: "approve",
      discordApprovalLookupStatus: "resolved",
      discordApprovalActionId: "opaque-action-1",
    });

    await expect(
      executeDiscordRuntimeInboundCommand(host, {
        eventType: acceptedInput.eventType,
        inboundEventId: "inbound-interaction-approval-1",
        operationKey: acceptedInput.idempotencyKey,
        idempotencyKey: acceptedInput.idempotencyKey,
        channel: acceptedInput.channel,
        connectionId: acceptedInput.connectionId,
        bindingTarget: acceptedInput.bindingTarget,
        message: acceptedInput.message,
      }),
    ).resolves.toEqual({
      resultText: "Approved approval-1. GoatCitadel will resume any waiting work it can safely resume.",
    });
    expect(host.resolveApprovalWithRemoteTokenId).toHaveBeenCalledWith({
      tokenId: "opaque-action-1",
      connectorId: "integration:discord-1",
      decision: "approve",
      resolvedBy: "discord:user-1",
    });
    expect(host.resolveApprovalWithRemoteToken).not.toHaveBeenCalled();
  });

  it("persists only a not-found marker when an approval bearer value is unknown", async () => {
    const host = createHost();
    host.findRemoteActionTokenId = vi.fn(() => undefined);
    await acceptDiscordRuntimeSlashCommand(host, {
      connectionId: "discord-1",
      target: "channel-1",
      actorId: "user-1",
      commandText: "/deny grat_unknown_secret",
      sourceCommandId: "interaction-deny-unknown",
    });

    const acceptedInput = host.acceptMock.mock.calls[0]?.[0];
    expect(JSON.stringify(acceptedInput)).not.toContain("grat_unknown_secret");
    expect(acceptedInput.message.metadata).toMatchObject({
      discordApprovalVersion: 1,
      discordApprovalDecision: "reject",
      discordApprovalLookupStatus: "not_found",
    });
    expect(acceptedInput.message.metadata).not.toHaveProperty("discordApprovalActionId");

    await expect(
      executeDiscordRuntimeInboundCommand(host, {
        eventType: acceptedInput.eventType,
        inboundEventId: "inbound-deny-unknown",
        operationKey: acceptedInput.idempotencyKey,
        idempotencyKey: acceptedInput.idempotencyKey,
        channel: acceptedInput.channel,
        connectionId: acceptedInput.connectionId,
        bindingTarget: acceptedInput.bindingTarget,
        message: acceptedInput.message,
      }),
    ).resolves.toEqual({
      resultText: "The approval action token was not recognized. Request a fresh approval message.",
    });
    expect(host.resolveApprovalWithRemoteTokenId).not.toHaveBeenCalled();
    expect(host.resolveApprovalWithRemoteToken).not.toHaveBeenCalled();
  });

  it("reconstructs only the allowlisted Discord command envelope for the durable executor", async () => {
    const host = createHost();
    host.parseChatCommand = vi.fn(async () => ({ message: "Mode set to gpt-5.4." }));

    const result = await executeDiscordRuntimeInboundCommand(host, {
      eventType: "discord-gateway-slash-command",
      inboundEventId: "inbound-interaction-1",
      operationKey: "discord:discord-1:interaction:interaction-1",
      idempotencyKey: "discord:discord-1:interaction:interaction-1",
      channel: "discord",
      connectionId: "discord-1",
      bindingTarget: "channel-1",
      message: {
        eventId: "interaction-1",
        account: "discord-1",
        room: "channel-1",
        actorId: "user-1",
        actorType: "user",
        content: "/model gpt-5.4",
        metadata: { interaction: true },
      },
    });

    expect(result).toEqual({ resultText: "Mode set to gpt-5.4." });
    expect(host.parseChatCommand).toHaveBeenCalledWith(
      expect.any(String),
      "/model gpt-5.4",
      expect.objectContaining({ resolvedBy: "discord:user-1", source: "channel" }),
    );
  });

  it("fails closed before execution when a durable command identity is not Discord slash", async () => {
    const host = createHost();
    await expect(
      executeDiscordRuntimeInboundCommand(host, {
        eventType: "generic-channel",
        inboundEventId: "inbound-generic-1",
        operationKey: "generic-1",
        idempotencyKey: "generic-1",
        channel: "generic-channel",
        connectionId: "generic-1",
        bindingTarget: "room-1",
        message: {
          eventId: "event-1",
          account: "generic-1",
          actorId: "user-1",
          actorType: "user",
          content: "/stop",
        },
      }),
    ).rejects.toThrow("Unsupported durable inbound command event");
    expect(host.parseChatCommand).not.toHaveBeenCalled();
  });

  it("replays the persisted result and uses provider-safe copy for manual reconciliation", async () => {
    const host = createHost();
    await expect(awaitDiscordRuntimeSlashCommandResult(host, "inbound-interaction-1")).resolves.toBe(
      "Persisted command result.",
    );

    host.awaitCommandMock.mockResolvedValueOnce({
      status: "manual_reconciliation_required",
      message: "internal detail must stay operator-only",
    });
    await expect(awaitDiscordRuntimeSlashCommandResult(host, "inbound-ambiguous-1")).resolves.toBe(
      "Command was durably accepted but needs operator reconciliation before it can be retried. Event inbound-ambiguous-1.",
    );
  });
});
