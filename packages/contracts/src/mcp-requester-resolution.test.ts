import { describe, expect, it } from "vitest";
import {
  MCP_PROFILE_DISCOVERY_AUTHORITY_HASH_MATERIAL_VERSION,
  MCP_REQUESTER_DISCOVERY_CATALOG_HASH_MATERIAL_VERSION,
  MCP_REQUESTER_DISCOVERY_TOOL_HASH_MATERIAL_VERSION,
  MCP_REQUESTER_PROVIDER_ALIAS_HASH_MATERIAL_VERSION,
  MCP_REQUESTER_RESOLUTION_BINDING_VERSION,
  MCP_TOOL_CALL_AUTHORITY_HASH_MATERIAL_VERSION,
  assertMcpRequesterResolutionBinding,
  assertMcpServerConnectionConfiguration,
  mcpProfileDiscoveryAuthorityHashMaterial,
  mcpRequesterDiscoveryCatalogHashMaterial,
  mcpRequesterDiscoveryToolHashMaterial,
  mcpRequesterProviderAliasHashMaterial,
  mcpRequesterResolutionBindingHashMaterial,
  mcpRequesterScopeHashMaterial,
  mcpToolCallAuthorityHashMaterial,
  resolveMcpServerConnectionMode,
  type McpProfileDiscoveryAuthorityHashInput,
  type McpRequesterResolutionBinding,
  type McpServerConnectionConfiguration,
  type McpToolCallAuthorityHashInput,
} from "./mcp.js";

function requesterConfiguration(): McpServerConnectionConfiguration {
  return {
    transport: "http",
    connectionMode: "requester_scoped",
    configurationRevision: 7,
    authType: "none",
    requesterResolution: {
      resolverId: "gateway.tenant-mcp",
      resolverVersion: "1.2.3",
      configGeneration: 4,
      transportPolicy: {
        allowedSchemes: ["https"],
        allowedHosts: ["mcp.example.test"],
        allowedPorts: [443],
        allowedHeaderNames: ["authorization", "x-tenant"],
      },
    },
  };
}

function requesterBinding(): McpRequesterResolutionBinding {
  return {
    schemaVersion: MCP_REQUESTER_RESOLUTION_BINDING_VERSION,
    mode: "requester_scoped",
    serverId: "tenant-mcp",
    toolName: "mcp.tenant-mcp.search",
    resolverId: "gateway.tenant-mcp",
    resolverVersion: "1.2.3",
    resolverConfigGeneration: 4,
    requesterScopeSha256: "a".repeat(64),
    serverConfigRevision: 7,
    serverConfigSha256: "b".repeat(64),
    transportPolicySha256: "c".repeat(64),
    callableCatalogSnapshotId: "chat-cap-snap-a-b",
    callableCatalogSha256: "d".repeat(64),
    bindingSha256: "e".repeat(64),
  };
}

function discoveryAuthorityInput(): McpProfileDiscoveryAuthorityHashInput {
  return {
    actorId: "operator-1",
    actorSource: "token",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    turnId: "turn-1",
    futureProfileId: "future-profile-1",
    baseCallableCatalogSha256: "a".repeat(64),
    serverId: "tenant-mcp",
    serverConfigRevision: 7,
    serverConfigSha256: "b".repeat(64),
    resolverId: "gateway.tenant-mcp",
    resolverVersion: "1.2.3",
    resolverConfigGeneration: 4,
    transportPolicySha256: "c".repeat(64),
    globalNetworkPolicyGeneration: 5,
    authConnectionGeneration: 6,
    turnGeneration: 7,
    preparationGeneration: 8,
    meshPublisherGeneration: 9,
    meshActivationGeneration: 10,
    discoveryAttemptId: "discovery-attempt-1",
    discoveryAttemptGeneration: 11,
  };
}

