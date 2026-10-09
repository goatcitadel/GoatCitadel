import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  classifyMutationAttempt,
  createAttemptKey,
  fetchMutationAttempt,
  matchRoutePattern,
} from "./mutation-attempts";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.stubGlobal("crypto", { randomUUID: () => "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b" });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it("creates UUID attempt keys", () => {
  expect(createAttemptKey()).toBe("6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b");
});

it("reads the caller's attempt by key, method and registered route pattern", async () => {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ attempt: { status: "completed", claimExpired: false } }));
  vi.stubGlobal("fetch", fetchMock);
  const result = await fetchMutationAttempt(
    "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b",
    "POST",
    "/api/v1/secrets/providers/:providerId",
  );
  expect(result).toEqual({ status: "completed", claimExpired: false });
  const url = String(fetchMock.mock.calls[0]?.[0]);
  expect(url).toContain("/api/v1/mutation-attempts/6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b?");
  expect(url).toContain("method=POST");
  expect(url).toContain(`route=${encodeURIComponent("/api/v1/secrets/providers/:providerId")}`);
});

it("maps a captured path to the owner's registered route pattern, one segment per parameter", () => {
  const patterns = [
    "/api/v1/settings",
    "/api/v1/secrets/providers/:providerId",
    "/api/v1/change-plans/:planId/confirmations",
  ];
  expect(matchRoutePattern("/api/v1/settings", patterns)).toBe("/api/v1/settings");
  expect(matchRoutePattern("/api/v1/secrets/providers/open%2Fai", patterns)).toBe(
    "/api/v1/secrets/providers/:providerId",
  );
  expect(matchRoutePattern("/api/v1/change-plans/p-1/confirmations", patterns)).toBe(
    "/api/v1/change-plans/:planId/confirmations",
  );
  expect(matchRoutePattern("/api/v1/secrets/providers/", patterns)).toBeUndefined();
  expect(matchRoutePattern("/api/v1/secrets/providers/a/b", patterns)).toBeUndefined();
  expect(matchRoutePattern("/api/v1/change-plans/p-1/cancellations", patterns)).toBeUndefined();
});

it.each([
  [{ status: "completed", claimExpired: false }, "committed"],
  // "failed" only means the Gateway released the claim: a handler may have committed before an unmarked error.
  [{ status: "failed", claimExpired: false }, "failed_confirm_by_readback"],
  [{ status: "pending", claimExpired: false }, "in_progress"],
  [{ status: "pending", claimExpired: true }, "unknown"],
  [{ status: "absent" }, "resend_same_key"],
] as const)("classifies %o as %s", (attempt, verdict) => {
  expect(classifyMutationAttempt(attempt)).toBe(verdict);
});
