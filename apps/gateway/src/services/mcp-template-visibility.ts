import type { McpServerTemplateRecord } from "@goatcitadel/contracts";
import { MCP_APPROVAL_INBOX_URL } from "./mcp-approval-inbox.js";

const EXPERIMENTAL_REMOTE_MCP_TRANSPORTS_ENV = "GOATCITADEL_EXPERIMENTAL_REMOTE_MCP_TRANSPORTS";

export function isVisibleMcpTemplateRecord(template: Pick<McpServerTemplateRecord, "transport" | "url">): boolean {
  return isAllowedMcpDefinitionForCreate(template);
}

export function isRuntimeSupportedMcpDefinition(input: Pick<McpServerTemplateRecord, "transport" | "url">): boolean {
  return input.transport === "stdio" || input.url?.trim().toLowerCase() === MCP_APPROVAL_INBOX_URL;
}

export function isAllowedMcpDefinitionForCreate(
  input: Pick<McpServerTemplateRecord, "transport" | "url">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isRuntimeSupportedMcpDefinition(input) || areExperimentalRemoteMcpTransportsEnabled(env);
}

export function areExperimentalRemoteMcpTransportsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env[EXPERIMENTAL_REMOTE_MCP_TRANSPORTS_ENV]?.trim() ?? "");
}

export function buildUnsupportedMcpTransportMessage(transport: string): string {
  return `MCP transport ${transport} is not part of the 1.0 runtime-invokable surface. Use stdio or the built-in Approval Inbox template, or set ${EXPERIMENTAL_REMOTE_MCP_TRANSPORTS_ENV}=true for experimental remote transport records.`;
}
