import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildGatewayHeaders,
  buildGatewayUrl,
  clearGatewayAuthState,
  consumeGatewayAccessBootstrapFromLocation,
  getGatewayApiBaseUrl,
  getGatewayAuthStorageMode,
  normalizeGatewayBaseUrl,
  persistGatewayAuthState,
  preflightGatewayAccess,
  readGatewayAuthHeaders,
  readStoredGatewayAuthState,
  request,
  runUiAction,
  setGatewayAuthStorageMode,
} from "./client-core";
import { ApiRequestError } from "./http-internal";

class MemoryStorage implements Storage {
  private items = new Map<string, string>();

  get length() {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.items.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

function installWindow(href = "http://localhost:5173/") {
  const location = new URL(href);
  const win = {
    location,
    sessionStorage: new MemoryStorage(),
    localStorage: new MemoryStorage(),
    history: {
      replaceState: vi.fn((_state: unknown, _title: string, next: string) => {
        const nextUrl = new URL(next, location.origin);
        location.pathname = nextUrl.pathname;
        location.search = nextUrl.search;
        location.hash = nextUrl.hash;
      }),
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: win,
  });
  return win;
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

describe("client-core", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "uuid-1") });
    vi.stubGlobal("btoa", (value: string) => Buffer.from(value, "utf8").toString("base64"));
    installWindow();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("normalizes gateway URLs and builds request headers", () => {
    expect(normalizeGatewayBaseUrl(" http://localhost:8787/// ")).toBe("http://localhost:8787");
    expect(buildGatewayUrl("api/v1/health", "http://localhost:8787/")).toBe("http://localhost:8787/api/v1/health");
    expect(getGatewayApiBaseUrl()).toBeTruthy();

    expect(buildGatewayHeaders("/api/v1/chat/messages", "GET", "corr-1")).toMatchObject({
      "Content-Type": "application/json",
      "x-goatcitadel-correlation-id": "corr-1",
      "x-goatcitadel-origin-surface": "chat",
    });
    expect(buildGatewayHeaders("/api/v1/mcp/tools", "POST", "corr-2")).toMatchObject({
      "Idempotency-Key": "uuid-1",
      "x-goatcitadel-browser-intent": "mutation",
      "x-goatcitadel-origin-surface": "mcp",
    });
    expect(buildGatewayHeaders("/api/v1/addons/catalog", "PUT", "corr-3")).toMatchObject({
      "x-goatcitadel-origin-surface": "addons",
    });
    expect(buildGatewayHeaders("/api/v1/voice/status", "DELETE", "corr-4")).toMatchObject({
      "x-goatcitadel-origin-surface": "voice",
    });
    expect(buildGatewayHeaders("/api/v1/integrations/catalog", "PATCH", "corr-5", { "X-Test": "yes" })).toMatchObject({
      "X-Test": "yes",
      "x-goatcitadel-origin-surface": "integrations",
    });
  });

