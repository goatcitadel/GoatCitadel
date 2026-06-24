/**
 * Mobile-context prompt helpers for chat turn preparation.
 *
 * Renders request-scoped mobile-context envelopes into prompt parts and records
 * their use for audit provenance. Extracted verbatim from chat-turn-prep-service.ts
 * to keep that module under the max-lines budget; behavior is unchanged.
 */

import type { ChatInputPart, MobileContextEnvelope } from "@goatcitadel/contracts";
import { sanitizeMobileContextForAudit } from "./mobile-route-service.js";
import type { ChatTurnPrepHost } from "./chat-turn-prep-service.js";

const MOBILE_CONTEXT_MAX_PARTS = 6;
const MOBILE_CONTEXT_SAFE_FIELD_KEYS = new Set([
  "accuracyMeters",
  "approxLatitude",
  "approxLongitude",
  "attachmentCount",
  "notificationApp",
  "notificationCategory",
  "permissionState",
  "place",
  "source",
  "timezone",
  "trigger",
  "zoneLabel",
]);

export function appendMobileContextParts(
  inputParts: ChatInputPart[],
  mobileContext: MobileContextEnvelope[] | undefined,
): ChatInputPart[] {
  const contextParts = buildMobileContextParts(mobileContext);
  if (contextParts.length === 0) {
    return inputParts;
  }
  return [...inputParts, ...contextParts];
}

function buildMobileContextParts(mobileContext: MobileContextEnvelope[] | undefined): ChatInputPart[] {
  if (!Array.isArray(mobileContext) || mobileContext.length === 0) {
    return [];
  }
  const nowMs = Date.now();
  return mobileContext
    .filter((context) => {
      if (!context.expiresAt) {
        return true;
      }
      const expiresAtMs = Date.parse(context.expiresAt);
      return Number.isNaN(expiresAtMs) || expiresAtMs > nowMs;
    })
    .slice(0, MOBILE_CONTEXT_MAX_PARTS)
    .map((context) => ({
      type: "text" as const,
      text: renderMobileContextForPrompt(context),
    }));
}

function renderMobileContextForPrompt(context: MobileContextEnvelope): string {
  const fields = Object.entries(context.structuredFields ?? {})
    .filter(([key]) => MOBILE_CONTEXT_SAFE_FIELD_KEYS.has(key))
    .map(([key, value]) => `${key}: ${truncateMobileContextText(value, 80)}`)
    .slice(0, 8);
  const lines = [
    "[Mobile context]",
    `Capability: ${context.capabilityId}`,
    `Reason visible to user: ${truncateMobileContextText(context.userVisibleReason, 160)}`,
    `Summary: ${truncateMobileContextText(context.summary, 240)}`,
    `Captured at: ${context.capturedAt}`,
  ];
  if (context.expiresAt) {
    lines.push(`Expires at: ${context.expiresAt}`);
  }
  if (fields.length > 0) {
    lines.push(`Structured fields: ${fields.join("; ")}`);
  }
  if (context.attachmentIds?.length) {
    lines.push(`Linked attachments: ${context.attachmentIds.length}`);
  }
  lines.push(
    "Use this as request-scoped context only; do not persist it as memory unless the operator explicitly asks.",
  );
  return lines.join("\n");
}

export async function recordMobileContextTurnProvenance(
  host: ChatTurnPrepHost,
  sessionId: string,
  userEventId: string,
  mobileContext: MobileContextEnvelope[] | undefined,
): Promise<void> {
  if (!host.storage.audit || !Array.isArray(mobileContext) || mobileContext.length === 0) {
    return;
  }
  await host.storage.audit.append("approvals", {
    eventType: "mobile.context_used_for_chat_turn",
    sessionId,
    userEventId,
    capabilityIds: mobileContext.map((context) => context.capabilityId),
    contexts: mobileContext.map(sanitizeMobileContextForAudit),
  });
}

function truncateMobileContextText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
