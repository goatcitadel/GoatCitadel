import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ApprovalRequest,
  ChatSessionBindingRecord,
  ConnectorRecord,
  DiscordPairingRecord,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import {
  deliverErrandApproval,
  type ErrandApprovalConversation,
  type ErrandApprovalDeliveryDeps,
} from "./errand-approval-delivery.js";
import { ERRAND_APPROVAL_KIND } from "./errand-constants.js";
import { createErrandEscalation, type ErrandEscalationDeps } from "./errand-escalation.js";
import {
  createGatewayErrandEscalation,
  createOwnErrandConversationLookup,
  ownDirectConversation,
  readErrandApprovalSessionId,
} from "./errand-escalation-gateway.js";
import type { ErrandOrigin } from "./errand-origin.js";

const NOW = Date.parse("2026-11-02T10:00:00.000Z");
const PICKED: ErrandApprovalConversation = {
  connectionId: "conn-dm",
  channelKey: "telegram",
  target: "chat-dm",
  conversation: "direct",
};
const CHANNEL_ORIGIN: ErrandOrigin = {
  kind: "channel",
  connectionId: "conn-origin",
  channelKey: "telegram",
  target: "chat-origin",
  conversation: "group",
  actorId: "owner",
};

function approval(partial: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: "approval-1",
    kind: ERRAND_APPROVAL_KIND,
    status: "pending",
    riskLevel: "caution",
    expiresAt: new Date(NOW + 60_000).toISOString(),
    linkage: { sessionId: "session-errand" },
    preview: { summary: 'Click "Place order" — Buy the cart', screenshotAttachmentId: "attachment-before" },
    ...partial,
  } as unknown as ApprovalRequest;
}

function connector(status: ConnectorRecord["status"]): ConnectorRecord {
  return {
    connectorId: "integration:conn",
    connectorType: "channel",
    status,
    capabilities: [],
  } as unknown as ConnectorRecord;
}

