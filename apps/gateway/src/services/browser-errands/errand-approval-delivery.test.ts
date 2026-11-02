import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, ConnectorRecord } from "@goatcitadel/contracts";
import {
  deliverErrandApproval,
  type ErrandApprovalConversation,
  type ErrandApprovalDeliveryDeps,
} from "./errand-approval-delivery.js";

const NOW = Date.parse("2026-11-02T10:00:00.000Z");
const RAW_TOKEN = `grat_${"e".repeat(43)}`;
const SESSION_ID = "session-errand";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deliverErrandApproval", () => {
  it("sends plain text only to a group, with the private-only line", async () => {
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
      plainText: true,
    });
    // A group never even looks the screenshot up.
    expect(harness.attachmentSessionId).not.toHaveBeenCalled();
  });

  it("attaches the screenshot in a private conversation when it belongs to the approval's session", async () => {
    const harness = createHarness();

    await deliverErrandApproval(harness.deps, {
      approval: createApproval(),
      origin: createOrigin({ conversation: "direct", target: "4242" }),
      screenshotAttachmentId: "att-before",
    });

    expect(harness.attachmentSessionId).toHaveBeenCalledWith("att-before");
    const [, input] = harness.createToken.mock.calls[0]!;
    expect(input.delivery).toEqual({
      target: "4242",
      message:
        "GoatCitadel wants to: Click Buy — Places the order\nPage: https://shop.example/cart\nTap Approve or Deny.",
      plainText: true,
      attachmentIds: ["att-before"],
    });
  });

  it.each([
    { name: "another session's attachment", owner: "session-other" },
    { name: "an unreadable attachment", owner: new Error("not found") },
  ])("still delivers, without the screenshot, for $name", async ({ owner }) => {
    const harness = createHarness({ attachmentOwner: owner });

    const result = await deliverErrandApproval(harness.deps, {
      approval: createApproval(),
      origin: createOrigin(),
      screenshotAttachmentId: "att-foreign",
    });

    expect(result).toEqual({ delivered: true });
    expect(harness.createToken.mock.calls[0]![1].delivery).not.toHaveProperty("attachmentIds");
  });

  it("skips the screenshot when the approval has no linked session", async () => {
    const harness = createHarness();

    await deliverErrandApproval(harness.deps, {
      approval: createApproval({ linkage: {} }),
      origin: createOrigin(),
      screenshotAttachmentId: "att-before",
    });

    expect(harness.attachmentSessionId).not.toHaveBeenCalled();
    expect(harness.createToken.mock.calls[0]![1].delivery).not.toHaveProperty("attachmentIds");
  });

  it("uses only the screenshot it is given, never the approval preview's", async () => {
    const harness = createHarness();

    await deliverErrandApproval(harness.deps, { approval: createApproval(), origin: createOrigin() });

    expect(harness.attachmentSessionId).not.toHaveBeenCalled();
    expect(harness.createToken.mock.calls[0]![1].delivery).not.toHaveProperty("attachmentIds");
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

  it("refuses an approval that is not an errand approval, without issuing a token", async () => {
    const harness = createHarness();

    await expect(
      deliverErrandApproval(harness.deps, {
        approval: createApproval({ kind: "tool.invoke" }),
        origin: createOrigin(),
        screenshotAttachmentId: "att-before",
      }),
    ).resolves.toEqual({ delivered: false, reason: "not_errand_approval" });
    expect(harness.requireConnector).not.toHaveBeenCalled();
    expect(harness.createToken).not.toHaveBeenCalled();
  });

  it.each([
    { name: "not queued", status: "not_configured" as const, error: undefined },
    { name: "failed", status: "failed" as const, error: "Approval 7f3c-uuid send refused" },
  ])("returns a fixed reason and logs the detail when the delivery is $name", async ({ status, error }) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const harness = createHarness({ deliveryStatus: status, deliveryError: error });

    const result = await deliverErrandApproval(harness.deps, { approval: createApproval(), origin: createOrigin() });

    expect(result).toEqual({ delivered: false, reason: "delivery_failed" });
    expect(harness.recordDelivery).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[goatcitadel] errand approval was not sent to the conversation",
      expect.objectContaining({ approvalId: "apr_errand", detail: error ?? status }),
    );
  });

  it("keeps an issuance error's text out of the result", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const harness = createHarness();
    harness.createToken.mockRejectedValueOnce(new Error("Approval 1b2c3d4e-0000 has expired."));

    const result = await deliverErrandApproval(harness.deps, { approval: createApproval(), origin: createOrigin() });

    expect(result).toEqual({ delivered: false, reason: "delivery_failed" });
    expect(JSON.stringify(result)).not.toContain("1b2c3d4e");
    expect(warn).toHaveBeenCalledWith(
      "[goatcitadel] errand approval was not sent to the conversation",
      expect.objectContaining({ detail: "Approval 1b2c3d4e-0000 has expired." }),
    );
  });

  it("does not issue a token for a disconnected connection, a resolved approval or an expired one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const disconnected = createHarness({ connectorStatus: "degraded" });
    await expect(
      deliverErrandApproval(disconnected.deps, { approval: createApproval(), origin: createOrigin() }),
    ).resolves.toEqual({ delivered: false, reason: "connection_unavailable" });

    const unreadable = createHarness();
    unreadable.requireConnector.mockRejectedValueOnce(new Error("Connector integration:conn-telegram not found"));
    await expect(
      deliverErrandApproval(unreadable.deps, { approval: createApproval(), origin: createOrigin() }),
    ).resolves.toEqual({ delivered: false, reason: "connection_unavailable" });
    expect(warn).toHaveBeenCalledWith(
      "[goatcitadel] errand approval connection could not be read",
      expect.objectContaining({ connectionId: "conn-telegram" }),
    );

    const resolved = createHarness();
    await expect(
      deliverErrandApproval(resolved.deps, {
        approval: createApproval({ status: "approved" }),
        origin: createOrigin(),
      }),
    ).resolves.toEqual({ delivered: false, reason: "approval_not_pending" });

    const expired = createHarness();
    await expect(
      deliverErrandApproval(expired.deps, {
        approval: createApproval({ expiresAt: "2026-11-02T09:59:59.000Z" }),
        origin: createOrigin(),
      }),
    ).resolves.toEqual({ delivered: false, reason: "approval_expired" });

    for (const harness of [disconnected, unreadable, resolved, expired]) {
      expect(harness.createToken).not.toHaveBeenCalled();
      expect(harness.recordDelivery).not.toHaveBeenCalled();
    }
  });
});

