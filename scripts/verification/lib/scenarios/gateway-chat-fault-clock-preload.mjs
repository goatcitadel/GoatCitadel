/**
 * Verification-only clock fault used by the real Gateway Chat SSE journey.
 *
 * The preload advances Date.now only while the LLM completion budget code is
 * handling one marked synthetic provider failure. Other Gateway/runtime code
 * keeps wall-clock truth, so durable leases and persisted timestamps are not
 * moved into the future. Production startup never imports this file.
 */
import { subscribe } from "node:diagnostics_channel";

const marker = process.env.GOATCITADEL_VERIFY_FAULT_CLOCK_MARKER?.trim();
const advanceMs = parsePositiveInt(process.env.GOATCITADEL_VERIFY_FAULT_CLOCK_ADVANCE_MS);
const activeWindowMs = parsePositiveInt(process.env.GOATCITADEL_VERIFY_FAULT_CLOCK_WINDOW_MS) ?? 1_000;
const targetPath = process.env.GOATCITADEL_VERIFY_FAULT_CLOCK_TARGET_PATH?.trim() || "/v1/chat/completions";

if (marker && advanceMs) {
  const originalDateNow = Date.now.bind(Date);
  let armedUntil = 0;
  let armed = false;

  Date.now = () => {
    const now = originalDateNow();
    if (!armed || performance.now() > armedUntil) return now;
    const stack = new Error().stack ?? "";
    return /llm-completion-(?:service|helpers)\.[cm]?[jt]s/u.test(stack) ? now + advanceMs : now;
  };

  // Both native fetch and the provider's pinned Undici publish this event.
  // Do not replace fetch or its guarded dispatcher. A response marker avoids
  // inspecting/consuming request bodies and arms before response.failed is read.
  subscribe("undici:request:headers", (message) => {
    if (!armed && responseMatches(message, marker, targetPath)) {
      armed = true;
      armedUntil = performance.now() + activeWindowMs;
    }
  });
}

function responseMatches(message, expectedMarker, expectedPath) {
  const { request, response } = message ?? {};
  if (request?.method !== "POST" || response?.statusCode !== 200) return false;
  try {
    const url = new URL(request.path, request.origin);
    const host = url.hostname.replace(/^\[|\]$/gu, "");
    if (url.protocol !== "http:" || (host !== "127.0.0.1" && host !== "::1") || url.pathname !== expectedPath) {
      return false;
    }
  } catch {
    return false;
  }
  const headers = response.headers;
  if (!Array.isArray(headers)) return false;
  for (let index = 0; index + 1 < headers.length; index += 2) {
    if (
      headerText(headers[index]).toLowerCase() === "x-goatcitadel-verification-fault-clock" &&
      headerText(headers[index + 1]) === expectedMarker
    ) {
      return true;
    }
  }
  return false;
}

function headerText(value) {
  return Buffer.isBuffer(value) ? value.toString("utf8") : typeof value === "string" ? value : "";
}

function parsePositiveInt(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
