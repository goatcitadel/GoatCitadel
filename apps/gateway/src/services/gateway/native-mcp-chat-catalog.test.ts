import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalJsonString,
  MCP_REQUESTER_RESOLUTION_BINDING_VERSION,
  type McpRequesterResolutionBindingMaterial,
} from "@goatcitadel/contracts";
import { normalizeMcpRequesterDiscoveryOutput } from "../mcp-requester-resolution.js";
import { createMcpRequesterDiscoverySecretScanner } from "../mcp-resolution-secret-guard.js";
import { createStaticMcpCatalogSnapshot } from "../mcp-static-catalog.js";
import {
  assertNativeMcpChatToolSchema,
  bindNativeMcpChatToolSchema,
  bindNativeStaticMcpChatToolSchema,
  collectNativeMcpChatCatalogCandidates,
  NATIVE_MCP_CHAT_CATALOG_LIMIT,
  resolveNativeMcpChatToolSchemas,
} from "./native-mcp-chat-catalog.js";

const digest = (value: unknown) => createHash("sha256").update(canonicalJsonString(value)).digest("hex");
const inputSchema = {
  type: "object",
  properties: { filter: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  required: ["filter"],
  additionalProperties: false,
};
function catalog(serverId = "tenant", names = ["search"], description = "Search records") {
  return normalizeMcpRequesterDiscoveryOutput(
    serverId,
    {
      tools: names.map((name) => ({
        rawRemoteToolName: name,
        canonicalToolName: `mcp.${serverId}.${name}`,
        description,
        inputSchema,
      })),
    },
    createMcpRequesterDiscoverySecretScanner(),
  );
}
function binding(overrides: Partial<McpRequesterResolutionBindingMaterial> = {}) {
  const material: McpRequesterResolutionBindingMaterial = {
    schemaVersion: MCP_REQUESTER_RESOLUTION_BINDING_VERSION,
    mode: "requester_scoped",
    serverId: "tenant",
    toolName: "mcp.tenant.search",
    resolverId: "gateway.tenant",
    resolverVersion: "1.0.0",
    resolverConfigGeneration: 1,
    requesterScopeSha256: "a".repeat(64),
    serverConfigRevision: 1,
    serverConfigSha256: "b".repeat(64),
    transportPolicySha256: "c".repeat(64),
    callableCatalogSnapshotId: "snapshot",
    callableCatalogSha256: "d".repeat(64),
    ...overrides,
  };
  return Object.freeze({ ...material, bindingSha256: digest(material) });
}

describe("native MCP Chat catalog admission", () => {
  it("excludes dotted-name collisions across static and requester catalogs", () => {
    const snapshot = createStaticMcpCatalogSnapshot({
      serverId: "a", label: "Fixture", transport: "http", connectionMode: "static", authType: "none",
      enabled: true, status: "connected", category: "automation", trustTier: "restricted", costTier: "unknown",
      configurationBindingId: "c2827339-4843-48ae-a410-cdf3f160c1c5", createdAt: "fixture", updatedAt: "fixture",
      policy: { requireFirstToolApproval: true, redactionMode: "off", allowedToolPatterns: [], blockedToolPatterns: [] },
    }, catalog("a", ["b.search"]));
    expect(collectNativeMcpChatCatalogCandidates([catalog("a.b", ["search"])], [], [snapshot])).toEqual([]);
    expect(() => collectNativeMcpChatCatalogCandidates([], [], [{ ...snapshot }])).toThrow("not server-owned");
    const candidate = collectNativeMcpChatCatalogCandidates([], [], [snapshot])[0]!;
    expect(collectNativeMcpChatCatalogCandidates([], [candidate.entry], [snapshot])).toEqual([]);
    expect(() => bindNativeMcpChatToolSchema(candidate, binding())).toThrow("static configuration binding");
    const native = bindNativeStaticMcpChatToolSchema(candidate, {
      profileId: "profile", turnId: "turn", sessionId: "session", workspaceId: "workspace",
      authActorId: "actor", authActorSource: "token",
    }, { snapshotId: "snapshot", callableHash: "a".repeat(64) });
    expect(native.staticBinding).toMatchObject({ serverId: "a", nativeToolName: "b.search", toolName: "mcp.a.b.search" });
    expect(native.requesterBinding).toBeUndefined();
    expect(native.modelName).toMatch(/^mcp_s_[a-f0-9]{56}$/u);
    expect(() => assertNativeMcpChatToolSchema(native)).not.toThrow();
    expect(() => JSON.stringify(native)).toThrow("cannot be serialized");
    expect(() => bindNativeStaticMcpChatToolSchema({ ...candidate }, {
      profileId: "profile", turnId: "turn", sessionId: "session", workspaceId: "workspace",
      authActorId: "actor", authActorSource: "token",
    }, { snapshotId: "snapshot", callableHash: "a".repeat(64) })).toThrow("not server-owned");
  });

  it("retains exact schemas and bound aliases with a conservative effect classification", () => {
    const discovered = catalog();
    const candidate = collectNativeMcpChatCatalogCandidates([discovered], [])[0]!;
    const native = bindNativeMcpChatToolSchema(candidate, binding());
    expect(native.providerDefinition).toEqual({
      type: "function",
      function: { name: native.modelName, description: "Search records", parameters: inputSchema },
    });
    expect(candidate.entry).toMatchObject({
      callable: true,
      sourceRef: `mcp-tool-definition:${discovered.tools[0]!.toolDefinitionSha256}`,
      wrapperVisibility: { readOnly: false, deterministic: false, codeModeAllowed: false },
      effectPotential: { potential: "unknown", sourceKind: "mcp" },
    });
    expect(() => assertNativeMcpChatToolSchema(native)).not.toThrow();
    expect(() => JSON.stringify(native)).toThrow("cannot be serialized");
    expect(() => {
      (native.providerDefinition.function as Record<string, unknown>).name = "forged";
    }).toThrow();
    expect(bindNativeMcpChatToolSchema(candidate, binding({ serverConfigRevision: 2 })).modelName).not.toBe(
      native.modelName,
    );
    const changed = collectNativeMcpChatCatalogCandidates([catalog("tenant", ["search"], "Changed search")], [])[0]!;
    expect(bindNativeMcpChatToolSchema(changed, binding()).modelName).not.toBe(native.modelName);
  });

  it("rejects cloned catalogs, candidates and schemas and mismatched server bindings", () => {
    const discovered = catalog();
    expect(() => collectNativeMcpChatCatalogCandidates([structuredClone(discovered)], [])).toThrow();
    const candidate = collectNativeMcpChatCatalogCandidates([discovered], [])[0]!;
    expect(() => bindNativeMcpChatToolSchema({ ...candidate }, binding())).toThrow("not server-owned");
    expect(() => bindNativeMcpChatToolSchema(candidate, binding({ serverId: "different" }))).toThrow("does not match");
    const native = bindNativeMcpChatToolSchema(candidate, binding());
    expect(() => assertNativeMcpChatToolSchema({ ...native })).toThrow("not server-owned");
  });

  it("excludes registered names and ambiguous dotted names on both sides", () => {
    const collision = collectNativeMcpChatCatalogCandidates(
      [catalog("a.b", ["search"]), catalog("a", ["b.search"])],
      [],
    );
    expect(collision).toEqual([]);
    const first = collectNativeMcpChatCatalogCandidates([catalog()], [])[0]!;
    expect(collectNativeMcpChatCatalogCandidates([catalog()], [first.entry])).toEqual([]);
    expect(collectNativeMcpChatCatalogCandidates([catalog(), catalog()], [])).toEqual([]);
  });

  it("bounds the inventory while giving each server tools in deterministic order", () => {
    const names = Array.from({ length: 64 }, (_, index) => `tool-${index}`);
    const catalogs = Array.from({ length: 8 }, (_, index) => catalog(`server-${index}`, names));
    const selected = collectNativeMcpChatCatalogCandidates(catalogs, []);
    expect(selected).toHaveLength(NATIVE_MCP_CHAT_CATALOG_LIMIT);
    for (let index = 0; index < 8; index += 1)
      expect(selected.filter((candidate) => candidate.serverId === `server-${index}`)).toHaveLength(32);
    expect(
      collectNativeMcpChatCatalogCandidates([...catalogs].reverse(), []).map(({ entry }) => entry.capabilityId),
    ).toEqual(selected.map(({ entry }) => entry.capabilityId));
  });

  it("freezes multiple native tools with one final discovery call per server", async () => {
    const candidates = collectNativeMcpChatCatalogCandidates([catalog("tenant", ["search", "count"])], []);
    const hook = {
      profileId: "profile",
      turnId: "turn",
      sessionId: "session",
      workspaceId: "workspace",
      authActorId: "operator",
      authActorSource: "token" as const,
      requesterScopeSha256: "a".repeat(64),
      catalogSnapshotId: "snapshot",
      callableCatalogSha256: "d".repeat(64),
    };
    const resolve = vi.fn(async (input: { tools: readonly { canonicalToolName: string }[] }) =>
      input.tools.map((tool) => binding({ toolName: tool.canonicalToolName })),
    );
    const schemas = await resolveNativeMcpChatToolSchemas(candidates, hook, resolve);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]![0].tools).toEqual(
      candidates.map(({ tool }) => ({
        canonicalToolName: tool.canonicalToolName,
        expectedToolDefinitionSha256: tool.toolDefinitionSha256,
      })),
    );
    expect(schemas).toHaveLength(2);
    expect(await resolveNativeMcpChatToolSchemas(candidates, hook, async () => undefined)).toEqual([]);
    await expect(resolveNativeMcpChatToolSchemas(candidates, hook, async () => [binding()])).rejects.toThrow(
      "incomplete binding batch",
    );
    await expect(
      resolveNativeMcpChatToolSchemas(candidates.slice(1), hook, async () => [
        binding({ requesterScopeSha256: "f".repeat(64) }),
      ]),
    ).rejects.toThrow("different profile binding");
  });
});
