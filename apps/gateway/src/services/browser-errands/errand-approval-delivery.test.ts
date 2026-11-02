import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, ConnectorRecord } from "@goatcitadel/contracts";
import {
  deliverErrandApproval,
  type ErrandApprovalConversation,
  type ErrandApprovalDeliveryDeps,
} from "./errand-approval-delivery.js";

const NOW = Date.parse("2026-11-02T10:00:00.000Z");
const RAW_TOKEN = `grat_${"e".repeat(43)}`;

describe("deliverErrandApproval", () => {
  it("sends text only to a group, with the private-only line", async () => {
    const harness = createHarness();

    const result = await deliverErrandApproval(harness.deps, {
      approval: createApproval(),
      origin: createOrigin({ conversation: "group" }),
      screenshotAttachmentId: "att-before",
    });

    expect(result).toEqual({ delivered: true });
    const [, input] = harness.createToken.mock.calls[0]!;
    expect(input.delivery).toEqual({
      target: "-100777",
      message:
        "GoatCitadel wants to: Click Buy — Places the order\nPage: https://shop.example/cart\n" +
        "Tap Approve or Deny.\nScreenshots are only sent in a private conversation.",
    });
    expect(input.delivery).not.toHaveProperty("attachmentIds");
  });

  it("attaches the screenshot in a private conversation", async () => {
    const harness = createHarness();

    await deliverErrandApproval(harness.deps, {
      approval: createApproval(),
      origin: createOrigin({ conversation: "direct", target: "4242" }),
      screenshotAttachmentId: "att-before",
    });

    const [, input] = harness.createToken.mock.calls[0]!;
    expect(input.delivery).toEqual({
      target: "4242",
      message:
        "GoatCitadel wants to: Click Buy — Places the order\nPage: https://shop.example/cart\nTap Approve or Deny.",
      attachmentIds: ["att-before"],
    });
  });

  it("falls back to the approval's own screenshot when none is passed", async () => {
    const harness = createHarness();

    await deliverErrandApproval(harness.deps, { approval: createApproval(), origin: createOrigin() });

    expect(harness.createToken.mock.calls[0]![1].delivery.attachmentIds).toEqual(["att-preview"]);
  });

  it("asks for a reply when the connection can't take inline buttons", async () => {
    const harness = createHarness({ inlineReady: false });

    await deliverErrandApproval(harness.deps, { approval: createApproval(), origin: createOrigin() });

    expect(harness.createToken.mock.calls[0]![1].delivery.message).toMatch(
      /\nReply APPROVE or DENY\. Reply STOP to end the errand\.$/,
    );
  });

  it("issues one token bound to the conversation's connector, for the approval's remaining time", async () => {
    const harness = createHarness();

    const result = await deliverErrandApproval(harness.deps, { approval: createApproval(), origin: createOrigin() });

    expect(harness.createToken).toHaveBeenCalledTimes(1);
    expect(harness.createToken).toHaveBeenCalledWith(
      "apr_errand",
      expect.objectContaining({
        connectorId: "integration:conn-telegram",
        issuedBy: "system:errand",
        expiresInMs: 120_000,
      }),
    );
    expect(harness.requireConnector).toHaveBeenCalledWith("integration:conn-telegram");
    expect(harness.recordDelivery).toHaveBeenCalledWith({
      approvalId: "apr_errand",
      connectionId: "conn-telegram",
      target: "4242",
    });
    // The raw bearer the issuer returns never comes back out.
    expect(JSON.stringify(result)).not.toContain(RAW_TOKEN);
  });

  it.each([
    { name: "not queued", status: "not_configured" as const, reason: "The channel connection can't send approvals." },
    { name: "failed", status: "failed" as const, reason: "send refused" },
  ])("records nothing when the delivery is $name", async ({ status, reason }) => {
    const harness = createHarness({ deliveryStatus: status, deliveryError: status === "failed" ? reason : undefined });

    await expect(
      deliverErrandApproval(harness.deps, { approval: createApproval(), origin: createOrigin() }),
    ).resolves.toEqual({ delivered: false, reason });
    expect(harness.recordDelivery).not.toHaveBeenCalled();
  });

  it("does not issue a token for a disconnected connection, a resolved approval or an expired one", async () => {
    const disconnected = createHarness({ connectorStatus: "degraded" });
    await expect(
      deliverErrandApproval(disconnected.deps, { approval: createApproval(), origin: createOrigin() }),
    ).resolves.toEqual({ delivered: false, reason: "The channel connection is not connected." });

    const resolved = createHarness();
    await expect(
      deliverErrandApproval(resolved.deps, {
        approval: createApproval({ status: "approved" }),
        origin: createOrigin(),
      }),
    ).resolves.toMatchObject({ delivered: false });

    const expired = createHarness();
    await expect(
      deliverErrandApproval(expired.deps, {
        approval: createApproval({ expiresAt: "2026-11-02T09:59:59.000Z" }),
        origin: createOrigin(),
      }),
    ).resolves.toEqual({ delivered: false, reason: "The approval has expired." });

    for (const harness of [disconnected, resolved, expired]) {
      expect(harness.createToken).not.toHaveBeenCalled();
      expect(harness.recordDelivery).not.toHaveBeenCalled();
    }
  });

  it("turns an issuance error into a not-delivered result", async () => {
    const harness = createHarness();
    harness.createToken.mockRejectedValueOnce(new Error("Approval apr_errand has expired."));

    await expect(
      deliverErrandApproval(harness.deps, { approval: createApproval(), origin: createOrigin() }),
    ).resolves.toEqual({ delivered: false, reason: "Approval apr_errand has expired." });
  });
});

