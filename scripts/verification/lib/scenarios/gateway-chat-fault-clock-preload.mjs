/**
 * Verification-only clock fault used by the real Gateway Chat SSE journey.
 *
 * The preload advances Date.now only while the LLM completion budget code is
 * handling one marked synthetic provider failure. Other Gateway/runtime code
 * keeps wall-clock truth, so durable leases and persisted timestamps are not
 * moved into the future. Production startup never imports this file.
 */

const marker = process.env.GOATCITADEL_VERIFY_FAULT_CLOCK_MARKER?.trim();
const advanceMs = parsePositiveInt(process.env.GOATCITADEL_VERIFY_FAULT_CLOCK_ADVANCE_MS);
const activeWindowMs = parsePositiveInt(process.env.GOATCITADEL_VERIFY_FAULT_CLOCK_WINDOW_MS) ?? 1_000;
const targetPath = process.env.GOATCITADEL_VERIFY_FAULT_CLOCK_TARGET_PATH?.trim() || "/v1/chat/completions";

if (marker && advanceMs && typeof globalThis.fetch === "function") {
  const originalFetch = globalThis.fetch.bind(globalThis);
  const originalDateNow = Date.now.bind(Date);
  let armedUntil = 0;
  let armed = false;

  Date.now = () => {
    const now = originalDateNow();
    if (!armed || performance.now() > armedUntil) return now;
    const stack = new Error().stack ?? "";
    return /llm-completion-(?:service|helpers)\.[cm]?[jt]s/u.test(stack) ? now + advanceMs : now;
  };

  globalThis.fetch = async (input, init) => {
    const shouldArm = !armed && requestMatches(input, init, marker, targetPath);
    const response = await originalFetch(input, init);
    // Provider-native Responses failures use HTTP 200 plus a response.failed
    // SSE frame, so matching the marked request is the deterministic boundary.
    if (shouldArm) {
      armed = true;
      armedUntil = performance.now() + activeWindowMs;
    }
    return response;
  };
}

function requestMatches(input, init, expectedMarker, expectedPath) {
  const body = typeof init?.body === "string" ? init.body : "";
  if (!body.includes(expectedMarker)) return false;
  try {
    const rawUrl = typeof input === "string" || input instanceof URL ? String(input) : String(input?.url ?? "");
    return new URL(rawUrl).pathname === expectedPath;
  } catch {
    return false;
  }
}

function parsePositiveInt(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