/** The escalation over the real delivery, with the connection's status and the setting under the test's control. */
function setup(options: { stored?: ApprovalRequest; status?: ConnectorRecord["status"]; sessionId?: string } = {}) {
  const delivery: ErrandApprovalDeliveryDeps = {
    requireConnectorRecord: vi.fn(async () => connector(options.status ?? "active")),
    createApprovalRemoteActionToken: vi.fn(async () => ({ deliveryStatus: "queued" as const })),
    recordDelivery: vi.fn(),
    attachmentSessionId: vi.fn(async () => "session-errand"),
    now: () => NOW,
  };
  const deps: ErrandEscalationDeps = {
    readApproval: vi.fn(async () => options.stored ?? approval()),
    deliver: vi.fn((input) => deliverErrandApproval(delivery, input)),
    approvalSessionId: () => options.sessionId,
    conversationFor: vi.fn(async (sessionId: string) => (sessionId === "session-dm" ? PICKED : undefined)),
    pushToPhone: vi.fn(async () => 1),
  };
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  return { escalate: createErrandEscalation(deps), deps, delivery, warn };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("errand escalation", () => {
  it("asks a channel errand's own conversation at once, and nothing else", async () => {
    const { escalate, deps, delivery } = setup({ sessionId: "session-dm" });
    await escalate(approval(), CHANNEL_ORIGIN, "asked");
    expect(deps.deliver).toHaveBeenCalledTimes(1);
    expect(deps.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ origin: CHANNEL_ORIGIN, screenshotAttachmentId: "attachment-before" }),
    );
    expect(delivery.recordDelivery).toHaveBeenCalledWith({
      approvalId: "approval-1",
      connectionId: "conn-origin",
      target: "chat-origin",
    });
    expect(deps.conversationFor).not.toHaveBeenCalled();
    expect(deps.pushToPhone).not.toHaveBeenCalled();
  });

  it("sends a channel errand's waited approval to the phone only", async () => {
    const { escalate, deps } = setup({ sessionId: "session-dm" });
    await escalate(approval(), CHANNEL_ORIGIN, "waited");
    expect(deps.deliver).not.toHaveBeenCalled();
    expect(deps.conversationFor).not.toHaveBeenCalled();
    expect(deps.pushToPhone).toHaveBeenCalledWith("approval-1");
  });

  it("sends nothing for a PC errand before it has waited", async () => {
    const { escalate, deps } = setup({ sessionId: "session-dm" });
    await escalate(approval(), { kind: "pc" }, "asked");
    expect(deps.readApproval).not.toHaveBeenCalled();
    expect(deps.deliver).not.toHaveBeenCalled();
    expect(deps.pushToPhone).not.toHaveBeenCalled();
  });

  it("sends a PC errand's waited approval to the picked conversation and the phone", async () => {
    const { escalate, deps, delivery } = setup({ sessionId: "session-dm" });
    await escalate(approval(), { kind: "pc" }, "waited");
    expect(deps.conversationFor).toHaveBeenCalledWith("session-dm");
    expect(deps.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ origin: PICKED, screenshotAttachmentId: "attachment-before" }),
    );
    // Only the gate's own screenshot for this approval is attached.
    expect(delivery.createApprovalRemoteActionToken).toHaveBeenCalledWith(
      "approval-1",
      expect.objectContaining({
        connectorId: "integration:conn-dm",
        delivery: expect.objectContaining({ target: "chat-dm", attachmentIds: ["attachment-before"] }),
      }),
    );
    expect(deps.pushToPhone).toHaveBeenCalledWith("approval-1");
  });

  it("with no conversation picked, sends only to the phone", async () => {
    const { escalate, deps, warn } = setup({ sessionId: undefined });
    await escalate(approval(), { kind: "pc" }, "waited");
    expect(deps.conversationFor).not.toHaveBeenCalled();
    expect(deps.deliver).not.toHaveBeenCalled();
    expect(deps.pushToPhone).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("with a disconnected connection, skips the channel with a warning and still sends to the phone", async () => {
    const { escalate, deps, delivery, warn } = setup({ sessionId: "session-dm", status: "degraded" });
    await escalate(approval(), { kind: "pc" }, "waited");
    expect(delivery.createApprovalRemoteActionToken).not.toHaveBeenCalled();
    expect(delivery.recordDelivery).not.toHaveBeenCalled();
    expect(deps.pushToPhone).toHaveBeenCalledWith("approval-1");
    expect(warn).toHaveBeenCalledWith(
      "[goatcitadel] errand approval skipped the channel conversation",
      expect.objectContaining({ approvalId: "approval-1", connectionId: "conn-dm", detail: "connection_unavailable" }),
    );
  });

  it("with a picked session that is not the operator's own direct conversation, warns and still sends to the phone", async () => {
    const { escalate, deps, warn } = setup({ sessionId: "session-mission" });
    await escalate(approval(), { kind: "pc" }, "waited");
    expect(deps.deliver).not.toHaveBeenCalled();
    expect(deps.pushToPhone).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[goatcitadel] errand approval conversation is not your own direct conversation",
      expect.objectContaining({ approvalId: "approval-1" }),
    );
  });

  it("still sends to the phone when the channel delivery throws", async () => {
    const { escalate, deps } = setup({ sessionId: "session-dm" });
    vi.mocked(deps.deliver).mockRejectedValueOnce(new Error("boom"));
    await escalate(approval(), { kind: "pc" }, "waited");
    expect(deps.pushToPhone).toHaveBeenCalledTimes(1);
  });

  it("sends nothing for an approval answered in the meantime", async () => {
    const { escalate, deps } = setup({ sessionId: "session-dm", stored: approval({ status: "approved" }) });
    await escalate(approval(), { kind: "pc" }, "waited");
    await escalate(approval(), CHANNEL_ORIGIN, "asked");
    await escalate(approval(), CHANNEL_ORIGIN, "waited");
    expect(deps.deliver).not.toHaveBeenCalled();
    expect(deps.pushToPhone).not.toHaveBeenCalled();
  });
});

const OWNER_CONFIG = { ownerActorIds: ["owner-1"], telegramPairing: { approved: [{ actorId: "owner-1" }] } };

function binding(conversation: unknown, partial: Record<string, unknown> = {}): ChatSessionBindingRecord {
  return {
    sessionId: "session-dm",
    transport: "integration",
    connectionId: "conn-dm",
    target: "chat-dm",
    writable: true,
    ...(conversation ? { conversation } : {}),
    ...partial,
  } as unknown as ChatSessionBindingRecord;
}

