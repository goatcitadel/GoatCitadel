import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const testAuthorityBrands = vi.hoisted(() => ({
  profileDiscovery: new WeakSet<object>(),
  toolCall: new WeakSet<object>(),
}));

vi.mock("./mcp-requester-resolution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mcp-requester-resolution.js")>();
  return {
    ...actual,
    assertMcpProfileDiscoveryAuthority(input: unknown): void {
      if (typeof input !== "object" || input === null || !testAuthorityBrands.profileDiscovery.has(input)) {
        throw new actual.McpRequesterResolutionError("requester_context_ambiguous");
      }
    },
    assertMcpToolCallAuthority(input: unknown): void {
      if (typeof input !== "object" || input === null || !testAuthorityBrands.toolCall.has(input)) {
        throw new actual.McpRequesterResolutionError("requester_context_ambiguous");
      }
    },
  };
});

import {
  MCP_REQUESTER_RESOLUTION_BINDING_VERSION,
  canonicalJsonString,
  mcpRequesterScopeHashMaterial,
  type McpNormalizedRequesterDiscoveryCatalog,
  type McpProfileDiscoveryAuthorityHashInput,
  type McpRequesterResolutionBinding,
  type McpToolCallAuthorityHashInput,
} from "@goatcitadel/contracts";
import {
  McpRequesterResolverRegistry,
  createMcpEphemeralResolvedConnectionCandidate,
  createMcpRequesterProviderAlias,
  mcpRequesterScopedServerConfigHash,
  mcpRequesterTransportPolicyHash,
  normalizeMcpRequesterDiscoveryOutput,
  type McpEphemeralResolvedConnectionInput,
  type McpProfileDiscoveryAuthority,
  type McpProfileDiscoveryConnectionResolverInput,
  type McpProfileDiscoveryCurrentState,
  type McpRequesterScopedServerSnapshot,
  type McpToolCallAuthority,
  type McpToolCallConnectionResolverInput,
  type McpToolCallCurrentState,
} from "./mcp-requester-resolution.js";
import {
  McpRequesterResolutionService,
  type McpProfileDiscoveryResolutionServiceInput,
  type McpToolCallResolutionServiceInput,
} from "./mcp-requester-resolution-service.js";

const START = Date.parse("2026-07-14T12:00:00.000Z");

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
        allowedHosts: ["a.example.test", "b.example.test", "mcp.example.test"],
        allowedPorts: [443],
        allowedHeaderNames: ["authorization", "x-tenant"],
      },
    },
  };
}