function toolCallAuthorityInput(): McpToolCallAuthorityHashInput {
  return {
    actorId: "operator-1",
    actorSource: "token",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    turnId: "turn-1",
    finalProfileId: "profile-1",
    finalProfileSha256: "d".repeat(64),
    baseCallableCatalogSha256: "a".repeat(64),
    finalCallableCatalogSha256: "e".repeat(64),
    serverId: "tenant-mcp",
    serverConfigRevision: 7,
    serverConfigSha256: "b".repeat(64),
    resolverId: "gateway.tenant-mcp",
    resolverVersion: "1.2.3",
    resolverConfigGeneration: 4,
    transportPolicySha256: "c".repeat(64),
    globalNetworkPolicyGeneration: 5,
    authConnectionGeneration: 6,
    turnGeneration: 7,
    preparationGeneration: 8,
    meshPublisherGeneration: 9,
    meshActivationGeneration: 10,
    profileDiscoveryAttemptId: "discovery-attempt-1",
    profileDiscoveryAttemptGeneration: 11,
    revalidationAttemptId: "revalidation-attempt-1",
    revalidationAttemptGeneration: 12,
    finalEffectAttemptId: "effect-attempt-1",
    finalEffectAttemptGeneration: 13,
    rawRemoteToolName: "search",
    canonicalToolName: "mcp.tenant-mcp.search",
    providerAlias: `mcp__${"f".repeat(64)}`,
    normalizedDiscoveryCatalogSha256: "1".repeat(64),
    normalizedToolDefinitionSha256: "2".repeat(64),
    bindingSha256: "3".repeat(64),
  };
}