describe("the picked conversation must be the operator's own direct conversation", () => {
  const connection = { connectionId: "conn-dm", key: "telegram", config: OWNER_CONFIG };

  it("accepts a direct conversation with the operator's own paired account", () => {
    expect(
      ownDirectConversation(binding({ kind: "direct", counterpartActorId: "Owner-1" }), connection, "telegram", []),
    ).toEqual({ connectionId: "conn-dm", channelKey: "telegram", target: "chat-dm", conversation: "direct" });
  });

  it("refuses a group conversation", () => {
    expect(
      ownDirectConversation(binding({ kind: "group", title: "Team" }), connection, "telegram", []),
    ).toBeUndefined();
  });

  it("refuses a conversation whose kind was never recorded", () => {
    expect(ownDirectConversation(binding(undefined), connection, "telegram", [])).toBeUndefined();
  });

  it("refuses someone else's direct conversation", () => {
    expect(
      ownDirectConversation(binding({ kind: "direct", counterpartActorId: "stranger" }), connection, "telegram", []),
    ).toBeUndefined();
  });

  it("refuses the owner's direct conversation once the pairing is revoked", () => {
    expect(
      ownDirectConversation(
        binding({ kind: "direct", counterpartActorId: "owner-1" }),
        { ...connection, config: { ownerActorIds: ["owner-1"] } },
        "telegram",
        [],
      ),
    ).toBeUndefined();
  });

  it("checks Discord against the connection's approved pairing records", () => {
    const discord = { connectionId: "conn-dm", key: "discord", config: { ownerActorIds: ["owner-1"] } };
    const paired = [{ connectionId: "conn-dm", userId: "owner-1", status: "approved" }] as DiscordPairingRecord[];
    const direct = binding({ kind: "direct", counterpartActorId: "owner-1" });
    expect(ownDirectConversation(direct, discord, "discord", paired)).toMatchObject({ conversation: "direct" });
    expect(ownDirectConversation(direct, discord, "discord", [])).toBeUndefined();
  });

  it("refuses a binding nothing can be sent through", () => {
    expect(
      ownDirectConversation(
        binding({ kind: "direct", counterpartActorId: "owner-1" }, { writable: false }),
        connection,
        "telegram",
        [],
      ),
    ).toBeUndefined();
  });

  it("refuses a binding that is not an integration conversation", () => {
    expect(
      ownDirectConversation(
        binding({ kind: "direct", counterpartActorId: "owner-1" }, { transport: "mission" }),
        connection,
        "telegram",
        [],
      ),
    ).toBeUndefined();
  });
});

