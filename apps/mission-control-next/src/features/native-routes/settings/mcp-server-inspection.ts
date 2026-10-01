import { canonicalJsonString, type McpRemotePreviewItem, type McpToolRecord } from "@goatcitadel/contracts";
import { fetchMcpRemotePreview, fetchMcpServer, fetchMcpTools } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { hasMcpServerBinding, mcpServerReviewMatches } from "./mcp-server-mutation";

/** Existing saved-server and cached-inventory reads only; never discovers, connects or invokes a tool. */
export async function inspectMcpServer(serverId: string) {
  const server = await fetchMcpServer(serverId);
  if (server?.serverId !== serverId || !hasMcpServerBinding(server))
    throw new Error("The server owner returned incomplete or mismatched configuration.");
  const [toolRead, remoteRead] = await Promise.allSettled([
    fetchMcpTools(serverId),
    server.transport === "stdio" ? Promise.resolve(null) : fetchMcpRemotePreview(),
  ]);
  const current = await fetchMcpServer(serverId);
  if (!mcpServerReviewMatches(server, current) || canonicalJsonString(server) !== canonicalJsonString(current))
    throw new Error("The server changed during inspection. Refresh to inspect a consistent saved configuration.");
  const issues: string[] = [];
  let tools: McpToolRecord[] | undefined, remote: McpRemotePreviewItem | undefined;
  if (toolRead.status === "rejected")
    issues.push(`Cached tools unavailable: ${describeApiError(toolRead.reason).summary}`);
  else {
    const items = toolRead.value.items;
    if (
      !Array.isArray(items) ||
      items.some(
        (item) =>
          item?.serverId !== serverId ||
          typeof item.toolName !== "string" ||
          !item.toolName ||
          typeof item.enabled !== "boolean" ||
          (item.description !== undefined && typeof item.description !== "string"),
      ) ||
      new Set(items.map((item) => item.toolName)).size !== items.length
    )
      issues.push("Cached tool evidence is incomplete, duplicated or belongs to another server.");
    else tools = items;
  }
  if (remoteRead.status === "rejected")
    issues.push(`Transport inspection unavailable: ${describeApiError(remoteRead.reason).summary}`);
  else if (remoteRead.value) {
    const snapshot = remoteRead.value;
    const matches = Array.isArray(snapshot.items)
      ? snapshot.items.filter((item) => item.source === "server" && item.id === serverId)
      : [];
    const item = matches[0];
    if (
      snapshot.readOnly !== true ||
      snapshot.mutationSemantics !== "none" ||
      !Number.isFinite(Date.parse(snapshot.generatedAt)) ||
      matches.length !== 1 ||
      !item ||
      ["label", "transport", "url", "authType", "trustTier", "status", "enabled"].some(
        (key) => item[key as keyof McpRemotePreviewItem] !== server[key as keyof typeof server],
      ) ||
      typeof item.operatorNextAction !== "string" ||
      !Array.isArray(item.blockers) ||
      !Array.isArray(item.governance) ||
      [...item.blockers, ...item.governance].some((value) => typeof value !== "string")
    )
      issues.push("Transport evidence does not match this saved server. Refresh before relying on it.");
    else remote = item;
  }
  return { server, tools, remote, issues };
}
