import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoverRequesterScopedMcpTools,
  invokeRequesterScopedMcpToolCall,
  type McpRequesterScopedDiscoveryAttempt,
  type McpRequesterScopedToolCallAttempt,
} from "./mcp-runtime.js";
import { McpRequesterResolutionError } from "./mcp-requester-resolution.js";
import type { McpFreshToolsListRevalidationInput } from "./mcp-requester-resolution-service.js";

// HX-415 runtime integration seam. These tests prove the RUNTIME WIRING around
// the already-shipped, independently-reviewed requester attempt lease. They use
// a structural test double for the lease — the unforgeable authority/lease
// itself is proven in the resolver tranche; here we prove that the transport:
//   * routes through the isolated guarded dispatcher (never the shared cache);
//   * uses the resolved URL + headers as the SOLE auth material;
//   * runs the fresh tools/list REVALIDATION under its permit before the call;
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
    acceptRevalidation?: (input: McpFreshToolsListRevalidationInput) => void;
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
    async assertCurrent(): Promise<void> {
      events.push("assertCurrent");
      if (controller.signal.aborted) {
        throw new McpRequesterResolutionError("connection_generation_revoked");
      }
      options.assertCurrent?.();
    },
    async authorizeToolsListRevalidation() {
      events.push("authorizeRevalidation");
      return {
        stage: "tool_call_revalidation",
        operation: "tools/list",
        authoritySha256: "a".repeat(64),
        revalidationAttemptId: "reval-1",
        revalidationAttemptGeneration: 1,
        connectionGeneration: 1,
        expectedCatalogSha256: "b".repeat(64),
        expectedToolDefinitionSha256: "c".repeat(64),
      } as unknown as Awaited<ReturnType<McpRequesterScopedToolCallAttempt["authorizeToolsListRevalidation"]>>;
    },
    async consumeToolsListRevalidationPermit(input) {
      events.push("consumeRevalidation");
      return input;
    },
    async acceptFreshToolsListRevalidation(input) {
      events.push("acceptRevalidation");
      options.acceptRevalidation?.(input);
    },
    async authorizeToolsCall() {
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
      } as unknown as Awaited<ReturnType<McpRequesterScopedToolCallAttempt["authorizeToolsCall"]>>;
    },
    async consumeToolsCallPermit(input) {
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

interface FakeDiscoveryAttempt extends McpRequesterScopedDiscoveryAttempt {
  readonly events: string[];
  disposed(): boolean;
  abortNow(): void;
}

function createFakeDiscoveryAttempt(
  options: {
    url?: string;
    headers?: Array<{ name: string; value: string }>;
    assertCurrent?: () => void;
  } = {},
): FakeDiscoveryAttempt {
  const events: string[] = [];
  const controller = new AbortController();
  let disposed = false;
  const permit = (operation: string) =>
    ({
      stage: "profile_discovery",
      operation,
      authoritySha256: "a".repeat(64),
      connectionGeneration: 1,
    }) as unknown as Awaited<ReturnType<McpRequesterScopedDiscoveryAttempt["authorizeInitialize"]>>;
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
    } as unknown as McpRequesterScopedDiscoveryAttempt["connection"],
    signal: controller.signal,
    async assertCurrent(): Promise<void> {
      events.push("assertCurrent");
      if (controller.signal.aborted) {
        throw new McpRequesterResolutionError("connection_generation_revoked");
      }
      options.assertCurrent?.();
    },
    async authorizeInitialize() {
      events.push("authorize:initialize");
      return permit("initialize");
    },
    async authorizeInitializedNotification() {
      events.push("authorize:initialized");
      return permit("notifications/initialized");
    },
    async authorizeToolsList() {
      events.push("authorize:tools/list");
      return permit("tools/list");
    },
    async consumeOperationPermit(input) {
      events.push(`consume:${(input as { operation?: string }).operation ?? "unknown"}`);
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
    if (method === "tools/list") {
      return jsonRpcResponse(body.id ?? 0, {
        tools: [{ name: "remote_tool", description: "does things", inputSchema: { type: "object" } }],
      });
    }
    if (method === "tools/call") {
      return jsonRpcResponse(body.id ?? 0, { content: [{ type: "text", text: "done" }] });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof global.fetch;
}

function defaultRevalidate(): McpFreshToolsListRevalidationInput {
  order.push("revalidate");
  return {
    revalidationAttemptId: "reval-1",
    revalidationAttemptGeneration: 1,
    catalog: { serverId: "srv-scoped" } as never,
  };
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
  it("revalidates, then fires the effect callback exactly once, immediately before the tools/call write", async () => {
    stubFetch({});
    const attempt = createFakeAttempt();
    const effectDispatch = vi.fn(() => order.push("effectDispatch"));

    const result = await invokeRequesterScopedMcpToolCall({
      attempt,
      toolName: "mcp__scoped",
      arguments: { a: 1 },
      effectDispatch,
      networkAllowlist: ALLOWLIST,
      revalidate: defaultRevalidate,
    });

    expect(result.ok).toBe(true);
    expect(effectDispatch).toHaveBeenCalledTimes(1);
    // The revalidation tools/list runs under its consumed permit, the fresh
    // catalog is accepted, and only then does the effect callback fire —
    // immediately before the tools/call bytes are written.
    expect(order).toEqual([
      "fetch:initialize",
      "fetch:notifications/initialized",
      "fetch:tools/list",
      "revalidate",
      "effectDispatch",
      "fetch:tools/call",
    ]);
    const revalidationConsume = attempt.events.indexOf("consumeRevalidation");
    const accept = attempt.events.indexOf("acceptRevalidation");
    const callAuthorize = attempt.events.indexOf("authorize");
    expect(revalidationConsume).toBeGreaterThan(-1);
    expect(accept).toBeGreaterThan(revalidationConsume);
    expect(callAuthorize).toBeGreaterThan(accept);
    expect(attempt.disposed()).toBe(true);
  });

  it("fires effectDispatch after acceptFreshToolsListRevalidation and before the tools/call fetch", async () => {
    stubFetch({});
    const attempt = createFakeAttempt();
    const timeline: string[] = [];
    const effectDispatch = vi.fn(() => {
      timeline.push(`effect@${captured.length}`);
      order.push("effectDispatch");
    });

    await invokeRequesterScopedMcpToolCall({
      attempt,
      toolName: "mcp__scoped",
      effectDispatch,
      networkAllowlist: ALLOWLIST,
      revalidate: defaultRevalidate,
    });

    // Three requests (initialize, initialized, tools/list) happened before the
    // effect callback; the fourth (tools/call) happens after it.
    expect(timeline).toEqual(["effect@3"]);
    expect(order.slice(-2)).toEqual(["effectDispatch", "fetch:tools/call"]);
  });

  it("rechecks live authority after an asynchronous effect fence before writing tools/call bytes", async () => {
    stubFetch({});
    const attempt = createFakeAttempt();
    const effectDispatch = vi.fn(async () => {
      order.push("effectDispatch");
      attempt.abortNow();
    });

    const result = await invokeRequesterScopedMcpToolCall({
      attempt,
      toolName: "mcp__scoped",
      effectDispatch,
      networkAllowlist: ALLOWLIST,
      revalidate: defaultRevalidate,
    });

    expect(effectDispatch).toHaveBeenCalledTimes(1);
    expect(captured.some((call) => call.method === "tools/call")).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      externalOutcome: "unknown_after_send",
      manualReconciliationRequired: true,
      failurePhase: "post_dispatch",
      output: { requesterScoped: true, reasonCode: "connection_generation_revoked" },
    });
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
      revalidate: defaultRevalidate,
    });

    const toolsCall = captured.find((call) => call.method === "tools/call");
    expect(toolsCall?.url).toBe("https://scoped.example.com/mcp");
    expect(toolsCall?.init.headers?.["x-requester"]).toBe("requester-token");
    // An isolated per-attempt dispatcher is always threaded through, and the
    // revalidation tools/list reuses the same isolated dispatcher (never the
    // shared cache, never a second pool).
    expect(toolsCall?.init.dispatcher).toBeDefined();
    const toolsList = captured.find((call) => call.method === "tools/list");
    expect(toolsList?.init.dispatcher).toBe(toolsCall?.init.dispatcher);
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
      revalidate: defaultRevalidate,
    });

    expect(effectDispatch).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.failurePhase).toBe("pre_dispatch");
    expect(result.externalOutcome).toBeUndefined();
    expect(result.manualReconciliationRequired).toBeFalsy();
    expect(captured.map((call) => call.method)).toEqual(["initialize"]);
    expect(attempt.disposed()).toBe(true);
  });

  it("treats a fresh-catalog rejection (SHA mismatch) as pre-dispatch: no effect, no tools/call", async () => {
    stubFetch({});
    const attempt = createFakeAttempt({
      acceptRevalidation: () => {
        throw new McpRequesterResolutionError("schema_revalidation_drift");
      },
    });
    const effectDispatch = vi.fn();

    const result = await invokeRequesterScopedMcpToolCall({
      attempt,
      toolName: "mcp__scoped",
      effectDispatch,
      networkAllowlist: ALLOWLIST,
      revalidate: defaultRevalidate,
    });

    expect(effectDispatch).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.failurePhase).toBe("pre_dispatch");
    expect(result.output).toMatchObject({ requesterScoped: true, reasonCode: "schema_revalidation_drift" });
    expect(captured.map((call) => call.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(attempt.disposed()).toBe(true);
  });

  it("treats a revalidate-callback throw as pre-dispatch: no effect, no tools/call", async () => {
    stubFetch({});
    const attempt = createFakeAttempt();
    const effectDispatch = vi.fn();

    const result = await invokeRequesterScopedMcpToolCall({
      attempt,
      toolName: "mcp__scoped",
      effectDispatch,
      networkAllowlist: ALLOWLIST,
      revalidate: () => {
        throw new McpRequesterResolutionError("discovery_secret_detected");
      },
    });

    expect(effectDispatch).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.failurePhase).toBe("pre_dispatch");
    expect(result.output).toMatchObject({ requesterScoped: true, reasonCode: "discovery_secret_detected" });
    expect(attempt.events).not.toContain("acceptRevalidation");
    expect(captured.map((call) => call.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(attempt.disposed()).toBe(true);
  });

  it("discards a late revalidate result after abort: no accept, no effect, no tools/call", async () => {
    stubFetch({});
    const attempt = createFakeAttempt();
    const effectDispatch = vi.fn();

    const result = await invokeRequesterScopedMcpToolCall({
      attempt,
      toolName: "mcp__scoped",
      effectDispatch,
      networkAllowlist: ALLOWLIST,
      revalidate: () => {
        // Revocation lands while the composition-owned normalize+scan runs.
        attempt.abortNow();
        return defaultRevalidate();
      },
    });

    expect(effectDispatch).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.failurePhase).toBe("pre_dispatch");
    expect(attempt.events).not.toContain("acceptRevalidation");
    expect(captured.map((call) => call.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(attempt.disposed()).toBe(true);
  });

  it("treats a tools/list revalidation transport error as pre-dispatch", async () => {
    stubFetch({ "tools/list": () => new Response("nope", { status: 500 }) });
    const attempt = createFakeAttempt();
    const effectDispatch = vi.fn();

    const result = await invokeRequesterScopedMcpToolCall({
      attempt,
      toolName: "mcp__scoped",
      effectDispatch,
      networkAllowlist: ALLOWLIST,
      revalidate: defaultRevalidate,
    });

    expect(effectDispatch).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.failurePhase).toBe("pre_dispatch");
    expect(order).not.toContain("revalidate");
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
      revalidate: defaultRevalidate,
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
      revalidate: defaultRevalidate,
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
      revalidate: defaultRevalidate,
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
      revalidate: defaultRevalidate,
    });

    expect(result).not.toHaveProperty("attempt");
    expect(result).not.toHaveProperty("connection");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("resolved-secret");
    expect(serialized).not.toContain("scoped.example.com");
  });
});

