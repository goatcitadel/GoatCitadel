import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, ConnectorRecord } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import {
  deliverErrandApproval,
  type ErrandApprovalConversation,
  type ErrandApprovalDeliveryDeps,
} from "./errand-approval-delivery.js";
import { ERRAND_APPROVAL_KIND } from "./errand-constants.js";
import { createErrandEscalation, type ErrandEscalationDeps } from "./errand-escalation.js";
import { createGatewayErrandEscalation, readErrandApprovalSessionId } from "./errand-escalation-gateway.js";
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
  it("sends a channel errand's approval to its origin conversation and not to the phone", async () => {
    const { escalate, deps, delivery } = setup();
    await escalate(approval(), CHANNEL_ORIGIN);
    expect(deps.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ origin: CHANNEL_ORIGIN, screenshotAttachmentId: "attachment-before" }),
    );
    expect(delivery.recordDelivery).toHaveBeenCalledWith({
      approvalId: "approval-1",
      connectionId: "conn-origin",
      target: "chat-origin",
    });
    expect(deps.pushToPhone).not.toHaveBeenCalled();
  });

  it("sends a PC errand's approval to the picked conversation and the phone", async () => {
    const { escalate, deps, delivery } = setup({ sessionId: "session-dm" });
    await escalate(approval(), { kind: "pc" });
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
    await escalate(approval(), { kind: "pc" });
    expect(deps.conversationFor).not.toHaveBeenCalled();
    expect(deps.deliver).not.toHaveBeenCalled();
    expect(deps.pushToPhone).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("with a disconnected connection, skips the channel with a warning and still sends to the phone", async () => {
    const { escalate, deps, delivery, warn } = setup({ sessionId: "session-dm", status: "degraded" });
    await escalate(approval(), { kind: "pc" });
    expect(delivery.createApprovalRemoteActionToken).not.toHaveBeenCalled();
    expect(delivery.recordDelivery).not.toHaveBeenCalled();
    expect(deps.pushToPhone).toHaveBeenCalledWith("approval-1");
    expect(warn).toHaveBeenCalledWith(
      "[goatcitadel] errand approval skipped the channel conversation",
      expect.objectContaining({ approvalId: "approval-1", connectionId: "conn-dm", detail: "connection_unavailable" }),
    );
  });

  it("with a picked session that is no channel conversation, warns and still sends to the phone", async () => {
    const { escalate, deps, warn } = setup({ sessionId: "session-mission" });
    await escalate(approval(), { kind: "pc" });
    expect(deps.deliver).not.toHaveBeenCalled();
    expect(deps.pushToPhone).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("still sends to the phone when the channel delivery throws", async () => {
    const { escalate, deps } = setup({ sessionId: "session-dm" });
    vi.mocked(deps.deliver).mockRejectedValueOnce(new Error("boom"));
    await escalate(approval(), { kind: "pc" });
    expect(deps.pushToPhone).toHaveBeenCalledTimes(1);
  });

  it("sends nothing for an approval answered in the meantime", async () => {
    const { escalate, deps } = setup({ sessionId: "session-dm", stored: approval({ status: "approved" }) });
    await escalate(approval(), { kind: "pc" });
    await escalate(approval(), CHANNEL_ORIGIN);
    expect(deps.deliver).not.toHaveBeenCalled();
    expect(deps.pushToPhone).not.toHaveBeenCalled();
  });
});

describe("Gateway errand escalation", () => {
  it("reads the picked conversation from config until the governed setting exists", () => {
    expect(readErrandApprovalSessionId({ browserErrands: { approvalSessionId: " session-dm " } })).toBe("session-dm");
    expect(readErrandApprovalSessionId({ browserErrands: { approvalSessionId: "  " } })).toBeUndefined();
    expect(readErrandApprovalSessionId({ browserErrands: { approvalSessionId: 7 } })).toBeUndefined();
    expect(readErrandApprovalSessionId({})).toBeUndefined();
  });

  function gatewaySetup(connectionStatus: string) {
    const enqueueApprovalRefresh = vi.fn(() => [{ deliveryId: "delivery-1" }]);
    const storage = {
      approvals: { get: vi.fn(async () => approval()) },
      chatAttachments: { get: vi.fn(async () => ({ sessionId: "session-errand" })) },
      chatSessionBindings: {
        get: vi.fn(async () => ({
          sessionId: "session-dm",
          transport: "integration",
          connectionId: "conn-dm",
          target: "chat-dm",
          conversation: { kind: "direct" },
        })),
      },
      sessions: { getBySessionId: vi.fn(async () => ({ channel: "telegram" })) },
      integrationConnections: {
        get: vi.fn(async () => ({
          connectionId: "conn-dm",
          kind: "channel",
          key: "telegram",
          label: "Telegram",
          enabled: true,
          status: connectionStatus,
          config: {},
        })),
      },
      mobilePush: { enqueueApprovalRefresh },
    } as unknown as AsyncStorage;
    const createApprovalRemoteActionToken = vi.fn(async () => ({ deliveryStatus: "queued" as const }));
    const recordDelivery = vi.fn();
    const escalate = createGatewayErrandEscalation(
      {
        config: { browserErrands: { approvalSessionId: "session-dm" } },
        storage,
        approvals: { createApprovalRemoteActionToken },
      },
      () => ({ recordDelivery }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    return { escalate, enqueueApprovalRefresh, createApprovalRemoteActionToken, recordDelivery, warn };
  }

  it("sends to the picked conversation on a connected connection and records the delivery", async () => {
    const { escalate, enqueueApprovalRefresh, createApprovalRemoteActionToken, recordDelivery } =
      gatewaySetup("connected");
    await escalate(approval(), { kind: "pc" });
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
  });

  it("with a disconnected connection, queues only the phone push and warns", async () => {
    const { escalate, enqueueApprovalRefresh, createApprovalRemoteActionToken, warn } = gatewaySetup("disconnected");
    await escalate(approval(), { kind: "pc" });
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
});
