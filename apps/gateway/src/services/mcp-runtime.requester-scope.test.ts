import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeRequesterScopedMcpToolCall, type McpRequesterScopedToolCallAttempt } from "./mcp-runtime.js";
import { McpRequesterResolutionError } from "./mcp-requester-resolution.js";

// HX-415 runtime integration seam. These tests prove the RUNTIME WIRING around
// the already-shipped, independently-reviewed requester attempt lease. They use
// a structural test double for the lease — the unforgeable authority/lease
// itself is proven in the resolver tranche; here we prove that the transport:
//   * routes through the isolated guarded dispatcher (never the shared cache);
//   * uses the resolved URL + headers as the SOLE auth material;
//   * fires the HX-305 effect callback exactly once, at the tools/call write;
//   * follows zero redirects;
//   * leaves no live attempt (disposes) on success or failure; and
//   * never lets the ephemeral connection/lease reach the returned result.

interface FakeAttempt extends McpRequesterScopedToolCallAttempt {
  readonly events: string[];
  disposed(): boolean;
  abortNow(): void;
}

function createFakeAttempt(
  options: {
    url?: string;
    headers?: Array<{ name: string; value: string }>;
    rawRemoteToolName?: string;
    assertCurrent?: () => void;
  } = {},
): FakeAttempt {
  const events: string[] = [];
  const controller = new AbortController();
  let disposed = false;
  return {
    events,
    disposed: () => disposed,
    abortNow: () => controller.abort(),
    connection: {
      outcomeClass: "resolved",
      url: options.url ?? "https://scoped.example.com/mcp",
      headers: Object.freeze(options.headers ?? [{ name: "authorization", value: "Bearer resolved-secret" }]),
      connectionGeneration: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      toJSON(): never {
        throw new Error("ephemeral connection is not serializable");
      },
    } as unknown as McpRequesterScopedToolCallAttempt["connection"],
    signal: controller.signal,
    assertCurrent(): void {
      events.push("assertCurrent");
      options.assertCurrent?.();
    },
    authorizeToolsCall() {
      events.push("authorize");
      return {
        stage: "tool_call",
        operation: "tools/call",
        authoritySha256: "a".repeat(64),
        finalEffectAttemptId: "effect-1",
        finalEffectAttemptGeneration: 1,
        connectionGeneration: 1,
        serverId: "srv-scoped",
        rawRemoteToolName: options.rawRemoteToolName ?? "remote_tool",
        canonicalToolName: "remote_tool",
        providerAlias: "mcp__scoped",
      } as unknown as ReturnType<McpRequesterScopedToolCallAttempt["authorizeToolsCall"]>;
    },
    consumeToolsCallPermit(input) {
      events.push("consume");
      return input;
    },
    scrubText(input) {
      return input;
    },
    scrubDiagnostic(input) {
      return input;
    },
    dispose(): void {
      disposed = true;
      events.push("dispose");
    },
  };
}

const ALLOWLIST = ["scoped.example.com"];
const originalFetch = global.fetch;

interface Captured {
  url: string;
  method: string;
  init: RequestInit & { dispatcher?: unknown; headers?: Record<string, string> };
}

let captured: Captured[];
let order: string[];

function jsonRpcResponse(id: number, result: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json", "mcp-session-id": "session-abc" },
  });
}

