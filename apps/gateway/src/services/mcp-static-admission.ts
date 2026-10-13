import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  mcpStaticAdmissionConnectionSchema,
  type McpStaticAdmissionConnection,
  type McpRequesterAdmissionScope,
  type McpServerRecord,
} from "@goatcitadel/contracts";
import { mcpServerRevision } from "./mcp-server-revision.js";
import {
  assertStaticMcpCatalogSnapshot,
  staticMcpProviderDefinition,
  type StaticMcpCatalogSnapshot,
} from "./mcp-static-catalog.js";

export const staticAdmissionDigest = (value: unknown): string =>
  createHash("sha256").update(canonicalJsonString(value)).digest("hex");

export function assertStaticMcpAdmissionReceipt(value: unknown): McpStaticAdmissionConnection {
  const receipt = mcpStaticAdmissionConnectionSchema.parse(value);
  const { bindingSha256, ...material } = receipt;
  if (staticAdmissionDigest(material) !== bindingSha256) throw new Error("Static MCP admission evidence changed.");
  return receipt;
}

export function buildStaticMcpAdmissionReceipt(
  scope: McpRequesterAdmissionScope,
  server: McpServerRecord,
  snapshot: StaticMcpCatalogSnapshot,
  selectedToolNames: readonly string[],
): McpStaticAdmissionConnection {
  assertStaticMcpCatalogSnapshot(snapshot);
  if (
    !server.connectionRevision ||
    snapshot.configurationBindingId !== server.configurationBindingId ||
    snapshot.serverId !== server.serverId
  )
    throw new Error("Static MCP requires its reviewed connection generation.");
  const selectedTools = selectedToolNames.map((name) => {
    const tool = snapshot.catalog.tools.find((entry) => entry.canonicalToolName === name);
    if (!tool) throw new Error("Selected static MCP descriptor is unavailable.");
    return {
      rawRemoteToolName: tool.rawRemoteToolName,
      canonicalToolName: tool.canonicalToolName,
      modelName: staticMcpProviderDefinition(snapshot, tool).function.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: tool.inputSchema,
      toolDefinitionSha256: tool.toolDefinitionSha256,
    };
  });
  const material = {
    version: "mcp.static.admission.v1" as const,
    scope,
    serverId: server.serverId,
    transport: server.transport,
    configurationBindingId: snapshot.configurationBindingId,
    connectionRevision: server.connectionRevision,
    serverRevision: mcpServerRevision(server),
    selectedTools,
  };
  return assertStaticMcpAdmissionReceipt({ ...material, bindingSha256: staticAdmissionDigest(material) });
}

export function assertStaticMcpAdmissionServer(receipt: McpStaticAdmissionConnection, server: McpServerRecord): void {
  if (
    server.serverId !== receipt.serverId ||
    server.transport !== receipt.transport ||
    !server.enabled ||
    server.status !== "connected" ||
    server.configurationBindingId !== receipt.configurationBindingId ||
    server.connectionRevision !== receipt.connectionRevision ||
    mcpServerRevision(server) !== receipt.serverRevision
  )
    throw new Error("Selected static MCP connection changed; start a new Chat turn.");
}
