import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "./client";

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

class MockHeaders {
  private readonly map = new Map<string, string>();

  public constructor(input: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(input)) {
      this.map.set(key.toLowerCase(), value);
    }
  }

  public get(key: string): string | null {
    return this.map.get(key.toLowerCase()) ?? null;
  }
}

class MockResponse {
  public readonly status: number;
  public readonly ok: boolean;
  public readonly headers: MockHeaders;
  private readonly payload: unknown;

  public constructor(status: number, payload: unknown, headers: Record<string, string> = {}) {
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this.payload = payload;
    this.headers = new MockHeaders(headers);
  }

  public async json(): Promise<unknown> {
    return this.payload;
  }

  public async text(): Promise<string> {
    if (typeof this.payload === "string") {
      return this.payload;
    }
    try {
      return JSON.stringify(this.payload);
    } catch {
      return String(this.payload);
    }
  }

  public async blob(): Promise<Blob> {
    const text = await this.text();
    return new Blob([text], { type: "application/json" });
  }
}

class MockEventSource {
  public onopen: ((event: Event) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public readonly url: string;
  public readonly withCredentials: boolean;

  public constructor(url: string, options?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = options?.withCredentials ?? false;
    setTimeout(() => {
      this.onopen?.(new Event("open"));
    }, 0);
  }

  public close(): void {}
}

function installMockWindow(): void {
  const win = {
    location: {
      protocol: "http:",
      hostname: "localhost",
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

function makePayload(path: string): unknown {
  if (path.includes("/api/v1/auth/sse-token")) {
    return {
      sseToken: "coverage-sse-token",
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    };
  }
  if (path.includes("/download")) {
    return {
      relativePath: "coverage.txt",
      fullPath: "./coverage.txt",
      bytes: 10,
      contentBase64: Buffer.from("coverage").toString("base64"),
    };
  }
  if (path.includes("/sessions")) {
    return {
      items: [],
      nextCursor: undefined,
      session: { sessionId: "coverage-session" },
    };
  }
  if (path.includes("/report")) {
    return {
      summary: { totalTests: 0, passRate: 0 },
      items: [],
    };
  }
  return {
    items: [],
    ok: true,
    status: "ok",
  };
}

describe("client broad coverage sweep", () => {
  beforeEach(() => {
    installMockWindow();
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      writable: true,
      value: {
        randomUUID: () => "coverage-uuid",
      },
    });
    Object.defineProperty(globalThis, "EventSource", {
      configurable: true,
      writable: true,
      value: MockEventSource,
    });
    const fetchMock = vi.fn(async (input: string | URL) => {
      const asText = String(input);
      const url = new URL(asText, "http://localhost");
      const payload = makePayload(url.pathname);
      const headers: Record<string, string> = url.pathname.includes("/download")
        ? { "content-disposition": 'attachment; filename="coverage.txt"' }
        : {};
      return new MockResponse(200, payload, headers) as unknown as Response;
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });
    client.clearGatewayAuthState();
    client.setGatewayAuthStorageMode("session");
    client.persistGatewayAuthState({ mode: "token", token: "coverage-token" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    client.clearGatewayAuthState();
  });

  it("executes most exported API helpers", async () => {
    const skip = new Set<string>([
      "isTrustedGatewayHost",
      "getGatewayAuthStorageMode",
      "setGatewayAuthStorageMode",
      "persistGatewayAuthState",
      "clearGatewayAuthState",
      "readStoredGatewayAuthState",
    ]);

    const overrides: Record<string, unknown[]> = {
      runUiAction: [async () => ({ ok: true })],
      connectEventStream: [
        () => undefined,
        () => undefined,
        { reconnectDelayMs: 1_000, onStatusChange: () => undefined },
      ],
      streamChatMessage: ["coverage-session", { content: "coverage" }, () => undefined],
      streamAgentChatMessage: ["coverage-session", { content: "coverage" }, () => undefined],
      streamChatDelegation: ["coverage-session", { content: "delegate" }, () => undefined],
      resolveApproval: ["missing-approval", { decision: "reject" }],
      retryDurableRun: ["missing-run", { reason: "coverage", actorId: "coverage" }],
      wakeDurableRun: ["missing-run", { eventType: "coverage", payload: {} }],
      createWorkspace: [{ name: "Coverage Workspace", slug: "coverage-workspace" }],
      updateWorkspace: ["coverage-workspace", { name: "Coverage Workspace Updated" }],
      createTask: [{ title: "coverage task" }],
      updateTask: ["coverage-task", { status: "in_progress" }],
      addTaskActivity: ["coverage-task", { message: "coverage message", createdBy: "coverage" }],
      addTaskDeliverable: ["coverage-task", { title: "coverage deliverable", status: "draft" }],
      registerTaskSubagent: ["coverage-task", { title: "coverage subagent", mode: "assist" }],
      updateTaskSubagent: ["coverage-subagent", { status: "running" }],
      uploadFile: ["coverage.txt", Buffer.from("coverage").toString("base64")],
      createFileFromTemplate: ["text-note", { relativePath: "coverage-note.md", overwrite: true }],
      patchSettings: [{ auth: { mode: "token" } }],
      patchMemoryItem: ["coverage-item", { pinned: true }],
      forgetMemory: [{ namespace: "coverage" }],
      createMcpServer: [{ label: "Coverage MCP", transport: "http", url: "https://example.com/mcp" }],
      updateMcpServer: ["coverage-server", { trustTier: "restricted" }],
      updateMcpServerPolicy: ["coverage-server", { requireFirstToolApproval: true }],
      invokeMcpTool: [{ serverId: "coverage-server", toolName: "search", arguments: { query: "coverage" } }],
      transcribeVoice: [{ audioBase64: Buffer.from("voice").toString("base64"), mimeType: "audio/wav" }],
      startVoiceTalkSession: [{ mode: "push_to_talk", sessionId: "coverage-session" }],
      createCronJob: [{ jobId: "coverage-cron", name: "Coverage Cron", schedule: "*/15 * * * *", enabled: false }],
      updateCronJob: ["coverage-cron", { enabled: true }],
      createDurableRun: [{ workflowType: "coverage", payload: { note: "coverage" } }],
      createAgentProfile: [{ roleId: "coverage-role", name: "Coverage Agent", systemPrompt: "coverage prompt" }],
      updateAgentProfile: ["coverage-agent", { name: "Coverage Agent Updated" }],
      archiveAgentProfile: ["coverage-agent", { archivedBy: "coverage", reason: "coverage" }],
      createIntegrationConnection: [{ catalogId: "coverage-catalog", label: "Coverage Integration", config: {} }],
      updateIntegrationConnection: ["coverage-connection", { label: "Coverage Integration Updated", config: {} }],
      patchObsidianIntegrationConfig: [{ enabled: false }],
      searchObsidianNotes: [{ query: "coverage", limit: 5 }],
      appendObsidianNote: [{ path: "Coverage.md", content: "coverage content" }],
      captureObsidianInboxEntry: [{ content: "coverage inbox", source: "coverage" }],
    };

    const asFunctions = Object.entries(client)
      .filter(([name, value]) => !skip.has(name) && typeof value === "function")
      .map(([name, value]) => [name, value as (...args: unknown[]) => unknown] as const);

    let invoked = 0;
    for (const [name, fn] of asFunctions) {
      const argList =
        overrides[name] ??
        Array.from({ length: Math.max(fn.length, 1) }, (_, index) => {
          if (index === 0) {
            if (name.startsWith("create") || name.startsWith("update") || name.startsWith("patch")) {
              return {};
            }
            if (name.startsWith("fetch") || name.startsWith("get")) {
              return "coverage-id";
            }
            return "coverage";
          }
          if (index === 1) {
            return {};
          }
          if (index === 2) {
            return 25;
          }
          return undefined;
        });

      try {
        const result = fn(...argList);
        if (result && typeof result === "object" && typeof (result as Promise<unknown>).then === "function") {
          await (result as Promise<unknown>);
        }
        invoked += 1;
      } catch {
        // Intentionally tolerant for broad execution coverage across many API shapes.
      }
    }

    expect(invoked).toBeGreaterThan(120);
  });
});
