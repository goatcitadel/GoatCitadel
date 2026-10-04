import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { findCheck, makeTestContext } from "../test-support/context";
import { healthChecks } from "./health";

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ request: requestMock }));

beforeEach(() => {
  requestMock.mockReset();
});

describe("health checks", () => {
  it("passes when the gateway reports ok", async () => {
    requestMock.mockResolvedValueOnce({ status: "ok", readiness: "ready", service: "gateway" });
    const ctx = makeTestContext();
    await expect(findCheck(healthChecks, "health.gateway").run(ctx)).resolves.toMatchObject({ status: "pass" });
    expect(requestMock).toHaveBeenCalledWith("/health", { signal: ctx.signal });
  });

  it("fails, rather than blocks, when health answers 503 degraded", async () => {
    requestMock.mockRejectedValueOnce(
      new ApiRequestError("API error 503", {
        kind: "http",
        method: "GET",
        path: "/health",
        status: 503,
        body: { status: "degraded", readiness: "degraded", service: "gateway" },
      }),
    );
    await expect(findCheck(healthChecks, "health.gateway").run(makeTestContext())).resolves.toMatchObject({
      status: "fail",
      summary: expect.stringContaining("degraded"),
    });
  });

  it("requires liveness to report uptime", async () => {
    requestMock.mockResolvedValueOnce({ status: "ok", service: "gateway", uptimeSeconds: 42.4 });
    await expect(findCheck(healthChecks, "health.livez").run(makeTestContext())).resolves.toMatchObject({
      status: "pass",
      summary: "Process alive for 42 s.",
    });
    requestMock.mockResolvedValueOnce({ status: "ok", service: "gateway" });
    await expect(findCheck(healthChecks, "health.livez").run(makeTestContext())).rejects.toThrow(
      "did not report uptime",
    );
  });

  it("names the readiness checks that are not ready", async () => {
    requestMock.mockResolvedValueOnce({
      status: "ok",
      readiness: "ready",
      service: "gateway",
      checks: [
        { key: "database", state: "ready" },
        { key: "config_generation", state: "degraded" },
      ],
    });
    await expect(findCheck(healthChecks, "ops.readiness").run(makeTestContext())).resolves.toMatchObject({
      status: "fail",
      summary: "Readiness is degraded: config_generation.",
    });
  });
});
