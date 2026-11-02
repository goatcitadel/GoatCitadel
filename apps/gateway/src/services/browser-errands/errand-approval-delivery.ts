/**
 * Sends one errand approval to one channel conversation: the plain errand message, the spotlight screenshot in a
 * private conversation only, and the platform's Approve / Deny buttons when the connection can take them back.
 *
 * Delivery reuses the remote-token machinery: one token bound to the conversation's connector, with a per-delivery
 * target and message. The raw token never leaves this function.
 */

import type { ApprovalRequest, ConnectorRecord } from "@goatcitadel/contracts";
import {
  supportsInlineApprovalActions,
  type ApprovalRemoteTokenDeliveryOverride,
} from "../approval-connector-delivery.js";
import type { ErrandOrigin } from "./errand-origin.js";
import { buildErrandApprovalMessage, ERRAND_SCREENSHOT_PRIVATE_ONLY_LINE } from "./errand-approval-message.js";
import { ERRAND_APPROVAL_KIND } from "./errand-constants.js";

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
  /** The chat session a stored chat attachment was uploaded to. */
  attachmentSessionId(attachmentId: string): Promise<string | undefined>;
  now(): number;
}

export interface ErrandApprovalDeliveryInput {
  approval: ApprovalRequest;
  origin: ErrandApprovalConversation;
  screenshotAttachmentId?: string;
}

/** Fixed reasons only: raw failure detail (which can name approvals or connections) goes to the log. */
export type ErrandApprovalDeliveryFailure =
  | "not_errand_approval"
  | "approval_not_pending"
  | "approval_expired"
  | "connection_unavailable"
  | "delivery_failed";

export type ErrandApprovalDeliveryResult =
  | { delivered: true }
  | { delivered: false; reason: ErrandApprovalDeliveryFailure };

export async function deliverErrandApproval(
  deps: ErrandApprovalDeliveryDeps,
  input: ErrandApprovalDeliveryInput,
): Promise<ErrandApprovalDeliveryResult> {
  const { requireConnectorRecord, createApprovalRemoteActionToken, recordDelivery, attachmentSessionId, now } = deps;
  const { approval, origin } = input;
  if (approval.kind !== ERRAND_APPROVAL_KIND) {
    return { delivered: false, reason: "not_errand_approval" };
  }
  if (approval.status !== "pending") {
    return { delivered: false, reason: "approval_not_pending" };
  }
  const expiresInMs = remainingTtlMs(approval, now());
  if (expiresInMs !== undefined && expiresInMs <= 0) {
    return { delivered: false, reason: "approval_expired" };
  }
  const connectorId = `integration:${origin.connectionId}`;
  const connector = await requireConnectorRecord(connectorId).catch((error: unknown) => {
    warnDeliveryFailure("errand approval connection could not be read", approval, origin, error);
    return undefined;
  });
  if (!connector || connector.status !== "active") {
    return { delivered: false, reason: "connection_unavailable" };
  }
  const screenshotAttachmentId =
    origin.conversation === "direct"
      ? await readOwnScreenshot(attachmentSessionId, approval, input.screenshotAttachmentId)
      : undefined;
  const delivery = buildErrandApprovalDelivery(
    { approval, origin, ...(screenshotAttachmentId ? { screenshotAttachmentId } : {}) },
    // The same readiness the delivery payload uses to attach the Approve / Deny buttons.
    supportsInlineApprovalActions(connector, { toConversation: true }),
  );
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
    warnDeliveryFailure(
      "errand approval was not sent to the conversation",
      approval,
      origin,
      issued.deliveryError ?? issued.deliveryStatus ?? "no delivery status",
    );
    return { delivered: false, reason: "delivery_failed" };
  }
  recordDelivery({ approvalId: approval.approvalId, connectionId: origin.connectionId, target: origin.target });
  return { delivered: true };
}

/**
 * The target, message and (private conversations only) screenshot for one delivery. Sent as plain text: the
 * summary comes from page text, which must not be parsed as channel markup.
 */
export function buildErrandApprovalDelivery(
  input: ErrandApprovalDeliveryInput,
  buttons: boolean,
): ApprovalRemoteTokenDeliveryOverride {
  const { approval, origin } = input;
  const direct = origin.conversation === "direct";
  const screenshotAttachmentId = input.screenshotAttachmentId?.trim();
  const message = buildErrandApprovalMessage({
    summary: readPreviewString(approval, "summary") ?? "",
    pageUrl: readPreviewString(approval, "url"),
    buttons,
    notes: direct ? [] : [ERRAND_SCREENSHOT_PRIVATE_ONLY_LINE],
  });
  return {
    target: origin.target,
    message,
    plainText: true,
    ...(direct && screenshotAttachmentId ? { attachmentIds: [screenshotAttachmentId] } : {}),
  };
}

/**
 * The screenshot to attach: only the one the caller names, and only when it was uploaded to the approval's own
 * session. A mismatch or a failed read drops the screenshot, not the delivery.
 */
async function readOwnScreenshot(
  attachmentSessionId: ErrandApprovalDeliveryDeps["attachmentSessionId"],
  approval: ApprovalRequest,
  requested: string | undefined,
): Promise<string | undefined> {
  const attachmentId = requested?.trim();
  const sessionId = approval.linkage?.sessionId?.trim();
  if (!attachmentId || !sessionId) {
    return undefined;
  }
  const ownerSessionId = await attachmentSessionId(attachmentId).catch(() => undefined);
  return ownerSessionId === sessionId ? attachmentId : undefined;
}

function warnDeliveryFailure(
  message: string,
  approval: ApprovalRequest,
  origin: ErrandApprovalConversation,
  detail: unknown,
): void {
  // eslint-disable-next-line no-console -- bounded diagnostic; the caller only sees a fixed reason.
  console.warn(`[goatcitadel] ${message}`, {
    approvalId: approval.approvalId,
    connectionId: origin.connectionId,
    detail: (detail instanceof Error ? detail.message : String(detail)).slice(0, 500),
  });
}

function remainingTtlMs(approval: ApprovalRequest, nowMs: number): number | undefined {
  const expiresAtMs = approval.expiresAt ? Date.parse(approval.expiresAt) : Number.NaN;
  return Number.isFinite(expiresAtMs) ? expiresAtMs - nowMs : undefined;
}

function readPreviewString(approval: ApprovalRequest, key: string): string | undefined {
  const value = approval.preview?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
