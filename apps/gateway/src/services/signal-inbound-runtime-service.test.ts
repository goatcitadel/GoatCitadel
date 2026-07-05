import { describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import { ChannelBotLoopGuard } from "./channel-bot-loop-guard.js";
import type { IntegrationWebhookRouteLike } from "./channel-inbound-dispatch.js";
import {
  SIGNAL_INBOUND_MAX_BACKOFF_MS,
  SignalInboundRuntimeService,
  clampPollIntervalSeconds,
  normalizeSignalInboundEnvelope,
  type SignalInboundBridgeResponse,
  type SignalInboundScheduler,
} from "./signal-inbound-runtime-service.js";

type ScheduledTask = {
  id: number;
  callback: () => void;
  delayMs: number;
  cancelled: boolean;
  ran: boolean;
};

/** Deterministic scheduler: ticks run only when the test asks for them. */
function createManualScheduler() {
  let nextId = 1;
  const tasks: ScheduledTask[] = [];
  const scheduler: SignalInboundScheduler = {
    schedule: (callback, delayMs) => {
      const task: ScheduledTask = { id: nextId++, callback, delayMs, cancelled: false, ran: false };
      tasks.push(task);
      return task.id;
    },
    cancel: (handle) => {
      const task = tasks.find((item) => item.id === handle);
      if (task) {
        task.cancelled = true;
      }
    },
  };
  const pending = () => tasks.filter((task) => !task.cancelled && !task.ran);
  const runNext = async () => {
    const task = pending()[0];
    if (!task) {
      throw new Error("No pending scheduled task");
    }
    task.ran = true;
    task.callback();
    // Poll ticks are fire-and-forget async; drain the event loop until the
    // tick's await chain (fetch → dispatch → reschedule) has fully settled.
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return { scheduler, tasks, pending, runNext };
}

function createConnection(overrides: {
  connectionId?: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
  status?: IntegrationConnection["status"];
  key?: string;
  kind?: string;
}): IntegrationConnection {
  return {
    connectionId: overrides.connectionId ?? "conn-signal-1",
    catalogId: "channel.signal",
    kind: (overrides.kind ?? "channel") as IntegrationConnection["kind"],
    key: overrides.key ?? "signal",
    label: "Signal",
    enabled: overrides.enabled ?? true,
    status: overrides.status ?? "connected",
    config: overrides.config ?? {},
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  } as IntegrationConnection;
}

function createWebhookHost(connections: Map<string, IntegrationConnection>) {
  const ingestChannelMessage = vi
    .fn<IntegrationWebhookRouteLike["ingestChannelMessage"]>()
    .mockImplementation(async () => ({ deduped: false, session: { sessionId: "session-1" } }));
  const host: IntegrationWebhookRouteLike = {
    getIntegrationConnection: (connectionId) => {
      const connection = connections.get(connectionId);
      if (!connection) {
        throw new Error(`Unknown connection ${connectionId}`);
      }
      return connection;
    },
    cancelLatestActiveChatTurnForSession: vi.fn(async () => ({ status: "no_active_run" as const })),
    ingestChannelMessage,
    setChatSessionBinding: vi.fn(),
    respondToExistingChatMessage: vi.fn(async () => ({ turnId: "turn-1", trace: { status: "completed" } })),
    resolveApprovalWithRemoteTokenId: vi.fn(async () => ({ approval: { approvalId: "a", status: "approved" } })),
    resolveApprovalWithRemoteToken: vi.fn(async () => ({ approval: { approvalId: "a", status: "approved" } })),
    hasRunningTurn: vi.fn(() => false),
    parseChatCommand: vi.fn(async () => ({ message: "ok" })),
    emitChannelActivity: vi.fn(async () => ({ delivered: true }) as never),
    recordDevDiagnostic: vi.fn(),
    updateIntegrationConnection: vi.fn((connectionId) => {
      const connection = connections.get(connectionId);
      if (!connection) {
        throw new Error(`Unknown connection ${connectionId}`);
      }
      return connection;
    }),
  };
  return { host, ingestChannelMessage };
}

function bridgeResponse(payload: unknown, status = 200): SignalInboundBridgeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

function textEnvelope(overrides: { source?: string; message?: string; timestamp?: number; groupId?: string } = {}) {
  return {
    envelope: {
      source: overrides.source ?? "+15551230000",
      sourceNumber: overrides.source ?? "+15551230000",
      sourceUuid: "uuid-1",
      sourceName: "Alice",
      timestamp: overrides.timestamp ?? 1_700_000_000_000,
      dataMessage: {
        timestamp: overrides.timestamp ?? 1_700_000_000_000,
        message: overrides.message ?? "hello from signal",
        ...(overrides.groupId ? { groupInfo: { groupId: overrides.groupId } } : {}),
      },
    },
    account: "+15559990000",
  };
}

const ALLOWLISTED_CONFIG = {
  baseUrl: "http://127.0.0.1:8080",
  accountId: "+15559990000",
  defaultRecipient: "+15551230000",
  inboundEnabled: true,
  inboundAccessMode: "allowlist",
  allowedSenders: ["+15551230000"],
};

function createService(input: {
  connections: IntegrationConnection[];
  fetchBridge: (url: string) => Promise<SignalInboundBridgeResponse>;
  enabled?: () => boolean;
}) {
  const connectionMap = new Map(input.connections.map((connection) => [connection.connectionId, connection]));
  const manual = createManualScheduler();
  const { host, ingestChannelMessage } = createWebhookHost(connectionMap);
  const service = new SignalInboundRuntimeService({
    isEnabled: input.enabled ?? (() => true),
    listConnections: () => [...connectionMap.values()],
    fetchBridge: input.fetchBridge,
    integrationWebhooks: host,
    scheduler: manual.scheduler,
    loopGuard: new ChannelBotLoopGuard({
      maxEventsPerWindow: 20,
      windowSeconds: 60,
      cooldownSeconds: 60,
      enabled: true,
    }),
  });
  return { service, manual, host, ingestChannelMessage, connectionMap };
}

describe("SignalInboundRuntimeService", () => {
  it("polls the bridge receive endpoint, normalizes envelopes, and dispatches through the trust gate", async () => {
    const fetchBridge = vi.fn(async (url: string) => {
      expect(url).toBe("http://127.0.0.1:8080/v1/receive/%2B15559990000");
      return bridgeResponse([textEnvelope()]);
    });
    const { service, manual, host, ingestChannelMessage } = createService({
      connections: [createConnection({ config: ALLOWLISTED_CONFIG })],
      fetchBridge,
    });

    service.sync();
    expect(service.activePollerCount).toBe(1);
    expect(manual.pending()).toHaveLength(1);
    expect(manual.pending()[0]?.delayMs).toBe(10_000);

    await manual.runNext();

    expect(fetchBridge).toHaveBeenCalledTimes(1);
    expect(ingestChannelMessage).toHaveBeenCalledTimes(1);
    const [channel, idempotencyKey, message] = ingestChannelMessage.mock.calls[0] ?? [];
    expect(channel).toBe("signal");
    expect(idempotencyKey).toBe("signal:conn-signal-1:+15551230000:1700000000000");
    expect(message).toMatchObject({
      actorId: "+15551230000",
      account: "+15559990000",
      peer: "+15551230000",
      content: "hello from signal",
      actorType: "user",
      displayName: "Alice",
    });
    expect(host.setChatSessionBinding).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "conn-signal-1", target: "+15551230000", writable: true }),
    );
    expect(host.respondToExistingChatMessage).toHaveBeenCalledTimes(1);
    // Loop keeps running at the configured interval after a successful poll.
    expect(manual.pending()).toHaveLength(1);
    expect(manual.pending()[0]?.delayMs).toBe(10_000);
  });

  it("routes group messages with the outbound-compatible group: target", async () => {
    const fetchBridge = vi.fn(async () => bridgeResponse([textEnvelope({ groupId: "grp-1" })]));
    const { service, manual, host, ingestChannelMessage } = createService({
      connections: [createConnection({ config: ALLOWLISTED_CONFIG })],
      fetchBridge,
    });
    service.sync();
    await manual.runNext();

    expect(ingestChannelMessage.mock.calls[0]?.[2]).toMatchObject({ room: "group:grp-1", peer: undefined });
    expect(host.setChatSessionBinding).toHaveBeenCalledWith(expect.objectContaining({ target: "group:grp-1" }));
  });

  it("drops non-allowlisted senders before ingest — identical to webhook channels", async () => {
    const fetchBridge = vi.fn(async () => bridgeResponse([textEnvelope({ source: "+19998887777" })]));
    const { service, manual, host, ingestChannelMessage } = createService({
      connections: [createConnection({ config: ALLOWLISTED_CONFIG })],
      fetchBridge,
    });
    service.sync();
    await manual.runNext();

    expect(ingestChannelMessage).not.toHaveBeenCalled();
    expect(host.setChatSessionBinding).not.toHaveBeenCalled();
    expect(host.respondToExistingChatMessage).not.toHaveBeenCalled();
    expect(host.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "channel.sender_not_allowlisted" }),
    );
  });

  it("dedupes repeated envelopes across polls", async () => {
    const fetchBridge = vi.fn(async () => bridgeResponse([textEnvelope(), textEnvelope()]));
    const { service, manual, ingestChannelMessage } = createService({
      connections: [createConnection({ config: ALLOWLISTED_CONFIG })],
      fetchBridge,
    });
    service.sync();
    await manual.runNext();
    // Second poll re-serves the same envelope.
    await manual.runNext();

    expect(fetchBridge).toHaveBeenCalledTimes(2);
    expect(ingestChannelMessage).toHaveBeenCalledTimes(1);
  });

  it("ignores non-text envelopes without crashing the loop", async () => {
    const reactionEnvelope = {
      envelope: {
        source: "+15551230000",
        timestamp: 1_700_000_000_111,
        dataMessage: { timestamp: 1_700_000_000_111, reaction: { emoji: "👍" } },
      },
    };
    const receiptEnvelope = {
      envelope: {
        source: "+15551230000",
        timestamp: 1_700_000_000_222,
        receiptMessage: { isDelivery: true },
      },
    };
    const fetchBridge = vi.fn(async () =>
      bridgeResponse([reactionEnvelope, receiptEnvelope, textEnvelope({ timestamp: 1_700_000_000_333 })]),
    );
    const { service, manual, host, ingestChannelMessage } = createService({
      connections: [createConnection({ config: ALLOWLISTED_CONFIG })],
      fetchBridge,
    });
    service.sync();
    await manual.runNext();

    expect(ingestChannelMessage).toHaveBeenCalledTimes(1);
    expect(host.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "signal.inbound.envelope_ignored" }),
    );
    // Next poll is still scheduled at the normal interval.
    expect(manual.pending()).toHaveLength(1);
    expect(manual.pending()[0]?.delayMs).toBe(10_000);
  });

  it("backs off exponentially on bridge errors, caps at ~5 minutes, and recovers", async () => {
    let failing = true;
    const fetchBridge = vi.fn(async () => {
      if (failing) {
        throw new Error("bridge down");
      }
      return bridgeResponse([]);
    });
    const { service, manual, host } = createService({
      connections: [createConnection({ config: ALLOWLISTED_CONFIG })],
      fetchBridge,
    });
    service.sync();

    await manual.runNext();
    expect(manual.pending()[0]?.delayMs).toBe(20_000);
    await manual.runNext();
    expect(manual.pending()[0]?.delayMs).toBe(40_000);
    await manual.runNext();
    expect(manual.pending()[0]?.delayMs).toBe(80_000);
    await manual.runNext();
    expect(manual.pending()[0]?.delayMs).toBe(160_000);
    await manual.runNext();
    expect(manual.pending()[0]?.delayMs).toBe(SIGNAL_INBOUND_MAX_BACKOFF_MS);
    await manual.runNext();
    // Stays capped.
    expect(manual.pending()[0]?.delayMs).toBe(SIGNAL_INBOUND_MAX_BACKOFF_MS);
    expect(host.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "signal.inbound.poll_failed" }),
    );

    failing = false;
    await manual.runNext();
    // Recovery resets to the configured interval.
    expect(manual.pending()[0]?.delayMs).toBe(10_000);
  });

  it("keeps polling when a single dispatch fails", async () => {
    const fetchBridge = vi.fn(async () => bridgeResponse([textEnvelope()]));
    const { service, manual, host, ingestChannelMessage } = createService({
      connections: [createConnection({ config: ALLOWLISTED_CONFIG })],
      fetchBridge,
    });
    ingestChannelMessage.mockRejectedValueOnce(new Error("ingest exploded"));
    service.sync();
    await manual.runNext();

    expect(host.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "signal.inbound.dispatch_failed" }),
    );
    // Poll loop survives and reschedules at the normal interval.
    expect(manual.pending()).toHaveLength(1);
    expect(manual.pending()[0]?.delayMs).toBe(10_000);
  });

  it("never starts pollers when the feature flag is off", () => {
    const fetchBridge = vi.fn();
    const { service, manual } = createService({
      connections: [createConnection({ config: ALLOWLISTED_CONFIG })],
      fetchBridge,
      enabled: () => false,
    });
    service.sync();

    expect(service.activePollerCount).toBe(0);
    expect(manual.pending()).toHaveLength(0);
    expect(fetchBridge).not.toHaveBeenCalled();
  });

  it("never starts pollers when the connection has inbound disabled", () => {
    const fetchBridge = vi.fn();
    const { service, manual } = createService({
      connections: [
        createConnection({ config: { ...ALLOWLISTED_CONFIG, inboundEnabled: false } }),
        createConnection({ connectionId: "conn-2", config: { ...ALLOWLISTED_CONFIG, inboundEnabled: undefined } }),
      ],
      fetchBridge,
    });
    service.sync();

    expect(service.activePollerCount).toBe(0);
    expect(manual.pending()).toHaveLength(0);
  });

  it("skips misconfigured connections (inbound on, no account id) with a diagnostic", () => {
    const fetchBridge = vi.fn();
    const { service, host } = createService({
      connections: [
        createConnection({
          config: { baseUrl: "http://127.0.0.1:8080", inboundEnabled: true },
        }),
      ],
      fetchBridge,
    });
    service.sync();

    expect(service.activePollerCount).toBe(0);
    expect(host.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "signal.inbound.misconfigured" }),
    );
  });

  it("halts an active poller once the kill switch flips off between ticks", async () => {
    let enabled = true;
    const fetchBridge = vi.fn(async () => bridgeResponse([]));
    const { service, manual } = createService({
      connections: [createConnection({ config: ALLOWLISTED_CONFIG })],
      fetchBridge,
      enabled: () => enabled,
    });
    service.sync();
    expect(service.activePollerCount).toBe(1);

    enabled = false;
    await manual.runNext();

    expect(service.activePollerCount).toBe(0);
    expect(manual.pending()).toHaveLength(0);
    expect(fetchBridge).not.toHaveBeenCalled();
  });

  it("stop() cancels pending timers and blocks restarts", async () => {
    const fetchBridge = vi.fn(async () => bridgeResponse([]));
    const { service, manual } = createService({
      connections: [createConnection({ config: ALLOWLISTED_CONFIG })],
      fetchBridge,
    });
    service.sync();
    expect(manual.pending()).toHaveLength(1);

    service.stop();
    expect(service.activePollerCount).toBe(0);
    expect(manual.pending()).toHaveLength(0);

    // A later sync (e.g. stray connection-change event during shutdown) is inert.
    service.sync();
    expect(service.activePollerCount).toBe(0);
  });

  it("restarts a poller when its bridge settings change and stops removed connections", () => {
    const fetchBridge = vi.fn(async () => bridgeResponse([]));
    const connection = createConnection({ config: ALLOWLISTED_CONFIG });
    const { service, manual, connectionMap } = createService({ connections: [connection], fetchBridge });
    service.sync();
    expect(manual.tasks).toHaveLength(1);

    connectionMap.set(
      connection.connectionId,
      createConnection({ config: { ...ALLOWLISTED_CONFIG, pollIntervalSeconds: 30 } }),
    );
    service.sync();
    // Old timer cancelled, one fresh pending timer at the new interval.
    expect(manual.pending()).toHaveLength(1);
    expect(manual.pending()[0]?.delayMs).toBe(30_000);

    connectionMap.delete(connection.connectionId);
    service.sync();
    expect(service.activePollerCount).toBe(0);
    expect(manual.pending()).toHaveLength(0);
  });
});

