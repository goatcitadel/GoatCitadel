// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_MUTATION_INTENT_HEADER, BROWSER_MUTATION_INTENT_VALUE } from "./http-internal";
import {
  buildGatewayHeaders,
  clearGatewayAuthState,
  consumeGatewayAccessBootstrapFromLocation,
  getGatewayAuthStorageMode,
  persistGatewayAuthState,
  preflightGatewayAccess,
  readGatewayAuthHeaders,
  readStoredGatewayAuthState,
  request,
  runUiAction,
  setGatewayAuthStorageMode,
} from "./client-core";

const AUTH_STORAGE_KEY = "goatcitadel.gateway.auth";

describe("client-core auth and header tails", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    clearGatewayAuthState();
    vi.stubGlobal("crypto", {
      randomUUID: () => "tail-uuid",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearGatewayAuthState();
  });

  it("keeps Basic auth passwords volatile while persisted storage only carries non-secret metadata", () => {
    persistGatewayAuthState(
      {
        mode: "basic",
        username: " operator ",
        password: " secret-password ",
      },
      "persistent",
    );

    const sessionRaw = window.sessionStorage.getItem(AUTH_STORAGE_KEY);
    const localRaw = window.localStorage.getItem(AUTH_STORAGE_KEY);

    expect(sessionRaw).toBe(localRaw);
    expect(sessionRaw).toContain("operator");
    expect(sessionRaw).not.toContain("secret-password");
    expect(readStoredGatewayAuthState()).toMatchObject({
      mode: "basic",
      username: "operator",
      tokenQueryParam: "access_token",
    });
    expect(readGatewayAuthHeaders("/api/v1/onboarding/startup")).toEqual({
      Authorization: `Basic ${btoa("operator:secret-password")}`,
    });

    clearGatewayAuthState();

    expect(readGatewayAuthHeaders("/api/v1/onboarding/startup")).toEqual({});
  });

  it("builds trust headers, idempotency keys, and mutation-intent markers for write requests", () => {
    persistGatewayAuthState(
      {
        mode: "token",
        token: "token-1",
      },
      "session",
    );

    const postHeaders = buildGatewayHeaders("/api/v1/chat/sessions", "POST", "corr-1", {
      "Content-Type": "application/vnd.goat+json",
      "X-Trace-Test": "yes",
    }) as Record<string, string>;

    expect(postHeaders["Content-Type"]).toBe("application/vnd.goat+json");
    expect(postHeaders.Authorization).toBe("Bearer token-1");
    expect(postHeaders["Idempotency-Key"]).toBe("tail-uuid");
    expect(postHeaders[BROWSER_MUTATION_INTENT_HEADER]).toBe(BROWSER_MUTATION_INTENT_VALUE);
    expect(postHeaders["x-goatcitadel-correlation-id"]).toBe("corr-1");
    expect(postHeaders["x-goatcitadel-origin-surface"]).toBeTruthy();
    expect(postHeaders["X-Trace-Test"]).toBe("yes");

    const getHeaders = buildGatewayHeaders("/api/v1/chat/sessions", "GET", "corr-2") as Record<string, string>;

    expect(getHeaders["Idempotency-Key"]).toBeUndefined();
    expect(getHeaders[BROWSER_MUTATION_INTENT_HEADER]).toBeUndefined();
    expect(getHeaders.Authorization).toBe("Bearer token-1");
  });

  it("wraps UI actions with explicit success and error states", async () => {
    await expect(runUiAction(async () => ({ ok: true }))).resolves.toMatchObject({
      state: "success",
      data: { ok: true },
    });

    await expect(
      runUiAction(async () => {
        throw new Error("operator action failed");
      }),
    ).resolves.toMatchObject({
      state: "error",
      error: "operator action failed",
    });
  });

  it("retries safe API requests and records terminal network errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "try later" }), {
          status: 503,
          headers: {
            "content-type": "application/json",
            "x-goatcitadel-correlation-id": "gateway-corr-1",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: { ok: true } }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-goatcitadel-correlation-id": "gateway-corr-2",
          },
        }),
      )
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(request<{ ok: boolean }>("/api/v1/health")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await expect(request("/api/v1/tasks", { method: "POST", body: "{}" })).rejects.toMatchObject({
      kind: "network",
      method: "POST",
      path: "/api/v1/tasks",
    });
  });

  it("normalizes storage-mode migration, malformed auth, and fragment bootstrap edge cases", () => {
    expect(getGatewayAuthStorageMode()).toBe("session");
    window.sessionStorage.setItem(AUTH_STORAGE_KEY, "{not-json");
    expect(readStoredGatewayAuthState()).toBeUndefined();
    expect(window.sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();

    window.sessionStorage.clear();
    window.localStorage.setItem("goatcitadel.gateway.auth.storageMode", "persistent");
    window.localStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({
        mode: "token",
        token: " migrated-token ",
      }),
    );
    expect(readStoredGatewayAuthState()).toMatchObject({
      mode: "token",
      token: "migrated-token",
    });
    expect(window.localStorage.getItem(AUTH_STORAGE_KEY)).toContain("migrated-token");

    setGatewayAuthStorageMode("persistent");
    persistGatewayAuthState({ mode: "token", token: "session-token" }, "session");
    setGatewayAuthStorageMode("persistent");
    expect(window.localStorage.getItem(AUTH_STORAGE_KEY)).toContain("session-token");

    window.location.hash = "#access_token=%20%20";
    expect(consumeGatewayAccessBootstrapFromLocation()).toEqual({ consumed: false });

    window.location.hash = "#access_token=fragment-token&view=ops";
    expect(consumeGatewayAccessBootstrapFromLocation()).toEqual({ consumed: true, source: "fragment" });
    expect(readStoredGatewayAuthState()).toMatchObject({ mode: "token", token: "fragment-token" });
    expect(window.location.hash).toBe("#view=ops");
  });

  it("classifies startup preflight HTTP failures with operator-facing messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ error: "missing startup route" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    await expect(preflightGatewayAccess()).resolves.toMatchObject({
      status: "misconfigured",
      message: "Gateway startup endpoints are unavailable. Check the Mission Control gateway URL.",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ error: "auth backend miswired", authMode: "basic" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    await expect(preflightGatewayAccess()).resolves.toMatchObject({
      status: "misconfigured",
      message: "auth backend miswired",
      authMode: "basic",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ error: "rate limited", authMode: "token" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    await expect(preflightGatewayAccess()).resolves.toMatchObject({
      status: "misconfigured",
      message: "rate limited",
      authMode: "token",
    });
  });
});
