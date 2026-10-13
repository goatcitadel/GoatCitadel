import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionRequest } from "@goatcitadel/contracts";
import { LlmDispatchGuardRejectedError, type LlmDispatchGuardInput } from "./llm-dispatch-guard.js";
import {
  attachChatProviderFallbackAuthorization,
  assertChatProviderFallbackPrimaryRoute,
  issueChatProviderFallbackAuthorization,
  isLocalChatProviderUrl,
  markChatProviderFallbackRequired,
  prepareChatProviderFallbackDispatch,
  prepareCurrentChatProviderFallbackDispatch,
  readAuthorizedChatProviderFallback,
  requiresChatProviderFallbackAuthorization,
} from "./chat-provider-fallback-authority.js";

const providers = [
  { providerId: "primary", baseUrl: "http://127.0.0.1:8080/v1" },
  { providerId: "backup", baseUrl: "https://api.example.test/v1" },
];
const dispatch = { route: { providerId: "backup", modelId: "model-b" } } as LlmDispatchGuardInput;
function fixture(allowLocalToCloud = true) {
  const revalidateBeforeFallback = vi.fn(async () => {});
  const dispatchGuard = vi.fn(async () => {});
  const handle = issueChatProviderFallbackAuthorization({
    sessionId: "session",
    turnId: "turn",
    runId: "run",
    primary: { providerId: "primary", model: "model-a" },
    fallback: { providerId: "backup", model: "model-b" },
    allowLocalToCloud,
    revalidateBeforeFallback,
    dispatchGuard,
  });
  const request = attachChatProviderFallbackAuthorization(
    {
      providerId: "primary",
      model: "model-a",
      messages: [],
      memory: { sessionId: "session", turnId: "turn", runId: "run" },
    },
    handle,
  );
  return {
    handle,
    request,
    revalidateBeforeFallback,
    dispatchGuard,
    effective: { ...request, providerId: "backup", model: "model-b" },
  };
}

