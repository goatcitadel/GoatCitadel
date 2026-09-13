import { createHash } from "node:crypto";
import { canonicalJsonString, ConflictError, type McpServerCreateInput } from "@goatcitadel/contracts";
import { normalizeMcpPolicy } from "./mcp-server-policy.js";
import { updateMcpServer, type McpServerAdminHost } from "./mcp-server-admin-service.js";

export function packMcpConfiguration(server: McpServerCreateInput) {
  return {
    label: server.label,
    transport: server.transport,
    command: server.command,
    args: server.args,
    url: server.url,
    authType: server.authType,
    category: server.category,
    trustTier: server.trustTier,
    costTier: server.costTier,
    policy: normalizeMcpPolicy(server.policy),
    oauth: server.oauth,
  };
}
export const packMcpConfigurationHash = (server: McpServerCreateInput) =>
  createHash("sha256")
    .update(canonicalJsonString(packMcpConfiguration(server)))
    .digest("hex");

export interface PackMcpCompensationInput {
  planId: string;
  serverId: string;
  mode: "created" | "enabled";
  configurationHash: string;
}

/** Called inside the MCP registry's transaction. Never deletes configuration,
 * downloaded artifacts, pre-existing installations, or later operator edits. */
export async function compensatePackMcpServer(
  host: McpServerAdminHost,
  input: PackMcpCompensationInput,
): Promise<void> {
  const server = await host.requireMcpServer(input.serverId);
  const owner = server.packChange;
  if (
    !owner ||
    owner.planId !== input.planId ||
    (input.mode === "created" && !owner.created) ||
    packMcpConfigurationHash(server) !== input.configurationHash
  ) {
    throw new ConflictError({ message: "MCP configuration changed after pack setup; the later state was preserved." });
  }
  const expectedRevision = input.mode === "created" ? 2 : 1;
  if (owner.phase === "compensate" && !server.enabled && owner.revision === expectedRevision + 1) return;
  if (owner.phase !== "apply" || owner.revision !== expectedRevision) {
    // A failed create-before-enable has no enabled effect to undo.
    if (input.mode === "created" && owner.phase === "apply" && owner.revision === 1 && !server.enabled) return;
    throw new ConflictError({ message: "MCP pack revision changed; compensation requires owner review." });
  }
  await updateMcpServer(host, input.serverId, { enabled: false }, { planId: input.planId, phase: "compensate" });
}
