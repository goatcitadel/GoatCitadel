// Scenario harness primitives: axes, result helpers, and a tiny HTTP client.
//
// A scenario is a plain object:
//   {
//     id: string,                       // stable id, e.g. "trust.dry-run-hash-mismatch"
//     axis: "CAPABILITY"|"TRUST"|"RELIABILITY",
//     title: string,
//     description: string,
//     requiresEdges: string[],          // which user-provided edges this needs (for the doc)
//     mode: "in-process"|"http",        // in-process = imports shipped dist; http = hits a baseUrl
//     async run(target, ctx): ScenarioResult
//   }
//
// run() must NOT throw for an expected negative outcome — it returns a result with
// status "fail". Throwing is reserved for harness/infrastructure errors and is
// caught by the runner and recorded as status "error".

import { randomUUID } from "node:crypto";

// Re-exported so scenarios import HTTP + auth helpers from one place.
export { authHeaders } from "./targets.mjs";

export const AXES = Object.freeze(["CAPABILITY", "TRUST", "RELIABILITY"]);

export const STATUS = Object.freeze({
  PASS: "pass",
  FAIL: "fail",
  SKIP: "skip",
  ERROR: "error",
});

/** A scenario passed: the asserted property held. `evidence` is shown verbatim in the report. */
export function pass(evidence, detail) {
  return { status: STATUS.PASS, evidence: evidence ?? "ok", detail: detail ?? null };
}

/** A scenario failed: the asserted property did NOT hold. */
export function fail(evidence, detail) {
  return { status: STATUS.FAIL, evidence: evidence ?? "assertion failed", detail: detail ?? null };
}

/** A scenario was skipped (missing edge / unconfigured target). `reason` explains why. */
export function skip(reason, detail) {
  return { status: STATUS.SKIP, evidence: reason ?? "skipped", detail: detail ?? null };
}

/**
 * Assert helper: returns pass() when `condition` is truthy, fail() otherwise.
 * Keeps scenario bodies declarative.
 */
export function expect(condition, passEvidence, failEvidence, detail) {
  return condition ? pass(passEvidence, detail) : fail(failEvidence, detail);
}

/**
 * Minimal JSON-over-HTTP client mirroring scripts/verification/lib/runtime.mjs
 * (requestJson). Returns { ok, status, body }. Never throws on non-2xx — only on
 * transport failure (so callers can assert on status codes).
 */
export async function requestJson(baseUrl, route, init = {}) {
  const method = init.method ?? "GET";
  const headers = {
    "Content-Type": "application/json",
    // The gateway requires an Idempotency-Key on every mutating request (mirrors
    // scripts/verification/lib/runtime.mjs). Without it, POSTs 400 before routing.
    ...(method !== "GET" ? { "Idempotency-Key": randomUUID() } : {}),
    ...(init.headers ?? {}),
  };
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: response.ok, status: response.status, body };
}

/** Probe whether a gateway base URL is reachable via its keys-free liveness route. */
export async function isReachable(baseUrl, timeoutMs = 2500) {
  if (!baseUrl) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/livez`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
