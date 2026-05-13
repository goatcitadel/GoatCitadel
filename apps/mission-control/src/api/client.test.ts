import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptMemoryMaintenanceRecommendation,
  clearGatewayAuthState,
  connectEventStream,
  fetchMemoryMaintenancePolicy,
  fetchMemoryMaintenanceRuns,
  getGatewayAuthStorageMode,
  isTrustedGatewayHost,
  patchMemoryMaintenancePolicy,
  persistGatewayAuthState,
  readStoredGatewayAuthState,
  rejectMemoryMaintenanceRecommendation,
  runMemoryMaintenanceNow,
  setGatewayAuthStorageMode,
  streamAgentChatMessage,
} from "./client";

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
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    localStorage: createMemoryStorage(),
    sessionStorage: createMemoryStorage(),
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: win,
  });
}

async function settlePromises(iterations = 4): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

async function waitForCondition(condition: () => boolean, attempts = 20): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    await settlePromises();
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("isTrustedGatewayHost", () => {
  beforeEach(() => {
    installMockWindow();
    clearGatewayAuthState();
    setGatewayAuthStorageMode("session");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearGatewayAuthState();
  });

  it("allows local and private hosts by default", () => {
    expect(isTrustedGatewayHost("localhost")).toBe(true);
    expect(isTrustedGatewayHost("127.0.0.1")).toBe(true);
    expect(isTrustedGatewayHost("10.0.0.15")).toBe(true);
    expect(isTrustedGatewayHost("100.115.92.2")).toBe(true);
    expect(isTrustedGatewayHost("bld.ts.net")).toBe(true);
  });

  it("rejects untrusted public hostnames without explicit allowlist", () => {
    expect(isTrustedGatewayHost("evil.example.com")).toBe(false);
  });

  it("allows explicitly configured hosts", () => {
    expect(isTrustedGatewayHost("gateway.internal", "gateway.internal,.corp.local")).toBe(true);
    expect(isTrustedGatewayHost("api.corp.local", "gateway.internal,.corp.local")).toBe(true);
  });

  it("stores auth session-only by default", () => {
    persistGatewayAuthState({
      mode: "token",
      token: "abc123",
    });

    const stored = readStoredGatewayAuthState();
    expect(stored).toMatchObject({ mode: "token", token: "abc123" });
    expect(getGatewayAuthStorageMode()).toBe("session");
    expect(window.sessionStorage.getItem("goatcitadel.gateway.auth")).toBeTruthy();
    expect(window.localStorage.getItem("goatcitadel.gateway.auth")).toBeNull();
  });

  it("supports persistent remember-me storage when enabled", () => {
    setGatewayAuthStorageMode("persistent");
    persistGatewayAuthState(
      {
        mode: "basic",
        username: "operator",
        password: "secret",
      },
      "persistent",
    );

    expect(getGatewayAuthStorageMode()).toBe("persistent");
    expect(window.sessionStorage.getItem("goatcitadel.gateway.auth")).toBeTruthy();
    expect(window.localStorage.getItem("goatcitadel.gateway.auth")).toBeTruthy();
    expect(readStoredGatewayAuthState()).toMatchObject({
      mode: "basic",
      username: "operator",
    });
    expect(readStoredGatewayAuthState()).not.toHaveProperty("password");
    expect(window.sessionStorage.getItem("goatcitadel.gateway.auth")).not.toContain("secret");
    expect(window.localStorage.getItem("goatcitadel.gateway.auth")).not.toContain("secret");
  });

  it("clears the persisted last-route shell state with auth reset", () => {
    window.localStorage.setItem("goatcitadel.shell.last-route", "?space=operate&page=surface&surface=code");
    persistGatewayAuthState({
      mode: "token",
      token: "abc123",
    });

    clearGatewayAuthState();

    expect(window.localStorage.getItem("goatcitadel.shell.last-route")).toBeNull();
    expect(window.sessionStorage.getItem("goatcitadel.gateway.auth")).toBeNull();
  });

  it("clears stale lease and gateway node identity when the realtime stream errors and retries", async () => {
    class MockEventSource {
      public static instances: MockEventSource[] = [];
      public onopen: ((event: Event) => void) | null = null;
      public onerror: ((event: Event) => void) | null = null;
      private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();

      public constructor(_url: string) {
        MockEventSource.instances.push(this);
      }

      public addEventListener(type: string, listener: (event: MessageEvent) => void): void {
        const current = this.listeners.get(type) ?? [];
        current.push(listener);
        this.listeners.set(type, current);
      }

      public emit(type: string, payload: unknown): void {
        const event = {
          data: JSON.stringify(payload),
        } as MessageEvent;
        for (const listener of this.listeners.get(type) ?? []) {
          listener(event);
        }
      }

      public close(): void {}
    }

    vi.stubGlobal("EventSource", MockEventSource);

    const statuses: Array<{
      state: string;
      leaseId?: string;
      clientId?: string;
      gatewayNodeId?: string;
    }> = [];
    const disconnect = connectEventStream(
      () => undefined,
      undefined,
      (status) => {
        statuses.push({
          state: status.state,
          leaseId: status.leaseId,
          clientId: status.clientId,
          gatewayNodeId: status.gatewayNodeId,
        });
      },
    );

    await settlePromises();
    const source = MockEventSource.instances[0];
    if (!source) {
      throw new Error("Expected a realtime EventSource instance.");
    }

    source.onopen?.(new Event("open"));
    source.emit("stream-ready", {
      leaseId: "lease-1",
      clientId: "client-1",
      gatewayNodeId: "node-1",
    });
    await settlePromises();

    expect(statuses.at(-1)).toMatchObject({
      state: "open",
      leaseId: "lease-1",
      clientId: "client-1",
      gatewayNodeId: "node-1",
    });

    source.onerror?.(new Event("error"));
    await settlePromises();

    expect(statuses.at(-1)).toMatchObject({
      state: "retrying",
      leaseId: undefined,
      clientId: "client-1",
      gatewayNodeId: undefined,
    });

    disconnect();
  });

  it("surfaces bridge-token failures for authenticated realtime streams instead of falling back to anonymous SSE", async () => {
    persistGatewayAuthState({
      mode: "token",
      token: "secret-token",
    });

    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/auth/sse-token")) {
        return new Response(JSON.stringify({ error: "bridge token unavailable" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    class MockEventSource {
      public static instances: MockEventSource[] = [];

      public constructor(_url: string) {
        MockEventSource.instances.push(this);
      }

      public close(): void {}

      public addEventListener(): void {}
    }

    vi.stubGlobal("EventSource", MockEventSource);

    const states: string[] = [];
    const disconnect = connectEventStream(
      () => undefined,
      (state) => {
        states.push(state);
      },
    );

    await waitForCondition(() => states.includes("retrying"));

    expect(MockEventSource.instances).toHaveLength(0);
    expect(states).toContain("error");
    expect(states).toContain("retrying");
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/v1/auth/sse-token"))).toBe(true);

    disconnect();
  });

  it("falls back to direct realtime SSE when stored auth is stale but gateway auth mode is none", async () => {
    persistGatewayAuthState({
      mode: "token",
      token: "stale-token",
    });

    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/auth/sse-token")) {
        return new Response(JSON.stringify({ error: "SSE token bridge is not needed when auth mode is none" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    class MockEventSource {
      public static instances: MockEventSource[] = [];
      public readonly url: string;

      public constructor(url: string) {
        this.url = url;
        MockEventSource.instances.push(this);
      }

      public close(): void {}

      public addEventListener(): void {}
    }

    vi.stubGlobal("EventSource", MockEventSource);

    const states: string[] = [];
    const disconnect = connectEventStream(
      () => undefined,
      (state) => {
        states.push(state);
      },
    );

    await waitForCondition(() => MockEventSource.instances.length === 1);

    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes("/api/v1/auth/sse-token"))).toHaveLength(1);
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]?.url).toContain("/api/v1/events/stream");
    expect(MockEventSource.instances[0]?.url).not.toContain("sse_token=");
    expect(readStoredGatewayAuthState()).toBeUndefined();
    expect(states).not.toContain("retrying");

    disconnect();
  });

  it("drops legacy session-mode localStorage auth instead of rehydrating web storage", () => {
    window.localStorage.setItem(
      "goatcitadel.gateway.auth",
      JSON.stringify({
        mode: "token",
        token: "legacy-token",
        tokenQueryParam: "access_token",
      }),
    );

    const migrated = readStoredGatewayAuthState();

    expect(migrated).toBeUndefined();
    expect(window.sessionStorage.getItem("goatcitadel.gateway.auth")).toBeNull();
    expect(window.localStorage.getItem("goatcitadel.gateway.auth")).toBeNull();
  });

  it("treats aborted SSE chat streams as silent cancellation", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "message_start",
                sessionId: "sess-1",
                turnId: "turn-1",
                messageId: "assistant-1",
                branchKind: "append",
              })}\n\n`,
            ),
          );
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    const controller = new AbortController();
    const chunks: Array<{ type: string }> = [];

    await expect(
      streamAgentChatMessage(
        "sess-1",
        { content: "coverage" },
        (chunk) => {
          chunks.push({ type: chunk.type });
          controller.abort();
        },
        { signal: controller.signal },
      ),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(chunks).toEqual([{ type: "message_start" }]);
  });

  it("fails chat streams on malformed SSE payloads instead of swallowing them", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"message_start"\n\n'));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    await expect(streamAgentChatMessage("sess-1", { content: "coverage" }, () => undefined)).rejects.toThrow(
      /Malformed SSE event payload/,
    );
  });

  it("fails chat streams when an SSE event grows past the client buffer limit", async () => {
    const encoder = new TextEncoder();
    const oversizedChunk = `data: ${"x".repeat(300_000)}`;
    const fetchMock = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(oversizedChunk));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    await expect(streamAgentChatMessage("sess-1", { content: "coverage" }, () => undefined)).rejects.toThrow(
      /buffer limit/,
    );
  });

  it("targets the memory-maintenance read endpoints with workspace-scoped query params", async () => {
    const fetchMock = vi.fn(async (_input: string | URL) => {
      return new Response(JSON.stringify({ items: [], workspaceId: "workspace-alpha" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    await fetchMemoryMaintenancePolicy("workspace-alpha");
    await fetchMemoryMaintenanceRuns("workspace-alpha", 25);

    const calls = fetchMock.mock.calls as unknown as Array<[string | URL, RequestInit | undefined]>;
    expect(calls).toHaveLength(2);
    const firstCall = calls[0];
    const secondCall = calls[1];
    if (!firstCall || !secondCall) {
      throw new Error("Expected memory-maintenance read calls to be recorded.");
    }
    const firstUrl = new URL(String(firstCall[0]));
    const secondUrl = new URL(String(secondCall[0]));

    expect(firstUrl.pathname).toBe("/api/v1/memory/maintenance/policy");
    expect(firstUrl.searchParams.get("workspaceId")).toBe("workspace-alpha");
    expect(secondUrl.pathname).toBe("/api/v1/memory/maintenance/runs");
    expect(secondUrl.searchParams.get("workspaceId")).toBe("workspace-alpha");
    expect(secondUrl.searchParams.get("limit")).toBe("25");
  });

  it("targets the memory-maintenance mutation endpoints with the expected verbs and payloads", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });

    await patchMemoryMaintenancePolicy("workspace-alpha", { enabled: true, minChangedSessions: 5 });
    await runMemoryMaintenanceNow({ workspaceId: "workspace-alpha", triggerSource: "manual" });
    await acceptMemoryMaintenanceRecommendation("recommendation-1");
    await rejectMemoryMaintenanceRecommendation("recommendation-2");

    const calls = fetchMock.mock.calls as unknown as Array<[string | URL, RequestInit | undefined]>;
    expect(calls).toHaveLength(4);
    const patchCall = calls[0];
    const runCall = calls[1];
    const acceptCall = calls[2];
    const rejectCall = calls[3];
    if (!patchCall || !runCall || !acceptCall || !rejectCall) {
      throw new Error("Expected memory-maintenance mutation calls to be recorded.");
    }
    const patchUrl = new URL(String(patchCall[0]));
    const patchInit = patchCall[1] ?? {};
    const runUrl = new URL(String(runCall[0]));
    const runInit = runCall[1] ?? {};
    const acceptUrl = new URL(String(acceptCall[0]));
    const acceptInit = acceptCall[1] ?? {};
    const rejectUrl = new URL(String(rejectCall[0]));
    const rejectInit = rejectCall[1] ?? {};

    expect(patchUrl.pathname).toBe("/api/v1/memory/maintenance/policy");
    expect(patchUrl.searchParams.get("workspaceId")).toBe("workspace-alpha");
    expect(patchInit.method).toBe("PATCH");
    expect(String(patchInit.body ?? "")).toContain('"enabled":true');
    expect(String(patchInit.body ?? "")).toContain('"minChangedSessions":5');

    expect(runUrl.pathname).toBe("/api/v1/memory/maintenance/run-now");
    expect(runInit.method).toBe("POST");
    expect(String(runInit.body ?? "")).toContain('"workspaceId":"workspace-alpha"');
    expect(String(runInit.body ?? "")).toContain('"triggerSource":"manual"');

    expect(acceptUrl.pathname).toBe("/api/v1/memory/maintenance/recommendations/recommendation-1/accept");
    expect(acceptInit.method).toBe("POST");
    expect(rejectUrl.pathname).toBe("/api/v1/memory/maintenance/recommendations/recommendation-2/reject");
    expect(rejectInit.method).toBe("POST");
  });
});
