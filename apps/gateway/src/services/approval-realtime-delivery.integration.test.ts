import { describe, expect, it, vi } from "vitest";
import type {
  ApprovalRequest,
  ChannelSendInput,
  ConnectorRecord,
  DurableRunRecord,
  ExternalSideEffectRunRecord,
  RealtimeEvent,
} from "@goatcitadel/contracts";
import { buildApprovalRemoteTokenConnectorDeliveryPayload } from "./approval-connector-delivery.js";
import { dispatchConnectorDelivery } from "./connector-delivery.js";
import { executeDurableConnectorDeliveryRun } from "./durable-execution-service.js";
import { buildChannelDeliveryPayload, sendQueuedChannelDelivery } from "./gateway/channel-delivery-helpers.js";
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

  it("keeps integration approval bearers sealed across durable and channel queues through the policy handoff", async () => {
    const rawToken = `grat_${"i".repeat(43)}`;
    const tokenRef = "keychain:goatcitadel:approval-remote-action:rat_integration";
    const connector = createIntegrationConnector();
    const workflow = buildApprovalRemoteTokenConnectorDeliveryPayload({
      approval: createApproval(),
      connector,
      tokenRef,
      tokenId: "rat_integration",
      expiresAt: "2099-07-10T00:15:00.000Z",
    });
    expect(workflow).toBeDefined();
    const run: DurableRunRecord = {
      runId: "durable-integration-approval",
      workflowKey: "connector.delivery",
      status: "running",
      attemptCount: 1,
      maxAttempts: 3,
      version: 1,
      payload: workflow as unknown as Record<string, unknown>,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:01.000Z",
    };
    let queuedPayload: Record<string, unknown> | undefined;
    const resolveToken = vi.fn(() => rawToken);
    const deleteToken = vi.fn();
    const commsSend = vi.fn(async (input: ChannelSendInput) => {
      expect(input.interactiveActions).toBeUndefined();
      expect(input.interactiveActionTemplate).toMatchObject({ tokenRef, tokenId: "rat_integration" });
      queuedPayload = buildChannelDeliveryPayload(input, "telegram");
      return {
        deliveryId: "delivery-integration-approval",
        status: "queued",
        deliveryStatus: "retrying",
        createdAt: "2026-07-10T00:00:01.000Z",
        updatedAt: "2026-07-10T00:00:01.000Z",
      };
    });
    const updateRun = vi.fn();
    const createCheckpoint = vi.fn();

    await executeDurableConnectorDeliveryRun(
      {
        requireConnectorRecord: vi.fn(() => connector),
        approvalRemoteTokenSecrets: { resolve: resolveToken, delete: deleteToken },
        commsSend,
        commsReply: vi.fn(),
        commsReact: vi.fn(),
        commsUnsend: vi.fn(),
        commsTyping: vi.fn(),
        commsActivity: vi.fn(),
        invokeMcpTool: vi.fn(),
        resolveDurableRunHookWorkspaceId: vi.fn(() => "default"),
        storage: {
          ...createStrictSideEffectStores(),
          durableRuns: {
            getRun: vi.fn(() => run),
            updateRun,
            createCheckpoint,
          },
        },
        recordDurableTimelineEvent: vi.fn(),
        publishRealtime: vi.fn(),
      } as never,
      run,
    );

    expect(commsSend).toHaveBeenCalledTimes(1);
    expect(resolveToken).not.toHaveBeenCalled();
    expect(deleteToken).not.toHaveBeenCalled();
    expect(queuedPayload).toBeDefined();
    expect(JSON.stringify(queuedPayload)).not.toContain(rawToken);
    expect(JSON.stringify(queuedPayload)).toContain(tokenRef);
    expect(JSON.stringify(updateRun.mock.calls)).not.toContain(rawToken);
    expect(JSON.stringify(createCheckpoint.mock.calls)).not.toContain(rawToken);

    const providerSend = vi.fn(async (input: ChannelSendInput) => {
      expect(input.interactiveActions).toBeUndefined();
      expect(input.interactiveActionTemplate).toMatchObject({ tokenId: "rat_integration", tokenRef });
      expect(JSON.stringify(input)).not.toContain(rawToken);
      return { status: "sent", providerMessageId: "provider-integration-approval" };
    });
    await sendQueuedChannelDelivery(providerSend, createChannelRuntimeInput(queuedPayload!));

    expect(resolveToken).not.toHaveBeenCalled();
    expect(deleteToken).not.toHaveBeenCalled();
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

function createStrictSideEffectStores() {
  let mutationStatus: "pending" | "completed" | "failed" | undefined;
  let sideEffect: ExternalSideEffectRunRecord | undefined;
  return {
    runImmediateTransaction: <T>(callback: () => T): T => callback(),
    mutationIdempotency: {
      claim: (input: { payloadHash: string }) => {
        if (!mutationStatus) {
          mutationStatus = "pending";
          return {
            outcome: "claimed" as const,
            claimKind: "new" as const,
            record: { payloadHash: input.payloadHash, status: mutationStatus },
          };
        }
        return {
          outcome: mutationStatus === "completed" ? ("duplicate" as const) : ("in_progress" as const),
          record: { payloadHash: input.payloadHash, status: mutationStatus },
        };
      },
      markCompleted: () => {
        mutationStatus = "completed";
      },
      markFailed: () => {
        mutationStatus = "failed";
      },
    },
    externalSideEffectRuns: {
      createOrGet: (input: Record<string, unknown>, createdAt = new Date().toISOString()) => {
        sideEffect ??= {
          runId: "side-effect-approval-delivery",
          workspaceId: String(input.workspaceId ?? "default"),
          boundary: String(input.boundary),
          routePath: String(input.routePath),
          catalogId: typeof input.catalogId === "string" ? input.catalogId : undefined,
          connectionId: typeof input.connectionId === "string" ? input.connectionId : undefined,
          actionId: typeof input.actionId === "string" ? input.actionId : undefined,
          actorScope: String(input.actorScope ?? ""),
          idempotencyKey: String(input.idempotencyKey),
          payloadHash: String(input.payloadHash),
          status: (input.status ?? "claimed_not_sent") as ExternalSideEffectRunRecord["status"],
          replayPolicy: "idempotent_external",
          replayOutcome: input.replayOutcome as ExternalSideEffectRunRecord["replayOutcome"],
          replayAttempt: input.replayAttempt as ExternalSideEffectRunRecord["replayAttempt"],
          resumeState: "not_resumable",
          attemptCount: 0,
          createdAt,
          updatedAt: createdAt,
        };
        return sideEffect;
      },
      markExternalCallStarted: () => updateStrictSideEffect("external_call_started"),
      markCompleted: () => updateStrictSideEffect("completed"),
      markFailure: (_runId: string, input: { status: "failed_before_boundary" | "unknown_external_outcome" }) =>
        updateStrictSideEffect(input.status),
    },
  };

  function updateStrictSideEffect(status: ExternalSideEffectRunRecord["status"]): ExternalSideEffectRunRecord {
    sideEffect = { ...sideEffect!, status, updatedAt: new Date().toISOString() };
    return sideEffect;
  }
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

function createIntegrationConnector(): ConnectorRecord {
  return {
    connectorId: "integration:approval-actions",
    connectorType: "integration_connection",
    label: "Approval actions",
    sourceId: "connection-approval-actions",
    status: "active",
    capabilities: [
      { id: "approvals", enabled: true, version: "v1" },
      { id: "outbound_messages", enabled: true, version: "v1" },
      { id: "interactive_actions", enabled: true, version: "v1" },
    ],
    metadata: {
      approvalDeliveryTarget: "#approvals",
      approvalDeliveryPlatform: "telegram",
      approvalInlineActionsReady: true,
    },
  };
}

function createChannelRuntimeInput(payload: Record<string, unknown>) {
  return {
    deliveryId: "delivery-integration-approval",
    connectionId: "connection-approval-actions",
    channelKey: "telegram",
    target: "#approvals",
    status: "running",
    attempts: 1,
    maxAttempts: 3,
    createdAt: "2026-07-10T00:00:01.000Z",
    updatedAt: "2026-07-10T00:00:02.000Z",
    payload,
  } as const;
}
