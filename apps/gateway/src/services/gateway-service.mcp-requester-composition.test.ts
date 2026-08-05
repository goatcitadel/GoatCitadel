import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalJsonString,
  type ChatTurnCapabilityProfileRecord,
  type McpServerRecord,
} from "@goatcitadel/contracts";
import {
  createMcpEphemeralResolvedConnectionCandidate,
  type McpEphemeralResolvedConnectionInput,
  type McpRequesterResolverRegistryInput,
} from "./mcp-requester-resolution.js";
import {
  buildMcpRequesterScopedTurnContextFromCapabilityProfile,
  type McpRequesterScopedProfileFreezeHookInput,
  type McpRequesterScopedTurnContextHandle,
} from "./mcp-requester-resolution-service.js";
import type { ChatTurnCapabilityProfileResolveDeps } from "./chat-turn-capability-profile-service.js";
import * as mcpDiagnosticsService from "./mcp-diagnostics-service.js";
import {
  composeMcpRequesterScopedRuntime,
  GatewayService,
  type McpRequesterScopedComposedRuntime,
  type McpRequesterScopedCompositionHost,
} from "./gateway-service.js";
import { loadGatewayConfig } from "../config.js";

const profileServiceCapture = vi.hoisted(() => ({ deps: [] as unknown[] }));

vi.mock("./chat-turn-capability-profile-service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./chat-turn-capability-profile-service.js")>();
  return {
    ...original,
    resolveChatTurnCapabilityProfile: vi.fn(async (deps: unknown) => {
      profileServiceCapture.deps.push(deps);
      throw new Error("capability-profile deps captured (test stop)");
    }),
  };
});

const START = Date.parse("2026-07-22T12:00:00.000Z");
const NETWORK_ALLOWLIST = ["a.example.test", "b.example.test"];

function digest(input: unknown): string {
  return createHash("sha256").update(canonicalJsonString(input)).digest("hex");
}

function requesterScopedServerRecord(): McpServerRecord {
  return {
    serverId: "tenant-mcp",
    label: "Tenant MCP",
    transport: "http",
    connectionMode: "requester_scoped",
    configurationRevision: 7,
    requesterResolution: {
      resolverId: "gateway.tenant",
      resolverVersion: "1.2.3",
      configGeneration: 4,
      transportPolicy: {
        allowedSchemes: ["https"],
        allowedHosts: ["a.example.test", "b.example.test"],
        allowedPorts: [443],
        allowedHeaderNames: ["authorization", "x-tenant"],
      },
    },
    authType: "none",
    enabled: true,
    status: "disconnected",
    category: "automation",
    trustTier: "restricted",
    costTier: "unknown",
    policy: {
      requireFirstToolApproval: false,
      redactionMode: "off",
      allowedToolPatterns: [],
      blockedToolPatterns: [],
    },
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  } as McpServerRecord;
}

function staticServerRecord(): McpServerRecord {
  return {
    serverId: "static-mcp",
    label: "Static MCP",
    transport: "http",
    url: "https://static.example.test/mcp",
    authType: "none",
    enabled: true,
    status: "connected",
    category: "automation",
    trustTier: "restricted",
    costTier: "unknown",
    policy: {
      requireFirstToolApproval: false,
      redactionMode: "off",
      allowedToolPatterns: [],
      blockedToolPatterns: [],
    },
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  } as McpServerRecord;
}

function profileRecordFor(actorId: string): ChatTurnCapabilityProfileRecord {
  const callableHash = digest({ tools: ["mcp.tenant-mcp.search"], actorId });
  return {
    profileId: `chat-capability-profile-turn-${actorId}`,
    identity: {
      turnId: `turn-${actorId}`,
      sessionId: `session-${actorId}`,
      workspaceId: "workspace-1",
      citadelId: "citadel-1",
      authActorId: actorId,
      authActorSource: "token",
    },
    catalog: {
      snapshotId: `chat-cap-snap-${actorId}`,
      inspectableHash: callableHash,
      callableHash,
      inspectableCount: 1,
      callableCount: 1,
    },
    hashes: {
      identityHash: digest({ identity: actorId }),
      sourceHash: digest({ source: actorId }),
      catalogHash: digest({ catalog: actorId }),
      selectionHash: digest({ selection: actorId }),
      governanceHash: digest({ governance: actorId }),
      profileHash: digest({ profile: actorId }),
    },
  } as unknown as ChatTurnCapabilityProfileRecord;
}