function createHarness(
  options: {
    inlineReady?: boolean;
    connectorStatus?: ConnectorRecord["status"];
    deliveryStatus?: "queued" | "not_configured" | "failed";
    deliveryError?: string;
  } = {},
) {
  const requireConnector = vi.fn(
    async (connectorId: string): Promise<ConnectorRecord> => ({
      connectorId,
      connectorType: "integration_connection",
      label: "Telegram",
      sourceId: "conn-telegram",
      status: options.connectorStatus ?? "active",
      capabilities: [
        { id: "outbound_messages", enabled: true, version: "v1" },
        { id: "interactive_actions", enabled: true, version: "v1" },
      ],
      metadata: { key: "telegram", approvalInlineActionsReady: options.inlineReady ?? true },
    }),
  );
  const createToken = vi.fn<ErrandApprovalDeliveryDeps["createApprovalRemoteActionToken"]>(async () => ({
    token: RAW_TOKEN,
    deliveryStatus: options.deliveryStatus ?? "queued",
    ...(options.deliveryError ? { deliveryError: options.deliveryError } : {}),
  }));
  const recordDelivery = vi.fn();
  const deps: ErrandApprovalDeliveryDeps = {
    requireConnectorRecord: requireConnector,
    createApprovalRemoteActionToken: createToken,
    recordDelivery,
    now: () => NOW,
  };
  return { deps, requireConnector, createToken, recordDelivery };
}

function createOrigin(overrides: Partial<ErrandApprovalConversation> = {}): ErrandApprovalConversation {
  return {
    connectionId: "conn-telegram",
    channelKey: "telegram",
    target: overrides.conversation === "group" ? "-100777" : "4242",
    conversation: "direct",
    ...overrides,
  };
}

function createApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: "apr_errand",
    kind: "browser.errand.action",
    riskLevel: "danger",
    status: "pending",
    payload: {},
    preview: {
      summary: "Click Buy — Places the order",
      url: "https://shop.example/cart",
      title: "Cart",
      screenshotAttachmentId: "att-preview",
      screenshotSha256: "abc",
    },
    createdAt: "2026-11-02T09:59:00.000Z",
    expiresAt: "2026-11-02T10:02:00.000Z",
    explanationStatus: "not_requested",
    ...overrides,
  };
}