describe("Chat provider fallback authority", () => {
  it("reads current uncached configuration with its provider receiver before preparing fallback", async () => {
    const f = fixture();
    const llmService = {
      providers: [...providers],
      getRuntimeConfig: vi.fn(function (this: { providers: typeof providers }, options: unknown) {
        expect(options).toEqual({ useCache: false });
        return { providers: this.providers } as never;
      }),
    };
    llmService.providers = [];
    await expect(prepareCurrentChatProviderFallbackDispatch({ llmService }, f.request, f.effective)).rejects.toThrow(
      "route is unavailable",
    );
    expect(llmService.getRuntimeConfig).toHaveBeenCalledOnce();
    expect(f.revalidateBeforeFallback).not.toHaveBeenCalled();
  });
  it.each([
    "http://host.docker.internal:8080/v1",
    "https://gateway.docker.internal/v1",
    "http://goatbox:8080/v1",
    "https://goatbox.example.ts.net/v1",
    "http://model.local./v1",
    "http://100.64.0.1:8080/v1",
    "http://100.127.255.255/v1",
    "http://127.12.0.1/v1",
    "http://[fd12:3456::1]/v1",
    "http://[fe80::1]/v1",
    "http://[::ffff:127.0.0.1]/v1",
    "http://[::ffff:192.168.1.1]/v1",
  ])("requires consent before leaving local endpoint %s", async (baseUrl) => {
    expect(isLocalChatProviderUrl(baseUrl)).toBe(true);
    const f = fixture(false);
    await expect(
      prepareChatProviderFallbackDispatch(f.request, f.effective, [{ providerId: "primary", baseUrl }, providers[1]!]),
    ).rejects.toThrow(/explicit operator consent/);
    expect(f.revalidateBeforeFallback).not.toHaveBeenCalled();
  });

  it.each([
    "https://api.openai.com/v1",
    "https://api.anthropic.com",
    "http://100.128.0.1/v1",
    "https://[2606:4700::1111]/v1",
    "https://[::ffff:8.8.8.8]/v1",
  ])("does not classify public endpoint %s as local", (baseUrl) => {
    expect(isLocalChatProviderUrl(baseUrl)).toBe(false);
  });

  it("survives internal spreads while JSON cannot recreate its authority", () => {
    const { request, handle } = fixture();
    expect(readAuthorizedChatProviderFallback({ ...request })).toEqual({ providerId: "backup", model: "model-b" });
    expect(readAuthorizedChatProviderFallback(JSON.parse(JSON.stringify(request)))).toBeUndefined();
    expect(() => attachChatProviderFallbackAuthorization(request, JSON.parse(JSON.stringify(handle)))).toThrow(
      LlmDispatchGuardRejectedError,
    );
    expect(requiresChatProviderFallbackAuthorization({ ...markChatProviderFallbackRequired({ messages: [] }) })).toBe(
      true,
    );
  });

  it("binds exact turn identity and rejects hook retargeting", () => {
    const { request } = fixture();
    expect(() =>
      readAuthorizedChatProviderFallback({ ...request, memory: { ...request.memory, turnId: "other" } }),
    ).toThrow(/different Chat turn/);
    expect(() => assertChatProviderFallbackPrimaryRoute(request, { providerId: "backup", model: "model-b" })).toThrow(
      /primary provider route changed/,
    );
  });

  it("revalidates before dispatch and consumes at most one fallback attempt", async () => {
    const f = fixture();
    const guard = await prepareChatProviderFallbackDispatch(f.request, f.effective, providers);
    expect(f.revalidateBeforeFallback).toHaveBeenCalledExactlyOnceWith(f.effective);
    expect(f.dispatchGuard).not.toHaveBeenCalled();
    await guard!(dispatch);
    expect(f.dispatchGuard).toHaveBeenCalledExactlyOnceWith(dispatch);
    await expect(guard!(dispatch)).rejects.toThrow(/network attempt has already been consumed/);
    await expect(prepareChatProviderFallbackDispatch(f.request, f.effective, providers)).rejects.toThrow(
      /already been consumed/,
    );
  });

  it("refuses an unconsented local-to-cloud boundary before revalidation", async () => {
    const f = fixture(false);
    await expect(prepareChatProviderFallbackDispatch(f.request, f.effective, providers)).rejects.toThrow(
      /explicit operator consent/,
    );
    expect(f.revalidateBeforeFallback).not.toHaveBeenCalled();
  });

  it("checks current boundaries when a previously local fallback changes", async () => {
    const f = fixture(false);
    const local = providers.map((p) => ({ ...p, baseUrl: "http://localhost:8080/v1" }));
    const guard = await prepareChatProviderFallbackDispatch(f.request, f.effective, local);
    await expect(guard!({ ...dispatch, route: { ...dispatch.route, modelId: "other" } })).rejects.toThrow(
      /changed before network/,
    );
    expect(f.dispatchGuard).not.toHaveBeenCalled();
  });

  it("makes revocation an authoritative error without a retry", async () => {
    const f = fixture();
    f.revalidateBeforeFallback.mockRejectedValueOnce(new Error("grant revoked"));
    await expect(prepareChatProviderFallbackDispatch(f.request, f.effective, providers)).rejects.toThrow(
      LlmDispatchGuardRejectedError,
    );
    await expect(prepareChatProviderFallbackDispatch(f.request, f.effective, providers)).rejects.toThrow(
      /already been consumed/,
    );
  });

  it("rejects missing providers and pinned local execution", async () => {
    const missing = fixture();
    await expect(prepareChatProviderFallbackDispatch(missing.request, missing.effective, [])).rejects.toThrow(
      /unavailable/,
    );
    const pinned = fixture();
    await expect(
      prepareChatProviderFallbackDispatch(
        { ...pinned.request, requiredRuntimeTarget: { providerId: "primary", model: "model-a" } },
        pinned.effective,
        providers,
      ),
    ).rejects.toThrow(/pinned/);
  });

  it("requires both authority guards at issuance", () => {
    expect(() =>
      issueChatProviderFallbackAuthorization({
        sessionId: "s",
        turnId: "t",
        runId: "r",
        primary: { providerId: "a", model: "a" },
        fallback: { providerId: "b", model: "b" },
        allowLocalToCloud: false,
        revalidateBeforeFallback: async () => {},
        dispatchGuard: undefined as never,
      }),
    ).toThrow(/both live authority guards/);
    expect(requiresChatProviderFallbackAuthorization({ memory: { turnId: "t" } } as ChatCompletionRequest)).toBe(true);
  });
});
