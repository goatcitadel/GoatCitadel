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

function installMockWindow(): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location: {
        protocol: "http:",
        hostname: "localhost",
        pathname: "/cowork",
        search: "",
        hash: "",
      },
      localStorage: new MemoryStorage(),
      sessionStorage: new MemoryStorage(),
    },
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

function toHeaderRecord(headers: HeadersInit | undefined): Record<string, string> {
  const normalized = new Headers(headers);
  return Object.fromEntries(normalized.entries());
}

describe("chat API origin surface headers", () => {
  beforeEach(() => {
    vi.resetModules();
    installMockWindow();
    vi.stubGlobal("crypto", {
      randomUUID: () => "test-uuid",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("defaults chat requests to chat origin surface", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ sessionId: "session-1" }));
    vi.stubGlobal("fetch", fetchMock);
    const { createChatSession } = await import("./chat");

    await createChatSession({ mode: "chat" });

    const headers = toHeaderRecord(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers["x-goatcitadel-origin-surface"]).toBe("chat");
    expect(headers["x-goatcitadel-browser-intent"]).toBe("mutation");
  });

  it("allows Cowork to override chat-route origin surface", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ sessionId: "session-1", turnId: "turn-1" }));
    vi.stubGlobal("fetch", fetchMock);
    const { sendAgentChatMessage } = await import("./chat");

    await sendAgentChatMessage(
      "session-1",
      { content: "Coordinate beta outreach", mode: "cowork" },
      {
        originSurface: "cowork",
      },
    );

    const headers = toHeaderRecord(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers["x-goatcitadel-origin-surface"]).toBe("cowork");
    expect(headers["x-goatcitadel-browser-intent"]).toBe("mutation");
  });
});
