import { canonicalJsonString, type McpServerRecord } from "@goatcitadel/contracts";
import type { createMcpServer } from "@goatcitadel/mission-control-shared/api/client";
import { isRuntimeInvokableMcpServer } from "./helpers/mcp-helpers";
import { hasMcpServerBinding, isGatewayMcpServer } from "./mcp-server-mutation";
import type { McpCreateForm } from "./sections/mcp-editor-drafts";

export type McpCreateInput = Parameters<typeof createMcpServer>[0];
const strings = (values: string[]) => values.map((value) => value.trim()).filter(Boolean);

/** Normalize displayed inputs only. Gateway validation and transport policy remain authoritative. */
export function prepareMcpCreateInput(form: McpCreateForm): McpCreateInput {
  if (!form.label.trim()) throw new Error("Server label is required.");
  if (!["stdio", "http", "sse"].includes(form.transport)) throw new Error("Choose a supported transport.");
  if (form.transport === "stdio" && !form.command.trim()) throw new Error("A local server command is required.");
  if (form.transport !== "stdio" && !form.url.trim()) throw new Error("A remote server URL is required.");
  const oauth = form.oauth ? { ...form.oauth } : undefined;
  if (oauth) {
    for (const key of ["authorizationUrl", "tokenUrl", "clientIdEnv", "clientSecretEnv", "redirectUri"] as const)
      oauth[key] = oauth[key]?.trim() || undefined;
    oauth.scopes = oauth.scopes ? strings(oauth.scopes) : undefined;
  }
  return {
    label: form.label.trim(),
    transport: form.transport,
    command: form.transport === "stdio" ? form.command.trim() : undefined,
    args: form.transport === "stdio" ? strings(form.args) : undefined,
    url: form.transport !== "stdio" ? form.url.trim() : undefined,
    authType: form.authType,
    oauth:
      oauth && Object.values(oauth).some((value) => (Array.isArray(value) ? value.length : value !== undefined))
        ? oauth
        : undefined,
    enabled: isRuntimeInvokableMcpServer(form) ? form.enabled : false,
    category: form.category,
    trustTier: form.trustTier,
    costTier: form.costTier,
    policy: {
      requireFirstToolApproval: form.policy.requireFirstToolApproval,
      redactionMode: form.policy.redactionMode,
      allowedToolPatterns: strings(form.policy.allowedToolPatterns),
      blockedToolPatterns: strings(form.policy.blockedToolPatterns),
      allowedEnvKeys: [...new Set(strings(form.policy.allowedEnvKeys ?? []))],
      notes: form.policy.notes?.trim() || undefined,
    },
  };
}
export function mcpCreationMatches(input: McpCreateInput, record: McpServerRecord) {
  return (
    hasMcpServerBinding(record) &&
    !isGatewayMcpServer(record) &&
    record.status === "disconnected" &&
    Object.entries(input).every(
      ([key, value]) =>
        canonicalJsonString(value ?? null) === canonicalJsonString(record[key as keyof McpServerRecord] ?? null),
    )
  );
}
export function sameMcpCreationReceipt(receipt: McpServerRecord, current: McpServerRecord) {
  return (
    hasMcpServerBinding(current) &&
    [
      "serverId",
      "revision",
      "createdAt",
      "label",
      "transport",
      "command",
      "args",
      "url",
      "authType",
      "oauth",
      "enabled",
      "category",
      "trustTier",
      "costTier",
      "policy",
      "status",
    ].every(
      (key) =>
        canonicalJsonString(receipt[key as keyof McpServerRecord] ?? null) ===
        canonicalJsonString(current[key as keyof McpServerRecord] ?? null),
    )
  );
}
