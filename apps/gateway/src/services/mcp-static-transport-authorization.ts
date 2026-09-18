import type { McpServerRecord, ToolPolicyActorContext } from "@goatcitadel/contracts";
import type { McpRuntimeTransportOptions } from "./mcp-runtime.js";
import { withStdioMcpClient, type StdioClient } from "./mcp-stdio-transport.js";
import { withHttpMcpClient, type HttpMcpClient } from "./mcp-http-transport.js";
import { prepareStaticEnvironment } from "./mcp-transport-credentials.js";
import { assertMcpStaticEnvironmentCurrent, type McpStaticEnvironmentHandle } from "./mcp-static-environment-service.js";
import { consumeStaticMcpCallAuthority, type StaticMcpCallAuthority } from "./mcp-static-call-authority.js";

interface McpStaticTransportPort extends McpRuntimeTransportOptions {
  staticEnvironment?: McpStaticEnvironmentHandle;
  staticToolCall?: StaticMcpCallAuthority;
}

export function buildToolsListParams(actorContext?: ToolPolicyActorContext): Record<string, unknown> {
  if (!actorContext) {
    return {};
  }
  const context: Record<string, unknown> = {};
  if (actorContext.operatorId) context.operatorId = actorContext.operatorId;
  if (actorContext.workspaceId) context.workspaceId = actorContext.workspaceId;
  if (actorContext.sessionId) context.sessionId = actorContext.sessionId;
  if (actorContext.permissionProfileId) context.permissionProfileId = actorContext.permissionProfileId;
  if (actorContext.surface) context.surface = actorContext.surface;
  return Object.keys(context).length > 0 ? { context } : {};
}

export async function discoverStaticMcpToolsList(
  server: McpServerRecord,
  timeoutMs: number,
  options: McpStaticTransportPort,
  signal?: AbortSignal,
): Promise<unknown> {
  options = await prepareStaticEnvironment(server, options);
  const read = async (client: StdioClient | HttpMcpClient) => {
    const response = await client.request("tools/list", buildToolsListParams(options.actorContext), signal);
    if (response.error || !response.result) throw new Error("Static MCP discovery did not return a valid catalog.");
    if (options.staticEnvironment) await assertMcpStaticEnvironmentCurrent(options.staticEnvironment, server);
    return response.result;
  };
  return server.transport === "stdio"
    ? withStdioMcpClient(server, timeoutMs, read, signal, undefined, options)
    : withHttpMcpClient(server, timeoutMs, options, read, signal);
}

export async function authorizeStaticMcpToolCall(
  client: StdioClient | HttpMcpClient,
  server: McpServerRecord,
  options: McpStaticTransportPort,
  signal?: AbortSignal,
): Promise<void> {
  if (options.staticEnvironment) await assertMcpStaticEnvironmentCurrent(options.staticEnvironment, server);
  if (!options.staticToolCall) return;
  const response = await client.request("tools/list", buildToolsListParams(options.actorContext), signal);
  if (response.error || !response.result) throw new Error("Static MCP catalog revalidation failed before dispatch.");
  await consumeStaticMcpCallAuthority(options.staticToolCall, response.result);
}
