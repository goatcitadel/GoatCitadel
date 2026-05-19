import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearGatewayAuthState,
  createGatewayDeviceAccessRequest,
  fetchWorkspaces,
  pollGatewayDeviceAccessRequestStatus,
  resolveApproval,
  resolveApprovalWithRemoteToken,
  setGatewayAuthStorageMode,
} from "./shell-client";

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

function installMockWindow(): void {
  const win = {
    location: {
      protocol: "http:",
      hostname: "localhost",
      hash: "",
      href: "http://localhost:5173/",
    },
    history: {
      replaceState: vi.fn(),
    },
    localStorage: createMemoryStorage(),
    sessionStorage: createMemoryStorage(),
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: win,
  });
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });
}

describe("shell-client request parity", () => {
  beforeEach(() => {
    installMockWindow();
    clearGatewayAuthState();
    setGatewayAuthStorageMode("session");
    vi.useFakeTimers();
  });

  afterEach(() => {
    clearGatewayAuthState();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("adds browser mutation intent on write requests", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: {
          requestId: "req-1",
          verificationUri: "https://example.test/verify",
          userCode: "ABC-123",
          requestSecret: "secret",
          expiresAt: "2026-03-22T12:15:00.000Z",
          pollIntervalSeconds: 5,
        },
      }),
    );
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    await createGatewayDeviceAccessRequest({
      deviceLabel: "Mission Control",
      deviceType: "desktop",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(init.method).toBe("POST");
    expect(headers["x-goatcitadel-browser-intent"]).toBe("mutation");
    expect(headers["Idempotency-Key"]).toBeTruthy();
  });

  it("does not add browser mutation intent on safe reads", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: {
          items: [],
          view: "active",
        },
      }),
    );
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    await fetchWorkspaces();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(init.method).toBe("GET");
    expect(headers["x-goatcitadel-browser-intent"]).toBeUndefined();
  });

  it("retries transient safe read failures once", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "temporarily unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            items: [],
            view: "active",
          },
        }),
      );
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    const promise = fetchWorkspaces();
    await vi.runAllTimersAsync();
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry unsafe writes automatically", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "temporarily unavailable" }, { status: 503 }));
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    await expect(resolveApproval("approval-1", { decision: "approve" })).rejects.toThrow(/503/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("polls device access status with the request secret header", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: {
          requestId: "request 1",
          status: "pending",
        },
      }),
    );
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    await pollGatewayDeviceAccessRequestStatus("request 1", "secret-value");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(url).toContain("/api/v1/auth/device-requests/request%201/status");
    expect(headers["x-goatcitadel-device-request-secret"]).toBe("secret-value");
    expect(headers["x-goatcitadel-browser-intent"]).toBeUndefined();
  });

  it("resolves remote approvals with a single-use token as an unsafe mutation", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: {
          approval: {
            approvalId: "approval-remote",
            status: "approved",
          },
        },
      }),
    );
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    await resolveApprovalWithRemoteToken("remote-token", "approve");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(url).toContain("/api/v1/approvals/remote-resolve");
    expect(init.method).toBe("POST");
    expect(headers["x-goatcitadel-browser-intent"]).toBe("mutation");
    expect(init.body).toBe(JSON.stringify({ token: "remote-token", decision: "approve" }));
  });
});