function freezeHookFor(profile: ChatTurnCapabilityProfileRecord): McpRequesterScopedProfileFreezeHookInput {
  return {
    profileId: profile.profileId,
    turnId: profile.identity.turnId,
    sessionId: profile.identity.sessionId,
    workspaceId: profile.identity.workspaceId,
    authActorId: profile.identity.authActorId as string,
    authActorSource: profile.identity.authActorSource as "token",
    catalogSnapshotId: profile.catalog.snapshotId,
    callableCatalogSha256: profile.catalog.callableHash,
    canonicalToolName: "mcp.tenant-mcp.search",
    modelToolName: "mcp__scoped_search",
  };
}

function resolvedFor(stage: "profile_discovery" | "tool_call", actorId: string): McpEphemeralResolvedConnectionInput {
  const host = stage === "profile_discovery" ? "a.example.test" : "b.example.test";
  return {
    outcomeClass: "resolved",
    url: `https://${host}/tools?requester=${actorId}&stage=${stage}`,
    headers: [
      { name: "Authorization", value: `Bearer secret-${actorId}-${stage}` },
      { name: "X-Tenant", value: actorId },
    ],
    connectionGeneration: 11,
    expiresAt: "2026-07-22T12:04:00.000Z",
  };
}

const originalFetch = global.fetch;

interface Captured {
  url: string;
  method: string;
  authorization?: string;
  dispatcher?: unknown;
}

let captured: Captured[];

const DISCOVERED_TOOLS = [
  {
    name: "search",
    description: "Search safely",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  },
];

