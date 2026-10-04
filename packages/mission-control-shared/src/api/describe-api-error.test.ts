import { describe, expect, it } from "vitest";
import { ApiRequestError } from "./http-internal";
import { describeApiError, GATEWAY_UNREACHABLE_SUMMARY } from "./describe-api-error";

function httpError(status: number, body?: unknown): ApiRequestError {
  return new ApiRequestError(`API error ${status}: {}`, {
    kind: "http",
    method: "POST",
    path: "/api/v1/x",
    status,
    body,
  });
}

describe("describeApiError", () => {
  it("turns request failures into plain copy while retaining technical details", () => {
    const error = new ApiRequestError("Network error POST /api/v1/chat/sessions/s/route-preflight: Failed to fetch", {
      kind: "network",
      method: "POST",
      path: "/api/v1/chat/sessions/s/route-preflight",
    });
    const result = describeApiError(error);
    expect(result.summary).toBe(GATEWAY_UNREACHABLE_SUMMARY);
    expect(result.technical).toContain("POST /api/v1/chat/sessions/s/route-preflight");
  });

  it("maps common HTTP failures to actionable copy", () => {
    expect(describeApiError(httpError(401)).summary).toContain("Sign in again");
    expect(describeApiError(httpError(403)).summary).toContain("permission");
    expect(describeApiError(httpError(404)).summary).toContain("Refresh");
    expect(describeApiError(httpError(409)).summary).toContain("Refresh and try again");
    expect(describeApiError(httpError(429)).summary).toContain("Wait a moment");
    expect(describeApiError(httpError(503)).summary).toContain("System health");
  });

  it("keeps readable validation messages but hides request paths", () => {
    expect(describeApiError(httpError(400, { error: "Name is required." })).summary).toBe("Name is required.");
    expect(describeApiError(httpError(422, { error: "API error 422: /api/v1/x" })).summary).toBe(
      "The gateway couldn't complete that request.",
    );
  });

  it("handles plain transport errors and technical messages", () => {
    expect(describeApiError(new TypeError("Failed to fetch")).summary).toBe(GATEWAY_UNREACHABLE_SUMMARY);
    expect(describeApiError(new Error("TypeError: x is undefined")).summary).toBe("Something went wrong. Try again.");
    expect(describeApiError(new Error("Choose a model first.")).summary).toBe("Choose a model first.");
    expect(describeApiError(undefined, "Couldn't load skills.").summary).toBe("Couldn't load skills.");
  });

  it("names a switched-off feature instead of reporting an edit conflict", () => {
    const disabled = {
      error: "Feature flag memoryLifecycleAdminV1Enabled is disabled.",
      code: "STATE_CONFLICT",
      details: { flag: "memoryLifecycleAdminV1Enabled" },
    };
    expect(describeApiError(httpError(409, disabled)).summary).toBe(
      "This feature is turned off for this installation.",
    );
    expect(
      describeApiError(httpError(409, { error: "Revision 4 is stale.", code: "STATE_CONFLICT" })).summary,
    ).toContain("Refresh and try again");
  });
});
