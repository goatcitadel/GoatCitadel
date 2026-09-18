import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ConflictError, resolveMcpServerConnectionMode, type McpServerRecord } from "@goatcitadel/contracts";
import type { McpServerStoreCtx } from "./mcp-server-store.js";
import type { McpCredentialRetirementStore } from "./mcp-credential-retirement-store.js";
import type { McpCredentialStagingStore } from "./mcp-credential-staging-store.js";
import { isMcpEnvironmentRefForServer, type McpEnvironmentBindingRecord } from "./mcp-static-environment-service.js";
import { newMcpServerRevision, mcpServerRevision } from "./mcp-server-revision.js";
import { callerOwnedServers, assertUniqueServers, assertConfigurationSnapshot, jsonMaterial } from "./mcp-server-state-helpers.js";
const MCP_SERVERS_SETTING_KEY = "mcp_servers_v1";
const MCP_ENVIRONMENT_SETTING_KEY = "mcp_environment_bindings_v1";
interface McpEnvironmentPublicationPort {
  credentialRetirements: Pick<McpCredentialRetirementStore, "assertPublishable" | "record">;
  credentialStaging: Pick<McpCredentialStagingStore, "publish">;
  removeAuthState(serverIds: string[]): Promise<void>;
  removeFirstApprovals(serverIds: string[]): Promise<void>;
}
export async function publishMcpEnvironmentBinding(
  ctx: McpServerStoreCtx, port: McpEnvironmentPublicationPort, server: McpServerRecord,
  expected: McpEnvironmentBindingRecord | undefined, next: McpEnvironmentBindingRecord | undefined,
): Promise<McpServerRecord> {
    const input = structuredClone({ server, expected, next });
    if (
      input.next &&
      (Object.keys(input.next).length !== 1 || !isMcpEnvironmentRefForServer(input.next.credentialRef, server.serverId))
    ) {
      throw new ConflictError({ message: "MCP environment credential reference belongs to another authority." });
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await ctx.runImmediateTransaction(async () => {
          const before = await ctx.systemSettings.get<McpServerRecord[]>(MCP_SERVERS_SETTING_KEY);
          const servers = callerOwnedServers(before?.value);
          assertUniqueServers(servers);
          const current = servers.find((item) => item.serverId === input.server.serverId);
          if (!current || resolveMcpServerConnectionMode(current) !== "static")
            throw new ConflictError({ message: "MCP environment requires current static configuration." });
          assertConfigurationSnapshot([current], [input.server]);
          const environmentBefore =
            await ctx.systemSettings.get<Record<string, McpEnvironmentBindingRecord>>(MCP_ENVIRONMENT_SETTING_KEY);
          const bindings = environmentBefore?.value ?? {};
          if (!isDeepStrictEqual(jsonMaterial(bindings[current.serverId]), jsonMaterial(input.expected))) {
            throw new ConflictError({ message: "MCP environment authority changed before publication." });
          }
          const changed = !isDeepStrictEqual(jsonMaterial(input.expected), jsonMaterial(input.next));
          await port.credentialRetirements.assertPublishable(current.serverId, [input.next?.credentialRef]);
          await port.credentialStaging.publish(current.serverId, [input.next?.credentialRef]);
          const updated = {
            ...current,
            revision: changed || !current.configurationBindingId ? newMcpServerRevision() : mcpServerRevision(current),
            configurationBindingId:
              changed || !current.configurationBindingId ? randomUUID() : current.configurationBindingId,
          };
          if (
            !(await ctx.systemSettings.compareAndSet(
              MCP_SERVERS_SETTING_KEY,
              before,
              servers.map((item) => (item.serverId === current.serverId ? updated : item)),
            ))
          ) {
            throw new ConflictError({
              code: "WRITE_CONFLICT",
              message: "MCP configuration changed during environment publication.",
            });
          }
          if (changed) {
            const nextBindings = { ...bindings };
            if (input.next) nextBindings[current.serverId] = input.next;
            else delete nextBindings[current.serverId];
            if (
              !(await ctx.systemSettings.compareAndSet(
                MCP_ENVIRONMENT_SETTING_KEY,
                environmentBefore,
                nextBindings,
              ))
            ) {
              throw new ConflictError({
                code: "WRITE_CONFLICT",
                message: "MCP environment changed during publication.",
              });
            }
            await port.credentialRetirements.record(current.serverId, [input.expected?.credentialRef], [input.next?.credentialRef]);
            if (current.authType === "oauth2") await port.removeAuthState([current.serverId]);
          }
          if (updated.configurationBindingId !== current.configurationBindingId)
            await port.removeFirstApprovals([current.serverId]);
          return updated;
        });
      } catch (error) {
        if (!(error instanceof ConflictError) || error.code !== "WRITE_CONFLICT") throw error;
      }
    }
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: "MCP environment publication conflicted; reload before retrying.",
    });
  }
