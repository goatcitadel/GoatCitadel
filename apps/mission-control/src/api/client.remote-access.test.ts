import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  persistGatewayAuthState,
  clearGatewayAuthState,
  consumeGatewayAccessBootstrapFromLocation,
  fetchOnboardingState,
  isApiRequestError,
  preflightGatewayAccess,
  readStoredGatewayAuthState,
  setGatewayAuthStorageMode,
} from "./client";
import {
  buildDevDiagnosticsBundle,
  clearClientDiagnostics,
  recordClientDiagnostic,
  setDevDiagnosticsCurrentRoute,
} from "../state/dev-diagnostics-store";

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => {
      map.clear();
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
}

function installMockWindow(urlValue = "http://localhost:5173/"): void {
  const applyUrl = (nextValue: string) => {
    const next = new URL(nextValue, urlValue);
    location.href = next.toString();
    location.origin = next.origin;
    location.protocol = next.protocol;
    location.hostname = next.hostname;
    location.pathname = next.pathname;
    location.search = next.search;
    location.hash = next.hash;
  };

  const initial = new URL(urlValue);
  const location = {
    href: initial.toString(),
    origin: initial.origin,
    protocol: initial.protocol,
    hostname: initial.hostname,
    pathname: initial.pathname,
    search: initial.search,
    hash: initial.hash,
  };
  const history = {
    replaceState: (_state: unknown, _unused: string, nextUrl?: string | URL | null) => {
      if (typeof nextUrl === "string") {
        applyUrl(nextUrl);
      } else if (nextUrl instanceof URL) {
        applyUrl(nextUrl.toString());
      }
    },
    pushState: (_state: unknown, _unused: string, nextUrl?: string | URL | null) => {
      if (typeof nextUrl === "string") {
        applyUrl(nextUrl);
      } else if (nextUrl instanceof URL) {
        applyUrl(nextUrl.toString());
      }
    },
  };

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location,
      history,
      localStorage: createMemoryStorage(),
      sessionStorage: createMemoryStorage(),
    },
  });
  Object.defineProperty(globalThis, "history", {
    configurable: true,
    writable: true,
    value: history,
  });
}

describe("Mission Control remote access bootstrap", () => {
  beforeEach(() => {
    installMockWindow();
    clearGatewayAuthState();
    setGatewayAuthStorageMode("session");
  });

  afterEach(() => {
    clearGatewayAuthState();
    clearClientDiagnostics();
    vi.unstubAllGlobals();
  });

  it("consumes access_token from the URL fragment and strips it from the address bar", () => {
    installMockWindow("http://localhost:5173/?tab=dashboard#access_token=abc123");

    const result = consumeGatewayAccessBootstrapFromLocation();

    expect(result).toEqual({ consumed: true, source: "fragment" });
    expect(readStoredGatewayAuthState()).toMatchObject({
      mode: "token",
      token: "abc123",
    });
    expect(window.location.href).toBe("http://localhost:5173/?tab=dashboard");
  });

  it("leaves non-bootstrap hashes alone", () => {
    installMockWindow("http://localhost:5173/?tab=dashboard#dashboard");

    const result = consumeGatewayAccessBootstrapFromLocation();

    expect(result).toEqual({ consumed: false });
    expect(window.location.href).toBe("http://localhost:5173/?tab=dashboard#dashboard");
    expect(readStoredGatewayAuthState()).toBeUndefined();
  });

  it("surfaces structured auth metadata on API failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/api/v1/onboarding/state")) {
        return new Response(JSON.stringify({
          error: "Unauthorized",
          authMode: "token",
        }), {
          status: 401,
          headers: {
            "content-type": "application/json",
          },
        });
      }
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    }) as typeof fetch);

    let captured: unknown;
    try {
      await fetchOnboardingState();
    } catch (error) {
      captured = error;
    }

    expect(isApiRequestError(captured)).toBe(true);
    expect((captured as { status?: number }).status).toBe(401);
    expect((captured as { authMode?: string }).authMode).toBe("token");
  });

  it("clears a rejected bootstrap token and returns a needs-auth preflight result", async () => {
    installMockWindow("http://localhost:5173/?tab=dashboard#access_token=stale-token");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }
      if (url.pathname.endsWith("/api/v1/onboarding/startup")) {
        return new Response(JSON.stringify({
          error: "Unauthorized",
          authMode: "token",
        }), {
          status: 401,
          headers: {
            "content-type": "application/json",
          },
        });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    }) as typeof fetch);

    const bootstrap = consumeGatewayAccessBootstrapFromLocation();
    const result = await preflightGatewayAccess({ bootstrap });

    expect(result.status).toBe("needs-auth");
    expect(result.bootstrapTokenRejected).toBe(true);
    expect(result.authMode).toBe("token");
    expect(readStoredGatewayAuthState()).toBeUndefined();
  });

  it("clears rejected stored credentials and reports the auth failure explicitly", async () => {
    persistGatewayAuthState({
      mode: "token",
      token: "expired-token",
      tokenQueryParam: "access_token",
    }, "persistent");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }
      return new Response(JSON.stringify({
        error: "Unauthorized",
        authMode: "token",
      }), {
        status: 401,
        headers: {
          "content-type": "application/json",
        },
      });
    }) as typeof fetch);

    const result = await preflightGatewayAccess();

    expect(result.status).toBe("needs-auth");
    expect(result.rejectedStoredAuth).toBe(true);
    expect(readStoredGatewayAuthState()).toBeUndefined();
  });

  it("classifies an unreachable startup probe before Mission Control starts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch);

    const result = await preflightGatewayAccess();

    expect(result.status).toBe("unreachable");
    expect(result.healthDetail).toMatch(/ECONNREFUSED/);
  });

  it("uses the authenticated startup probe without a separate health request", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/api/v1/onboarding/startup")) {
        return new Response(JSON.stringify({
          completed: true,
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }
      throw new Error(`unexpected path: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const result = await preflightGatewayAccess();

    expect(result.status).toBe("ready");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/v1/onboarding/startup");
    expect(result.startupTiming?.phases).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "health",
        status: "skipped",
      }),
      expect.objectContaining({
        key: "auth",
        status: "success",
      }),
    ]));
  });

  it("sanitizes access tokens out of dev diagnostics route state and emitted events", () => {
    setDevDiagnosticsCurrentRoute("/?tab=dashboard#access_token=secret-token&view=ops");
    recordClientDiagnostic({
      level: "info",
      category: "ui",
      event: "route.check",
      message: "Route sanitized",
      route: "/?tab=chat#access_token=secret-token&focus=latest",
    });

    const bundle = buildDevDiagnosticsBundle();
    expect(bundle.route).toBe("/?tab=dashboard#view=ops");
    expect(JSON.stringify(bundle)).not.toContain("secret-token");
    expect(JSON.stringify(bundle)).not.toContain("access_token");
  });
});
