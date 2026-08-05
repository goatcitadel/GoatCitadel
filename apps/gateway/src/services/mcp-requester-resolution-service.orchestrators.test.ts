import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MCP_REQUESTER_RESOLUTION_BINDING_VERSION,
  canonicalJsonString,
  mcpRequesterScopeHashMaterial,
  type McpRequesterResolutionBinding,
} from "@goatcitadel/contracts";
import {
  McpRequesterResolverRegistry,
  assertMcpRequesterResolutionBindingIntegrity,
  createMcpEphemeralResolvedConnectionCandidate,
  mcpRequesterScopedServerConfigHash,
  mcpRequesterTransportPolicyHash,
  type McpEphemeralResolvedConnectionInput,
  type McpRequesterScopedServerSnapshot,
} from "./mcp-requester-resolution.js";
import {
  MCP_PROFILE_DISCOVERY_OUTCOME_REGISTRY_LIMIT,
  McpProfileDiscoveryOutcomeRegistry,
  McpRequesterResolutionService,
  dispatchRequesterScopedToolCall,
  resolveRequesterScopedBindingForProfileFreeze,
  type McpProfileDiscoveryOutcomeRecord,
  type McpRequesterScopedFreezeCurrentState,
  type McpRequesterScopedProfileFreezeInput,
  type McpRequesterScopedToolCallCurrentState,
  type McpRequesterScopedToolCallDispatchInput,
} from "./mcp-requester-resolution-service.js";
import { createMcpRequesterDiscoverySecretScanner } from "./mcp-resolution-secret-guard.js";
import { discoverRequesterScopedMcpTools, invokeRequesterScopedMcpToolCall } from "./mcp-runtime.js";

const START = Date.parse("2026-07-14T12:00:00.000Z");
const NETWORK_ALLOWLIST = ["a.example.test", "b.example.test"];

function digest(input: unknown): string {
  return createHash("sha256").update(canonicalJsonString(input)).digest("hex");
}

function server(): McpRequesterScopedServerSnapshot {
  return {
    serverId: "tenant-mcp",
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
    connectionGeneration: stage === "profile_discovery" ? 11 : 12,
    rotationGeneration: 2,
    expiresAt: "2026-07-14T12:04:00.000Z",
  };
}

function outcomeRecord(overrides: Partial<McpProfileDiscoveryOutcomeRecord> = {}): McpProfileDiscoveryOutcomeRecord {
  return {
    profileId: "profile-1",
    serverId: "tenant-mcp",
    canonicalToolName: "mcp.tenant-mcp.search",
    discoveryAttemptId: "discovery-1",
    discoveryAttemptGeneration: 1,
    rawRemoteToolName: "search",
    providerAlias: `mcp__${"a".repeat(64)}`,
    normalizedDiscoveryCatalogSha256: "b".repeat(64),
    normalizedToolDefinitionSha256: "c".repeat(64),
    bindingSha256: "d".repeat(64),
    requesterScopeSha256: "e".repeat(64),
    recordedAtMs: START,
    ...overrides,
  };
}