/** Route the stub by JSON-RPC method; override per-test via `handlers`. */
function stubFetch(handlers: Partial<Record<string, (id: number) => Response>>): void {
  global.fetch = vi.fn(async (url: string, init?: RequestInit & { dispatcher?: unknown }) => {
    const body = JSON.parse(String((init as RequestInit).body)) as { id?: number; method?: string };
    const method = body.method ?? "unknown";
    order.push(`fetch:${method}`);
    captured.push({ url, method, init: (init ?? {}) as Captured["init"] });
    const handler = handlers[method];
    if (handler) {
      return handler(body.id ?? 0);
    }
    if (method === "initialize") {
      return jsonRpcResponse(body.id ?? 0, { protocolVersion: "2025-06-18" });
    }
    if (method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (method === "tools/call") {
      return jsonRpcResponse(body.id ?? 0, { content: [{ type: "text", text: "done" }] });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof global.fetch;
}

beforeEach(() => {
  captured = [];
  order = [];
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("invokeRequesterScopedMcpToolCall (HX-415 runtime seam)", () => {
  it("fires the effect callback exactly once, immediately before the tools/call write", async () => {
    stubFetch({});
    const attempt = createFakeAttempt();
    const effectDispatch = vi.fn(() => order.push("effectDispatch"));

    const result = await invokeRequesterScopedMcpToolCall({
      attempt,
      toolName: "mcp__scoped",
      arguments: { a: 1 },
      effectDispatch,
      networkAllowlist: ALLOWLIST,
    });

    expect(result.ok).toBe(true);
    expect(effectDispatch).toHaveBeenCalledTimes(1);
    // The effect callback fires after initialize + initialized and immediately
    // before the tools/call bytes are written.
    expect(order).toEqual([
      "fetch:initialize",
      "fetch:notifications/initialized",
      "effectDispatch",
      "fetch:tools/call",
    ]);
    expect(attempt.disposed()).toBe(true);
  });

  it("uses the resolved URL + headers as the sole auth material over an isolated dispatcher", async () => {
    stubFetch({});
    const attempt = createFakeAttempt({
      url: "https://scoped.example.com/mcp",
      headers: [{ name: "x-requester", value: "requester-token" }],
      rawRemoteToolName: "remote_search",
    });

    await invokeRequesterScopedMcpToolCall({
      attempt,
      toolName: "mcp__scoped",
      arguments: { q: "hi" },
      effectDispatch: () => undefined,
      networkAllowlist: ALLOWLIST,
    });

    const toolsCall = captured.find((call) => call.method === "tools/call");
    expect(toolsCall?.url).toBe("https://scoped.example.com/mcp");
    expect(toolsCall?.init.headers?.["x-requester"]).toBe("requester-token");
    // An isolated per-attempt dispatcher is always threaded through.
    expect(toolsCall?.init.dispatcher).toBeDefined();
    // Zero-redirect: the single-shot guarded fetch is used.
    expect(toolsCall?.init.redirect).toBe("manual");
    // The remote tool name comes from the authorized permit, not the caller alias.
    const body = JSON.parse(String(toolsCall?.init.body)) as { params?: { name?: string } };
    expect(body.params?.name).toBe("remote_search");
  });

  it("treats an initialize failure as pre-dispatch and never fires the effect callback", async () => {
    stubFetch({ initialize: () => new Response("nope", { status: 500 }) });
    const attempt = createFakeAttempt();
    const effectDispatch = vi.fn();

    const result = await invokeRequesterScopedMcpToolCall({
      attempt,
      toolName: "mcp__scoped",
      effectDispatch,
      networkAllowlist: ALLOWLIST,
    });

    expect(effectDispatch).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.failurePhase).toBe("pre_dispatch");
    expect(result.externalOutcome).toBeUndefined();
    expect(result.manualReconciliationRequired).toBeFalsy();
    expect(captured.map((call) => call.method)).toEqual(["initialize"]);
    expect(attempt.disposed()).toBe(true);
  });

  it("follows zero redirects: an initialize 3xx is denied pre-dispatch with no next hop", async () => {
    stubFetch({
      initialize: () =>
        new Response(null, { status: 302, headers: { location: "https://scoped.example.com/elsewhere" } }),
    });
    const attempt = createFakeAttempt();
    const effectDispatch = vi.fn();

    const result = await invokeRequesterScopedMcpToolCall({
      attempt,
      toolName: "mcp__scoped",
      effectDispatch,
      networkAllowlist: ALLOWLIST,
    });

    expect(effectDispatch).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.failurePhase).toBe("pre_dispatch");
    // Exactly one hop attempted; the redirect target is never contacted.
    expect(captured).toHaveLength(1);
  });

  it("classifies a tools/call 3xx after the write as unknown-after-send (manual reconciliation)", async () => {
    stubFetch({
      "tools/call": () =>
        new Response(null, { status: 302, headers: { location: "https://scoped.example.com/elsewhere" } }),
    });
    const attempt = createFakeAttempt();
    const effectDispatch = vi.fn();

    const result = await invokeRequesterScopedMcpToolCall({
      attempt,
      toolName: "mcp__scoped",
      effectDispatch,
      networkAllowlist: ALLOWLIST,
    });

    expect(effectDispatch).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.externalOutcome).toBe("unknown_after_send");
    expect(result.manualReconciliationRequired).toBe(true);
    expect(result.failurePhase).toBe("post_dispatch");
    expect(attempt.disposed()).toBe(true);
  });

  it("fails closed before the write when the attempt is no longer current (revoke/expiry)", async () => {
    stubFetch({});
    const attempt = createFakeAttempt({
      assertCurrent: () => {
        throw new McpRequesterResolutionError("connection_generation_revoked");
      },
    });
    const effectDispatch = vi.fn();

    const result = await invokeRequesterScopedMcpToolCall({
      attempt,
      toolName: "mcp__scoped",
      effectDispatch,
      networkAllowlist: ALLOWLIST,
    });

    expect(effectDispatch).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.failurePhase).toBe("pre_dispatch");
    // No network contact at all.
    expect(captured).toHaveLength(0);
    expect(attempt.disposed()).toBe(true);
  });

  it("never returns the ephemeral connection/lease or resolved secrets", async () => {
    stubFetch({});
    const attempt = createFakeAttempt({
      url: "https://scoped.example.com/mcp",
      headers: [{ name: "authorization", value: "Bearer resolved-secret" }],
    });

    const result = await invokeRequesterScopedMcpToolCall({
      attempt,
      toolName: "mcp__scoped",
      effectDispatch: () => undefined,
      networkAllowlist: ALLOWLIST,
    });

    expect(result).not.toHaveProperty("attempt");
    expect(result).not.toHaveProperty("connection");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("resolved-secret");
    expect(serialized).not.toContain("scoped.example.com");
  });
});
