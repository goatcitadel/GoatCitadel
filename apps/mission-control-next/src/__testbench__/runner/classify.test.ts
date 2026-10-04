import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { CheckAssertionError } from "./assert";
import { classifyError, readErrorMessage } from "./classify";

function httpError(status: number, body: unknown) {
  return new ApiRequestError(`API error ${status}`, {
    kind: "http",
    method: "GET",
    path: "/api/v1/demo",
    status,
    body,
    bodyText: JSON.stringify(body),
  });
}

describe("classifyError", () => {
  it("stops the run when the gateway is unreachable", () => {
    const error = new ApiRequestError("Network error GET /api/v1/demo: fetch failed", {
      kind: "network",
      method: "GET",
      path: "/api/v1/demo",
    });
    expect(classifyError(error)).toMatchObject({
      status: "unreachable",
      summary: expect.stringContaining("fetch failed"),
    });
  });

  it("maps a user stop to cancelled and a timeout to fail", () => {
    expect(classifyError(new DOMException("stopped", "AbortError")).status).toBe("cancelled");
    expect(classifyError(new DOMException("slow", "TimeoutError"))).toEqual({
      status: "fail",
      summary: "Timed out before it finished.",
    });
  });

  it("blocks known disabled and unavailable responses", () => {
    expect(classifyError(httpError(404, { error: "Development verification endpoints are disabled." })).status).toBe(
      "blocked",
    );
    expect(
      classifyError(
        httpError(409, {
          error: "Feature flag memoryLifecycleAdminV1Enabled is disabled.",
          code: "STATE_CONFLICT",
          details: { flag: "memoryLifecycleAdminV1Enabled" },
        }),
      ).status,
    ).toBe("blocked");
    expect(classifyError(httpError(400, { error: "Code Mode v1 is disabled. Enable codeModeV1Enabled." })).status).toBe(
      "blocked",
    );
    expect(classifyError(httpError(403, { error: "Authenticated access is required." })).status).toBe("blocked");
    expect(classifyError(httpError(503, { error: "Journey timeline service is unavailable." })).status).toBe("blocked");
  });

  it("fails every other HTTP error with the route and message", () => {
    expect(classifyError(httpError(500, { error: "Internal server error" }))).toMatchObject({
      status: "fail",
      summary: "GET /api/v1/demo returned 500: Internal server error",
    });
    expect(classifyError(httpError(404, { error: "Session not found." })).status).toBe("fail");
  });

  it("fails assertion errors, protocol errors, and plain errors", () => {
    expect(classifyError(new CheckAssertionError("Expected ok.", { ok: false }))).toEqual({
      status: "fail",
      summary: "Expected ok.",
      evidence: { ok: false },
    });
    const protocol = new ApiRequestError("Malformed", {
      kind: "protocol",
      method: "GET",
      path: "/api/v1/demo",
      bodyText: "<html>",
    });
    expect(classifyError(protocol)).toMatchObject({ status: "fail", evidence: "<html>" });
    expect(classifyError(new Error("boom"))).toEqual({ status: "fail", summary: "boom" });
  });
});

describe("readErrorMessage", () => {
  it("reads string errors, coded errors, messages, and raw text", () => {
    expect(readErrorMessage({ error: "Plain." }, undefined)).toBe("Plain.");
    expect(readErrorMessage({ error: { code: "route_changed", reason: "route_decision_required" } }, undefined)).toBe(
      "route_changed: route_decision_required",
    );
    expect(readErrorMessage({ message: "From message." }, undefined)).toBe("From message.");
    expect(readErrorMessage(undefined, " raw text ")).toBe("raw text");
    expect(readErrorMessage(undefined, undefined)).toBe("No error message.");
  });
});