describe("McpProfileDiscoveryOutcomeRegistry", () => {
  it("round-trips frozen copies and returns undefined on miss", () => {
    const registry = new McpProfileDiscoveryOutcomeRegistry();
    const record = outcomeRecord();
    registry.recordProfileDiscoveryOutcome(record);
    record.rawRemoteToolName = "mutated-after-record";

    const loaded = registry.loadProfileDiscoveryOutcome({
      profileId: "profile-1",
      serverId: "tenant-mcp",
      canonicalToolName: "mcp.tenant-mcp.search",
    });
    expect(loaded).toMatchObject({ rawRemoteToolName: "search", discoveryAttemptId: "discovery-1" });
    expect(Object.isFrozen(loaded)).toBe(true);
    // Copies out: mutating one load never affects the stored value or later loads.
    expect(() => {
      (loaded as { rawRemoteToolName: string }).rawRemoteToolName = "hacked";
    }).toThrow();
    expect(
      registry.loadProfileDiscoveryOutcome({
        profileId: "profile-1",
        serverId: "tenant-mcp",
        canonicalToolName: "mcp.tenant-mcp.search",
      }),
    ).not.toBe(loaded);

    expect(
      registry.loadProfileDiscoveryOutcome({
        profileId: "profile-2",
        serverId: "tenant-mcp",
        canonicalToolName: "mcp.tenant-mcp.search",
      }),
    ).toBeUndefined();
  });

  it("re-records the same key in place and rejects malformed records", () => {
    const registry = new McpProfileDiscoveryOutcomeRegistry();
    registry.recordProfileDiscoveryOutcome(outcomeRecord());
    registry.recordProfileDiscoveryOutcome(outcomeRecord({ discoveryAttemptId: "discovery-2" }));
    expect(
      registry.loadProfileDiscoveryOutcome({
        profileId: "profile-1",
        serverId: "tenant-mcp",
        canonicalToolName: "mcp.tenant-mcp.search",
      }),
    ).toMatchObject({ discoveryAttemptId: "discovery-2" });

    expect(() => registry.recordProfileDiscoveryOutcome(outcomeRecord({ bindingSha256: "NOT-A-SHA" }))).toThrowError(
      expect.objectContaining({ code: "capability_profile_invalid" }),
    );
    expect(() => registry.recordProfileDiscoveryOutcome(outcomeRecord({ profileId: "with space" }))).toThrowError(
      expect.objectContaining({ code: "capability_profile_invalid" }),
    );
    expect(() => registry.recordProfileDiscoveryOutcome({ ...outcomeRecord(), extra: true } as never)).toThrowError(
      expect.objectContaining({ code: "capability_profile_invalid" }),
    );
  });

  it("evicts oldest-first at the documented cap", () => {
    const registry = new McpProfileDiscoveryOutcomeRegistry();
    expect(MCP_PROFILE_DISCOVERY_OUTCOME_REGISTRY_LIMIT).toBe(512);
    for (let index = 0; index < MCP_PROFILE_DISCOVERY_OUTCOME_REGISTRY_LIMIT + 1; index += 1) {
      registry.recordProfileDiscoveryOutcome(outcomeRecord({ profileId: `profile-${index}` }));
    }
    expect(
      registry.loadProfileDiscoveryOutcome({
        profileId: "profile-0",
        serverId: "tenant-mcp",
        canonicalToolName: "mcp.tenant-mcp.search",
      }),
    ).toBeUndefined();
    expect(
      registry.loadProfileDiscoveryOutcome({
        profileId: "profile-1",
        serverId: "tenant-mcp",
        canonicalToolName: "mcp.tenant-mcp.search",
      }),
    ).toBeDefined();
    expect(
      registry.loadProfileDiscoveryOutcome({
        profileId: `profile-${MCP_PROFILE_DISCOVERY_OUTCOME_REGISTRY_LIMIT}`,
        serverId: "tenant-mcp",
        canonicalToolName: "mcp.tenant-mcp.search",
      }),
    ).toBeDefined();
  });
});

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