function catalog(schemaType = "string"): McpNormalizedRequesterDiscoveryCatalog {
  return normalizeMcpRequesterDiscoveryOutput(
    "tenant-mcp",
    {
      tools: [
        {
          rawRemoteToolName: "search",
          canonicalToolName: "mcp.tenant-mcp.search",
          description: "Search safely",
          inputSchema: { type: "object", properties: { query: { type: schemaType } } },
        },
      ],
    },
    {
      scannerId: "gateway.secret-scan",
      scannerVersion: "1.0.0",
      scannerGeneration: 3,
      scan: ({ payloadSha256 }) => ({ verdict: "clean", evidenceSha256: digest({ payloadSha256, clean: true }) }),
    },
  );
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

interface Fixture {
  discoveryInput: McpProfileDiscoveryResolutionServiceInput;
  toolCallInput: McpToolCallResolutionServiceInput;
  discoveryCurrent: McpProfileDiscoveryCurrentState;
  toolCallCurrent: McpToolCallCurrentState;
  binding: McpRequesterResolutionBinding;
  catalog: McpNormalizedRequesterDiscoveryCatalog;
}

function discoveryCurrent(authority: McpProfileDiscoveryAuthority): McpProfileDiscoveryCurrentState {
  return {
    revoked: false,
    actorId: authority.actorId,
    actorSource: authority.actorSource,
    workspaceId: authority.workspaceId,
    sessionId: authority.sessionId,
    turnId: authority.turnId,
    futureProfileId: authority.futureProfileId,
    baseCallableCatalogSha256: authority.baseCallableCatalogSha256,
    serverId: authority.serverId,
    serverConfigRevision: authority.serverConfigRevision,
    serverConfigSha256: authority.serverConfigSha256,
    resolverId: authority.resolverId,
    resolverVersion: authority.resolverVersion,
    resolverConfigGeneration: authority.resolverConfigGeneration,
    transportPolicySha256: authority.transportPolicySha256,
    globalNetworkPolicyGeneration: authority.globalNetworkPolicyGeneration,
    authConnectionGeneration: authority.authConnectionGeneration,
    turnGeneration: authority.turnGeneration,
    preparationGeneration: authority.preparationGeneration,
    ...(authority.meshPublisherGeneration === undefined
      ? {}
      : {
          meshPublisherGeneration: authority.meshPublisherGeneration,
          meshActivationGeneration: authority.meshActivationGeneration,
        }),
    discoveryAttemptId: authority.discoveryAttemptId,
    discoveryAttemptGeneration: authority.discoveryAttemptGeneration,
    discoveryAttemptOpen: true,
    connectionGenerationCurrent: true,
    rotationGenerationCurrent: true,
  };
}

function toolCallCurrent(authority: McpToolCallAuthority): McpToolCallCurrentState {
  return {
    revoked: false,
    actorId: authority.actorId,
    actorSource: authority.actorSource,
    workspaceId: authority.workspaceId,
    sessionId: authority.sessionId,
    turnId: authority.turnId,
    finalProfileId: authority.finalProfileId,
    finalProfileSha256: authority.finalProfileSha256,
    baseCallableCatalogSha256: authority.baseCallableCatalogSha256,
    finalCallableCatalogSha256: authority.finalCallableCatalogSha256,
    serverId: authority.serverId,
    serverConfigRevision: authority.serverConfigRevision,
    serverConfigSha256: authority.serverConfigSha256,
    resolverId: authority.resolverId,
    resolverVersion: authority.resolverVersion,
    resolverConfigGeneration: authority.resolverConfigGeneration,
    transportPolicySha256: authority.transportPolicySha256,
    globalNetworkPolicyGeneration: authority.globalNetworkPolicyGeneration,
    authConnectionGeneration: authority.authConnectionGeneration,
    turnGeneration: authority.turnGeneration,
    preparationGeneration: authority.preparationGeneration,
    ...(authority.meshPublisherGeneration === undefined
      ? {}
      : {
          meshPublisherGeneration: authority.meshPublisherGeneration,
          meshActivationGeneration: authority.meshActivationGeneration,
        }),
    profileDiscoveryAttemptId: authority.profileDiscoveryAttemptId,
    profileDiscoveryAttemptGeneration: authority.profileDiscoveryAttemptGeneration,
    revalidationAttemptId: authority.revalidationAttemptId,
    revalidationAttemptGeneration: authority.revalidationAttemptGeneration,
    finalEffectAttemptId: authority.finalEffectAttemptId,
    finalEffectAttemptGeneration: authority.finalEffectAttemptGeneration,
    finalEffectAttemptOpen: true,
    rawRemoteToolName: authority.rawRemoteToolName,
    canonicalToolName: authority.canonicalToolName,
    providerAlias: authority.providerAlias,
    normalizedDiscoveryCatalogSha256: authority.normalizedDiscoveryCatalogSha256,
    normalizedToolDefinitionSha256: authority.normalizedToolDefinitionSha256,
    bindingSha256: authority.bindingSha256,
    connectionGenerationCurrent: true,
    rotationGenerationCurrent: true,
  };
}

function brandProfileDiscoveryAuthority(input: McpProfileDiscoveryAuthorityHashInput): McpProfileDiscoveryAuthority {
  const authority = Object.freeze({
    ...input,
    stage: "profile_discovery" as const,
    authoritySha256: digest({ stage: "profile_discovery", ...input }),
    toJSON(): never {
      throw new Error("test authority is nonserializable");
    },
  }) as unknown as McpProfileDiscoveryAuthority;
  testAuthorityBrands.profileDiscovery.add(authority);
  return authority;
}

function brandToolCallAuthority(input: McpToolCallAuthorityHashInput): McpToolCallAuthority {
  const authority = Object.freeze({
    ...input,
    stage: "tool_call" as const,
    authoritySha256: digest({ stage: "tool_call", ...input }),
    toJSON(): never {
      throw new Error("test authority is nonserializable");
    },
  }) as unknown as McpToolCallAuthority;
  testAuthorityBrands.toolCall.add(authority);
  return authority;
}

function buildFixture(actorId = "operator-a", revocationSignal?: AbortSignal): Fixture {
  const selectedServer = server();
  const selectedCatalog = catalog();
  const tool = selectedCatalog.tools[0]!;
  const baseCatalogSha256 = digest({ tools: ["mcp.invoke"] });
  const finalCatalogSha256 = digest({ tools: [tool.canonicalToolName] });
  const finalProfileId = `profile-${actorId}`;
  const finalProfileSha256 = digest({ profile: actorId, catalog: finalCatalogSha256 });
  const requesterScopeSha256 = digest(
    mcpRequesterScopeHashMaterial({
      profileId: finalProfileId,
      turnId: `turn-${actorId}`,
      sessionId: `session-${actorId}`,
      workspaceId: "workspace-1",
      authActorId: actorId,
      authActorSource: "token",
    }),
  );
  const bindingMaterial = {
    schemaVersion: MCP_REQUESTER_RESOLUTION_BINDING_VERSION,
    mode: "requester_scoped" as const,
    serverId: selectedServer.serverId,
    toolName: tool.canonicalToolName,
    resolverId: selectedServer.requesterResolution.resolverId,
    resolverVersion: selectedServer.requesterResolution.resolverVersion,
    resolverConfigGeneration: selectedServer.requesterResolution.configGeneration,
    requesterScopeSha256,
    serverConfigRevision: selectedServer.configurationRevision,
    serverConfigSha256: mcpRequesterScopedServerConfigHash(selectedServer),
    transportPolicySha256: mcpRequesterTransportPolicyHash(selectedServer.requesterResolution.transportPolicy),
    callableCatalogSnapshotId: `snapshot-${actorId}`,
    callableCatalogSha256: finalCatalogSha256,
  };
  const binding: McpRequesterResolutionBinding = { ...bindingMaterial, bindingSha256: digest(bindingMaterial) };
  const profileBase = {
    finalProfileId,
    finalProfileSha256,
    baseCallableCatalogSha256: baseCatalogSha256,
    finalCallableCatalogSha256: finalCatalogSha256,
    serverId: selectedServer.serverId,
    rawRemoteToolName: tool.rawRemoteToolName,
    canonicalToolName: tool.canonicalToolName,
    normalizedDiscoveryCatalogSha256: selectedCatalog.catalogSha256,
    normalizedToolDefinitionSha256: tool.toolDefinitionSha256,
    bindingSha256: binding.bindingSha256,
  };
  const providerAlias = createMcpRequesterProviderAlias({
    serverId: profileBase.serverId,
    rawRemoteToolName: profileBase.rawRemoteToolName,
    canonicalToolName: profileBase.canonicalToolName,
    normalizedToolDefinitionSha256: profileBase.normalizedToolDefinitionSha256,
    bindingSha256: profileBase.bindingSha256,
  });
  const shared = {
    actorId,
    actorSource: "token" as const,
    workspaceId: "workspace-1",
    sessionId: `session-${actorId}`,
    turnId: `turn-${actorId}`,
    serverConfigRevision: selectedServer.configurationRevision,
    serverConfigSha256: binding.serverConfigSha256,
    resolverId: binding.resolverId,
    resolverVersion: binding.resolverVersion,
    resolverConfigGeneration: binding.resolverConfigGeneration,
    transportPolicySha256: binding.transportPolicySha256,
    globalNetworkPolicyGeneration: 5,
    authConnectionGeneration: 6,
    turnGeneration: 7,
    preparationGeneration: 8,
  };
  const discoveryAuthority = brandProfileDiscoveryAuthority({
    ...shared,
    futureProfileId: `future-${actorId}`,
    baseCallableCatalogSha256: baseCatalogSha256,
    serverId: selectedServer.serverId,
    discoveryAttemptId: `discovery-${actorId}`,
    discoveryAttemptGeneration: 9,
  });
  const finalAuthority = brandToolCallAuthority({
    ...shared,
    ...profileBase,
    providerAlias,
    profileDiscoveryAttemptId: discoveryAuthority.discoveryAttemptId,
    profileDiscoveryAttemptGeneration: discoveryAuthority.discoveryAttemptGeneration,
    revalidationAttemptId: `revalidation-${actorId}`,
    revalidationAttemptGeneration: 10,
    finalEffectAttemptId: `effect-${actorId}`,
    finalEffectAttemptGeneration: 11,
  });
  const discoveryState = discoveryCurrent(discoveryAuthority);
  const finalState = toolCallCurrent(finalAuthority);
  const discoveryReader = vi.fn(async (check: { connectionGeneration?: number; rotationGeneration?: number }) => ({
    ...discoveryState,
    connectionGenerationCurrent:
      discoveryState.connectionGenerationCurrent &&
      (check.connectionGeneration === undefined || check.connectionGeneration === 11),
    rotationGenerationCurrent:
      discoveryState.rotationGenerationCurrent &&
      (check.rotationGeneration === undefined || check.rotationGeneration === 2),
  }));
  const toolCallReader = vi.fn(async (check: { connectionGeneration?: number; rotationGeneration?: number }) => ({
    ...finalState,
    connectionGenerationCurrent:
      finalState.connectionGenerationCurrent &&
      (check.connectionGeneration === undefined || check.connectionGeneration === 12),
    rotationGenerationCurrent:
      finalState.rotationGenerationCurrent &&
      (check.rotationGeneration === undefined || check.rotationGeneration === 2),
  }));
  return {
    discoveryInput: {
      requester: discoveryAuthority,
      server: selectedServer,
      readCurrentState: discoveryReader,
      revocationSignal,
    },
    toolCallInput: {
      requester: finalAuthority,
      server: selectedServer,
      binding,
      readCurrentState: toolCallReader,
      revocationSignal,
    },
    discoveryCurrent: discoveryState,
    toolCallCurrent: finalState,
    binding,
    catalog: selectedCatalog,
  };
}

type RawDiscoveryResolver = (
  input: McpProfileDiscoveryConnectionResolverInput,
) => McpEphemeralResolvedConnectionInput | Promise<McpEphemeralResolvedConnectionInput>;
type RawToolCallResolver = (
  input: McpToolCallConnectionResolverInput,
) => McpEphemeralResolvedConnectionInput | Promise<McpEphemeralResolvedConnectionInput>;

function registryWith(
  discovery: RawDiscoveryResolver = ({ requester }) => resolvedFor("profile_discovery", requester.actorId),
  final: RawToolCallResolver = ({ requester }) => resolvedFor("tool_call", requester.actorId),
): McpRequesterResolverRegistry {
  return new McpRequesterResolverRegistry({
    profileDiscovery: [
      {
        resolverId: "gateway.tenant",
        resolverVersion: "1.2.3",
        configGeneration: 4,
        resolveForProfileDiscovery: async (input) =>
          createMcpEphemeralResolvedConnectionCandidate(await discovery(input)),
      },
    ],
    toolCall: [
      {
        resolverId: "gateway.tenant",
        resolverVersion: "1.2.3",
        configGeneration: 4,
        resolveForToolCall: async (input) => createMcpEphemeralResolvedConnectionCandidate(await final(input)),
      },
    ],
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("McpRequesterResolutionService two-stage authority seam", () => {
  it("exposes only distinct discovery/final entrypoints and exact stage operations", async () => {
    const discoveryResolver = vi.fn<RawDiscoveryResolver>(({ requester }) =>
      resolvedFor("profile_discovery", requester.actorId),
    );
    const finalResolver = vi.fn<RawToolCallResolver>(({ requester }) => resolvedFor("tool_call", requester.actorId));
    const service = new McpRequesterResolutionService(registryWith(discoveryResolver, finalResolver), {
      now: () => START,
    });
    const fixture = buildFixture();

    expect((service as unknown as Record<string, unknown>).resolve).toBeUndefined();
    const discovery = await service.resolveForProfileDiscovery(fixture.discoveryInput);
    expect(discovery.stage).toBe("profile_discovery");
    const initialize = await discovery.authorizeInitialize();
    const initialized = await discovery.authorizeInitializedNotification();
    const toolsList = await discovery.authorizeToolsList();
    expect([initialize.operation, initialized.operation, toolsList.operation]).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    expect(toolsList.rotationGeneration).toBe(2);
    await expect(discovery.authorizeToolsList()).rejects.toMatchObject({ code: "operation_denied" });
    await expect(discovery.consumeOperationPermit(initialize)).resolves.toBe(initialize);
    await expect(discovery.consumeOperationPermit(initialized)).resolves.toBe(initialized);
    await expect(discovery.consumeOperationPermit(toolsList)).resolves.toBe(toolsList);
    await expect(discovery.authorizeToolsList()).rejects.toMatchObject({ code: "operation_denied" });
    await expect(discovery.consumeOperationPermit(toolsList)).rejects.toMatchObject({ code: "operation_denied" });
    expect((discovery as unknown as Record<string, unknown>).authorizeToolsCall).toBeUndefined();
    expect(() => JSON.stringify(toolsList)).toThrowError(expect.objectContaining({ code: "operation_denied" }));
    expect(finalResolver).not.toHaveBeenCalled();
    discovery.dispose();

    const final = await service.resolveForToolCall(fixture.toolCallInput);
    await expect(final.authorizeToolsCall()).rejects.toMatchObject({ code: "schema_revalidation_required" });
    const revalidation = await final.authorizeToolsListRevalidation();
    expect(revalidation).toMatchObject({
      operation: "tools/list",
      expectedCatalogSha256: fixture.catalog.catalogSha256,
      rotationGeneration: 2,
    });
    await expect(final.authorizeToolsListRevalidation()).rejects.toMatchObject({ code: "operation_denied" });
    await expect(
      final.acceptFreshToolsListRevalidation({
        revalidationAttemptId: fixture.toolCallInput.requester.revalidationAttemptId,
        revalidationAttemptGeneration: fixture.toolCallInput.requester.revalidationAttemptGeneration,
        catalog: fixture.catalog,
      }),
    ).rejects.toMatchObject({ code: "schema_revalidation_required" });
    await expect(final.consumeToolsListRevalidationPermit(revalidation)).resolves.toBe(revalidation);
    await expect(final.authorizeToolsListRevalidation()).rejects.toMatchObject({ code: "operation_denied" });
    await expect(final.consumeToolsListRevalidationPermit(revalidation)).rejects.toMatchObject({
      code: "operation_denied",
    });
    await final.acceptFreshToolsListRevalidation({
      revalidationAttemptId: fixture.toolCallInput.requester.revalidationAttemptId,
      revalidationAttemptGeneration: fixture.toolCallInput.requester.revalidationAttemptGeneration,
      catalog: fixture.catalog,
    });
    const call = await final.authorizeToolsCall();
    expect(call).toMatchObject({
      operation: "tools/call",
      rawRemoteToolName: "search",
      canonicalToolName: "mcp.tenant-mcp.search",
      providerAlias: fixture.toolCallInput.requester.providerAlias,
      rotationGeneration: 2,
    });
    await expect(final.authorizeToolsCall()).rejects.toMatchObject({ code: "operation_denied" });
    await expect(final.consumeToolsCallPermit(call)).resolves.toBe(call);
    await expect(final.consumeToolsCallPermit(call)).rejects.toMatchObject({ code: "operation_denied" });
    expect((final as unknown as Record<string, unknown>).authorizeInitialize).toBeUndefined();
    final.dispose();
  });

  it("rejects discovery/final authority stage substitution before resolver execution", async () => {
    const discoveryResolver = vi.fn<RawDiscoveryResolver>(({ requester }) =>
      resolvedFor("profile_discovery", requester.actorId),
    );
    const finalResolver = vi.fn<RawToolCallResolver>(({ requester }) => resolvedFor("tool_call", requester.actorId));
    const service = new McpRequesterResolutionService(registryWith(discoveryResolver, finalResolver), {
      now: () => START,
    });
    const fixture = buildFixture();
    await expect(
      service.resolveForProfileDiscovery({
        ...fixture.discoveryInput,
        requester: fixture.toolCallInput.requester as never,
      }),
    ).rejects.toMatchObject({ code: "requester_context_ambiguous" });
    await expect(
      service.resolveForToolCall({ ...fixture.toolCallInput, requester: fixture.discoveryInput.requester as never }),
    ).rejects.toMatchObject({ code: "requester_context_ambiguous" });
    expect(discoveryResolver).not.toHaveBeenCalled();
    expect(finalResolver).not.toHaveBeenCalled();
  });

  it("denies concurrent authority reuse and delegates sequential replay closure to the current effect owner", async () => {
    const service = new McpRequesterResolutionService(registryWith(), { now: () => START });
    const fixture = buildFixture();
    const first = await service.resolveForToolCall(fixture.toolCallInput);
    await expect(service.resolveForToolCall(fixture.toolCallInput)).rejects.toMatchObject({ code: "operation_denied" });
    first.dispose();
    fixture.toolCallCurrent.finalEffectAttemptOpen = false;
    await expect(service.resolveForToolCall(fixture.toolCallInput)).rejects.toMatchObject({ code: "operation_denied" });
  });

  it("releases high-cardinality active claims exactly on dispose", async () => {
    const service = new McpRequesterResolutionService(registryWith(), { now: () => START });
    const fixtures = Array.from({ length: 96 }, (_, index) => buildFixture(`cardinality-${index}`));
    const firstWave = await Promise.all(fixtures.map((fixture) => service.resolveForToolCall(fixture.toolCallInput)));
    for (const attempt of firstWave) attempt.dispose();
    const secondWave = await Promise.all(fixtures.map((fixture) => service.resolveForToolCall(fixture.toolCallInput)));
    expect(secondWave).toHaveLength(fixtures.length);
    for (const attempt of secondWave) attempt.dispose();
  });

  it("revokes detached call permits on dispose, revoke, rotation, and expiry", async () => {
    let now = START;
    const service = new McpRequesterResolutionService(registryWith(), { now: () => now });
    const authorize = async (fixture: Fixture) => {
      const attempt = await service.resolveForToolCall(fixture.toolCallInput);
      const revalidation = await attempt.authorizeToolsListRevalidation();
      await attempt.consumeToolsListRevalidationPermit(revalidation);
      await attempt.acceptFreshToolsListRevalidation({
        revalidationAttemptId: fixture.toolCallInput.requester.revalidationAttemptId,
        revalidationAttemptGeneration: fixture.toolCallInput.requester.revalidationAttemptGeneration,
        catalog: fixture.catalog,
      });
      return { attempt, permit: await attempt.authorizeToolsCall() };
    };

    const disposed = buildFixture("dispose-actor");
    const disposedCall = await authorize(disposed);
    disposedCall.attempt.dispose();
    await expect(disposedCall.attempt.consumeToolsCallPermit(disposedCall.permit)).rejects.toMatchObject({
      code: "connection_generation_revoked",
    });

    const revoked = buildFixture("revoke-actor");
    const revokedCall = await authorize(revoked);
    revoked.toolCallCurrent.revoked = true;
    await expect(revokedCall.attempt.consumeToolsCallPermit(revokedCall.permit)).rejects.toMatchObject({
      code: "connection_generation_revoked",
    });
    revokedCall.attempt.dispose();

    const rotated = buildFixture("rotate-actor");
    const rotatedCall = await authorize(rotated);
    rotated.toolCallCurrent.rotationGenerationCurrent = false;
    await expect(rotatedCall.attempt.consumeToolsCallPermit(rotatedCall.permit)).rejects.toMatchObject({
      code: "connection_generation_revoked",
    });
    rotatedCall.attempt.dispose();

    const expired = buildFixture("expire-actor");
    const expiredCall = await authorize(expired);
    now = Date.parse("2026-07-14T12:04:00.000Z");
    await expect(expiredCall.attempt.consumeToolsCallPermit(expiredCall.permit)).rejects.toMatchObject({
      code: "resolved_connection_expired",
    });
    expiredCall.attempt.dispose();
  });

  it("owns discovery and revalidation permits by exact attempt and revokes them on stale state", async () => {
    let now = START;
    const service = new McpRequesterResolutionService(registryWith(), { now: () => now });

    const discoveryA = buildFixture("discovery-owner-a");
    const discoveryB = buildFixture("discovery-owner-b");
    const [attemptA, attemptB] = await Promise.all([
      service.resolveForProfileDiscovery(discoveryA.discoveryInput),
      service.resolveForProfileDiscovery(discoveryB.discoveryInput),
    ]);
    const permitA = await attemptA.authorizeToolsList();
    const permitB = await attemptB.authorizeToolsList();
    await expect(attemptA.consumeOperationPermit(permitB)).rejects.toMatchObject({ code: "operation_denied" });
    await expect(attemptB.consumeOperationPermit(permitB)).resolves.toBe(permitB);
    discoveryA.discoveryCurrent.rotationGenerationCurrent = false;
    await expect(attemptA.consumeOperationPermit(permitA)).rejects.toMatchObject({
      code: "connection_generation_revoked",
    });
    discoveryA.discoveryCurrent.rotationGenerationCurrent = true;
    await expect(attemptA.consumeOperationPermit(permitA)).rejects.toMatchObject({
      code: "connection_generation_revoked",
    });
    await expect(attemptA.authorizeInitialize()).rejects.toMatchObject({ code: "connection_generation_revoked" });
    attemptA.dispose();
    attemptB.dispose();

    const revalidationA = buildFixture("revalidation-owner-a");
    const revalidationB = buildFixture("revalidation-owner-b");
    const [finalA, finalB] = await Promise.all([
      service.resolveForToolCall(revalidationA.toolCallInput),
      service.resolveForToolCall(revalidationB.toolCallInput),
    ]);
    const revalidationPermitA = await finalA.authorizeToolsListRevalidation();
    const revalidationPermitB = await finalB.authorizeToolsListRevalidation();
    await expect(finalA.consumeToolsListRevalidationPermit(revalidationPermitB)).rejects.toMatchObject({
      code: "operation_denied",
    });
    await expect(finalB.consumeToolsListRevalidationPermit(revalidationPermitB)).resolves.toBe(revalidationPermitB);
    revalidationA.toolCallCurrent.revoked = true;
    await expect(finalA.consumeToolsListRevalidationPermit(revalidationPermitA)).rejects.toMatchObject({
      code: "connection_generation_revoked",
    });
    revalidationA.toolCallCurrent.revoked = false;
    await expect(finalA.consumeToolsListRevalidationPermit(revalidationPermitA)).rejects.toMatchObject({
      code: "connection_generation_revoked",
    });
    await expect(finalA.authorizeToolsListRevalidation()).rejects.toMatchObject({
      code: "connection_generation_revoked",
    });
    finalA.dispose();
    finalB.dispose();

    const expired = buildFixture("discovery-expired");
    const expiredAttempt = await service.resolveForProfileDiscovery(expired.discoveryInput);
    const expiredPermit = await expiredAttempt.authorizeInitialize();
    now = Date.parse("2026-07-14T12:04:00.000Z");
    await expect(expiredAttempt.consumeOperationPermit(expiredPermit)).rejects.toMatchObject({
      code: "resolved_connection_expired",
    });
    now = START;
    await expect(expiredAttempt.consumeOperationPermit(expiredPermit)).rejects.toMatchObject({
      code: "resolved_connection_expired",
    });
    expiredAttempt.dispose();

    const disposed = buildFixture("revalidation-disposed");
    const disposedAttempt = await service.resolveForToolCall(disposed.toolCallInput);
    const disposedPermit = await disposedAttempt.authorizeToolsListRevalidation();
    disposedAttempt.dispose();
    await expect(disposedAttempt.consumeToolsListRevalidationPermit(disposedPermit)).rejects.toMatchObject({
      code: "connection_generation_revoked",
    });
  });

  it("actively aborts an outstanding permit when its connection expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const service = new McpRequesterResolutionService(registryWith(), { now: Date.now });
    const fixture = buildFixture("expiry-timer");
    const attempt = await service.resolveForProfileDiscovery(fixture.discoveryInput);
    const capturedConnection = attempt.connection;
    const permit = await attempt.authorizeToolsList();

    await vi.advanceTimersByTimeAsync(4 * 60_000);

    expect(attempt.signal.aborted).toBe(true);
    expect(attempt.isDisposed()).toBe(true);
    expect(() => attempt.connection).toThrowError(expect.objectContaining({ code: "resolved_connection_expired" }));
    expect(() => capturedConnection.url).toThrowError(
      expect.objectContaining({ code: "connection_generation_revoked" }),
    );
    await expect(attempt.consumeOperationPermit(permit)).rejects.toMatchObject({
      code: "resolved_connection_expired",
    });
    vi.setSystemTime(START);
    const replay = await service.resolveForProfileDiscovery(fixture.discoveryInput);
    replay.dispose();
  });

  it("destroys the secret lease and releases the authority claim on revocation abort", async () => {
    const revocation = new AbortController();
    const service = new McpRequesterResolutionService(registryWith(), { now: () => START });
    const fixture = buildFixture("revocation-cleanup", revocation.signal);
    const attempt = await service.resolveForProfileDiscovery(fixture.discoveryInput);
    const capturedConnection = attempt.connection;
    await attempt.authorizeInitialize();

    revocation.abort();

    expect(attempt.signal.aborted).toBe(true);
    expect(attempt.isDisposed()).toBe(true);
    expect(() => attempt.connection).toThrowError(expect.objectContaining({ code: "connection_generation_revoked" }));
    expect(() => capturedConnection.headers).toThrowError(
      expect.objectContaining({ code: "connection_generation_revoked" }),
    );
    const replay = await service.resolveForProfileDiscovery({
      ...fixture.discoveryInput,
      revocationSignal: undefined,
    });
    replay.dispose();
  });

  it("fails closed across actor, workspace, server, binding, and generation drift", async () => {
    const resolver = vi.fn<RawToolCallResolver>(({ requester }) => resolvedFor("tool_call", requester.actorId));
    const service = new McpRequesterResolutionService(registryWith(undefined, resolver), { now: () => START });

    const actor = buildFixture();
    actor.toolCallCurrent.actorId = "operator-b";
    await expect(service.resolveForToolCall(actor.toolCallInput)).rejects.toMatchObject({
      code: "requester_scope_mismatch",
    });

    const workspace = buildFixture();
    workspace.toolCallCurrent.workspaceId = "workspace-2";
    await expect(service.resolveForToolCall(workspace.toolCallInput)).rejects.toMatchObject({
      code: "requester_scope_mismatch",
    });

    const serverDrift = buildFixture();
    serverDrift.toolCallCurrent.serverConfigRevision += 1;
    await expect(service.resolveForToolCall(serverDrift.toolCallInput)).rejects.toMatchObject({
      code: "resolver_binding_drift",
    });

    const generation = buildFixture();
    generation.toolCallCurrent.globalNetworkPolicyGeneration += 1;
    await expect(service.resolveForToolCall(generation.toolCallInput)).rejects.toMatchObject({
      code: "resolver_binding_drift",
    });

    const binding = buildFixture();
    const forged = { ...binding.binding, callableCatalogSha256: "f".repeat(64) };
    forged.bindingSha256 = digest({ ...forged, bindingSha256: undefined });
    await expect(service.resolveForToolCall({ ...binding.toolCallInput, binding: forged })).rejects.toMatchObject({
      code: "capability_profile_drift",
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it("requires the exact branded selected-schema revalidation and rejects replay", async () => {
    const service = new McpRequesterResolutionService(registryWith(), { now: () => START });
    const fixture = buildFixture();
    const attempt = await service.resolveForToolCall(fixture.toolCallInput);
    const changed = catalog("number");
    const revalidation = await attempt.authorizeToolsListRevalidation();
    await attempt.consumeToolsListRevalidationPermit(revalidation);

    await expect(
      attempt.acceptFreshToolsListRevalidation({
        revalidationAttemptId: fixture.toolCallInput.requester.revalidationAttemptId,
        revalidationAttemptGeneration: fixture.toolCallInput.requester.revalidationAttemptGeneration,
        catalog: changed,
      }),
    ).rejects.toMatchObject({ code: "schema_revalidation_drift" });
    expect(attempt.isDisposed()).toBe(true);
    await expect(
      attempt.acceptFreshToolsListRevalidation({
        revalidationAttemptId: fixture.toolCallInput.requester.revalidationAttemptId,
        revalidationAttemptGeneration: fixture.toolCallInput.requester.revalidationAttemptGeneration,
        catalog: fixture.catalog,
      }),
    ).rejects.toMatchObject({ code: "schema_revalidation_required" });
    expect(() => attempt.connection.url).toThrowError(
      expect.objectContaining({ code: "connection_generation_revoked" }),
    );

    const exactFixture = buildFixture("exact-revalidation");
    const exactAttempt = await service.resolveForToolCall(exactFixture.toolCallInput);
    const exactPermit = await exactAttempt.authorizeToolsListRevalidation();
    await exactAttempt.consumeToolsListRevalidationPermit(exactPermit);
    const exact = {
      revalidationAttemptId: exactFixture.toolCallInput.requester.revalidationAttemptId,
      revalidationAttemptGeneration: exactFixture.toolCallInput.requester.revalidationAttemptGeneration,
      catalog: exactFixture.catalog,
    };
    await exactAttempt.acceptFreshToolsListRevalidation(exact);
    await expect(exactAttempt.acceptFreshToolsListRevalidation(exact)).rejects.toMatchObject({
      code: "schema_revalidation_drift",
    });
    await expect(exactAttempt.authorizeToolsCall()).resolves.toBeDefined();
    exactAttempt.dispose();
  });

  it("rechecks current state after revalidation and at tools/call TOCTOU boundary", async () => {
    const service = new McpRequesterResolutionService(registryWith(), { now: () => START });
    const fixture = buildFixture();
    const attempt = await service.resolveForToolCall(fixture.toolCallInput);
    const revalidation = await attempt.authorizeToolsListRevalidation();
    await attempt.consumeToolsListRevalidationPermit(revalidation);
    await attempt.acceptFreshToolsListRevalidation({
      revalidationAttemptId: fixture.toolCallInput.requester.revalidationAttemptId,
      revalidationAttemptGeneration: fixture.toolCallInput.requester.revalidationAttemptGeneration,
      catalog: fixture.catalog,
    });
    fixture.toolCallCurrent.finalEffectAttemptGeneration += 1;
    await expect(attempt.authorizeToolsCall()).rejects.toMatchObject({ code: "resolver_binding_drift" });
    expect(vi.mocked(fixture.toolCallInput.readCurrentState).mock.calls.length).toBeGreaterThan(7);
    attempt.dispose();
  });

  it("isolates requester and stage connections, guards, and attempts", async () => {
    const resolver = vi.fn<RawToolCallResolver>(({ requester }) => resolvedFor("tool_call", requester.actorId));
    const service = new McpRequesterResolutionService(registryWith(undefined, resolver), { now: () => START });
    const a = buildFixture("operator-a");
    const b = buildFixture("operator-b");
    const [attemptA, attemptB] = await Promise.all([
      service.resolveForToolCall(a.toolCallInput),
      service.resolveForToolCall(b.toolCallInput),
    ]);
    expect(attemptA).not.toBe(attemptB);
    expect(attemptA.connection).not.toBe(attemptB.connection);
    const scrubbedByA = attemptA.scrubText("secret-operator-a-tool_call secret-operator-b-tool_call");
    const scrubbedByB = attemptB.scrubText("secret-operator-a-tool_call secret-operator-b-tool_call");
    expect(scrubbedByA).not.toContain("secret-operator-a");
    expect(scrubbedByA).toContain("secret-operator-b");
    expect(scrubbedByB).toContain("secret-operator-a");
    expect(scrubbedByB).not.toContain("secret-operator-b");
    attemptA.dispose();
    await expect(attemptB.assertCurrent()).resolves.toBeUndefined();
    attemptB.dispose();
  });

  it("prevents a resolver candidate from being reused across discovery and final stages", async () => {
    const shared = createMcpEphemeralResolvedConnectionCandidate(resolvedFor("profile_discovery", "operator-a"));
    const registry = new McpRequesterResolverRegistry({
      profileDiscovery: [
        {
          resolverId: "gateway.tenant",
          resolverVersion: "1.2.3",
          configGeneration: 4,
          resolveForProfileDiscovery: async () => shared,
        },
      ],
      toolCall: [
        {
          resolverId: "gateway.tenant",
          resolverVersion: "1.2.3",
          configGeneration: 4,
          resolveForToolCall: async () => shared,
        },
      ],
    });
    const service = new McpRequesterResolutionService(registry, { now: () => START });
    const fixture = buildFixture();
    const discovery = await service.resolveForProfileDiscovery(fixture.discoveryInput);
    discovery.dispose();
    await expect(service.resolveForToolCall(fixture.toolCallInput)).rejects.toMatchObject({
      code: "resolved_connection_invalid",
    });
  });

  it("enforces the asynchronous deadline and discards an abort-ignoring late result", async () => {
    vi.useFakeTimers();
    let complete: ((value: McpEphemeralResolvedConnectionInput) => void) | undefined;
    let resolverSignal: AbortSignal | undefined;
    const resolver: RawDiscoveryResolver = ({ signal }) =>
      new Promise((resolve) => {
        resolverSignal = signal;
        complete = resolve;
      });
    const service = new McpRequesterResolutionService(registryWith(resolver), { now: () => START });
    const fixture = buildFixture();
    const pending = service.resolveForProfileDiscovery(fixture.discoveryInput);
    const rejection = expect(pending).rejects.toMatchObject({ code: "resolver_timeout" });
    await vi.advanceTimersByTimeAsync(2_000);
    await rejection;
    expect(resolverSignal?.aborted).toBe(true);
    complete?.(resolvedFor("profile_discovery", "operator-a"));
    await Promise.resolve();
  });

  it("treats resolver exceptions as opaque without reading hostile properties", async () => {
    let reads = 0;
    const hostile = Object.create(null);
    for (const key of ["message", "stack", "cause", "toString"]) {
      Object.defineProperty(hostile, key, {
        get() {
          reads += 1;
          return "https://secret.example.test/?token=canary";
        },
      });
    }
    const service = new McpRequesterResolutionService(
      registryWith((() => {
        throw hostile;
      }) as RawDiscoveryResolver),
      { now: () => START },
    );
    const error = await service
      .resolveForProfileDiscovery(buildFixture().discoveryInput)
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "resolver_failed" });
    expect(reads).toBe(0);
  });

  it("snapshots server and binding before the asynchronous final resolver seam", async () => {
    let complete: ((value: McpEphemeralResolvedConnectionInput) => void) | undefined;
    let seenBinding: McpRequesterResolutionBinding | undefined;
    const resolver: RawToolCallResolver = ({ binding }) =>
      new Promise((resolve) => {
        seenBinding = binding;
        complete = resolve;
      });
    const fixture = buildFixture();
    const service = new McpRequesterResolutionService(registryWith(undefined, resolver), { now: () => START });
    const pending = service.resolveForToolCall(fixture.toolCallInput);
    await vi.waitFor(() => expect(seenBinding).toBeDefined());
    fixture.toolCallInput.server.requesterResolution.transportPolicy.allowedHosts.push("evil.example.test");
    fixture.toolCallInput.binding.serverId = "evil-server";
    complete?.({ ...resolvedFor("tool_call", "operator-a"), url: "https://evil.example.test/path" });
    await expect(pending).rejects.toMatchObject({ code: "resolved_destination_denied" });
    expect(seenBinding?.serverId).toBe("tenant-mcp");
    expect(Object.isFrozen(seenBinding)).toBe(true);
  });

  it("fails closed on revocation, expiry, and hostile current-state values", async () => {
    let now = START;
    const service = new McpRequesterResolutionService(registryWith(), { now: () => now });
    const revoked = buildFixture("revoked-state-actor");
    const revokedAttempt = await service.resolveForProfileDiscovery(revoked.discoveryInput);
    revoked.discoveryCurrent.revoked = true;
    await expect(revokedAttempt.assertCurrent()).rejects.toMatchObject({ code: "connection_generation_revoked" });
    revokedAttempt.dispose();

    const rotated = buildFixture("rotated-state-actor");
    const rotatedAttempt = await service.resolveForToolCall(rotated.toolCallInput);
    rotated.toolCallCurrent.rotationGenerationCurrent = false;
    await expect(rotatedAttempt.assertCurrent()).rejects.toMatchObject({ code: "connection_generation_revoked" });
    expect(rotated.toolCallInput.readCurrentState).toHaveBeenLastCalledWith({
      connectionGeneration: 12,
      rotationGeneration: 2,
    });
    rotatedAttempt.dispose();

    const expired = buildFixture("expired-state-actor");
    const expiredAttempt = await service.resolveForToolCall(expired.toolCallInput);
    now = Date.parse("2026-07-14T12:04:00.000Z");
    await expect(expiredAttempt.assertCurrent()).rejects.toMatchObject({ code: "resolved_connection_expired" });
    expiredAttempt.dispose();

    const hostile = buildFixture("hostile-state-actor");
    let reads = 0;
    const value = { ...hostile.toolCallCurrent };
    Object.defineProperty(value, "resolverId", {
      enumerable: true,
      get() {
        reads += 1;
        return "gateway.attacker";
      },
    });
    hostile.toolCallInput.readCurrentState = vi.fn(async () => value);
    await expect(service.resolveForToolCall(hostile.toolCallInput)).rejects.toMatchObject({
      code: "resolver_binding_drift",
    });
    expect(reads).toBe(0);
  });

  it("accepts only genuine abort signals, handles pre-abort, and removes listeners on dispose", async () => {
    const resolver = vi.fn<RawDiscoveryResolver>(({ requester }) =>
      resolvedFor("profile_discovery", requester.actorId),
    );
    const service = new McpRequesterResolutionService(registryWith(resolver), { now: () => START });
    const fixture = buildFixture();
    let reads = 0;
    const forged = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(forged, "aborted", {
      enumerable: true,
      get() {
        reads += 1;
        return false;
      },
    });
    await expect(
      service.resolveForProfileDiscovery({ ...fixture.discoveryInput, signal: forged as never }),
    ).rejects.toMatchObject({ code: "requester_context_ambiguous" });
    expect(reads).toBe(0);

    const controller = new AbortController();
    await expect(
      service.resolveForProfileDiscovery({ ...fixture.discoveryInput, signal: new Proxy(controller.signal, {}) }),
    ).rejects.toMatchObject({ code: "requester_context_ambiguous" });

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      service.resolveForProfileDiscovery({ ...fixture.discoveryInput, signal: preAborted.signal }),
    ).rejects.toMatchObject({ code: "resolver_cancelled" });
    expect(resolver).not.toHaveBeenCalled();

    const live = new AbortController();
    const add = vi.spyOn(live.signal, "addEventListener");
    const remove = vi.spyOn(live.signal, "removeEventListener");
    const attempt = await service.resolveForProfileDiscovery({
      ...fixture.discoveryInput,
      revocationSignal: live.signal,
    });
    expect(add).toHaveBeenCalledTimes(1);
    attempt.dispose();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown/getter/proxy service inputs before any resolver call", async () => {
    const resolver = vi.fn<RawDiscoveryResolver>(({ requester }) =>
      resolvedFor("profile_discovery", requester.actorId),
    );
    const service = new McpRequesterResolutionService(registryWith(resolver), { now: () => START });
    const fixture = buildFixture();
    await expect(
      service.resolveForProfileDiscovery({ ...fixture.discoveryInput, method: "tools/call" } as never),
    ).rejects.toThrow();
    let reads = 0;
    const accessor = { ...fixture.discoveryInput };
    Object.defineProperty(accessor, "server", {
      enumerable: true,
      get() {
        reads += 1;
        return fixture.discoveryInput.server;
      },
    });
    await expect(service.resolveForProfileDiscovery(accessor)).rejects.toThrow();
    expect(reads).toBe(0);
    await expect(service.resolveForProfileDiscovery(new Proxy(fixture.discoveryInput, {}))).rejects.toThrow();
    expect(resolver).not.toHaveBeenCalled();
  });
});
