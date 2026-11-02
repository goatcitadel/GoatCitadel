/**
 * Sends one errand approval to one channel conversation: the plain errand message, the spotlight screenshot in a
 * private conversation only, and the platform's Approve / Deny buttons when the connection can take them back.
 *
 * Delivery reuses the remote-token machinery: one token bound to the conversation's connector, with a per-delivery
 * target and message. The raw token never leaves this function.
 */

import type { ApprovalRequest, ConnectorRecord } from "@goatcitadel/contracts";
import type { ApprovalRemoteTokenDeliveryOverride } from "../approval-connector-delivery.js";
import type { ErrandOrigin } from "./errand-origin.js";
import { buildErrandApprovalMessage, ERRAND_SCREENSHOT_PRIVATE_ONLY_LINE } from "./errand-approval-message.js";

/** Issued by the errand system, not an operator. */
export const ERRAND_APPROVAL_TOKEN_ISSUER = "system:errand";

export type ErrandApprovalConversation = Pick<
  Extract<ErrandOrigin, { kind: "channel" }>,
  "connectionId" | "channelKey" | "target" | "conversation"
>;

/** One delivery of an errand approval to a conversation, which a text reply there can answer. */
export interface ErrandApprovalDeliveryRecord {
  approvalId: string;
  connectionId: string;
  target: string;
}

export interface ErrandApprovalDeliveryDeps {
  requireConnectorRecord(connectorId: string): Promise<ConnectorRecord>;
  createApprovalRemoteActionToken(
    approvalId: string,
    input: {
      connectorId: string;
      issuedBy: string;
      expiresInMs?: number;
      delivery: ApprovalRemoteTokenDeliveryOverride;
    },
  ): Promise<{ deliveryStatus?: "queued" | "not_configured" | "failed"; deliveryError?: string }>;
  /** Adds the delivery to the running errand's in-memory delivery list. */
  recordDelivery(record: ErrandApprovalDeliveryRecord): void;
  now(): number;
}

export interface ErrandApprovalDeliveryInput {
  approval: ApprovalRequest;
  origin: ErrandApprovalConversation;
  screenshotAttachmentId?: string;
}

export type ErrandApprovalDeliveryResult = { delivered: true } | { delivered: false; reason: string };

export async function deliverErrandApproval(
  deps: ErrandApprovalDeliveryDeps,
  input: ErrandApprovalDeliveryInput,
): Promise<ErrandApprovalDeliveryResult> {
  const { requireConnectorRecord, createApprovalRemoteActionToken, recordDelivery, now } = deps;
  const { approval, origin } = input;
  if (approval.status !== "pending") {
    return { delivered: false, reason: "The approval is no longer waiting." };
  }
  const expiresInMs = remainingTtlMs(approval, now());
  if (expiresInMs !== undefined && expiresInMs <= 0) {
    return { delivered: false, reason: "The approval has expired." };
  }
  const connectorId = `integration:${origin.connectionId}`;
  const connector = await requireConnectorRecord(connectorId).catch(() => undefined);
  if (!connector || connector.status !== "active") {
    return { delivered: false, reason: "The channel connection is not connected." };
  }
  const delivery = buildErrandApprovalDelivery(input, canTakeInlineButtons(connector));
  const issued = await createApprovalRemoteActionToken(approval.approvalId, {
    connectorId,
    issuedBy: ERRAND_APPROVAL_TOKEN_ISSUER,
    // The token lives as long as the approval it answers; the issuer clamps it to its own bounds.
    ...(expiresInMs !== undefined ? { expiresInMs } : {}),
    delivery,
  }).catch((error: unknown) => ({
    deliveryStatus: "failed" as const,
    deliveryError: error instanceof Error ? error.message : String(error),
  }));
  if (issued.deliveryStatus !== "queued") {
    return {
      delivered: false,
      reason: issued.deliveryError ?? "The channel connection can't send approvals.",
    };
  }
  recordDelivery({ approvalId: approval.approvalId, connectionId: origin.connectionId, target: origin.target });
  return { delivered: true };
}

/** The target, message and (private conversations only) screenshot for one delivery. */
export function buildErrandApprovalDelivery(
  input: ErrandApprovalDeliveryInput,
  buttons: boolean,
): ApprovalRemoteTokenDeliveryOverride {
  const { approval, origin } = input;
  const direct = origin.conversation === "direct";
  const screenshotAttachmentId =
    input.screenshotAttachmentId?.trim() || readPreviewString(approval, "screenshotAttachmentId");
  const message = buildErrandApprovalMessage({
    summary: readPreviewString(approval, "summary") ?? "",
    pageUrl: readPreviewString(approval, "url"),
    buttons,
    notes: direct ? [] : [ERRAND_SCREENSHOT_PRIVATE_ONLY_LINE],
  });
  return {
    target: origin.target,
    message,
    ...(direct && screenshotAttachmentId ? { attachmentIds: [screenshotAttachmentId] } : {}),
  };
}

/** The same readiness the delivery payload uses to attach the Approve / Deny buttons. */
function canTakeInlineButtons(connector: ConnectorRecord): boolean {
  return (
    connector.metadata?.approvalInlineActionsReady === true &&
    connector.capabilities.some((capability) => capability.id === "interactive_actions" && capability.enabled)
  );
}

function remainingTtlMs(approval: ApprovalRequest, nowMs: number): number | undefined {
  const expiresAtMs = approval.expiresAt ? Date.parse(approval.expiresAt) : Number.NaN;
  return Number.isFinite(expiresAtMs) ? expiresAtMs - nowMs : undefined;
}

function readPreviewString(approval: ApprovalRequest, key: string): string | undefined {
  const value = approval.preview?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
