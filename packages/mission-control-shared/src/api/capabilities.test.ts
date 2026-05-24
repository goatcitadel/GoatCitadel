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
        pathname: "/code",
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

describe("capabilities API", () => {
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

  it("sends Code Mode originSurface in both body and gateway headers", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ runId: "code-run-1", status: "approval_pending" }));
    vi.stubGlobal("fetch", fetchMock);
    const { createCodeModeRun } = await import("./capabilities");

    await createCodeModeRun({
      language: "typescript",
      source: "return { ok: true };",
      originSurface: "code",
      sessionId: "session-1",
      turnId: "turn-1",
      permissionProfileId: "trusted-local-power",
      localOperatorOverrideId: "override-1",
    });

    const call = fetchMock.mock.calls[0];
    expect(String(call?.[0])).toContain("/api/v1/code-mode/runs");
    expect(toHeaderRecord(call?.[1]?.headers)["x-goatcitadel-origin-surface"]).toBe("code");
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
      language: "typescript",
      source: "return { ok: true };",
      originSurface: "code",
      sessionId: "session-1",
      turnId: "turn-1",
      permissionProfileId: "trusted-local-power",
      localOperatorOverrideId: "override-1",
    });
  });

  it("builds scoped Code Mode artifact and comparison URLs", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { compareCodeModeRuns, fetchCodeModeRunArtifact } = await import("./capabilities");

    await fetchCodeModeRunArtifact("run/1", "policy_snapshot", {
      sessionId: "session-1",
      turnId: "turn-1",
      workspaceId: "workspace-1",
    });
    await compareCodeModeRuns("run/1", "run/0", {
      sessionId: "session-1",
      workspaceId: "workspace-1",
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/api/v1/code-mode/runs/run%2F1/artifacts/policy_snapshot?sessionId=session-1&turnId=turn-1&workspaceId=workspace-1",
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "/api/v1/code-mode/runs/run%2F1/compare/run%2F0?sessionId=session-1&workspaceId=workspace-1",
    );
  });
});
