import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, ConnectorRecord, RealtimeEvent } from "@goatcitadel/contracts";
import { buildApprovalRemoteTokenConnectorDeliveryPayload } from "./approval-connector-delivery.js";
import { dispatchConnectorDelivery } from "./connector-delivery.js";
import { RealtimeEventService } from "./realtime-event-service.js";

describe("browser approval realtime delivery", () => {
  it("delivers the one-time token only to the authorized live subscriber while retention stays redacted", async () => {
    const actionToken = `grat_${"a".repeat(43)}`;
    const rows: RealtimeEvent[] = [];
    const storage = createRealtimeStorage(rows);
    const realtime = new RealtimeEventService({ storage, getGatewayNodeId: () => "node-1" });
    const publicListener = vi.fn();
    const approvalDeliveryListener = vi.fn();
    realtime.subscribeRealtime(publicListener);
    realtime.subscribeRealtime(approvalDeliveryListener, { includeApprovalActionTokens: true });

    const connector = createBrowserConnector();
    const workflow = buildApprovalRemoteTokenConnectorDeliveryPayload({
      approval: createApproval(),
      connector,
      tokenRef: "keychain:goatcitadel:approval-remote-action:rat_123",
      tokenId: "rat_123",
      expiresAt: "2026-07-10T00:00:00.000Z",
    });
    expect(workflow).toBeDefined();
    expect(JSON.stringify(workflow)).not.toContain(actionToken);
    const liveWorkflow = {
      ...workflow!,
      payload: {
        ...workflow!.payload,
        payload: {
          ...((workflow!.payload?.payload as Record<string, unknown>) ?? {}),
          token: actionToken,
        },
      },
    };

    await dispatchConnectorDelivery(connector, liveWorkflow, {
      commsSend: vi.fn(),
      commsReply: vi.fn(),
      commsReact: vi.fn(),
      commsUnsend: vi.fn(),
      commsTyping: vi.fn(),
      invokeMcpTool: vi.fn(),
      publishRealtime: (eventType, source, payload, options) => {
        realtime.publishRealtime(eventType, source, payload, options);
      },
    });

    expect(publicListener).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ token: "[REDACTED]" }) }),
    );
    expect(approvalDeliveryListener).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "approval_remote_action_ready",
        source: "approvals",
        payload: expect.objectContaining({
          connectorId: "browser:mission-control",
          approvalId: "apr_123",
          tokenId: "rat_123",
          token: actionToken,
          actionType: "approval.resolve",
        }),
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload.token).toBe("[REDACTED]");
    expect(realtime.listRealtimeEvents()[0]?.payload.token).toBe("[REDACTED]");

    realtime.publishRealtime(
      "approval_remote_action_ready",
      "approvals",
      {
        connectorId: "browser:mission-control",
        approvalId: "apr_spoofed",
        tokenId: "rat_spoofed",
        token: `grat_${"b".repeat(43)}`,
        action: "realtime.emit",
        actionType: "approval.resolve",
      },
      {
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
        links: { connectorId: "browser:mission-control", approvalId: "apr_different" },
      },
    );

    expect(approvalDeliveryListener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        eventType: "approval_remote_action_ready",
        payload: expect.objectContaining({ token: "[REDACTED]" }),
      }),
    );

    realtime.publishRealtime("generic_token_event", "tests", {
      token: "must_not_cross_live_boundary",
      tokenId: "safe-token-id",
    });

    expect(approvalDeliveryListener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        eventType: "generic_token_event",
        payload: { token: "[REDACTED]", tokenId: "safe-token-id" },
      }),
    );
    expect(JSON.stringify(rows)).not.toContain("must_not_cross_live_boundary");
  });
});

function createRealtimeStorage(rows: RealtimeEvent[]) {
  let sequence = 0;
  return {
    realtimeEvents: {
      append: vi.fn(
        (
          eventType: string,
          source: string,
          payload: Record<string, unknown>,
          options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
        ) => {
          sequence += 1;
          const event = {
            eventId: `event-${sequence}`,
            sequence,
            eventType,
            source,
            timestamp: "2026-07-09T12:00:00.000Z",
            payload,
            ...options,
          } as RealtimeEvent;
          rows.push(event);
          return event;
        },
      ),
      list: vi.fn(() => [...rows]),
      listAfterSequence: vi.fn((afterSequence: number) => rows.filter((event) => event.sequence > afterSequence)),
      getSequenceBounds: vi.fn(() => ({
        oldestSequence: rows[0]?.sequence,
        newestSequence: rows.at(-1)?.sequence,
      })),
    },
    realtimeStreamLeases: {
      open: vi.fn(),
      touch: vi.fn(),
      close: vi.fn(),
    },
  };
}

function createApproval(): ApprovalRequest {
  return {
    approvalId: "apr_123",
    kind: "tool.invoke",
    riskLevel: "danger",
    status: "pending",
    payload: {},
    preview: { summary: "Write file" },
    createdAt: "2026-07-09T11:00:00.000Z",
    explanationStatus: "not_requested",
  };
}

function createBrowserConnector(): ConnectorRecord {
  return {
    connectorId: "browser:mission-control",
    connectorType: "browser",
    label: "Mission Control",
    sourceId: "mission-control-web",
    status: "active",
    capabilities: [
      { id: "approvals", enabled: true, version: "v1" },
      { id: "interactive_actions", enabled: true, version: "v1" },
    ],
    metadata: {},
  };
}