  it("persists, migrates, sanitizes, and clears gateway auth state", () => {
    expect(getGatewayAuthStorageMode()).toBe("session");
    setGatewayAuthStorageMode("persistent");
    expect(getGatewayAuthStorageMode()).toBe("persistent");

    persistGatewayAuthState({ mode: "token", token: " token ", tokenQueryParam: "access_token" }, "persistent");
    expect(readStoredGatewayAuthState()).toEqual({
      mode: "token",
      token: "token",
      tokenQueryParam: "access_token",
    });
    expect(readGatewayAuthHeaders("/api/v1/test")).toEqual({ Authorization: "Bearer token" });

    persistGatewayAuthState({ mode: "basic", username: "user", password: " pass " });
    expect(readStoredGatewayAuthState()).toMatchObject({ mode: "basic", username: "user" });
    expect(readStoredGatewayAuthState()).not.toHaveProperty("password");
    expect(readGatewayAuthHeaders("/api/v1/test")).toEqual({
      Authorization: `Basic ${Buffer.from("user:pass", "utf8").toString("base64")}`,
    });

    window.localStorage.removeItem("goatcitadel.gateway.auth");
    setGatewayAuthStorageMode("persistent");
    expect(window.localStorage.getItem("goatcitadel.gateway.auth")).not.toContain("pass");
    setGatewayAuthStorageMode("session");
    expect(window.localStorage.getItem("goatcitadel.gateway.auth")).toBeNull();

    persistGatewayAuthState({ token: " fallback-token " });
    expect(readGatewayAuthHeaders("/api/v1/test")).toEqual({ Authorization: "Bearer fallback-token" });

    window.sessionStorage.clear();
    window.localStorage.setItem(
      "goatcitadel.gateway.auth",
      JSON.stringify({ token: " legacy-token ", extra: "ignored", tokenQueryParam: "" }),
    );
    window.localStorage.setItem("goatcitadel.gateway.auth.storageMode", "session");
    expect(readStoredGatewayAuthState()).toEqual({
      token: "legacy-token",
      tokenQueryParam: "access_token",
    });
    expect(window.localStorage.getItem("goatcitadel.gateway.auth")).toBeNull();

    window.sessionStorage.clear();
    window.localStorage.setItem("goatcitadel.gateway.auth.storageMode", "persistent");
    window.localStorage.setItem("goatcitadel.gateway.auth", JSON.stringify({ mode: "token", token: " keep-local " }));
    expect(readStoredGatewayAuthState()).toMatchObject({ token: "keep-local" });
    expect(window.localStorage.getItem("goatcitadel.gateway.auth")).toContain("keep-local");

    window.sessionStorage.clear();
    window.localStorage.setItem("goatcitadel.gateway.auth", "{bad local json");
    expect(readStoredGatewayAuthState()).toBeUndefined();
    expect(window.localStorage.getItem("goatcitadel.gateway.auth")).toBeNull();

    window.sessionStorage.setItem("goatcitadel.gateway.auth", "[]");
    expect(readStoredGatewayAuthState()).toBeUndefined();

    window.sessionStorage.setItem("goatcitadel.gateway.auth", "{bad json");
    expect(readStoredGatewayAuthState()).toBeUndefined();

    persistGatewayAuthState({ mode: "token", token: "to-clear" }, "session");
    window.localStorage.setItem("goatcitadel.shell.last-route", "/settings");
    clearGatewayAuthState();
    expect(readStoredGatewayAuthState()).toBeUndefined();
    expect(window.localStorage.getItem("goatcitadel.shell.last-route")).toBeNull();
  });

  it("consumes one-time bootstrap tokens from the URL fragment", () => {
    installWindow("http://localhost:5173/app#state=ok&access_token=one-time");
    const result = consumeGatewayAccessBootstrapFromLocation();
    expect(result).toEqual({ consumed: true, source: "fragment" });
    expect(readGatewayAuthHeaders("/api/v1/test")).toEqual({ Authorization: "Bearer one-time" });
    expect(window.location.hash).toBe("#state=ok");

    installWindow("http://localhost:5173/app#state=ok");
    expect(consumeGatewayAccessBootstrapFromLocation()).toEqual({ consumed: false });

    installWindow("http://localhost:5173/app");
    expect(consumeGatewayAccessBootstrapFromLocation()).toEqual({ consumed: false });

    installWindow("http://localhost:5173/app#access_token=%20%20");
    expect(consumeGatewayAccessBootstrapFromLocation()).toEqual({ consumed: false });
  });

  it("wraps UI actions with success and error metadata", async () => {
    await expect(runUiAction(async () => "ok")).resolves.toMatchObject({ state: "success", data: "ok" });
    await expect(
      runUiAction(async () => {
        throw new Error("failed action");
      }),
    ).resolves.toMatchObject({ state: "error", error: "failed action" });
  });

