import { describe, expect, it } from "vitest";
import type { RoutingPreflightResult } from "@goatcitadel/contracts";
import { resolveChatRouteReadiness } from "./chat-route-readiness";

const LOCAL_CHOICES = [{ disabled: false, models: ["gemma-4-local"] }];
const NO_PROVIDER_REASON = "No model provider is configured yet. Open Configure and connect a provider first.";

function preflight(overrides: Partial<RoutingPreflightResult>): RoutingPreflightResult {
  return {
    selectionSource: "global",
    fallbackPolicy: "off",
    fallbackResult: "not_applicable",
    runtimeReachability: "unknown",
    runtimeClass: "unknown",
    decision: {} as RoutingPreflightResult["decision"],
    ...overrides,
  } as RoutingPreflightResult;
}

describe("chat route readiness", () => {
  it("recognizes a chat with no provider from the preflight shape, not its copy", () => {
    const readiness = resolveChatRouteReadiness({
      routePreflight: preflight({ blockedReason: NO_PROVIDER_REASON }),
      providerOptions: LOCAL_CHOICES,
    });
    expect(readiness.state).toBe("no_provider");
    expect(readiness.title).toBe("No model connected yet");
    expect(readiness.message).not.toContain("Configure");
    expect(readiness.sendHint).toBe("No model is connected yet.");
    expect(readiness.technicalReason).toBe(NO_PROVIDER_REASON);
  });

  it("treats a missing preflight with no usable model choices as no provider", () => {
    expect(resolveChatRouteReadiness({ routePreflight: null, providerOptions: [] }).state).toBe("no_provider");
  });

  it("keeps a provider-specific block and its Gateway reason", () => {
    const readiness = resolveChatRouteReadiness({
      routePreflight: preflight({
        requestedProviderId: "openai",
        effectiveProviderId: "openai",
        blockedReason: "OpenAI is not configured yet. Add an API key before using it.",
      }),
      providerOptions: LOCAL_CHOICES,
    });
    expect(readiness).toMatchObject({
      state: "blocked",
      message: "OpenAI is not configured yet. Add an API key before using it.",
      sendHint: "OpenAI is not configured yet. Add an API key before using it.",
    });
  });

  it("reports checking while the preflight is loading and ready once a route resolves", () => {
    expect(
      resolveChatRouteReadiness({ routePreflight: null, routePreflightLoading: true, providerOptions: LOCAL_CHOICES })
        .state,
    ).toBe("checking");
    expect(
      resolveChatRouteReadiness({
        routePreflight: preflight({ effectiveProviderId: "llamacpp", effectiveModel: "gemma-4-local" }),
        providerOptions: LOCAL_CHOICES,
      }).state,
    ).toBe("ready");
  });

  it("reports a failed preflight as blocked", () => {
    expect(
      resolveChatRouteReadiness({
        routePreflight: null,
        routePreflightError: "Gateway unavailable",
        providerOptions: LOCAL_CHOICES,
      }),
    ).toMatchObject({ state: "blocked", message: "Gateway unavailable" });
  });
});
