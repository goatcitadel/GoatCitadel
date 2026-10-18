import { describe, expect, it } from "vitest";
import { PolicyViolationError } from "@goatcitadel/contracts";
import {
  assertChatRouteWardAdmitsTurn,
  buildModelChatWardAction,
  isLoopbackUrl,
  isRouteLocalProvider,
  selectRouteLocalProvider,
} from "./chat-route-local-ward.js";

function provider(providerId: string, baseUrl: string, defaultModel = "model-a") {
  return { providerId, label: providerId, baseUrl, defaultModel, hasApiKey: false };
}

describe("chat-route-local-ward", () => {
  it("isLoopbackUrl accepts only loopback hosts", () => {
    expect(isLoopbackUrl("http://localhost:11434")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.2:8080/v1")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:1234")).toBe(true);
    expect(isLoopbackUrl("http://192.168.1.5:11434")).toBe(false);
    expect(isLoopbackUrl("https://api.openai.com")).toBe(false);
    expect(isLoopbackUrl("http://localhost.evil.com")).toBe(false);
    expect(isLoopbackUrl(undefined)).toBe(false);
  });

  it("isRouteLocalProvider is strict about the engine and the host", () => {
    expect(isRouteLocalProvider(provider("ollama", "http://127.0.0.1:11434"))).toBe(true);
    expect(isRouteLocalProvider(provider("openai_compatible", "http://10.0.0.5:8000"))).toBe(false);
    expect(isRouteLocalProvider(provider("ollama", "https://ollama.com"))).toBe(false);
    expect(isRouteLocalProvider(provider("my-endpoint", "http://127.0.0.1:8000/v1"))).toBe(true);
    expect(isRouteLocalProvider(provider("litellm", "http://127.0.0.1:4000"))).toBe(false);
  });

  it("buildModelChatWardAction names the per-provider chat action", () => {
    expect(buildModelChatWardAction("ollama")).toBe("model.chat.ollama");
  });

  it("selectRouteLocalProvider skips cloud, unavailable and denied candidates", () => {
    const providers = [
      provider("openai", "https://api.openai.com/v1", "gpt"),
      provider("ollama", "http://127.0.0.1:11434", "llama3.2"),
      provider("llamacpp", "http://localhost:8080", "qwen"),
    ];
    expect(selectRouteLocalProvider({ providers })).toMatchObject({
      provider: { providerId: "ollama" },
      model: "llama3.2",
    });
    expect(
      selectRouteLocalProvider({
        providers,
        getModelAvailability: (providerId) => (providerId === "ollama" ? "unavailable" : "available"),
      }),
    ).toMatchObject({ provider: { providerId: "llamacpp" }, model: "qwen" });
    expect(
      selectRouteLocalProvider({ providers, isProviderDenied: (providerId) => providerId !== "openai" }),
    ).toBeUndefined();
  });

  it("assertChatRouteWardAdmitsTurn throws only for blocking ward codes", () => {
    expect(() => assertChatRouteWardAdmitsTurn({ wardReasonCode: "citadel_ward_route_local" })).not.toThrow();
    expect(() => assertChatRouteWardAdmitsTurn({})).not.toThrow();
    let caught: unknown;
    try {
      assertChatRouteWardAdmitsTurn({
        wardReasonCode: "citadel_ward_route_local_unavailable",
        wardCitadelId: "citadel-1",
        blockedReason: "blocked",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PolicyViolationError);
    expect((caught as PolicyViolationError).details).toEqual({
      reason: "citadel_ward_route_local_unavailable",
      citadelId: "citadel-1",
    });
  });
});
