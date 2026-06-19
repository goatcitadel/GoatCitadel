import type { McpServerRecord, McpToolRecord } from "@goatcitadel/contracts";

/**
 * Provider/server namespacing for MCP tool names.
 *
 * Two MCP servers can expose tools with the same bare name (e.g. `read_file`).
 * Dispatching a bare name plus an arbitrary `serverId` is ambiguous when more
 * than one connected server exposes it, so callers can disambiguate explicitly
 * with the `mcp__<serverId>__<toolName>` form. This module resolves that form
 * and detects un-namespaced collisions so the route can fail closed with an
 * actionable error instead of silently invoking an arbitrary server's tool.
 */

export const MCP_TOOL_NAMESPACE_PREFIX = "mcp__";
const MCP_TOOL_NAMESPACE_SEPARATOR = "__";

export interface ParsedNamespacedToolName {
  serverId: string;
  toolName: string;
}

/**
 * Parse a namespaced MCP tool name of the form `mcp__<serverId>__<toolName>`.
 *
 * The server id segment must be non-empty and free of the `__` separator; the
 * tool name is everything after the second separator (it may itself contain
 * `__`). Returns `undefined` for any value that is not a well-formed namespaced
 * name, so bare tool names pass through unchanged.
 */
export function parseNamespacedMcpToolName(rawToolName: string): ParsedNamespacedToolName | undefined {
  if (!rawToolName.startsWith(MCP_TOOL_NAMESPACE_PREFIX)) {
    return undefined;
  }
  const remainder = rawToolName.slice(MCP_TOOL_NAMESPACE_PREFIX.length);
  const separatorIndex = remainder.indexOf(MCP_TOOL_NAMESPACE_SEPARATOR);
  if (separatorIndex <= 0) {
    return undefined;
  }
  const serverId = remainder.slice(0, separatorIndex);
  const toolName = remainder.slice(separatorIndex + MCP_TOOL_NAMESPACE_SEPARATOR.length);
  if (!serverId.trim() || !toolName.trim()) {
    return undefined;
  }
  return { serverId, toolName };
}

/**
 * Build the canonical namespaced tool name for a server + tool pair.
 */
export function formatNamespacedMcpToolName(serverId: string, toolName: string): string {
  return `${MCP_TOOL_NAMESPACE_PREFIX}${serverId}${MCP_TOOL_NAMESPACE_SEPARATOR}${toolName}`;
}

/** A server is eligible to expose tools for dispatch only when connected and enabled. */
function isConnectedDispatchableServer(server: McpServerRecord): boolean {
  return server.enabled && server.status === "connected" && server.trustTier !== "quarantined";
}

/**
 * The set of connected/enabled server ids that expose a tool with the given
 * bare name. Used to detect collisions before dispatching an un-namespaced call.
 */
export function findServersExposingTool(
  toolName: string,
  servers: McpServerRecord[],
  listMcpTools: (serverId: string) => McpToolRecord[],
): string[] {
  const matches: string[] = [];
  for (const server of servers) {
    if (!isConnectedDispatchableServer(server)) {
      continue;
    }
    let tools: McpToolRecord[];
    try {
      tools = listMcpTools(server.serverId);
    } catch {
      // A server whose tools cannot be listed is not a dispatch candidate.
      continue;
    }
    if (tools.some((tool) => tool.toolName === toolName && tool.enabled)) {
      matches.push(server.serverId);
    }
  }
  return matches;
}

/**
 * Build the actionable error shown when a bare tool name is exposed by more than
 * one connected MCP server and the caller did not disambiguate with a namespaced
 * name. Lists the candidate servers and shows the namespaced form to use.
 */
export function buildMcpToolCollisionError(toolName: string, serverIds: string[]): string {
  const namespaced = serverIds.map((serverId) => formatNamespacedMcpToolName(serverId, toolName));
  return (
    `MCP tool ${toolName} is exposed by ${serverIds.length} connected servers (${serverIds.join(", ")}); ` +
    `the requested server cannot be resolved unambiguously. ` +
    `Re-invoke with an explicit namespaced tool name, e.g. ${namespaced.join(" or ")}.`
  );
}
