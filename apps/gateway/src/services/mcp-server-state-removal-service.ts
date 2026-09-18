import { ConflictError, type McpToolRecord } from "@goatcitadel/contracts";
import type { McpServerStoreCtx } from "./mcp-server-store.js";
import type { McpAuthStateRecord } from "./mcp-server-admin-service.js";
import type { McpEnvironmentBindingRecord } from "./mcp-static-environment-service.js";
import type { McpCredentialRetirementStore } from "./mcp-credential-retirement-store.js";
const MCP_TOOLS_SETTING_KEY = "mcp_tools_v1";
const MCP_TOOL_FIRST_APPROVAL_SETTING_KEY = "mcp_tool_first_approval_v1";
const MCP_ENVIRONMENT_SETTING_KEY = "mcp_environment_bindings_v1";

/** Uses the caller's transaction-bound repositories; never commits independently. */
export class McpServerStateRemovalService {
  constructor(
    private readonly ctx: McpServerStoreCtx,
    private readonly credentialRetirements: Pick<McpCredentialRetirementStore, "record">,
  ) {}

  async removeAuthState(serverIds: string[]): Promise<void> {
    const auth = await this.ctx.systemSettings.get<Record<string, McpAuthStateRecord>>("mcp_auth_state_v1");
    if (auth) {
      const next = { ...auth.value };
      for (const serverId of serverIds) delete next[serverId];
      if (!(await this.ctx.systemSettings.compareAndSet("mcp_auth_state_v1", auth, next))) {
        throw new ConflictError({ code: "WRITE_CONFLICT", message: "MCP auth registry changed during removal." });
      }
      for (const serverId of serverIds) await this.credentialRetirements.record(serverId,
        [auth.value[serverId]?.accessTokenRef, auth.value[serverId]?.refreshTokenRef], []);
    }
  }

  async removeServerState(serverIds: string[]): Promise<void> {
    for (const serverId of serverIds) await this.ctx.approvalInbox?.deleteByReceiver("mcp", serverId);
    await this.removeAuthState(serverIds);
    const environment =
      await this.ctx.systemSettings.get<Record<string, McpEnvironmentBindingRecord>>(MCP_ENVIRONMENT_SETTING_KEY);
    if (environment) {
      const next = { ...environment.value };
      for (const serverId of serverIds) delete next[serverId];
      if (!(await this.ctx.systemSettings.compareAndSet(MCP_ENVIRONMENT_SETTING_KEY, environment, next))) {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: "MCP environment registry changed during removal.",
        });
      }
      for (const serverId of serverIds) await this.credentialRetirements.record(serverId,
        [environment.value[serverId]?.credentialRef], []);
    }
    await this.removeTools(serverIds);
    await this.removeFirstApprovals(serverIds);
  }

  async removeTools(serverIds: string[]): Promise<void> {
    const tools = await this.ctx.systemSettings.get<McpToolRecord[]>(MCP_TOOLS_SETTING_KEY);
    if (
      tools &&
      !(await this.ctx.systemSettings.compareAndSet(
        MCP_TOOLS_SETTING_KEY,
        tools,
        tools.value.filter((tool) => !serverIds.includes(tool.serverId)),
      ))
    ) {
      throw new ConflictError({ code: "WRITE_CONFLICT", message: "MCP tool registry changed during removal." });
    }
  }

  async removeFirstApprovals(serverIds: string[]): Promise<void> {
    const approved = await this.ctx.systemSettings.get<Record<string, string[]>>(MCP_TOOL_FIRST_APPROVAL_SETTING_KEY);
    if (!approved) return;
    const next = { ...approved.value };
    for (const serverId of serverIds) delete next[serverId];
    if (!(await this.ctx.systemSettings.compareAndSet(MCP_TOOL_FIRST_APPROVAL_SETTING_KEY, approved, next))) {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: "MCP tool approvals changed during auth publication.",
      });
    }
  }
}