describe("requester-scoped MCP contracts", () => {
  it("preserves missing-mode legacy static compatibility", () => {
    const legacy: McpServerConnectionConfiguration = {
      transport: "stdio",
      command: "node",
      args: ["server.mjs"],
      authType: "none",
    };
    expect(resolveMcpServerConnectionMode(legacy)).toBe("static");
    expect(() => assertMcpServerConnectionConfiguration(legacy)).not.toThrow();
    expect(() =>
      assertMcpServerConnectionConfiguration({
        ...legacy,
        label: "Legacy",
        status: "connected",
      } as McpServerConnectionConfiguration),
    ).not.toThrow();
  });

  it("accepts only canonical non-secret requester configuration", () => {
    expect(() => assertMcpServerConnectionConfiguration(requesterConfiguration())).not.toThrow();
    for (const patch of [
      { transport: "stdio" },
      { url: "https://secret.example.test/path?token=canary" },
      { command: "node" },
      { args: [] },
      { authType: "token" },
      { oauth: { tokenUrl: "https://auth.example.test/token" } },
      { authState: { authType: "none", readiness: "not_required" } },
      { policy: { allowedEnvKeys: ["MCP_TOKEN"] } },
      { configurationRevision: undefined },
    ]) {
      expect(() =>
        assertMcpServerConnectionConfiguration({
          ...requesterConfiguration(),
          ...patch,
        } as McpServerConnectionConfiguration),
      ).toThrow();
    }
  });

  it("rejects hidden resolver fields, noncanonical arrays, and forbidden headers", () => {
    const hiddenSecret = requesterConfiguration();
    Object.assign(hiddenSecret.requesterResolution as object, { token: "never-store-this" });
    expect(() => assertMcpServerConnectionConfiguration(hiddenSecret)).toThrow(/unsupported fields/);
    const unsortedHosts = requesterConfiguration();
    unsortedHosts.requesterResolution!.transportPolicy.allowedHosts = ["z.example.test", "a.example.test"];
    expect(() => assertMcpServerConnectionConfiguration(unsortedHosts)).toThrow(/unique and sorted/);
    const forbiddenHeader = requesterConfiguration();
    forbiddenHeader.requesterResolution!.transportPolicy.allowedHeaderNames = ["host"];
    expect(() => assertMcpServerConnectionConfiguration(forbiddenHeader)).toThrow(/forbidden name/);
  });

  it("accepts only an exact secret-free binding shape", () => {
    const binding = requesterBinding();
    expect(() => assertMcpRequesterResolutionBinding(binding)).not.toThrow();
    expect(mcpRequesterResolutionBindingHashMaterial(binding)).not.toHaveProperty("bindingSha256");
    expect(() => assertMcpRequesterResolutionBinding({ ...binding, url: "https://secret.example.test" })).toThrow(
      /unsupported fields/,
    );
  });

  it("keeps legacy scope material exact and authenticated", () => {
    expect(
      mcpRequesterScopeHashMaterial({
        profileId: "profile-1",
        turnId: "turn-1",
        sessionId: "session-1",
        workspaceId: "workspace-1",
        authActorId: "operator-1",
        authActorSource: "token",
      }),
    ).toMatchObject({ schemaVersion: "goatcitadel.mcp-requester-scope-hash-material.v1" });
  });

  it("domain-separates discovery and final authority materials", () => {
    const discovery = mcpProfileDiscoveryAuthorityHashMaterial(discoveryAuthorityInput());
    const final = mcpToolCallAuthorityHashMaterial(toolCallAuthorityInput());
    expect(discovery).toMatchObject({
      schemaVersion: MCP_PROFILE_DISCOVERY_AUTHORITY_HASH_MATERIAL_VERSION,
      stage: "profile_discovery",
    });
    expect(final).toMatchObject({
      schemaVersion: MCP_TOOL_CALL_AUTHORITY_HASH_MATERIAL_VERSION,
      stage: "tool_call",
    });
    expect(discovery.schemaVersion).not.toBe(final.schemaVersion);
  });

  it("rejects partial mesh generations and unknown authority fields", () => {
    const partial = { ...discoveryAuthorityInput(), meshActivationGeneration: undefined };
    delete partial.meshActivationGeneration;
    expect(() => mcpProfileDiscoveryAuthorityHashMaterial(partial)).toThrow(/present together/);
    expect(() =>
      mcpProfileDiscoveryAuthorityHashMaterial({ ...discoveryAuthorityInput(), endpoint: "secret" } as never),
    ).toThrow(/unsupported fields/);
    expect(() =>
      mcpToolCallAuthorityHashMaterial({ ...toolCallAuthorityInput(), providerAlias: "mcp__search" }),
    ).toThrow(/opaque full-digest/);
  });

  it("domain-separates normalized tool, catalog, and provider alias materials", () => {
    const tool = {
      serverId: "tenant-mcp",
      rawRemoteToolName: "search",
      canonicalToolName: "mcp.tenant-mcp.search",
      description: "Search safely",
      inputSchema: { type: "object" },
    };
    const toolMaterial = mcpRequesterDiscoveryToolHashMaterial(tool);
    expect(toolMaterial.schemaVersion).toBe(MCP_REQUESTER_DISCOVERY_TOOL_HASH_MATERIAL_VERSION);
    const { serverId: _serverId, ...toolWithoutServer } = tool;
    const normalizedTool = { ...toolWithoutServer, toolDefinitionSha256: "1".repeat(64) };
    const catalog = mcpRequesterDiscoveryCatalogHashMaterial({
      serverId: "tenant-mcp",
      secretScan: {
        scannerId: "gateway.secret-scan",
        scannerVersion: "1.0.0",
        scannerGeneration: 1,
        scannedSha256: "2".repeat(64),
        evidenceSha256: "3".repeat(64),
        verdict: "clean",
      },
      tools: [normalizedTool],
    });
    expect(catalog.schemaVersion).toBe(MCP_REQUESTER_DISCOVERY_CATALOG_HASH_MATERIAL_VERSION);
    expect(
      mcpRequesterProviderAliasHashMaterial({
        serverId: "tenant-mcp",
        rawRemoteToolName: "search",
        canonicalToolName: "mcp.tenant-mcp.search",
        normalizedToolDefinitionSha256: "1".repeat(64),
        bindingSha256: "4".repeat(64),
      }).schemaVersion,
    ).toBe(MCP_REQUESTER_PROVIDER_ALIAS_HASH_MATERIAL_VERSION);
  });
});
