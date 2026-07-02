import type { McpServerTemplateRecord } from "@goatcitadel/contracts";
import { normalizeSafeEnvKeyNames } from "@goatcitadel/policy-engine";
import { MCP_APPROVAL_INBOX_URL } from "./mcp-approval-inbox.js";

const EXPERIMENTAL_REMOTE_MCP_TRANSPORTS_ENV = "GOATCITADEL_EXPERIMENTAL_REMOTE_MCP_TRANSPORTS";

export function isVisibleMcpTemplateRecord(template: Pick<McpServerTemplateRecord, "transport" | "url">): boolean {
  return isAllowedMcpDefinitionForCreate(template);
}

type RuntimeSupportInput = Pick<McpServerTemplateRecord, "transport" | "url"> &
  Partial<Pick<McpServerTemplateRecord, "authType" | "oauth" | "policy">>;

export function isRuntimeSupportedMcpDefinition(input: RuntimeSupportInput): boolean {
  if (input.transport === "stdio" || input.url?.trim().toLowerCase() === MCP_APPROVAL_INBOX_URL) {
    return true;
  }
  if ((input.transport === "http" || input.transport === "sse") && input.url?.trim()) {
    return isSupportedRemoteMcpAuth(input);
  }
  return false;
}

export function isAllowedMcpDefinitionForCreate(
  input: Pick<McpServerTemplateRecord, "transport" | "url">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isRuntimeSupportedMcpDefinition(input) || areExperimentalRemoteMcpTransportsEnabled(env);
}

export function isInternalMcpServerUrl(url: string | undefined): boolean {
  return url?.trim().toLowerCase().startsWith("goatcitadel://") ?? false;
}

export function isAllowedMcpDefinitionForCallerCreate(
  input: Pick<McpServerTemplateRecord, "transport" | "url">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !isInternalMcpServerUrl(input.url) && isAllowedMcpDefinitionForCreate(input, env);
}

export function buildInternalMcpServerCreateBlockedMessage(): string {
  return "Internal goatcitadel:// MCP servers are Gateway-owned and cannot be created or assigned by callers.";
}

export function areExperimentalRemoteMcpTransportsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env[EXPERIMENTAL_REMOTE_MCP_TRANSPORTS_ENV]?.trim() ?? "");
}

export function buildUnsupportedMcpTransportMessage(transport: string): string {
  return `MCP transport ${transport} requires local stdio, the built-in Approval Inbox, or a remote http/sse URL with supported auth. OAuth-backed remote records require authorizationUrl/tokenUrl metadata and a connected Gateway OAuth token.`;
}

function isSupportedRemoteMcpAuth(input: RuntimeSupportInput): boolean {
  if (!input.authType || input.authType === "none") {
    return true;
  }
  if (input.authType === "token") {
    return normalizeSafeEnvKeyNames(input.policy?.allowedEnvKeys).length > 0;
  }
  if (input.authType === "oauth2") {
    return Boolean(input.oauth?.authorizationUrl?.trim() && input.oauth.tokenUrl?.trim());
  }
  return false;
}
