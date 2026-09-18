import { ConflictError, type McpServerRecord, type McpToolRecord } from "@goatcitadel/contracts";
import type { McpServerStoreCtx } from "./mcp-server-store.js";
import { GATEWAY_OWNED_MCP_SERVER_IDS } from "./mcp-server-state-helpers.js";
import { createInternalMcpApprovalInboxTools } from "./mcp-approval-inbox.js";
import { createInternalMcpDurableTasksTools } from "./mcp-durable-tasks.js";
const MCP_TOOLS_SETTING_KEY = "mcp_tools_v1";
interface McpConnectionSettlementPort {
  patchServerState(serverId: string, patch: Partial<Pick<McpServerRecord, "status" | "lastConnectedAt" | "lastError">>, expected: McpServerRecord): Promise<McpServerRecord>;
}

export async function completeMcpConnection(ctx: McpServerStoreCtx, port: McpConnectionSettlementPort, expected: McpServerRecord, tools: McpToolRecord[]): Promise<McpServerRecord> {
    if (tools.some((tool) => tool.serverId !== expected.serverId)) throw new TypeError("MCP discovery returned tools for another server.");
    if (GATEWAY_OWNED_MCP_SERVER_IDS.has(expected.serverId)) {
      return { ...expected, status: "connected", lastConnectedAt: new Date().toISOString(), lastError: undefined };
    }
    return ctx.runImmediateTransaction(async () => {
      const saved = await port.patchServerState(expected.serverId, {
        status: "connected", lastConnectedAt: new Date().toISOString(), lastError: undefined,
      }, expected);
      const before = await ctx.systemSettings.get<McpToolRecord[]>(MCP_TOOLS_SETTING_KEY);
      const next = [...(before?.value ?? []).filter((tool) => tool.serverId !== expected.serverId), ...structuredClone(tools)];
      if (!(await ctx.systemSettings.compareAndSet(MCP_TOOLS_SETTING_KEY, before, next))) {
        throw new ConflictError({ code: "WRITE_CONFLICT", message: "MCP tool inventory changed before connection settlement." });
      }
      return saved;
    });
  }

export async function readMcpToolInventory(ctx: McpServerStoreCtx): Promise<McpToolRecord[]> {
    const stored = (await ctx.systemSettings.get<McpToolRecord[]>(MCP_TOOLS_SETTING_KEY))?.value;
    const persisted = Array.isArray(stored) ? stored : [];
    const callerOwned = persisted.filter(
      (item): item is McpToolRecord =>
        Boolean(item?.serverId && item?.toolName) && !GATEWAY_OWNED_MCP_SERVER_IDS.has(item.serverId),
    );
    return [...buildGatewayOwnedInternalMcpTools(), ...callerOwned];
  }

export async function writeMcpToolInventory(ctx: McpServerStoreCtx, tools: McpToolRecord[]): Promise<void> {
    await ctx.systemSettings.set(
      MCP_TOOLS_SETTING_KEY,
      tools.filter((tool) => !GATEWAY_OWNED_MCP_SERVER_IDS.has(tool.serverId)),
    );
  }

function buildGatewayOwnedInternalMcpTools(): McpToolRecord[] {
  return [
    ...createInternalMcpApprovalInboxTools("goatcitadel-internal-approval-inbox"),
    ...createInternalMcpDurableTasksTools("goatcitadel-internal-durable-tasks"),
  ];
}