describe("Gateway errand escalation", () => {
  // The Gateway wiring reads the real clock; the approval fixtures expire a minute after NOW.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the picked conversation from the governed setting", () => {
    const config = (browserErrands: unknown) => ({ assistant: { browserErrands } }) as never;
    expect(readErrandApprovalSessionId(config({ approvalSessionId: " session-dm " }))).toBe("session-dm");
    expect(readErrandApprovalSessionId(config({ approvalSessionId: "  " }))).toBeUndefined();
    expect(readErrandApprovalSessionId(config({ approvalSessionId: 7 }))).toBeUndefined();
    expect(readErrandApprovalSessionId(config(undefined))).toBeUndefined();
  });

  it("the settings lookup names the operator's own conversation and refuses a group", async () => {
    const { storage } = gatewaySetup();
    const lookup = createOwnErrandConversationLookup({ storage, readDiscordPairings: async () => [] });
    await expect(lookup("session-dm")).resolves.toEqual({ conversation: PICKED, title: "Owner’s DM" });

    const group = gatewaySetup({ conversation: { kind: "group", title: "Team" } });
    const groupLookup = createOwnErrandConversationLookup({
      storage: group.storage,
      readDiscordPairings: async () => [],
    });
    await expect(groupLookup("session-dm")).resolves.toBeUndefined();
  });

  it("the settings lookup falls back to the session title, then a generic one, on one printable line", async () => {
    const untitled = gatewaySetup({ conversation: { kind: "direct", counterpartActorId: "owner-1" } });
    const lookup = createOwnErrandConversationLookup({
      storage: untitled.storage,
      readDiscordPairings: async () => [],
    });
    await expect(lookup("session-dm")).resolves.toMatchObject({ title: "Direct message" });

    const titled = gatewaySetup({
      conversation: { kind: "direct", counterpartActorId: "owner-1" },
      sessionTitle: "Me\n\tagain",
    });
    const titledLookup = createOwnErrandConversationLookup({
      storage: titled.storage,
      readDiscordPairings: async () => [],
    });
    await expect(titledLookup("session-dm")).resolves.toMatchObject({ title: "Me again" });
  });

  function gatewaySetup(options: { status?: string; conversation?: unknown; sessionTitle?: string } = {}) {
    const enqueueApprovalRefresh = vi.fn(() => [{ deliveryId: "delivery-1" }]);
    const storage = {
      approvals: { get: vi.fn(async () => approval()) },
      chatAttachments: { get: vi.fn(async () => ({ sessionId: "session-errand" })) },
      chatSessionBindings: {
        get: vi.fn(async () =>
          binding(options.conversation ?? { kind: "direct", counterpartActorId: "owner-1", title: "Owner’s DM" }),
        ),
      },
      chatSessionMeta: { get: vi.fn(async () => (options.sessionTitle ? { title: options.sessionTitle } : undefined)) },
      sessions: { getBySessionId: vi.fn(async () => ({ channel: "telegram" })) },
      integrationConnections: {
        get: vi.fn(async () => ({
          connectionId: "conn-dm",
          kind: "channel",
          key: "telegram",
          label: "Telegram",
          enabled: true,
          status: options.status ?? "connected",
          config: OWNER_CONFIG,
        })),
      },
      mobilePush: { enqueueApprovalRefresh },
    } as unknown as AsyncStorage;
    const createApprovalRemoteActionToken = vi.fn(async () => ({ deliveryStatus: "queued" as const }));
    const recordDelivery = vi.fn();
    const readDiscordPairings = vi.fn(async (): Promise<DiscordPairingRecord[]> => []);
    const escalate = createGatewayErrandEscalation(
      {
        config: { assistant: { browserErrands: { approvalSessionId: "session-dm" } } } as never,
        storage,
        approvals: { createApprovalRemoteActionToken },
        readDiscordPairings,
      },
      () => ({ recordDelivery }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    return {
      storage,
      escalate,
      enqueueApprovalRefresh,
      createApprovalRemoteActionToken,
      recordDelivery,
      readDiscordPairings,
      warn,
    };
  }

  it("sends to the operator's own conversation on a connected connection and records the delivery", async () => {
    const { escalate, enqueueApprovalRefresh, createApprovalRemoteActionToken, recordDelivery, readDiscordPairings } =
      gatewaySetup();
    await escalate(approval(), { kind: "pc" }, "waited");
    expect(createApprovalRemoteActionToken).toHaveBeenCalledWith(
      "approval-1",
      expect.objectContaining({ connectorId: "integration:conn-dm", issuedBy: "system:errand" }),
    );
    expect(recordDelivery).toHaveBeenCalledWith({
      approvalId: "approval-1",
      connectionId: "conn-dm",
      target: "chat-dm",
    });
    expect(enqueueApprovalRefresh).toHaveBeenCalledTimes(1);
    // Telegram's pairing lives in the connection config; Discord's records are not read.
    expect(readDiscordPairings).not.toHaveBeenCalled();
  });

  it("with a disconnected connection, queues only the phone push and warns", async () => {
    const { escalate, enqueueApprovalRefresh, createApprovalRemoteActionToken, warn } = gatewaySetup({
      status: "disconnected",
    });
    await escalate(approval(), { kind: "pc" }, "waited");
    expect(createApprovalRemoteActionToken).not.toHaveBeenCalled();
    expect(enqueueApprovalRefresh).toHaveBeenCalledTimes(1);
    expect(enqueueApprovalRefresh).toHaveBeenCalledWith({
      sourceRealtimeEventId: "approval-escalation:approval-1",
      approvalId: "approval-1",
    });
    expect(warn).toHaveBeenCalledWith(
      "[goatcitadel] errand approval skipped the channel conversation",
      expect.objectContaining({ detail: "connection_unavailable" }),
    );
  });

  it.each([
    ["a group conversation", { kind: "group", title: "Team" }],
    ["a conversation whose kind was never recorded", { title: "Unknown" }],
    ["someone else's direct conversation", { kind: "direct", counterpartActorId: "stranger" }],
  ])("refuses %s as the picked conversation, warns, and still queues the phone push", async (_label, conversation) => {
    const { escalate, enqueueApprovalRefresh, createApprovalRemoteActionToken, warn } = gatewaySetup({ conversation });
    await escalate(approval(), { kind: "pc" }, "waited");
    expect(createApprovalRemoteActionToken).not.toHaveBeenCalled();
    expect(enqueueApprovalRefresh).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[goatcitadel] errand approval conversation is not your own direct conversation",
      expect.objectContaining({ approvalId: "approval-1" }),
    );
  });
});
