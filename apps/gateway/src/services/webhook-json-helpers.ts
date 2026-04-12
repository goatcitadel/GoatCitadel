/**
 * Shared JSON coercion helpers for webhook normalization modules.
 *
 * Previously duplicated byte-identically across line-webhook.ts,
 * nextcloud-talk-webhook.ts, slack-webhook.ts, telegram-webhook.ts and
 * whatsapp-webhook.ts. Consolidated here so webhook handlers share one
 * normalization surface.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Constant-time string comparison. Returns false on length mismatch
 * (which is itself not constant-time, but the timing leak only reveals
 * length, not content). All webhook signature verifiers use this same
 * pattern.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Stable per-payload digest used as idempotency key fallback when a
 * webhook payload doesn't expose its own message/event id.
 */
export function hashRawBodyDigest(rawBody: Buffer): string {
  return createHash("sha256").update(rawBody).digest("hex");
}