describe("normalizeSignalInboundEnvelope", () => {
  it("normalizes a plain-text envelope", () => {
    expect(normalizeSignalInboundEnvelope(textEnvelope())).toEqual({
      kind: "message",
      actorId: "+15551230000",
      sourceUuid: "uuid-1",
      displayName: "Alice",
      timestamp: 1_700_000_000_000,
      content: "hello from signal",
      groupId: undefined,
    });
  });

  it("accepts a bare envelope without the rest-api container", () => {
    const bare = (textEnvelope() as { envelope: Record<string, unknown> }).envelope;
    const normalized = normalizeSignalInboundEnvelope(bare);
    expect(normalized.kind).toBe("message");
  });

  it("ignores envelopes without a sender, data message, text, or timestamp", () => {
    expect(normalizeSignalInboundEnvelope({ envelope: {} })).toEqual({ kind: "ignored", reason: "missing_sender" });
    expect(normalizeSignalInboundEnvelope({ envelope: { source: "+1", timestamp: 1 } })).toEqual({
      kind: "ignored",
      reason: "no_data_message",
    });
    expect(normalizeSignalInboundEnvelope({ envelope: { source: "+1", dataMessage: { attachments: [{}] } } })).toEqual({
      kind: "ignored",
      reason: "non_text_message",
    });
    expect(normalizeSignalInboundEnvelope({ envelope: { source: "+1", dataMessage: { message: "hi" } } })).toEqual({
      kind: "ignored",
      reason: "missing_timestamp",
    });
    expect(normalizeSignalInboundEnvelope("not-an-object")).toEqual({ kind: "ignored", reason: "missing_sender" });
  });
});

describe("clampPollIntervalSeconds", () => {
  it("defaults, floors, and caps the poll interval", () => {
    expect(clampPollIntervalSeconds(undefined)).toBe(10);
    expect(clampPollIntervalSeconds("")).toBe(10);
    expect(clampPollIntervalSeconds("not-a-number")).toBe(10);
    expect(clampPollIntervalSeconds(1)).toBe(5);
    expect(clampPollIntervalSeconds("7")).toBe(7);
    expect(clampPollIntervalSeconds(1_000_000)).toBe(3_600);
  });
});
