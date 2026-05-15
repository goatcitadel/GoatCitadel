import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  public get length(): number {
    return this.values.size;
  }

  public clear(): void {
    this.values.clear();
  }

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class MockEventSource {
  public static instances: MockEventSource[] = [];

  public onopen: (() => void) | null = null;

  public onerror: (() => void) | null = null;

  public onmessage: ((event: MessageEvent<string>) => void) | null = null;

  public readonly url: string;

  private readonly listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();

  public constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  public addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    const bucket = this.listeners.get(type) ?? new Set<(event: MessageEvent<string>) => void>();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }

  public close(): void {}
}

const streamCleanups: Array<() => void> = [];

function installMockWindow(): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location: {
        protocol: "http:",
        hostname: "localhost",
        pathname: "/mission-control",
        search: "",
        hash: "",
      },
      localStorage: new MemoryStorage(),
      sessionStorage: new MemoryStorage(),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
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

function toHeaderRecord(headers: HeadersInit | undefined): Record<string, string> {
  const normalized = new Headers(headers);
  return Object.fromEntries(normalized.entries());
}

type ChatApiModule = typeof import("./chat");

async function captureChatApiRequest(
  loadApi: () => Promise<ChatApiModule>,
  invoke: (api: ChatApiModule) => Promise<void>,
): Promise<{ url: string; headers: Record<string, string>; body?: string }> {
  vi.resetModules();
  installMockWindow();
  vi.stubGlobal("crypto", {
    randomUUID: () => "test-uuid",
  });
  const fetchMock = vi.fn(async (input: string | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/stream")) {
      return new Response("", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return jsonResponse({
      item: { artifactId: "artifact-1" },
      artifact: { artifactId: "tool-artifact-1" },
      content: "artifact content",
      runId: "run-1",
      steps: [],
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  const api = await loadApi();
  await invoke(api);

  const [url, init] = fetchMock.mock.calls[0] ?? [];
  return {
    url: String(url),
    headers: toHeaderRecord(init?.headers),
    body: typeof init?.body === "string" ? init.body : undefined,
  };
}

describe("Mission Control transport parity", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    installMockWindow();
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal("crypto", {
      randomUUID: () => "test-uuid",
    });
  });

  afterEach(() => {
    for (const cleanup of streamCleanups.splice(0)) {
      cleanup();
    }
    MockEventSource.instances = [];
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("uses the same auth and retry semantics through client-core and shell-client request paths", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "try again" }, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ data: { items: [], view: "active" } }))
      .mockResolvedValueOnce(jsonResponse({ error: "try again" }, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ data: { items: [], view: "active" } }));
    vi.stubGlobal("fetch", fetchMock);

    const diagnostics = await import("../state/dev-diagnostics-store");
    const core = await import("./client-core");
    const shell = await import("./shell-client");

    core.persistGatewayAuthState({ mode: "token", token: "operator-token" });

    diagnostics.clearClientDiagnostics();
    const coreRequest = core.request<{ items: unknown[]; view: string }>("/api/v1/workspaces?view=active&limit=200");
    await vi.advanceTimersByTimeAsync(250);
    await coreRequest;
    const coreHeaders = toHeaderRecord(fetchMock.mock.calls[1]?.[1]?.headers);
    const coreEvents = diagnostics.listClientDiagnostics({ category: "api", limit: 3 });

    diagnostics.clearClientDiagnostics();
    const shellRequest = shell.fetchWorkspaces();
    await vi.advanceTimersByTimeAsync(250);
    await shellRequest;
    const shellHeaders = toHeaderRecord(fetchMock.mock.calls[3]?.[1]?.headers);
    const shellEvents = diagnostics.listClientDiagnostics({ category: "api", limit: 3 });

    expect(coreHeaders.authorization).toBe("Bearer operator-token");
    expect(shellHeaders.authorization).toBe("Bearer operator-token");
    expect(coreHeaders["x-goatcitadel-origin-surface"]).toBe(shellHeaders["x-goatcitadel-origin-surface"]);
    expect(coreEvents.map((item) => item.event)).toEqual(["request.finish", "request.retry", "request.start"]);
    expect(shellEvents.map((item) => item.event)).toEqual(["request.finish", "request.retry", "request.start"]);
  });

  it("shares the same realtime stream implementation between the standard client and shell surface", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      jsonResponse({
        token: "stream-token-1",
        expiresAt: new Date().toISOString(),
        scope: "events:stream",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = await import("./client");
    const shell = await import("./shell-client");

    client.persistGatewayAuthState({ mode: "token", token: "operator-token" });

    expect(shell.connectEventStream).toBe(client.connectEventStream);

    const stop = shell.connectEventStream(() => undefined);
    streamCleanups.push(stop);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/auth/sse-token"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]?.url).toContain("/api/v1/events/stream");
    expect(MockEventSource.instances[0]?.url).toContain("sse_token=stream-token-1");

    MockEventSource.instances[0]?.onerror?.();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(2);

    stop();
    streamCleanups.pop();
  });

  it("keeps legacy and shared chat artifact routes workspace-scoped", async () => {
    const legacyGenerated = await captureChatApiRequest(
      () => import("./chat"),
      async (api) => {
        await api.fetchChatGeneratedArtifact("artifact-1", "workspace-1");
      },
    );
    const sharedGenerated = await captureChatApiRequest(
      () => import("../../../../packages/mission-control-shared/src/api/chat"),
      async (api) => {
        await api.fetchChatGeneratedArtifact("artifact-1", "workspace-1");
      },
    );
    const legacyTool = await captureChatApiRequest(
      () => import("./chat"),
      async (api) => {
        await api.fetchChatToolArtifact("tool-artifact-1", "workspace-1");
      },
    );
    const sharedTool = await captureChatApiRequest(
      () => import("../../../../packages/mission-control-shared/src/api/chat"),
      async (api) => {
        await api.fetchChatToolArtifact("tool-artifact-1", "workspace-1");
      },
    );

    expect(new URL(legacyGenerated.url).pathname).toBe(new URL(sharedGenerated.url).pathname);
    expect(new URL(legacyGenerated.url).searchParams.get("workspaceId")).toBe("workspace-1");
    expect(new URL(sharedGenerated.url).searchParams.get("workspaceId")).toBe("workspace-1");
    expect(new URL(legacyTool.url).pathname).toBe(new URL(sharedTool.url).pathname);
    expect(new URL(legacyTool.url).searchParams.get("workspaceId")).toBe("workspace-1");
    expect(new URL(sharedTool.url).searchParams.get("workspaceId")).toBe("workspace-1");
  });

  it("keeps legacy and shared resume stream surface headers in parity", async () => {
    const legacy = await captureChatApiRequest(
      () => import("./chat"),
      async (api) => {
        await api.resumeChatTurnStream("session-1", "turn-1", () => undefined, {
          originSurface: "cowork",
          sinceEventId: "event-1",
        });
      },
    );
    const shared = await captureChatApiRequest(
      () => import("../../../../packages/mission-control-shared/src/api/chat"),
      async (api) => {
        await api.resumeChatTurnStream("session-1", "turn-1", () => undefined, {
          originSurface: "cowork",
          sinceEventId: "event-1",
        });
      },
    );

    expect(new URL(legacy.url).pathname).toBe(new URL(shared.url).pathname);
    expect(new URL(legacy.url).searchParams.get("sinceEventId")).toBe("event-1");
    expect(new URL(shared.url).searchParams.get("sinceEventId")).toBe("event-1");
    expect(legacy.headers["last-event-id"]).toBe("event-1");
    expect(shared.headers["last-event-id"]).toBe("event-1");
    expect(legacy.headers["x-goatcitadel-origin-surface"]).toBe("cowork");
    expect(shared.headers["x-goatcitadel-origin-surface"]).toBe("cowork");
  });

  it("keeps legacy and shared delegation surface propagation in parity", async () => {
    const legacy = await captureChatApiRequest(
      () => import("./chat"),
      async (api) => {
        await api.runChatDelegation("session-1", {
          objective: "Implement the plan",
          surfaceMode: "code",
          roles: ["Coder"],
        });
      },
    );
    const shared = await captureChatApiRequest(
      () => import("../../../../packages/mission-control-shared/src/api/chat"),
      async (api) => {
        await api.runChatDelegation("session-1", {
          objective: "Implement the plan",
          surfaceMode: "code",
          roles: ["Coder"],
        });
      },
    );

    expect(new URL(legacy.url).pathname).toBe(new URL(shared.url).pathname);
    expect(legacy.headers["x-goatcitadel-origin-surface"]).toBe("code");
    expect(shared.headers["x-goatcitadel-origin-surface"]).toBe("code");
    expect(JSON.parse(legacy.body ?? "{}")).toEqual(JSON.parse(shared.body ?? "{}"));
  });
});