  it("sends JSON requests, unwraps API envelopes, and reports HTTP/network errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { success: true, data: { answer: 42 } },
          { headers: { "x-goatcitadel-correlation-id": "corr-from-server" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(request<{ answer: number }>("/api/v1/chat/messages", { method: "POST", body: "{}" })).resolves.toEqual(
      {
        answer: 42,
      },
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        "x-goatcitadel-origin-surface": "chat",
        "x-goatcitadel-browser-intent": "mutation",
      }),
    });

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "auth required", authMode: "token" }, { status: 401 }));
    await expect(request("/api/v1/settings")).rejects.toMatchObject({
      kind: "http",
      status: 401,
      authMode: "token",
    });

    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await expect(request("/api/v1/settings", { method: "POST" })).rejects.toMatchObject({
      kind: "network",
      method: "POST",
    });
  });

  it("retries safe requests after transient HTTP and network failures", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "busy" }, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { ok: true } }))
      .mockRejectedValueOnce(new Error("temporary offline"))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { ok: "network" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(request<{ ok: boolean }>("/api/v1/settings")).resolves.toEqual({ ok: true });
    await expect(request<{ ok: string }>("/api/v1/settings")).resolves.toEqual({ ok: "network" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("preflights gateway access into ready, auth, unreachable, and misconfigured states", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { completed: true } }));
    await expect(preflightGatewayAccess()).resolves.toMatchObject({
      status: "ready",
      onboardingState: { completed: true },
      startupTiming: { outcome: "ready" },
    });

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "no", authMode: "basic" }, { status: 401 }));
    await expect(preflightGatewayAccess()).resolves.toMatchObject({
      status: "needs-auth",
      message: "Gateway authentication is required before Mission Control can connect.",
      rejectedStoredAuth: false,
      bootstrapTokenRejected: false,
      authMode: "basic",
    });

    persistGatewayAuthState({ mode: "token", token: "expired" });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "no", authMode: "token" }, { status: 401 }));
    await expect(preflightGatewayAccess()).resolves.toMatchObject({
      status: "needs-auth",
      rejectedStoredAuth: true,
      bootstrapTokenRejected: false,
      authMode: "token",
    });
    expect(readStoredGatewayAuthState()).toBeUndefined();

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "bad bootstrap", authMode: "token" }, { status: 403 }));
    await expect(preflightGatewayAccess({ bootstrap: { consumed: true, source: "fragment" } })).resolves.toMatchObject({
      status: "needs-auth",
      bootstrapTokenRejected: true,
      rejectedStoredAuth: false,
    });

    fetchMock.mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(new Error("offline"));
    await expect(preflightGatewayAccess()).resolves.toMatchObject({
      status: "unreachable",
      rejectedStoredAuth: false,
    });

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "missing route" }, { status: 404 }));
    await expect(preflightGatewayAccess()).resolves.toMatchObject({
      status: "misconfigured",
      message: "Gateway startup endpoints are unavailable. Check the Mission Control gateway URL.",
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "server auth misconfigured", authMode: "basic" }, { status: 500 }),
    );
    await expect(preflightGatewayAccess()).resolves.toMatchObject({
      status: "misconfigured",
      message: "server auth misconfigured",
      authMode: "basic",
    });

    fetchMock.mockResolvedValueOnce(jsonResponse({ notError: true }, { status: 500 }));
    await expect(preflightGatewayAccess()).resolves.toMatchObject({
      status: "misconfigured",
      message: "Gateway auth is configured incorrectly on the server.",
    });

    fetchMock.mockResolvedValueOnce(new Response("plain failure", { status: 418 }));
    await expect(preflightGatewayAccess()).resolves.toMatchObject({
      status: "misconfigured",
      message: expect.stringContaining("plain failure"),
    });

    fetchMock.mockResolvedValueOnce(jsonResponse([], { status: 400 }));
    await expect(preflightGatewayAccess()).resolves.toMatchObject({
      status: "misconfigured",
      message: expect.stringContaining("API error 400"),
    });
  });

  it("leaves server-side auth helpers inert when window is unavailable", () => {
    Reflect.deleteProperty(globalThis, "window");
    setGatewayAuthStorageMode("persistent");
    persistGatewayAuthState({ mode: "token", token: "x" }, "persistent");
    clearGatewayAuthState();
    expect(getGatewayAuthStorageMode()).toBe("session");
    expect(readStoredGatewayAuthState()).toBeUndefined();
    expect(readGatewayAuthHeaders("/api/v1/test")).toEqual({});
    expect(consumeGatewayAccessBootstrapFromLocation()).toEqual({ consumed: false });

    const error = new ApiRequestError("x", { kind: "http", method: "GET", path: "/x", status: 400 });
    expect(error.kind).toBe("http");
  });
});
