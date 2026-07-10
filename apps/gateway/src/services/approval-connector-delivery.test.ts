import { describe, expect, it } from "vitest";
import type { ApprovalRequest, ConnectorRecord } from "@goatcitadel/contracts";
import { buildApprovalRemoteTokenConnectorDeliveryPayload } from "./approval-connector-delivery.js";

describe("buildApprovalRemoteTokenConnectorDeliveryPayload", () => {
  it("builds browser delivery payloads for active approval-capable mission control connectors", () => {
    const payload = buildApprovalRemoteTokenConnectorDeliveryPayload({
      approval: createApproval(),
      connector: createConnector("browser", "active", ["approvals", "interactive_actions"]),
      token: "grat_token",
      tokenId: "rat_123",
      expiresAt: "2026-03-20T12:00:00.000Z",
    });

    expect(payload).toMatchObject({
      version: "connector.delivery.v1",
      connectorId: "browser:mission-control",
      connectorType: "browser",
      action: "realtime.emit",
      correlationId: "apr_123",
      payload: {
        eventType: "approval_remote_action_ready",
        source: "approvals",
        payload: {
          approvalId: "apr_123",
          tokenId: "rat_123",
          token: "grat_token",
          actionType: "approval.resolve",
          expiresAt: "2026-03-20T12:00:00.000Z",
        },
      },
    });
  });

  it("builds integration channel delivery payloads when a default target is available", () => {
    const payload = buildApprovalRemoteTokenConnectorDeliveryPayload({
      approval: createApproval(),
      connector: createConnector("integration_connection", "active", ["approvals", "outbound_messages"], {
        approvalDeliveryTarget: "#ops-approvals",
      }),
      token: "grat_token",
      tokenId: "rat_123",
      expiresAt: "2026-03-20T12:00:00.000Z",
    });

    expect(payload).toMatchObject({
      version: "connector.delivery.v1",
      connectorId: "integration:channel-1",
      connectorType: "integration_connection",
      action: "channel.send",
      correlationId: "apr_123",
      payload: {
        target: "#ops-approvals",
      },
    });
    expect(payload?.payload?.message).toContain("GoatCitadel approval action requested.");
    expect(payload?.payload?.message).toContain("Action token ID: rat_123");
    expect(payload?.payload?.message).toContain("Requester: n/a");
    expect(payload?.payload?.message).toContain("Rollback: n/a");
    expect(payload?.payload?.message).not.toContain("grat_token");
    expect(payload?.payload?.message).toContain("Resolve this approval from Mission Control.");
    expect(payload?.payload?.interactiveActions).toBeUndefined();
  });

  it("renders requester and rollback notes for integration approval delivery", () => {
    const payload = buildApprovalRemoteTokenConnectorDeliveryPayload({
      approval: createApproval({
        payload: {
          requesterActorId: "actor-1",
          requesterDisplayName: "Operator One",
          rollbackNote: "Restore the previous file from backup.",
        },
      }),
      connector: createConnector("integration_connection", "active", ["approvals", "outbound_messages"], {
        approvalDeliveryTarget: "#ops-approvals",
      }),
      token: "grat_token",
      tokenId: "rat_123",
      expiresAt: "2026-03-20T12:00:00.000Z",
    });

    expect(payload?.payload?.message).toContain("Requester: Operator One (actor-1)");
    expect(payload?.payload?.message).toContain("Rollback: Restore the previous file from backup.");
  });

  it("contains preview and rollback secrets while preserving the intended one-time action token", () => {
    const approval = createApproval({
      preview: {
        summary: "Send the governed action.",
        webhookUrl: "https://hooks.example.test/services/team/preview-secret",
        authorization: "Bearer short",
        DATABASE_PASSWORD: "hunter2",
      },
      payload: {
        rollbackNote: '{"DATABASE_PASSWORD":"rollback-secret"}',
      },
    });
    const browser = buildApprovalRemoteTokenConnectorDeliveryPayload({
      approval,
      connector: createConnector("browser", "active", ["approvals", "interactive_actions"]),
      token: "grat_token",
      tokenId: "rat_123",
      expiresAt: "2026-03-20T12:00:00.000Z",
    });
    const channel = buildApprovalRemoteTokenConnectorDeliveryPayload({
      approval,
      connector: createConnector("integration_connection", "active", ["approvals", "outbound_messages"], {
        approvalDeliveryTarget: "#ops-approvals",
      }),
      token: "grat_token",
      tokenId: "rat_123",
      expiresAt: "2026-03-20T12:00:00.000Z",
    });

    for (const delivery of [browser, channel]) {
      const serialized = JSON.stringify(delivery);
      expect(serialized).not.toContain("preview-secret");
      expect(serialized).not.toContain("Bearer short");
      expect(serialized).not.toContain("hunter2");
      expect(serialized).not.toContain("rollback-secret");
      expect(serialized).toContain("rat_123");
    }
    expect(JSON.stringify(browser)).toContain("grat_token");
    expect(JSON.stringify(channel)).not.toContain("grat_token");
    expect(JSON.stringify(approval)).toContain("preview-secret");
    expect(JSON.stringify(approval)).toContain("rollback-secret");
  });

  it("adds integration approval buttons only when interactive actions are enabled", () => {
    const payload = buildApprovalRemoteTokenConnectorDeliveryPayload({
      approval: createApproval(),
      connector: createConnector(
        "integration_connection",
        "active",
        ["approvals", "outbound_messages", "interactive_actions"],
        {
          approvalDeliveryTarget: "#ops-approvals",
          key: "discord",
        },
      ),
      token: "grat_token",
      tokenId: "rat_123",
      expiresAt: "2026-03-20T12:00:00.000Z",
    });

    expect(payload?.payload?.interactiveActions).toMatchObject({
      platform: "discord",
      tokenId: "rat_123",
      buttons: [
        { label: "Approve", callbackData: "gca:grat_token:a" },
        { label: "Deny", callbackData: "gca:grat_token:r" },
      ],
    });
  });

  it("builds MCP invoke payloads for approval-capable MCP connectors", () => {
    const payload = buildApprovalRemoteTokenConnectorDeliveryPayload({
      approval: createApproval(),
      connector: createConnector("mcp_server", "active", ["approvals", "interactive_actions"]),
      token: "grat_token",
      tokenId: "rat_123",
      expiresAt: "2026-03-20T12:00:00.000Z",
    });

    expect(payload).toMatchObject({
      version: "connector.delivery.v1",
      connectorId: "mcp:server-1",
      connectorType: "mcp_server",
      action: "mcp.invoke",
      correlationId: "apr_123",
      workspaceId: "workspace-1",
      taskId: "task-1",
      runId: "durable-run-1",
      operatorId: "operator-1",
      authActorId: "actor-1",
      authActorSource: "loopback",
      permissionProfileId: "profile-safe",
      localOperatorOverrideId: "override-1",
      originSurface: "cowork",
      payload: {
        approvalId: "apr_123",
        toolName: "goatcitadel.approval.remote_action_ready",
        workspaceId: "workspace-1",
        taskId: "task-1",
        runId: "durable-run-1",
        operatorId: "operator-1",
        authActorId: "actor-1",
        authActorSource: "loopback",
        permissionProfileId: "profile-safe",
        localOperatorOverrideId: "override-1",
        originSurface: "cowork",
        arguments: {
          approvalId: "apr_123",
          tokenId: "rat_123",
          token: "grat_token",
          actionType: "approval.resolve",
          expiresAt: "2026-03-20T12:00:00.000Z",
          governance: {
            workspaceId: "workspace-1",
            taskId: "task-1",
            runId: "durable-run-1",
            operatorId: "operator-1",
            authActorId: "actor-1",
            authActorSource: "loopback",
            permissionProfileId: "profile-safe",
            localOperatorOverrideId: "override-1",
            originSurface: "cowork",
          },
          linkage: {
            workspaceId: "workspace-1",
            taskId: "task-1",
            durableRunId: "durable-run-1",
            originSurface: "cowork",
            operatorId: "operator-1",
            authActorId: "actor-1",
            authActorSource: "loopback",
          },
        },
      },
    });
  });

  it("preserves A2A peer auth provenance in delivery governance and linkage", () => {
    const payload = buildApprovalRemoteTokenConnectorDeliveryPayload({
      approval: createApproval({
        linkage: {
          workspaceId: "workspace-1",
          taskId: "task-1",
          durableRunId: "durable-run-1",
          originSurface: "cowork",
          operatorId: "operator-1",
          authActorId: "peer-1",
          authActorSource: "a2a_peer",
        },
      }),
      connector: createConnector("mcp_server", "active", ["approvals", "interactive_actions"]),
      token: "grat_token",
      tokenId: "rat_123",
      expiresAt: "2026-03-20T12:00:00.000Z",
    });

    expect(payload).toMatchObject({
      authActorId: "peer-1",
      authActorSource: "a2a_peer",
      payload: {
        authActorId: "peer-1",
        authActorSource: "a2a_peer",
        arguments: {
          governance: {
            authActorId: "peer-1",
            authActorSource: "a2a_peer",
          },
          linkage: {
            authActorId: "peer-1",
            authActorSource: "a2a_peer",
          },
        },
      },
    });
  });

  it("skips connectors without the required delivery capabilities or metadata", () => {
    expect(
      buildApprovalRemoteTokenConnectorDeliveryPayload({
        approval: createApproval(),
        connector: createConnector("mcp_server", "active", ["approvals", "interactive_actions"]),
        token: "grat_token",
        tokenId: "rat_123",
        expiresAt: "2026-03-20T12:00:00.000Z",
      }),
    ).toBeDefined();

    expect(
      buildApprovalRemoteTokenConnectorDeliveryPayload({
        approval: createApproval(),
        connector: createConnector("browser", "active", ["approvals"]),
        token: "grat_token",
        tokenId: "rat_123",
        expiresAt: "2026-03-20T12:00:00.000Z",
      }),
    ).toBeUndefined();

    expect(
      buildApprovalRemoteTokenConnectorDeliveryPayload({
        approval: createApproval(),
        connector: createConnector("integration_connection", "active", ["approvals", "outbound_messages"]),
        token: "grat_token",
        tokenId: "rat_123",
        expiresAt: "2026-03-20T12:00:00.000Z",
      }),
    ).toBeUndefined();

    expect(
      buildApprovalRemoteTokenConnectorDeliveryPayload({
        approval: createApproval(),
        connector: createConnector("browser", "degraded", ["approvals", "interactive_actions"]),
        token: "grat_token",
        tokenId: "rat_123",
        expiresAt: "2026-03-20T12:00:00.000Z",
      }),
    ).toBeUndefined();
  });
});

function createApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: "apr_123",
    kind: "tool.invoke",
    riskLevel: "danger",
    status: "pending",
    payload: {
      toolName: "fs.write",
      permissionProfileId: "profile-safe",
      localOperatorOverrideId: "override-1",
    },
    preview: { summary: "Write file" },
    linkage: {
      workspaceId: "workspace-1",
      taskId: "task-1",
      durableRunId: "durable-run-1",
      originSurface: "cowork",
      operatorId: "operator-1",
      authActorId: "actor-1",
      authActorSource: "loopback",
    },
    createdAt: "2026-03-20T11:00:00.000Z",
    explanationStatus: "not_requested",
    ...overrides,
  };
}

function createConnector(
  connectorType: ConnectorRecord["connectorType"],
  status: ConnectorRecord["status"],
  capabilityIds: Array<ConnectorRecord["capabilities"][number]["id"]>,
  metadata: Record<string, unknown> = {},
): ConnectorRecord {
  return {
    connectorId:
      connectorType === "browser"
        ? "browser:mission-control"
        : connectorType === "mcp_server"
          ? "mcp:server-1"
          : "integration:channel-1",
    connectorType,
    label: "Connector",
    sourceId:
      connectorType === "browser" ? "mission-control-web" : connectorType === "mcp_server" ? "server-1" : "channel-1",
    status,
    capabilities: capabilityIds.map((id) => ({
      id,
      enabled: true,
      version: "v1",
    })),
    metadata,
  };
}