function stubFetch(overrides: { toolDescription?: string } = {}): void {
  global.fetch = vi.fn(async (url: string, init?: RequestInit & { dispatcher?: unknown }) => {
    const body = JSON.parse(String((init as RequestInit).body)) as { id?: number; method?: string };
    const headers = (init?.headers ?? {}) as Record<string, string>;
    captured.push({
      url,
      method: body.method ?? "unknown",
      authorization: headers.authorization,
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
      return respond({
        tools: overrides.toolDescription
          ? [{ ...DISCOVERED_TOOLS[0], description: overrides.toolDescription }]
          : DISCOVERED_TOOLS,
      });
    }
    if (body.method === "tools/call") {
      return respond({ content: [{ type: "text", text: "done" }] });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof global.fetch;
}

interface ActorFixture {
  actorId: string;
  hook: McpRequesterScopedProfileFreezeInput["hook"];
  freezeState: McpRequesterScopedFreezeCurrentState;
  toolCallState: McpRequesterScopedToolCallCurrentState;
  context: McpRequesterScopedToolCallDispatchInput["context"];
}

function actorFixture(actorId: string): ActorFixture {
  const selectedServer = server();
  const profileId = `chat-capability-profile-turn-${actorId}`;
  const callableCatalogSha256 = digest({ tools: ["mcp.tenant-mcp.search"], actorId });
  const baseCallableCatalogSha256 = digest({ tools: ["mcp.invoke"], actorId });
  const finalProfileSha256 = digest({ profile: actorId });
  const identity = {
    workspaceId: "workspace-1",
    sessionId: `session-${actorId}`,
    turnId: `turn-${actorId}`,
  };
  return {
    actorId,
    hook: {
      profileId,
      ...identity,
      authActorId: actorId,
      authActorSource: "token",
      catalogSnapshotId: `snapshot-${actorId}`,
      callableCatalogSha256,
      canonicalToolName: "mcp.tenant-mcp.search",
      modelToolName: "mcp__scoped_search",
    },
    freezeState: {
      revoked: false,
      actorId,
      actorSource: "token",
      ...identity,
      futureProfileId: profileId,
      baseCallableCatalogSha256,
      server: selectedServer,
      globalNetworkPolicyGeneration: 5,
      authConnectionGeneration: 6,
      turnGeneration: 7,
      preparationGeneration: 8,
      connectionGenerationCurrent: true,
      rotationGenerationCurrent: true,
    },
    toolCallState: {
      revoked: false,
      actorId,
      actorSource: "token",
      ...identity,
      finalProfileId: profileId,
      finalProfileSha256,
      baseCallableCatalogSha256,
      finalCallableCatalogSha256: callableCatalogSha256,
      server: selectedServer,
      globalNetworkPolicyGeneration: 5,
      authConnectionGeneration: 6,
      turnGeneration: 7,
      preparationGeneration: 8,
      connectionGenerationCurrent: true,
      rotationGenerationCurrent: true,
    },
    context: {
      profileId,
      finalProfileSha256,
      ...identity,
      actorId,
      actorSource: "token",
      baseCallableCatalogSha256,
      finalCallableCatalogSha256: callableCatalogSha256,
      callableCatalogSnapshotId: `snapshot-${actorId}`,
      globalNetworkPolicyGeneration: 5,
      authConnectionGeneration: 6,
      turnGeneration: 7,
      preparationGeneration: 8,
    },
  };
}

interface Harness {
  service: McpRequesterResolutionService;
  outcomes: McpProfileDiscoveryOutcomeRegistry;
  discoveryResolver: ReturnType<typeof vi.fn>;
  toolCallResolver: ReturnType<typeof vi.fn>;
  onDiagnostic: ReturnType<typeof vi.fn>;
  createAttemptId: () => string;
  freezeInput(fixture: ActorFixture): McpRequesterScopedProfileFreezeInput;
  dispatchInput(fixture: ActorFixture, effectDispatch?: () => void): McpRequesterScopedToolCallDispatchInput;
}

function buildHarness(): Harness {
  const discoveryResolver = vi.fn(async ({ requester }: { requester: { actorId: string } }) =>
    createMcpEphemeralResolvedConnectionCandidate(resolvedFor("profile_discovery", requester.actorId)),
  );
  const toolCallResolver = vi.fn(async ({ requester }: { requester: { actorId: string } }) =>
    createMcpEphemeralResolvedConnectionCandidate(resolvedFor("tool_call", requester.actorId)),
  );
  const registry = new McpRequesterResolverRegistry({
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
  });
  const service = new McpRequesterResolutionService(registry, { now: () => START });
  const outcomes = new McpProfileDiscoveryOutcomeRegistry();
  const onDiagnostic = vi.fn();
  let attemptCounter = 0;
  const createAttemptId = () => `attempt-${(attemptCounter += 1)}`;
  const scanner = createMcpRequesterDiscoverySecretScanner();
  return {
    service,
    outcomes,
    discoveryResolver,
    toolCallResolver,
    onDiagnostic,
    createAttemptId,
    freezeInput: (fixture) => ({
      hook: fixture.hook,
      service,
      outcomes,
      scanner,
      networkAllowlist: NETWORK_ALLOWLIST,
      readCurrentState: async (check) => ({
        ...fixture.freezeState,
        connectionGenerationCurrent:
          fixture.freezeState.connectionGenerationCurrent &&
          (check.connectionGeneration === undefined || check.connectionGeneration === 11),
        rotationGenerationCurrent:
          fixture.freezeState.rotationGenerationCurrent &&
          (check.rotationGeneration === undefined || check.rotationGeneration === 2),
      }),
      discoverTools: discoverRequesterScopedMcpTools,
      createAttemptId,
      onDiagnostic,
      now: () => START,
    }),
    dispatchInput: (fixture, effectDispatch = () => undefined) => ({
      context: fixture.context,
      serverId: "tenant-mcp",
      canonicalToolName: "mcp.tenant-mcp.search",
      toolName: "mcp__scoped_search",
      arguments: { query: "hello" },
      effectDispatch,
      service,
      outcomes,
      scanner,
      networkAllowlist: NETWORK_ALLOWLIST,
      readCurrentState: async (check) => ({
        ...fixture.toolCallState,
        connectionGenerationCurrent:
          fixture.toolCallState.connectionGenerationCurrent &&
          (check.connectionGeneration === undefined || check.connectionGeneration === 12),
        rotationGenerationCurrent:
          fixture.toolCallState.rotationGenerationCurrent &&
          (check.rotationGeneration === undefined || check.rotationGeneration === 2),
      }),
      invokeToolCall: invokeRequesterScopedMcpToolCall,
      createAttemptId,
      now: () => START,
    }),
  };
}

beforeEach(() => {
  captured = [];
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("resolveRequesterScopedBindingForProfileFreeze", () => {
  it("returns undefined for authActorSource none/missing without touching the resolver", async () => {
    stubFetch();
    const harness = buildHarness();
    const fixture = actorFixture("operator-a");

    await expect(
      resolveRequesterScopedBindingForProfileFreeze({
        ...harness.freezeInput(fixture),
        hook: { ...fixture.hook, authActorSource: "none" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolveRequesterScopedBindingForProfileFreeze({
        ...harness.freezeInput(fixture),
        hook: { ...fixture.hook, authActorId: undefined, authActorSource: undefined },
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolveRequesterScopedBindingForProfileFreeze({
        ...harness.freezeInput(fixture),
        hook: { ...fixture.hook, authActorSource: "sse" },
      }),
    ).resolves.toBeUndefined();

    expect(harness.discoveryResolver).not.toHaveBeenCalled();
    expect(captured).toHaveLength(0);
    expect(harness.onDiagnostic).toHaveBeenCalledWith("requester_context_missing");
  });

  it("returns undefined without diagnostics for a static/non-requester server", async () => {
    stubFetch();
    const harness = buildHarness();
    const fixture = actorFixture("operator-a");
    const input = harness.freezeInput(fixture);

    await expect(
      resolveRequesterScopedBindingForProfileFreeze({ ...input, readCurrentState: async () => undefined }),
    ).resolves.toBeUndefined();

    expect(harness.discoveryResolver).not.toHaveBeenCalled();
    expect(harness.onDiagnostic).not.toHaveBeenCalled();
  });

  it("discovers, records the outcome, and returns an integrity-verified binding", async () => {
    stubFetch();
    const harness = buildHarness();
    const fixture = actorFixture("operator-a");

    const binding = await resolveRequesterScopedBindingForProfileFreeze(harness.freezeInput(fixture));

    expect(binding).toBeDefined();
    expect(() => assertMcpRequesterResolutionBindingIntegrity(binding as McpRequesterResolutionBinding)).not.toThrow();
    expect(binding).toMatchObject({
      schemaVersion: MCP_REQUESTER_RESOLUTION_BINDING_VERSION,
      mode: "requester_scoped",
      serverId: "tenant-mcp",
      toolName: "mcp.tenant-mcp.search",
      resolverId: "gateway.tenant",
      serverConfigRevision: 7,
      serverConfigSha256: mcpRequesterScopedServerConfigHash(server()),
      transportPolicySha256: mcpRequesterTransportPolicyHash(server().requesterResolution.transportPolicy),
      callableCatalogSnapshotId: "snapshot-operator-a",
      callableCatalogSha256: fixture.hook.callableCatalogSha256,
      requesterScopeSha256: digest(
        mcpRequesterScopeHashMaterial({
          profileId: fixture.hook.profileId,
          turnId: fixture.hook.turnId,
          sessionId: fixture.hook.sessionId,
          workspaceId: fixture.hook.workspaceId,
          authActorId: "operator-a",
          authActorSource: "token",
        }),
      ),
    });
    // The discovery transport ran against the requester's resolved endpoint with
    // the resolved header material.
    expect(captured.map((call) => call.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(captured[0]?.url).toContain("a.example.test");
    expect(captured[0]?.authorization).toBe("Bearer secret-operator-a-profile_discovery");

    const outcome = harness.outcomes.loadProfileDiscoveryOutcome({
      profileId: fixture.hook.profileId,
      serverId: "tenant-mcp",
      canonicalToolName: "mcp.tenant-mcp.search",
    });
    expect(outcome).toMatchObject({
      rawRemoteToolName: "search",
      bindingSha256: (binding as McpRequesterResolutionBinding).bindingSha256,
      discoveryAttemptId: "attempt-1",
      discoveryAttemptGeneration: 1,
    });
    expect(outcome?.providerAlias).toMatch(/^mcp__[a-f0-9]{64}$/u);
    expect(harness.onDiagnostic).not.toHaveBeenCalled();
  });

  it("verifies a caller-supplied requester scope hash and fails closed on mismatch", async () => {
    stubFetch();
    const harness = buildHarness();
    const fixture = actorFixture("operator-a");

    await expect(
      resolveRequesterScopedBindingForProfileFreeze({
        ...harness.freezeInput(fixture),
        hook: { ...fixture.hook, requesterScopeSha256: "f".repeat(64) },
      }),
    ).resolves.toBeUndefined();
    expect(harness.onDiagnostic).toHaveBeenCalledWith("requester_scope_mismatch");
  });

  it("emits taxonomy codes for resolver failure, secret findings, and missing target tools", async () => {
    stubFetch();
    const harness = buildHarness();
    harness.discoveryResolver.mockImplementationOnce(async () => {
      throw new Error("resolver exploded with https://leak.example.test/?token=canary");
    });
    await expect(
      resolveRequesterScopedBindingForProfileFreeze(harness.freezeInput(actorFixture("operator-a"))),
    ).resolves.toBeUndefined();
    expect(harness.onDiagnostic).toHaveBeenLastCalledWith("resolver_failed");

    stubFetch({ toolDescription: "Use Bearer sk-canary-1234567890abcdef here" });
    await expect(
      resolveRequesterScopedBindingForProfileFreeze(harness.freezeInput(actorFixture("operator-b"))),
    ).resolves.toBeUndefined();
    expect(harness.onDiagnostic).toHaveBeenLastCalledWith("discovery_secret_detected");

    stubFetch();
    const wrongTool = actorFixture("operator-c");
    await expect(
      resolveRequesterScopedBindingForProfileFreeze({
        ...buildHarness().freezeInput(wrongTool),
        hook: { ...wrongTool.hook, canonicalToolName: "mcp.tenant-mcp.absent" },
      }),
    ).resolves.toBeUndefined();
  });

  it("fails closed when the live state is revoked mid-discovery", async () => {
    stubFetch();
    const harness = buildHarness();
    const fixture = actorFixture("operator-a");
    const input = harness.freezeInput(fixture);
    let reads = 0;
    const revokingInput: McpRequesterScopedProfileFreezeInput = {
      ...input,
      readCurrentState: async (check) => {
        reads += 1;
        const state = await input.readCurrentState(check);
        return reads > 3 && state ? { ...state, revoked: true } : state;
      },
    };

    await expect(resolveRequesterScopedBindingForProfileFreeze(revokingInput)).resolves.toBeUndefined();
    expect(harness.onDiagnostic).toHaveBeenCalledWith("connection_generation_revoked");
    expect(
      harness.outcomes.loadProfileDiscoveryOutcome({
        profileId: fixture.hook.profileId,
        serverId: "tenant-mcp",
        canonicalToolName: "mcp.tenant-mcp.search",
      }),
    ).toBeUndefined();
  });
});

describe("dispatchRequesterScopedToolCall", () => {
  it("fails closed with requester_context_missing when no discovery outcome exists", async () => {
    stubFetch();
    const harness = buildHarness();
    const effectDispatch = vi.fn();

    const result = await dispatchRequesterScopedToolCall(
      harness.dispatchInput(actorFixture("operator-a"), effectDispatch),
    );

    expect(result.ok).toBe(false);
    expect(result.failurePhase).toBe("pre_dispatch");
    expect(result.output).toMatchObject({ requesterScoped: true, reasonCode: "requester_context_missing" });
    expect(effectDispatch).not.toHaveBeenCalled();
    expect(harness.toolCallResolver).not.toHaveBeenCalled();
    expect(captured).toHaveLength(0);
  });

  it("runs the full freeze → outcome → revalidated tools/call path end to end", async () => {
    stubFetch();
    const harness = buildHarness();
    const fixture = actorFixture("operator-a");
    const binding = await resolveRequesterScopedBindingForProfileFreeze(harness.freezeInput(fixture));
    expect(binding).toBeDefined();
    captured = [];
    const effectDispatch = vi.fn();

    const result = await dispatchRequesterScopedToolCall(harness.dispatchInput(fixture, effectDispatch));

    expect(result.ok).toBe(true);
    expect(effectDispatch).toHaveBeenCalledTimes(1);
    expect(captured.map((call) => call.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    // The tool call runs on the requester's TOOL-CALL stage connection.
    expect(captured.every((call) => call.url.includes("b.example.test"))).toBe(true);
    expect(captured[0]?.authorization).toBe("Bearer secret-operator-a-tool_call");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret-operator-a");
    expect(serialized).not.toContain("b.example.test");
  });

  it("keeps two requesters on independent attempts, connections, and dispatchers with no reuse", async () => {
    stubFetch();
    const harness = buildHarness();
    const alpha = actorFixture("operator-a");
    const beta = actorFixture("operator-b");
    expect(await resolveRequesterScopedBindingForProfileFreeze(harness.freezeInput(alpha))).toBeDefined();
    expect(await resolveRequesterScopedBindingForProfileFreeze(harness.freezeInput(beta))).toBeDefined();
    captured = [];

    const [alphaResult, betaResult] = await Promise.all([
      dispatchRequesterScopedToolCall(harness.dispatchInput(alpha)),
      dispatchRequesterScopedToolCall(harness.dispatchInput(beta)),
    ]);

    expect(alphaResult.ok).toBe(true);
    expect(betaResult.ok).toBe(true);
    // One discovery + one tool-call resolution per requester; never shared.
    expect(harness.discoveryResolver).toHaveBeenCalledTimes(2);
    expect(harness.toolCallResolver).toHaveBeenCalledTimes(2);
    const alphaCalls = captured.filter((call) => call.authorization?.includes("operator-a"));
    const betaCalls = captured.filter((call) => call.authorization?.includes("operator-b"));
    expect(alphaCalls).toHaveLength(4);
    expect(betaCalls).toHaveLength(4);
    // Each requester's attempt uses its own resolved credentials and URL...
    expect(alphaCalls.every((call) => call.url.includes("requester=operator-a"))).toBe(true);
    expect(betaCalls.every((call) => call.url.includes("requester=operator-b"))).toBe(true);
    // ...and its own isolated dispatcher (no guarded-agent reuse across requesters).
    const alphaDispatchers = new Set(alphaCalls.map((call) => call.dispatcher));
    const betaDispatchers = new Set(betaCalls.map((call) => call.dispatcher));
    expect(alphaDispatchers.size).toBe(1);
    expect(betaDispatchers.size).toBe(1);
    expect([...alphaDispatchers][0]).not.toBe([...betaDispatchers][0]);
  });

  it("fails pre-dispatch when the fresh revalidation catalog drifts from the frozen outcome", async () => {
    stubFetch();
    const harness = buildHarness();
    const fixture = actorFixture("operator-a");
    expect(await resolveRequesterScopedBindingForProfileFreeze(harness.freezeInput(fixture))).toBeDefined();
    // The remote catalog changes between freeze-time discovery and the call.
    stubFetch({ toolDescription: "Search safely v2" });
    const effectDispatch = vi.fn();

    const result = await dispatchRequesterScopedToolCall(harness.dispatchInput(fixture, effectDispatch));

    expect(result.ok).toBe(false);
    expect(result.failurePhase).toBe("pre_dispatch");
    expect(result.output).toMatchObject({ requesterScoped: true, reasonCode: "schema_revalidation_drift" });
    expect(effectDispatch).not.toHaveBeenCalled();
    expect(captured.map((call) => call.method)).not.toContain("tools/call");
  });

  it("fails closed when the current server state drifts before resolution", async () => {
    stubFetch();
    const harness = buildHarness();
    const fixture = actorFixture("operator-a");
    expect(await resolveRequesterScopedBindingForProfileFreeze(harness.freezeInput(fixture))).toBeDefined();
    fixture.toolCallState.globalNetworkPolicyGeneration += 1;
    const effectDispatch = vi.fn();

    const result = await dispatchRequesterScopedToolCall(harness.dispatchInput(fixture, effectDispatch));

    expect(result.ok).toBe(false);
    expect(result.failurePhase).toBe("pre_dispatch");
    expect(result.output).toMatchObject({ requesterScoped: true, reasonCode: "resolver_binding_drift" });
    expect(effectDispatch).not.toHaveBeenCalled();
  });
});
