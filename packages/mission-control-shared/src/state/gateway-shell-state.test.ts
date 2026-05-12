import { describe, expect, it } from "vitest";

import { deriveShellGatewayAccessState } from "./gateway-shell-state";

describe("gateway-shell-state", () => {
  it("summarizes checking, ready, degraded stream, auth, unreachable, and misconfigured states", () => {
    expect(
      deriveShellGatewayAccessState({
        status: "checking",
        message: "Starting",
        healthDetail: "warming",
      }),
    ).toMatchObject({
      status: "checking",
      label: "Checking gateway",
      tone: "muted",
      detail: "warming",
    });

    expect(
      deriveShellGatewayAccessState({
        status: "ready",
        message: "Ready",
        healthDetail: "probe passed",
      } as never),
    ).toMatchObject({
      status: "ready",
      label: "Gateway ready",
      tone: "live",
      nextStep: "Mission Control can load the live control surfaces now.",
    });

    expect(
      deriveShellGatewayAccessState(
        {
          status: "ready",
          message: "Ready",
          healthDetail: "probe passed",
        } as never,
        "retrying",
      ),
    ).toMatchObject({
      status: "degraded-live-updates",
      label: "Live updates degraded",
      tone: "warning",
      detail: "Realtime stream state: retrying. probe passed",
    });

    expect(
      deriveShellGatewayAccessState({
        status: "needs-auth",
        message: "Auth needed",
        healthDetail: "401",
      } as never),
    ).toMatchObject({
      label: "Access required",
      tone: "warning",
    });

    expect(
      deriveShellGatewayAccessState({
        status: "unreachable",
        message: "Offline",
        healthDetail: "ECONNREFUSED",
      } as never),
    ).toMatchObject({
      label: "Gateway unreachable",
      tone: "critical",
    });

    expect(
      deriveShellGatewayAccessState({
        status: "misconfigured",
        message: "Bad route",
        healthDetail: "404",
      } as never),
    ).toMatchObject({
      label: "Gateway misconfigured",
      tone: "critical",
      nextStep: "Fix the gateway auth or probe configuration before continuing.",
    });
  });
});