describe("discoverRequesterScopedMcpTools (HX-415 discovery driver)", () => {
  it("consumes the initialize/initialized/tools-list permits before each write and returns the raw result", async () => {
    stubFetch({});
    const attempt = createFakeDiscoveryAttempt();

    const result = await discoverRequesterScopedMcpTools({
      attempt,
      networkAllowlist: ALLOWLIST,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.rawToolsListResult).toMatchObject({
      tools: [{ name: "remote_tool" }],
    });
    // Each stage permit is authorized + consumed strictly before its write.
    const sequence = attempt.events.filter((event) => event.startsWith("authorize:") || event.startsWith("consume:"));
    expect(sequence).toEqual([
      "authorize:initialize",
      "consume:initialize",
      "authorize:initialized",
      "consume:notifications/initialized",
      "authorize:tools/list",
      "consume:tools/list",
    ]);
    expect(order).toEqual(["fetch:initialize", "fetch:notifications/initialized", "fetch:tools/list"]);
    expect(attempt.disposed()).toBe(true);
  });

  it("interleaves permit consumption with writes in stage order", async () => {
    stubFetch({});
    const attempt = createFakeDiscoveryAttempt();
    const merged: string[] = [];
    const originalConsume = attempt.consumeOperationPermit.bind(attempt);
    (attempt as { consumeOperationPermit: typeof attempt.consumeOperationPermit }).consumeOperationPermit = (input) => {
      merged.push(`consume:${(input as { operation?: string }).operation ?? "unknown"}`);
      order.push(`consume:${(input as { operation?: string }).operation ?? "unknown"}`);
      return originalConsume(input);
    };

    await discoverRequesterScopedMcpTools({ attempt, networkAllowlist: ALLOWLIST });

    expect(order).toEqual([
      "consume:initialize",
      "fetch:initialize",
      "consume:notifications/initialized",
      "fetch:notifications/initialized",
      "consume:tools/list",
      "fetch:tools/list",
    ]);
  });

  it("threads one isolated dispatcher through every discovery request and never reuses it across runs", async () => {
    stubFetch({});
    await discoverRequesterScopedMcpTools({ attempt: createFakeDiscoveryAttempt(), networkAllowlist: ALLOWLIST });
    const firstRun = captured.map((call) => call.init.dispatcher);
    captured = [];
    await discoverRequesterScopedMcpTools({ attempt: createFakeDiscoveryAttempt(), networkAllowlist: ALLOWLIST });
    const secondRun = captured.map((call) => call.init.dispatcher);

    expect(firstRun[0]).toBeDefined();
    expect(new Set(firstRun).size).toBe(1);
    expect(new Set(secondRun).size).toBe(1);
    // A fresh isolated dispatcher per attempt: never shared across attempts.
    expect(secondRun[0]).not.toBe(firstRun[0]);
    for (const call of captured) expect(call.init.redirect).toBe("manual");
  });

  it("enforces one aggregate deadline across initialize, initialized, and tools/list", async () => {
    stubFetch({});
    let nowMs = 0;
    const attempt = createFakeDiscoveryAttempt();

    const result = await discoverRequesterScopedMcpTools({
      attempt,
      networkAllowlist: ALLOWLIST,
      now: () => {
        // First read establishes the deadline; afterwards the clock jumps past it.
        const current = nowMs;
        nowMs += 26_000;
        return current;
      },
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reasonCode).toBe("transport_pre_dispatch_failed");
    expect(captured).toHaveLength(0);
    expect(attempt.disposed()).toBe(true);
  });

  it("stops writing when the attempt is revoked mid-flow and disposes", async () => {
    stubFetch({});
    let calls = 0;
    const attempt = createFakeDiscoveryAttempt({
      assertCurrent: () => {
        calls += 1;
        if (calls > 2) {
          throw new McpRequesterResolutionError("connection_generation_revoked");
        }
      },
    });

    const result = await discoverRequesterScopedMcpTools({ attempt, networkAllowlist: ALLOWLIST });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reasonCode).toBe("connection_generation_revoked");
    // The revoke landed before the remaining writes: never all three requests.
    expect(captured.length).toBeLessThan(3);
    expect(attempt.disposed()).toBe(true);
  });

  it("returns a fixed, content-free failure with no canary URL or header material", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("connect failed to https://scoped.example.com/mcp with Bearer resolved-secret");
    }) as unknown as typeof global.fetch;
    const attempt = createFakeDiscoveryAttempt();

    const result = await discoverRequesterScopedMcpTools({ attempt, networkAllowlist: ALLOWLIST });

    expect(result.ok).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("scoped.example.com");
    expect(serialized).not.toContain("resolved-secret");
    expect(!result.ok && result.reasonCode).toBe("transport_pre_dispatch_failed");
    expect(attempt.disposed()).toBe(true);
  });

  it("denies a discovery 3xx as a zero-redirect pre-dispatch failure", async () => {
    stubFetch({
      "tools/list": () =>
        new Response(null, { status: 302, headers: { location: "https://scoped.example.com/elsewhere" } }),
    });
    const attempt = createFakeDiscoveryAttempt();

    const result = await discoverRequesterScopedMcpTools({ attempt, networkAllowlist: ALLOWLIST });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reasonCode).toBe("resolved_destination_denied");
    // The redirect target is never contacted.
    expect(captured).toHaveLength(3);
  });

  it("fails when the tools/list envelope is an error or missing a result", async () => {
    stubFetch({
      "tools/list": (id) =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -1, message: "denied" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const attempt = createFakeDiscoveryAttempt();

    const result = await discoverRequesterScopedMcpTools({ attempt, networkAllowlist: ALLOWLIST });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reasonCode).toBe("transport_pre_dispatch_failed");
    expect(attempt.disposed()).toBe(true);
  });
});