function stubFetch(): void {
  global.fetch = vi.fn(async (url: string, init?: RequestInit & { dispatcher?: unknown }) => {
    const body = JSON.parse(String((init as RequestInit).body)) as { id?: number; method?: string };
    const headers = (init?.headers ?? {}) as Record<string, string>;
    captured.push({
      url,
      method: body.method ?? "unknown",
      authorization: headers.Authorization ?? headers.authorization,
      dispatcher: init?.dispatcher,
    });
    const respond = (result: Record<string, unknown>) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 0, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (body.method === "initialize") {
      return respond({ protocolVersion: "2025-06-18" });
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (body.method === "tools/list") {
      return respond({ tools: DISCOVERED_TOOLS });
    }
    if (body.method === "tools/call") {
      return respond({ content: [{ type: "text", text: "done" }] });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof global.fetch;
}

interface Harness {
  runtime: McpRequesterScopedComposedRuntime;
  servers: McpServerRecord[];
  profiles: Map<string, ChatTurnCapabilityProfileRecord>;
  revokedActors: Set<string>;
  diagnostics: Array<{ event: string; reasonCode: unknown }>;
  discoveryResolver: ReturnType<typeof vi.fn>;
  toolCallResolver: ReturnType<typeof vi.fn>;
  contextFor(profile: ChatTurnCapabilityProfileRecord): McpRequesterScopedTurnContextHandle;
}

function buildHarness(options: { resolvers?: boolean; onAuthRead?: () => void } = {}): Harness {
  const servers: McpServerRecord[] = [requesterScopedServerRecord(), staticServerRecord()];
  const profiles = new Map<string, ChatTurnCapabilityProfileRecord>();
  const revokedActors = new Set<string>();
  const diagnostics: Array<{ event: string; reasonCode: unknown }> = [];
  const discoveryResolver = vi.fn(async ({ requester }: { requester: { actorId: string } }) =>
    createMcpEphemeralResolvedConnectionCandidate(resolvedFor("profile_discovery", requester.actorId)),
  );
  const toolCallResolver = vi.fn(async ({ requester }: { requester: { actorId: string } }) =>
    createMcpEphemeralResolvedConnectionCandidate(resolvedFor("tool_call", requester.actorId)),
  );
  const resolvers: McpRequesterResolverRegistryInput = {
    profileDiscovery: [
      {
        resolverId: "gateway.tenant",
        resolverVersion: "1.2.3",
        configGeneration: 4,
        resolveForProfileDiscovery: discoveryResolver as never,
      },
    ],
    toolCall: [
      {
        resolverId: "gateway.tenant",
        resolverVersion: "1.2.3",
        configGeneration: 4,
        resolveForToolCall: toolCallResolver as never,
      },
    ],
  };
  const host: McpRequesterScopedCompositionHost = {
    ...(options.resolvers === false ? {} : { resolvers }),
    listMcpServers: async () => servers.map((server) => ({ ...server })),
    getChatTurnCapabilityProfile: async (profileId) => profiles.get(profileId),
    readAuthConnectionState: async (actor) => {
      options.onAuthRead?.();
      return { revoked: revokedActors.has(actor.actorId) };
    },
    getNetworkAllowlist: () => NETWORK_ALLOWLIST,
    recordDevDiagnostic: (input) => {
      diagnostics.push({
        event: input.event,
        reasonCode: (input.context as Record<string, unknown> | undefined)?.reasonCode,
      });
    },
    now: () => START,
  };
  return {
    runtime: composeMcpRequesterScopedRuntime(host),
    servers,
    profiles,
    revokedActors,
    diagnostics,
    discoveryResolver,
    toolCallResolver,
    contextFor: (profile) => {
      const handle = buildMcpRequesterScopedTurnContextFromCapabilityProfile(profile);
      if (!handle) throw new Error("test fixture profile must produce a turn context");
      return handle;
    },
  };
}

beforeEach(() => {
  captured = [];
  stubFetch();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("composeMcpRequesterScopedRuntime (HX-415 slice 7d composed E2E)", () => {
  it("runs profile freeze -> discovery outcome -> revalidated tools/call end to end with one effect dispatch", async () => {
    const harness = buildHarness();
    const profile = profileRecordFor("operator-a");
    harness.profiles.set(profile.profileId, profile);

    const binding = await harness.runtime.resolveMcpRequesterResolutionBinding(freezeHookFor(profile));
    expect(binding).toMatchObject({
      mode: "requester_scoped",
      serverId: "tenant-mcp",
      toolName: "mcp.tenant-mcp.search",
      resolverId: "gateway.tenant",
      callableCatalogSha256: profile.catalog.callableHash,
      callableCatalogSnapshotId: profile.catalog.snapshotId,
    });
    expect(captured.map((call) => call.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(captured[0]?.url).toContain("a.example.test");
    captured = [];

    const effectDispatch = vi.fn();
    const result = await harness.runtime.requesterScopedMcpDispatch.invoke(
      {
        server: harness.servers[0] as McpServerRecord,
        toolName: "search",
        arguments: { query: "hello" },
        mcpRequesterTurnContext: harness.contextFor(profile),
      },
      { effectDispatch },
    );

    expect(result.ok).toBe(true);
    expect(effectDispatch).toHaveBeenCalledTimes(1);
    expect(captured.map((call) => call.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    expect(captured.every((call) => call.url.includes("b.example.test"))).toBe(true);
    expect(captured[0]?.authorization).toBe("Bearer secret-operator-a-tool_call");
    // No secret/endpoint material in any serialized output or diagnostic.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret-operator-a");
    expect(serialized).not.toContain("b.example.test");
    expect(serialized).not.toContain("a.example.test");
    expect(JSON.stringify(harness.diagnostics)).not.toMatch(/secret-operator-a|example\.test/u);
    expect(harness.diagnostics).toEqual([]);
  });

  it("keeps two requesters on independent resolutions, credentials, and dispatchers", async () => {
    const harness = buildHarness();
    const alpha = profileRecordFor("operator-a");
    const beta = profileRecordFor("operator-b");
    harness.profiles.set(alpha.profileId, alpha);
    harness.profiles.set(beta.profileId, beta);
    expect(await harness.runtime.resolveMcpRequesterResolutionBinding(freezeHookFor(alpha))).toBeDefined();
    expect(await harness.runtime.resolveMcpRequesterResolutionBinding(freezeHookFor(beta))).toBeDefined();
    captured = [];

    const [alphaResult, betaResult] = await Promise.all([
      harness.runtime.requesterScopedMcpDispatch.invoke(
        {
          server: harness.servers[0] as McpServerRecord,
          toolName: "search",
          arguments: { query: "alpha" },
          mcpRequesterTurnContext: harness.contextFor(alpha),
        },
        { effectDispatch: vi.fn() },
      ),
      harness.runtime.requesterScopedMcpDispatch.invoke(
        {
          server: harness.servers[0] as McpServerRecord,
          toolName: "search",
          arguments: { query: "beta" },
          mcpRequesterTurnContext: harness.contextFor(beta),
        },
        { effectDispatch: vi.fn() },
      ),
    ]);

    expect(alphaResult.ok).toBe(true);
    expect(betaResult.ok).toBe(true);
    expect(harness.discoveryResolver).toHaveBeenCalledTimes(2);
    expect(harness.toolCallResolver).toHaveBeenCalledTimes(2);
    const alphaCalls = captured.filter((call) => call.authorization?.includes("operator-a"));
    const betaCalls = captured.filter((call) => call.authorization?.includes("operator-b"));
    expect(alphaCalls).toHaveLength(4);
    expect(betaCalls).toHaveLength(4);
    expect(alphaCalls.every((call) => call.url.includes("requester=operator-a"))).toBe(true);
    expect(betaCalls.every((call) => call.url.includes("requester=operator-b"))).toBe(true);
    const alphaDispatchers = new Set(alphaCalls.map((call) => call.dispatcher));
    const betaDispatchers = new Set(betaCalls.map((call) => call.dispatcher));
    expect(alphaDispatchers.size).toBe(1);
    expect(betaDispatchers.size).toBe(1);
    expect([...alphaDispatchers][0]).not.toBe([...betaDispatchers][0]);
  });

  it("default composition (no injected resolvers) fails closed at freeze and at invoke", async () => {
    const harness = buildHarness({ resolvers: false });
    const profile = profileRecordFor("operator-a");
    harness.profiles.set(profile.profileId, profile);

    await expect(harness.runtime.resolveMcpRequesterResolutionBinding(freezeHookFor(profile))).resolves.toBeUndefined();
    expect(harness.diagnostics).toContainEqual({
      event: "mcp.requester_resolution.freeze_failed",
      reasonCode: "resolver_missing",
    });

    const effectDispatch = vi.fn();
    const result = await harness.runtime.requesterScopedMcpDispatch.invoke(
      {
        server: harness.servers[0] as McpServerRecord,
        toolName: "search",
        mcpRequesterTurnContext: harness.contextFor(profile),
      },
      { effectDispatch },
    );
    expect(result.ok).toBe(false);
    expect(result.failurePhase).toBe("pre_dispatch");
    expect(result.output).toMatchObject({ requesterScoped: true, reasonCode: "requester_context_missing" });
    expect(effectDispatch).not.toHaveBeenCalled();
    expect(captured).toHaveLength(0);
  });

  it("fails closed on a missing context and on a forged plain-object context (brand check)", async () => {
    const harness = buildHarness();
    const profile = profileRecordFor("operator-a");
    harness.profiles.set(profile.profileId, profile);
    expect(await harness.runtime.resolveMcpRequesterResolutionBinding(freezeHookFor(profile))).toBeDefined();
    captured = [];
    const effectDispatch = vi.fn();

    // Approval replay / direct-route posture: no context at all.
    const missing = await harness.runtime.requesterScopedMcpDispatch.invoke(
      { server: harness.servers[0] as McpServerRecord, toolName: "search" },
      { effectDispatch },
    );
    expect(missing.ok).toBe(false);
    expect(missing.failurePhase).toBe("pre_dispatch");
    expect(missing.output).toMatchObject({ requesterScoped: true, reasonCode: "requester_context_missing" });

    // A forged plain object with byte-identical fields carries no brand.
    const forged = {
      profileId: profile.profileId,
      finalProfileSha256: profile.hashes.profileHash,
      turnId: profile.identity.turnId,
      sessionId: profile.identity.sessionId,
      workspaceId: profile.identity.workspaceId,
      actorId: "operator-a",
      actorSource: "token",
      baseCallableCatalogSha256: profile.catalog.callableHash,
      finalCallableCatalogSha256: profile.catalog.callableHash,
      callableCatalogSnapshotId: profile.catalog.snapshotId,
      globalNetworkPolicyGeneration: 1,
      authConnectionGeneration: 1,
      turnGeneration: 1,
      preparationGeneration: 1,
      toJSON: () => undefined as never,
    };
    const forgedResult = await harness.runtime.requesterScopedMcpDispatch.invoke(
      {
        server: harness.servers[0] as McpServerRecord,
        toolName: "search",
        mcpRequesterTurnContext: forged as unknown as McpRequesterScopedTurnContextHandle,
      },
      { effectDispatch },
    );
    expect(forgedResult.ok).toBe(false);
    expect(forgedResult.output).toMatchObject({ requesterScoped: true, reasonCode: "requester_context_missing" });

    expect(effectDispatch).not.toHaveBeenCalled();
    expect(harness.toolCallResolver).not.toHaveBeenCalled();
    expect(captured).toHaveLength(0);
    expect(harness.diagnostics.filter((entry) => entry.reasonCode === "requester_context_missing")).toHaveLength(2);
  });

  it("fails closed when the actor's auth owner reports revocation between freeze and dispatch", async () => {
    const harness = buildHarness();
    const profile = profileRecordFor("operator-a");
    harness.profiles.set(profile.profileId, profile);
    expect(await harness.runtime.resolveMcpRequesterResolutionBinding(freezeHookFor(profile))).toBeDefined();
    harness.revokedActors.add("operator-a");
    captured = [];
    const effectDispatch = vi.fn();

    const result = await harness.runtime.requesterScopedMcpDispatch.invoke(
      {
        server: harness.servers[0] as McpServerRecord,
        toolName: "search",
        mcpRequesterTurnContext: harness.contextFor(profile),
      },
      { effectDispatch },
    );

    expect(result.ok).toBe(false);
    expect(result.failurePhase).toBe("pre_dispatch");
    expect(result.output).toMatchObject({ requesterScoped: true, reasonCode: "connection_generation_revoked" });
    expect(effectDispatch).not.toHaveBeenCalled();
    expect(captured.map((call) => call.method)).not.toContain("tools/call");
  });

  it("fails closed with the effect un-fired when revocation lands mid-transport", async () => {
    const harness = buildHarness();
    const profile = profileRecordFor("operator-a");
    harness.profiles.set(profile.profileId, profile);
    expect(await harness.runtime.resolveMcpRequesterResolutionBinding(freezeHookFor(profile))).toBeDefined();
    captured = [];
    // Revoke after the tool-call transport has already begun (first writes done).
    const baseFetch = global.fetch;
    global.fetch = (async (url: never, init: never) => {
      const response = await (baseFetch as (url: never, init: never) => Promise<Response>)(url, init);
      if (captured.length >= 2) {
        harness.revokedActors.add("operator-a");
      }
      return response;
    }) as typeof global.fetch;
    const effectDispatch = vi.fn();

    const result = await harness.runtime.requesterScopedMcpDispatch.invoke(
      {
        server: harness.servers[0] as McpServerRecord,
        toolName: "search",
        mcpRequesterTurnContext: harness.contextFor(profile),
      },
      { effectDispatch },
    );

    expect(result.ok).toBe(false);
    expect(effectDispatch).not.toHaveBeenCalled();
    expect(captured.map((call) => call.method)).not.toContain("tools/call");
  });

  it("fails closed when the server flips to disabled or static mid-flight", async () => {
    const harness = buildHarness();
    const profile = profileRecordFor("operator-a");
    harness.profiles.set(profile.profileId, profile);
    expect(await harness.runtime.resolveMcpRequesterResolutionBinding(freezeHookFor(profile))).toBeDefined();
    captured = [];

    const requesterServer = harness.servers[0] as McpServerRecord;
    (harness.servers[0] as { enabled: boolean }).enabled = false;
    const disabled = await harness.runtime.requesterScopedMcpDispatch.invoke(
      { server: requesterServer, toolName: "search", mcpRequesterTurnContext: harness.contextFor(profile) },
      { effectDispatch: vi.fn() },
    );
    expect(disabled.ok).toBe(false);
    expect(disabled.output).toMatchObject({ requesterScoped: true, reasonCode: "server_not_callable" });

    (harness.servers[0] as { enabled: boolean }).enabled = true;
    (harness.servers[0] as { connectionMode?: string }).connectionMode = "static";
    const flippedStatic = await harness.runtime.requesterScopedMcpDispatch.invoke(
      { server: requesterServer, toolName: "search", mcpRequesterTurnContext: harness.contextFor(profile) },
      { effectDispatch: vi.fn() },
    );
    expect(flippedStatic.ok).toBe(false);
    expect(flippedStatic.output).toMatchObject({ requesterScoped: true, reasonCode: "server_not_callable" });
    expect(captured).toHaveLength(0);
  });

  it("fails closed when the durable profile record disappears or its actor drifts", async () => {
    const harness = buildHarness();
    const profile = profileRecordFor("operator-a");
    harness.profiles.set(profile.profileId, profile);
    expect(await harness.runtime.resolveMcpRequesterResolutionBinding(freezeHookFor(profile))).toBeDefined();
    const context = harness.contextFor(profile);
    captured = [];

    harness.profiles.delete(profile.profileId);
    const missingProfile = await harness.runtime.requesterScopedMcpDispatch.invoke(
      { server: harness.servers[0] as McpServerRecord, toolName: "search", mcpRequesterTurnContext: context },
      { effectDispatch: vi.fn() },
    );
    expect(missingProfile.ok).toBe(false);
    expect(missingProfile.output).toMatchObject({ requesterScoped: true, reasonCode: "server_not_callable" });

    // A replaced record with a different actor is requester-scope drift.
    const swapped = profileRecordFor("operator-b");
    harness.profiles.set(profile.profileId, {
      ...profile,
      identity: { ...profile.identity, authActorId: swapped.identity.authActorId },
    } as ChatTurnCapabilityProfileRecord);
    const drifted = await harness.runtime.requesterScopedMcpDispatch.invoke(
      { server: harness.servers[0] as McpServerRecord, toolName: "search", mcpRequesterTurnContext: context },
      { effectDispatch: vi.fn() },
    );
    expect(drifted.ok).toBe(false);
    expect(drifted.output).toMatchObject({ requesterScoped: true, reasonCode: "requester_scope_mismatch" });
    expect(captured).toHaveLength(0);
  });

  it("freeze hook yields undefined silently for static canonical names and fails closed on ambiguous server ids", async () => {
    const harness = buildHarness();
    const profile = profileRecordFor("operator-a");

    // Static server canonical name: static behavior wins with NO diagnostic.
    await expect(
      harness.runtime.resolveMcpRequesterResolutionBinding({
        ...freezeHookFor(profile),
        canonicalToolName: "mcp.static-mcp.search",
      }),
    ).resolves.toBeUndefined();
    // Non-MCP canonical name: same silent undefined.
    await expect(
      harness.runtime.resolveMcpRequesterResolutionBinding({
        ...freezeHookFor(profile),
        canonicalToolName: "browser.search",
      }),
    ).resolves.toBeUndefined();
    expect(harness.diagnostics).toEqual([]);
    expect(harness.discoveryResolver).not.toHaveBeenCalled();

    // Two requester-scoped servers whose ids make the canonical name ambiguous.
    const nested = requesterScopedServerRecord();
    (nested as { serverId: string }).serverId = "tenant-mcp.search";
    harness.servers.push(nested);
    await expect(
      harness.runtime.resolveMcpRequesterResolutionBinding({
        ...freezeHookFor(profile),
        canonicalToolName: "mcp.tenant-mcp.search.lookup",
      }),
    ).resolves.toBeUndefined();
    expect(harness.diagnostics).toContainEqual({
      event: "mcp.requester_resolution.freeze_failed",
      reasonCode: "requester_context_ambiguous",
    });
    expect(harness.discoveryResolver).not.toHaveBeenCalled();
  });

  it("never emits endpoint or credential material through diagnostics on failures", async () => {
    const harness = buildHarness();
    const profile = profileRecordFor("operator-a");
    harness.profiles.set(profile.profileId, profile);
    harness.discoveryResolver.mockImplementationOnce(async () => {
      throw new Error("resolver exploded with https://leak.example.test/?token=canary-secret");
    });

    await expect(harness.runtime.resolveMcpRequesterResolutionBinding(freezeHookFor(profile))).resolves.toBeUndefined();
    expect(harness.diagnostics).toContainEqual({
      event: "mcp.requester_resolution.freeze_failed",
      reasonCode: "resolver_failed",
    });
    const serializedDiagnostics = JSON.stringify(harness.diagnostics);
    expect(serializedDiagnostics).not.toContain("canary-secret");
    expect(serializedDiagnostics).not.toContain("leak.example.test");
  });

  it("records secret-free last outcomes through the composed runtime for freeze and dispatch", async () => {
    const harness = buildHarness();
    const profile = profileRecordFor("operator-a");
    harness.profiles.set(profile.profileId, profile);

    // Before any attempt: no recorded outcome, registration posture readable.
    expect(harness.runtime.requesterScopeDiagnostics.loadLastOutcome("tenant-mcp")).toBeUndefined();
    expect(
      harness.runtime.requesterScopeDiagnostics.resolveRegistrationPosture({
        resolverId: "gateway.tenant",
        resolverVersion: "1.2.3",
        configGeneration: 4,
      }),
    ).toBe("registered");
    expect(
      harness.runtime.requesterScopeDiagnostics.resolveRegistrationPosture({
        resolverId: "gateway.tenant",
        resolverVersion: "9.9.9",
        configGeneration: 4,
      }),
    ).toBe("resolver_binding_drift");
    expect(
      harness.runtime.requesterScopeDiagnostics.resolveRegistrationPosture({
        resolverId: "gateway.other",
        resolverVersion: "1.2.3",
        configGeneration: 4,
      }),
    ).toBe("resolver_missing");

    // Freeze failure records the exact taxonomy class for the exact server.
    harness.discoveryResolver.mockImplementationOnce(async () => {
      throw new Error("resolver exploded with https://leak.example.test/?token=canary-secret");
    });
    await expect(harness.runtime.resolveMcpRequesterResolutionBinding(freezeHookFor(profile))).resolves.toBeUndefined();
    expect(harness.runtime.requesterScopeDiagnostics.loadLastOutcome("tenant-mcp")).toEqual({
      serverId: "tenant-mcp",
      outcomeClass: "resolver_failed",
      atMs: START,
      connectionGenerationClass: "absent",
      expiryClass: "absent",
      networkPolicyDecision: "not_evaluated",
      profileDrift: false,
    });

    // Successful freeze + dispatch replaces it with resolved_ok.
    expect(await harness.runtime.resolveMcpRequesterResolutionBinding(freezeHookFor(profile))).toBeDefined();
    expect(harness.runtime.requesterScopeDiagnostics.loadLastOutcome("tenant-mcp")).toMatchObject({
      outcomeClass: "resolved_ok",
      connectionGenerationClass: "present",
      expiryClass: "within_bounds",
      networkPolicyDecision: "allowed",
      profileDrift: false,
    });
    const result = await harness.runtime.requesterScopedMcpDispatch.invoke(
      {
        server: harness.servers[0] as McpServerRecord,
        toolName: "search",
        arguments: { query: "hello" },
        mcpRequesterTurnContext: harness.contextFor(profile),
      },
      { effectDispatch: vi.fn() },
    );
    expect(result.ok).toBe(true);
    expect(harness.runtime.requesterScopeDiagnostics.loadLastOutcome("tenant-mcp")).toMatchObject({
      outcomeClass: "resolved_ok",
    });

    // A dispatch without a server-built context records the fail-closed class.
    const missing = await harness.runtime.requesterScopedMcpDispatch.invoke(
      { server: harness.servers[0] as McpServerRecord, toolName: "search" },
      { effectDispatch: vi.fn() },
    );
    expect(missing.ok).toBe(false);
    expect(harness.runtime.requesterScopeDiagnostics.loadLastOutcome("tenant-mcp")).toMatchObject({
      outcomeClass: "requester_context_missing",
      connectionGenerationClass: "absent",
    });
  });

  it("projects a secret-free posture even while the recorder holds a canary-failure outcome", async () => {
    const harness = buildHarness();
    const profile = profileRecordFor("operator-a");
    harness.profiles.set(profile.profileId, profile);
    harness.discoveryResolver.mockImplementationOnce(async () => {
      throw new Error("resolver exploded with https://leak.example.test/?token=canary-secret");
    });
    await expect(harness.runtime.resolveMcpRequesterResolutionBinding(freezeHookFor(profile))).resolves.toBeUndefined();

    const postures = mcpDiagnosticsService.listMcpRequesterScopePostures({
      listMcpServers: () => harness.servers.map((server) => ({ ...server })),
      requesterScopeDiagnostics: harness.runtime.requesterScopeDiagnostics,
    });
    expect(postures).toHaveLength(1);
    expect(postures[0]).toEqual({
      serverId: "tenant-mcp",
      connectionMode: "requester_scoped",
      requesterContextRequired: true,
      enabled: true,
      resolverId: "gateway.tenant",
      resolverVersion: "1.2.3",
      resolverConfigGeneration: 4,
      resolverRegistration: "registered",
      lastOutcome: {
        outcomeClass: "resolver_failed",
        atMs: START,
        connectionGenerationClass: "absent",
        expiryClass: "absent",
        networkPolicyDecision: "not_evaluated",
        profileDrift: false,
      },
    });
    const serialized = JSON.stringify(postures);
    expect(serialized).not.toContain("canary-secret");
    expect(serialized).not.toContain("leak.example.test");
    expect(serialized).not.toContain("a.example.test");
    expect(serialized).not.toMatch(/url|command|header|authorization|token|secret/iu);

    // Stock deployment (no injected resolvers): resolver_missing posture.
    const stock = buildHarness({ resolvers: false });
    const stockPostures = mcpDiagnosticsService.listMcpRequesterScopePostures({
      listMcpServers: () => stock.servers.map((server) => ({ ...server })),
      requesterScopeDiagnostics: stock.runtime.requesterScopeDiagnostics,
    });
    expect(stockPostures[0]?.resolverRegistration).toBe("resolver_missing");
  });
});

describe("GatewayService HX-415 constructor wiring", () => {
  it("wires the composed runtime into the coordinator host and the capability-profile deps", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gc-hx415-wiring-"));
    let gateway: GatewayService | undefined;
    const previousDriver = process.env.GOATCITADEL_DATABASE_DRIVER;
    try {
      process.env.GOATCITADEL_DATABASE_DRIVER = "sqlite";
      // Seed the temp root with the repository config fixtures (same pattern
      // as app.test.ts) so loadGatewayConfig materializes real defaults.
      const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");
      await fs.cp(path.join(repoRoot, "config"), path.join(tempRoot, "config"), { recursive: true });
      const config = await loadGatewayConfig(tempRoot);
      gateway = new GatewayService(config);

      // 1. The composed runtime exists and its dispatch port is the EXACT
      //    object handed to the tool-invocation coordinator host.
      expect(gateway.mcpRequesterScopedRuntime).toBeDefined();
      const coordinatorHost = (
        gateway as unknown as {
          toolInvocationCoordinator: { host: { requesterScopedMcpDispatch?: unknown } };
        }
      ).toolInvocationCoordinator.host;
      expect(coordinatorHost.requesterScopedMcpDispatch).toBe(
        gateway.mcpRequesterScopedRuntime.requesterScopedMcpDispatch,
      );

      // 2. The capability-profile deps receive a freeze hook that delegates to
      //    the SAME composed runtime (behavioral identity via spy).
      const hookSpy = vi
        .spyOn(gateway.mcpRequesterScopedRuntime, "resolveMcpRequesterResolutionBinding")
        .mockResolvedValue(undefined);
      await expect(
        gateway.resolveChatTurnCapabilityProfile({
          sessionId: "session-1",
          turnId: "turn-1",
          workspaceId: "workspace-1",
          citadelId: "citadel-1",
          route: { channel: "chat", account: "default" },
          content: "hello",
          effectiveMode: "chat",
          effectiveToolAutonomy: "safe_auto",
          historyMessages: [],
          request: {},
          normalized: {},
          prefs: {
            webMode: "auto",
            memoryMode: "auto",
            thinkingLevel: "standard",
            speedMode: "standard",
            subagentPolicy: "off",
          },
          autonomy: { retrievalMode: "standard" },
          routeResolution: {
            requestedProviderId: "provider-a",
            requestedModel: "model-a",
            effectiveProviderId: "provider-a",
            effectiveModel: "model-a",
            fallbackPolicy: "off",
            runtimeClass: "local",
          },
        } as never),
      ).rejects.toThrow(/capability-profile deps captured/u);
      const deps = profileServiceCapture.deps.at(-1) as ChatTurnCapabilityProfileResolveDeps;
      expect(deps.resolveMcpRequesterResolutionBinding).toBeTypeOf("function");
      const hookInput = {
        profileId: "chat-capability-profile-turn-1",
        turnId: "turn-1",
        sessionId: "session-1",
        workspaceId: "workspace-1",
        authActorId: "operator-1",
        authActorSource: "token" as const,
        catalogSnapshotId: "chat-cap-snap-1",
        callableCatalogSha256: "a".repeat(64),
        canonicalToolName: "mcp.tenant-mcp.search",
        modelToolName: "mcp__scoped_search",
      };
      await deps.resolveMcpRequesterResolutionBinding?.(hookInput);
      expect(hookSpy).toHaveBeenCalledWith(hookInput);
    } finally {
      if (previousDriver === undefined) {
        delete process.env.GOATCITADEL_DATABASE_DRIVER;
      } else {
        process.env.GOATCITADEL_DATABASE_DRIVER = previousDriver;
      }
      await gateway?.close().catch(() => undefined);
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 120_000);
});
