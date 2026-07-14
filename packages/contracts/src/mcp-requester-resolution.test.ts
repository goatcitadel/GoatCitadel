import { describe, expect, it } from "vitest";
import {
  MCP_REQUESTER_RESOLUTION_BINDING_VERSION,
  assertMcpRequesterResolutionBinding,
  assertMcpServerConnectionConfiguration,
  mcpRequesterResolutionBindingHashMaterial,
  mcpRequesterScopeHashMaterial,
  resolveMcpServerConnectionMode,
  type McpRequesterResolutionBinding,
  type McpServerConnectionConfiguration,
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

    const legacyRecordShape = { ...legacy, label: "Legacy server", status: "connected" };
    expect(() => assertMcpServerConnectionConfiguration(legacyRecordShape)).not.toThrow();
  });

  it("accepts only canonical non-secret requester configuration", () => {
    expect(() => assertMcpServerConnectionConfiguration(requesterConfiguration())).not.toThrow();
  });

  it.each([
    ["stdio transport", { transport: "stdio" }],
    ["static URL", { url: "https://secret.example.test/path?token=canary" }],
    ["static command", { command: "node" }],
    ["static args", { args: [] }],
    ["static auth", { authType: "token" }],
    ["OAuth config", { oauth: { tokenUrl: "https://auth.example.test/token" } }],
    ["auth state", { authState: { authType: "none", readiness: "not_required" } }],
    ["environment pass-through", { policy: { allowedEnvKeys: ["MCP_TOKEN"] } }],
    ["missing configuration revision", { configurationRevision: undefined }],
  ])("rejects requester-scoped %s", (_label, patch) => {
    expect(() =>
      assertMcpServerConnectionConfiguration({
        ...requesterConfiguration(),
        ...patch,
      } as McpServerConnectionConfiguration),
    ).toThrow();
  });

  it("rejects hidden resolver fields, non-canonical arrays, and forbidden headers", () => {
    const hiddenSecret = requesterConfiguration();
    Object.assign(hiddenSecret.requesterResolution as object, { token: "never-store-this" });
    expect(() => assertMcpServerConnectionConfiguration(hiddenSecret)).toThrow(/unsupported fields/);

    const unsortedHosts = requesterConfiguration();
    unsortedHosts.requesterResolution!.transportPolicy.allowedHosts = ["z.example.test", "a.example.test"];
    expect(() => assertMcpServerConnectionConfiguration(unsortedHosts)).toThrow(/unique and sorted/);

    const forbiddenHeader = requesterConfiguration();
    forbiddenHeader.requesterResolution!.transportPolicy.allowedHeaderNames = ["host"];
    expect(() => assertMcpServerConnectionConfiguration(forbiddenHeader)).toThrow(/forbidden name/);

    const wildcardHost = requesterConfiguration();
    wildcardHost.requesterResolution!.transportPolicy.allowedHosts = ["*.example.test"];
    expect(() => assertMcpServerConnectionConfiguration(wildcardHost)).toThrow(/canonical hosts/);

    const hiddenTopLevel = { ...requesterConfiguration(), endpoint: "https://secret.example.test/path" };
    expect(() => assertMcpServerConnectionConfiguration(hiddenTopLevel)).toThrow(/unsupported fields/);

    const hiddenPolicy = requesterConfiguration();
    Object.assign(hiddenPolicy.policy ?? (hiddenPolicy.policy = {}), { credential: "never-store-this" });
    expect(() => assertMcpServerConnectionConfiguration(hiddenPolicy)).toThrow(/unsupported fields/);

    const malformedEmptyEnvList = requesterConfiguration();
    malformedEmptyEnvList.policy = { allowedEnvKeys: "" } as never;
    expect(() => assertMcpServerConnectionConfiguration(malformedEmptyEnvList)).toThrow(/environment variables/);
  });

  it("accepts only an exact secret-free binding shape", () => {
    const binding = requesterBinding();
    expect(() => assertMcpRequesterResolutionBinding(binding)).not.toThrow();
    const material = mcpRequesterResolutionBindingHashMaterial(binding);
    expect(material).not.toHaveProperty("bindingSha256");
    expect(material).toMatchObject({ serverId: binding.serverId, toolName: binding.toolName });

    const endpointSmuggling = { ...binding, url: "https://secret.example.test" };
    expect(() => assertMcpRequesterResolutionBinding(endpointSmuggling)).toThrow(/unsupported fields/);

    const endpointAsIdentifier = { ...binding, serverId: "https://secret.example.test/path" };
    expect(() => assertMcpRequesterResolutionBinding(endpointAsIdentifier)).toThrow(/canonical identifier/);
  });

  it("defines one exact non-secret authenticated requester scope hash material", () => {
    expect(
      mcpRequesterScopeHashMaterial({
        profileId: "chat-capability-profile-turn-1",
        turnId: "turn-1",
        sessionId: "session-1",
        workspaceId: "workspace-1",
        authActorId: "operator-1",
        authActorSource: "token",
      }),
    ).toEqual({
      schemaVersion: "goatcitadel.mcp-requester-scope-hash-material.v1",
      profileId: "chat-capability-profile-turn-1",
      turnId: "turn-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      authActorId: "operator-1",
      authActorSource: "token",
    });

    const hidden = {
      profileId: "chat-capability-profile-turn-1",
      turnId: "turn-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      authActorId: "operator-1",
      authActorSource: "token" as const,
      endpoint: "https://secret.example.test",
    };
    expect(() => mcpRequesterScopeHashMaterial(hidden)).toThrow(/unsupported fields/);
  });
});
