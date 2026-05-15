import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGatewayHeaders,
  buildGatewayUrl,
  clearGatewayAuthState,
  consumeGatewayAccessBootstrapFromLocation,
  normalizeGatewayBaseUrl,
  persistGatewayAuthState,
  readGatewayAuthHeaders,
  readStoredGatewayAuthState,
  setGatewayAuthStorageMode,
} from "./client-core";

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  clear() {
    this.items.clear();
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  key(index: number) {
    return Array.from(this.items.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
}

function installWindow(href = "http://localhost:5173/") {
  const location = new URL(href);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
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
    },
  });
}

describe("client-core loop 30 branch matrix", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "uuid-loop30") });
    vi.stubGlobal("btoa", (value: string) => Buffer.from(value, "utf8").toString("base64"));
    installWindow();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("normalizes gateway URLs and annotates request headers by surface and method", () => {
    expect(normalizeGatewayBaseUrl(" http://localhost:8787/// ")).toBe("http://localhost:8787");
    expect(buildGatewayUrl("/api/v1/settings", "http://localhost:8787/")).toBe("http://localhost:8787/api/v1/settings");
    expect(buildGatewayHeaders("/api/v1/mcp/tools", "POST", "corr")).toMatchObject({
      "Idempotency-Key": "uuid-loop30",
      "x-goatcitadel-origin-surface": "mcp",
      "x-goatcitadel-browser-intent": "mutation",
    });
    expect(buildGatewayHeaders("/api/v1/events/stream", "GET", "corr")).toMatchObject({
      "x-goatcitadel-origin-surface": "app",
    });
  });

  it("persists, migrates, and clears token/basic auth without keeping stale secrets", () => {
    persistGatewayAuthState({ mode: "token", token: " token ", tokenQueryParam: "auth" }, "persistent");
    expect(readStoredGatewayAuthState()).toMatchObject({ mode: "token", token: "token", tokenQueryParam: "auth" });
    expect(readGatewayAuthHeaders("/api/v1/settings")).toEqual({ Authorization: "Bearer token" });

    persistGatewayAuthState({ mode: "basic", username: "user", password: " pass " }, "session");
    expect(readStoredGatewayAuthState()).toEqual({ mode: "basic", username: "user", tokenQueryParam: "access_token" });
    expect(readGatewayAuthHeaders("/api/v1/settings")).toEqual({
      Authorization: `Basic ${Buffer.from("user:pass", "utf8").toString("base64")}`,
    });

    window.localStorage.setItem("goatcitadel.gateway.auth.storageMode", "persistent");
    window.localStorage.setItem("goatcitadel.gateway.auth", JSON.stringify({ mode: "basic", password: "secret" }));
    window.sessionStorage.clear();
    expect(readStoredGatewayAuthState()).toBeUndefined();
    expect(window.localStorage.getItem("goatcitadel.gateway.auth")).toBeNull();

    persistGatewayAuthState({ mode: "token", token: "clear-me" });
    window.localStorage.setItem("goatcitadel.shell.last-route", "/settings");
    clearGatewayAuthState();
    expect(readStoredGatewayAuthState()).toBeUndefined();
    expect(window.localStorage.getItem("goatcitadel.shell.last-route")).toBeNull();
  });

  it("consumes bootstrap tokens from fragments once and ignores query-only tokens", () => {
    installWindow("http://localhost:5173/app#state=ok&access_token=one");
    expect(consumeGatewayAccessBootstrapFromLocation()).toEqual({ consumed: true, source: "fragment" });
    expect(readGatewayAuthHeaders("/api/v1/settings")).toEqual({ Authorization: "Bearer one" });
    expect(window.location.hash).toBe("#state=ok");

    installWindow("http://localhost:5173/app?access_token=two&x=1");
    expect(consumeGatewayAccessBootstrapFromLocation()).toEqual({ consumed: false });

    installWindow("http://localhost:5173/app#access_token=%20%20");
    expect(consumeGatewayAccessBootstrapFromLocation()).toEqual({ consumed: false });
  });

  it("switches storage mode and drops persistent auth when returning to session mode", () => {
    persistGatewayAuthState({ mode: "token", token: "local" }, "persistent");
    setGatewayAuthStorageMode("session");
    expect(window.localStorage.getItem("goatcitadel.gateway.auth")).toBeNull();
    expect(readStoredGatewayAuthState()).toMatchObject({ token: "local" });
  });
});
