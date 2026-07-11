import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, ConnectorRecord } from "@goatcitadel/contracts";
import {
  buildApprovalRemoteTokenConnectorDeliveryPayload,
  enqueueApprovalRemoteTokenConnectorDelivery,
} from "./approval-connector-delivery.js";
import { DurableOperatorPostCommitError } from "./durable-operator-service.js";

describe("buildApprovalRemoteTokenConnectorDeliveryPayload", () => {
  it("never serializes the raw bearer into any connector delivery payload", () => {
    const rawToken = `grat_${"s".repeat(43)}`;
    const tokenRef = "keychain:goatcitadel:approval-remote-action:rat_123";
    const connectors = [
      createConnector("browser", "active", ["approvals", "interactive_actions"]),
      createConnector("integration_connection", "active", ["approvals", "outbound_messages", "interactive_actions"], {
        approvalDeliveryTarget: "#ops-approvals",
        key: "telegram",
        approvalInlineActionsReady: true,
      }),
      createConnector("mcp_server", "active", ["approvals", "interactive_actions"]),
    ];

    for (const connector of connectors) {
      const payload = buildApprovalRemoteTokenConnectorDeliveryPayload({
        approval: createApproval(),
        connector,
        tokenRef,
        tokenId: "rat_123",
        expiresAt: "2099-03-20T12:00:00.000Z",
      });

      expect(payload).toBeDefined();
      expect(JSON.stringify(payload)).not.toContain(rawToken);
    }
  });

  it("stores the bearer before enqueueing an opaque durable delivery", () => {
    const rawToken = `grat_${"q".repeat(43)}`;
    const tokenRef = "keychain:goatcitadel:approval-remote-action:rat_123";
    const createDurableRun = vi.fn(() => ({ runId: "delivery-run-1" }));
    const tokenSecrets = {
      store: vi.fn(() => tokenRef),
      delete: vi.fn(),
    };

    const run = enqueueApprovalRemoteTokenConnectorDelivery(
      {
        tokenSecrets,
        requestAttribution: { traceId: "trace-1", originSurface: "chat" },
        createDurableRun: createDurableRun as never,
      },
      {
        approval: createApproval(),
        connector: createConnector("browser", "active", ["approvals", "interactive_actions"]),
        tokenRecord: { token: rawToken, tokenId: "rat_123", expiresAt: "2099-03-20T12:00:00.000Z" },
      },
    );

    expect(run).toEqual({ runId: "delivery-run-1" });
    expect(tokenSecrets.store).toHaveBeenCalledWith("rat_123", rawToken);
    expect(JSON.stringify(createDurableRun.mock.calls)).not.toContain(rawToken);
    expect(createDurableRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowKey: "connector.delivery",
        payload: expect.objectContaining({
          traceId: "trace-1",
          secretRefs: { approvalActionToken: tokenRef },
        }),
      }),
    );
  });

  it("returns committed durable truth and preserves its secret when post-commit publication fails", () => {
    const rawToken = `grat_${"c".repeat(43)}`;
    const tokenRef = "keychain:goatcitadel:approval-remote-action:rat_committed";
    const committedRun = { runId: "delivery-run-committed", status: "queued" } as never;
    const tokenSecrets = {
      store: vi.fn(() => tokenRef),
      delete: vi.fn(),
    };
    const createDurableRun = vi.fn((input) => {
      expect(input).toMatchObject({
        workflowKey: "connector.delivery",
        payload: expect.objectContaining({ secretRefs: { approvalActionToken: tokenRef } }),
      });
      throw new DurableOperatorPostCommitError(
        "Durable run creation",
        committedRun,
        new Error("processing request unavailable"),
      );
    });

    const run = enqueueApprovalRemoteTokenConnectorDelivery(
      {
        tokenSecrets,
        requestAttribution: {},
        createDurableRun: createDurableRun as never,
      },
      {
        approval: createApproval(),
        connector: createConnector("browser", "active", ["approvals", "interactive_actions"]),
        tokenRecord: {
          token: rawToken,
          tokenId: "rat_committed",
          expiresAt: "2099-03-20T12:00:00.000Z",
        },
      },
    );

    expect(run).toBe(committedRun);
    expect(tokenSecrets.delete).not.toHaveBeenCalled();
  });

  it("deletes an uncommitted secret when durable creation fails before commit", () => {
    const rawToken = `grat_${"f".repeat(43)}`;
    const tokenRef = "keychain:goatcitadel:approval-remote-action:rat_uncommitted";
    const tokenSecrets = {
      store: vi.fn(() => tokenRef),
      delete: vi.fn(),
    };
    const createDurableRun = vi.fn(() => {
      throw new Error("checkpoint write unavailable");
    });

    expect(() =>
      enqueueApprovalRemoteTokenConnectorDelivery(
        {
          tokenSecrets,
          requestAttribution: {},
          createDurableRun: createDurableRun as never,
        },
        {
          approval: createApproval(),
          connector: createConnector("browser", "active", ["approvals", "interactive_actions"]),
          tokenRecord: {
            token: rawToken,
            tokenId: "rat_uncommitted",
            expiresAt: "2099-03-20T12:00:00.000Z",
          },
        },
      ),
    ).toThrow("checkpoint write unavailable");
    expect(tokenSecrets.delete).toHaveBeenCalledWith(tokenRef);
  });

  it("does not fail token issuance when cleanup of an undeliverable connector secret is deferred", () => {
    const rawToken = `grat_${"z".repeat(43)}`;
    const tokenRef = "keychain:goatcitadel:approval-remote-action:rat_deferred_cleanup";
    const tokenSecrets = {
      store: vi.fn(() => tokenRef),
      delete: vi.fn(() => {
        throw new Error("keychain cleanup unavailable");
      }),
    };
    const createDurableRun = vi.fn();
    let run: ReturnType<typeof enqueueApprovalRemoteTokenConnectorDelivery>;

    expect(() => {
      run = enqueueApprovalRemoteTokenConnectorDelivery(
        {
          tokenSecrets,
          requestAttribution: {},
          createDurableRun: createDurableRun as never,
        },
        {
          approval: createApproval(),
          connector: createConnector("browser", "degraded", ["approvals", "interactive_actions"]),
          tokenRecord: {
            token: rawToken,
            tokenId: "rat_deferred_cleanup",
            expiresAt: "2099-03-20T12:00:00.000Z",
          },
        },
      );
    }).not.toThrow();

    expect(run!).toBeUndefined();
    expect(tokenSecrets.store).toHaveBeenCalledWith("rat_deferred_cleanup", rawToken);
    expect(tokenSecrets.delete).toHaveBeenCalledTimes(1);
    expect(tokenSecrets.delete).toHaveBeenCalledWith(tokenRef);
    expect(createDurableRun).not.toHaveBeenCalled();
  });

  it("builds browser delivery payloads for active approval-capable mission control connectors", () => {
    const payload = buildApprovalRemoteTokenConnectorDeliveryPayload({
      approval: createApproval(),
      connector: createConnector("browser", "active", ["approvals", "interactive_actions"]),
      tokenRef: "keychain:goatcitadel:approval-remote-action:rat_123",
      tokenId: "rat_123",
      expiresAt: "2026-03-20T12:00:00.000Z",
    });

    expect(payload).toMatchObject({
      version: "connector.delivery.v1",
      connectorId: "browser:mission-control",
      connectorType: "browser",
      action: "realtime.emit",
      correlationId: "apr_123",
      secretRefs: {
        approvalActionToken: "keychain:goatcitadel:approval-remote-action:rat_123",
      },
      payload: {
        eventType: "approval_remote_action_ready",
        source: "approvals",
        payload: {
          approvalId: "apr_123",
          tokenId: "rat_123",
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
      tokenRef: "keychain:goatcitadel:approval-remote-action:rat_123",
      tokenId: "rat_123",
      expiresAt: "2026-03-20T12:00:00.000Z",
    });
    const channel = buildApprovalRemoteTokenConnectorDeliveryPayload({
      approval,
      connector: createConnector("integration_connection", "active", ["approvals", "outbound_messages"], {
        approvalDeliveryTarget: "#ops-approvals",
      }),
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
    expect(JSON.stringify(browser)).not.toContain("grat_token");
    expect(JSON.stringify(channel)).not.toContain("grat_token");
    expect(JSON.stringify(approval)).toContain("preview-secret");
    expect(JSON.stringify(approval)).toContain("rollback-secret");
  });

  it("adds integration approval buttons only when the provider has authenticated inline-action support", () => {
    const payload = buildApprovalRemoteTokenConnectorDeliveryPayload({
      approval: createApproval(),
      connector: createConnector(
        "integration_connection",
        "active",
        ["approvals", "outbound_messages", "interactive_actions"],
        {
          approvalDeliveryTarget: "#ops-approvals",
          key: "telegram",
          approvalInlineActionsReady: true,
        },
      ),
      tokenRef: "keychain:goatcitadel:approval-remote-action:rat_123",
      tokenId: "rat_123",
      expiresAt: "2026-03-20T12:00:00.000Z",
    });

    expect(payload?.payload?.interactiveActionTemplate).toMatchObject({
      platform: "telegram",
      tokenId: "rat_123",
      tokenRef: "keychain:goatcitadel:approval-remote-action:rat_123",
      buttons: [
        { label: "Approve", decision: "a" },
        { label: "Deny", decision: "r" },
      ],
    });
  });

  it("keeps unsupported integration providers on Mission Control resolution without storing a bearer", () => {
    const rawToken = `grat_${"u".repeat(43)}`;
    const createDurableRun = vi.fn(() => ({ runId: "delivery-run-unsupported" }));
    const tokenSecrets = {
      store: vi.fn(() => "keychain:goatcitadel:approval-remote-action:rat_unsupported"),
      delete: vi.fn(),
    };
    const connector = createConnector(
      "integration_connection",
      "active",
      ["approvals", "outbound_messages", "interactive_actions"],
      {
        approvalDeliveryTarget: "#ops-approvals",
        key: "discord",
        approvalInlineActionsReady: false,
      },
    );

    const run = enqueueApprovalRemoteTokenConnectorDelivery(
      {
        tokenSecrets,
        requestAttribution: {},
        createDurableRun: createDurableRun as never,
      },
      {
        approval: createApproval(),
        connector,
        tokenRecord: { token: rawToken, tokenId: "rat_unsupported", expiresAt: "2099-07-10T00:15:00.000Z" },
      },
    );

    expect(run).toEqual({ runId: "delivery-run-unsupported" });
    expect(tokenSecrets.store).not.toHaveBeenCalled();
    const durableInput = createDurableRun.mock.calls[0]?.[0] as { payload?: Record<string, unknown> };
    expect(durableInput.payload?.secretRefs).toBeUndefined();
    expect((durableInput.payload?.payload as Record<string, unknown>)?.interactiveActionTemplate).toBeUndefined();
    expect(String((durableInput.payload?.payload as Record<string, unknown>)?.message)).toContain(
      "Resolve this approval from Mission Control.",
    );
  });

  it("builds MCP invoke payloads for approval-capable MCP connectors", () => {
    const payload = buildApprovalRemoteTokenConnectorDeliveryPayload({
      approval: createApproval(),
      connector: createConnector("mcp_server", "active", ["approvals", "interactive_actions"]),
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
        tokenId: "rat_123",
        expiresAt: "2026-03-20T12:00:00.000Z",
      }),
    ).toBeDefined();

    expect(
      buildApprovalRemoteTokenConnectorDeliveryPayload({
        approval: createApproval(),
        connector: createConnector("browser", "active", ["approvals"]),
        tokenId: "rat_123",
        expiresAt: "2026-03-20T12:00:00.000Z",
      }),
    ).toBeUndefined();

    expect(
      buildApprovalRemoteTokenConnectorDeliveryPayload({
        approval: createApproval(),
        connector: createConnector("integration_connection", "active", ["approvals", "outbound_messages"]),
        tokenId: "rat_123",
        expiresAt: "2026-03-20T12:00:00.000Z",
      }),
    ).toBeUndefined();

    expect(
      buildApprovalRemoteTokenConnectorDeliveryPayload({
        approval: createApproval(),
        connector: createConnector("browser", "degraded", ["approvals", "interactive_actions"]),
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
