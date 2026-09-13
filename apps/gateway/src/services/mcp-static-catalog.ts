import { createHash } from "node:crypto";
import {
  assertMcpStaticToolBinding,
  canonicalJsonString,
  MCP_STATIC_TOOL_BINDING_VERSION,
  mcpStaticToolBindingHashMaterial,
  mcpStaticToolScopeHashMaterial,
  resolveMcpServerConnectionMode,
  type McpNormalizedRequesterDiscoveryCatalog,
  type McpNormalizedRequesterDiscoveryTool,
  type McpRequesterScopeHashInput,
  type McpServerRecord,
  type McpStaticToolBinding,
} from "@goatcitadel/contracts";
import { assertNormalizedMcpRequesterDiscoveryCatalog } from "./mcp-requester-resolution.js";

export interface StaticMcpCatalogSnapshot {
  readonly serverId: string;
  readonly transport: McpServerRecord["transport"];
  readonly configurationBindingId: string;
  readonly catalog: McpNormalizedRequesterDiscoveryCatalog;
}

const snapshots = new WeakSet<object>();
const digest = (value: unknown) => createHash("sha256").update(canonicalJsonString(value)).digest("hex");

/** Connection material never enters the catalog; only an opaque registry identity does. */
export function createStaticMcpCatalogSnapshot(
  server: McpServerRecord,
  catalog: McpNormalizedRequesterDiscoveryCatalog,
): StaticMcpCatalogSnapshot {
  assertNormalizedMcpRequesterDiscoveryCatalog(catalog);
  if (
    !server.configurationBindingId ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(server.configurationBindingId) ||
    resolveMcpServerConnectionMode(server) !== "static" ||
    !server.enabled ||
    server.status !== "connected" ||
    catalog.serverId !== server.serverId
  ) {
    throw new Error("Static MCP discovery requires its connected canonical configuration.");
  }
  const result = Object.freeze({
    serverId: server.serverId,
    transport: server.transport,
    configurationBindingId: server.configurationBindingId,
    catalog,
  });
  snapshots.add(result);
  return result;
}

export function assertStaticMcpCatalogSnapshot(value: StaticMcpCatalogSnapshot): void {
  if (!snapshots.has(value)) throw new Error("Static MCP catalog is not server-owned.");
}

export function staticMcpProviderDefinition(
  snapshot: StaticMcpCatalogSnapshot,
  tool: McpNormalizedRequesterDiscoveryTool,
) {
  assertStaticMcpCatalogSnapshot(snapshot);
  if (!snapshot.catalog.tools.includes(tool)) throw new Error("Static MCP definition is outside its catalog.");
  const name = `mcp_s_${digest({
    version: "goatcitadel.mcp-static-alias.v1",
    serverId: snapshot.serverId,
    configurationBindingId: snapshot.configurationBindingId,
    toolDefinitionSha256: tool.toolDefinitionSha256,
  }).slice(0, 56)}`;
  return Object.freeze({
    type: "function",
    function: Object.freeze({
      name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.inputSchema,
    }),
  });
}

export function bindStaticMcpCatalogTool(
  snapshot: StaticMcpCatalogSnapshot,
  tool: McpNormalizedRequesterDiscoveryTool,
  scope: McpRequesterScopeHashInput,
  catalog: { snapshotId: string; callableHash: string },
): McpStaticToolBinding {
  const definition = staticMcpProviderDefinition(snapshot, tool);
  const material = {
    schemaVersion: MCP_STATIC_TOOL_BINDING_VERSION,
    mode: "static" as const,
    serverId: snapshot.serverId,
    nativeToolName: tool.rawRemoteToolName,
    toolName: tool.canonicalToolName,
    transport: snapshot.transport,
    configurationBindingId: snapshot.configurationBindingId,
    toolDefinitionSha256: digest(definition),
    profileScopeSha256: digest(mcpStaticToolScopeHashMaterial(scope)),
    callableCatalogSnapshotId: catalog.snapshotId,
    callableCatalogSha256: catalog.callableHash,
  };
  const binding = { ...material, bindingSha256: digest(material) };
  assertStaticMcpToolBindingIntegrity(binding);
  return Object.freeze(binding);
}

export function assertStaticMcpToolBindingIntegrity(binding: McpStaticToolBinding): void {
  assertMcpStaticToolBinding(binding);
  if (digest(mcpStaticToolBindingHashMaterial(binding)) !== binding.bindingSha256) {
    throw new Error("Static MCP binding integrity check failed.");
  }
}