function createHarness(
  options: {
    inlineReady?: boolean;
    connectorStatus?: ConnectorRecord["status"];
    deliveryStatus?: "queued" | "not_configured" | "failed";
    deliveryError?: string;
    attachmentOwner?: string | Error;
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
  const attachmentSessionId = vi.fn(async (_attachmentId: string) => {
    const owner = options.attachmentOwner ?? SESSION_ID;
    if (owner instanceof Error) {
      throw owner;
    }
    return owner;
  });
  const deps: ErrandApprovalDeliveryDeps = {
    requireConnectorRecord: requireConnector,
    createApprovalRemoteActionToken: createToken,
    recordDelivery,
    attachmentSessionId,
    now: () => NOW,
  };
  return { deps, requireConnector, createToken, recordDelivery, attachmentSessionId };
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
    riskLevel: "caution",
    status: "pending",
    payload: {},
    preview: {
      summary: "Click Buy — Places the order",
      url: "https://shop.example/cart",
      title: "Cart",
      screenshotAttachmentId: "att-preview",
      screenshotSha256: "abc",
    },
    linkage: { sessionId: SESSION_ID, turnId: "turn-1" },
    createdAt: "2026-11-02T09:59:00.000Z",
    expiresAt: "2026-11-02T10:02:00.000Z",
    explanationStatus: "not_requested",
    ...overrides,
  };
}
