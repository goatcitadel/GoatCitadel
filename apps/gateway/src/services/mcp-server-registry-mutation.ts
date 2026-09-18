import { isDeepStrictEqual } from "node:util";
import { ConflictError, type McpServerRecord } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { callerOwnedServers, assertUniqueServers, jsonMaterial } from "./mcp-server-state-helpers.js";
const MCP_SERVERS_SETTING_KEY = "mcp_servers_v1";
interface McpRegistryMutationDependencies {
  systemSettings: Pick<AsyncStorage["systemSettings"], "get" | "compareAndSet">;
}
/** Re-evaluate the requested edit against each fresh snapshot; never overwrite a losing CAS. */
export async function mutateMcpServerRegistry(
  deps: McpRegistryMutationDependencies,
  update: (current: McpServerRecord[]) => McpServerRecord[],
): Promise<McpServerRecord[]> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const before = await deps.systemSettings.get<McpServerRecord[]>(MCP_SERVERS_SETTING_KEY);
      const current = callerOwnedServers(before?.value);
      assertUniqueServers(current);
      const next = update(current);
      if (isDeepStrictEqual(jsonMaterial(next), jsonMaterial(before?.value))) return next;
      const saved = await deps.systemSettings.compareAndSet(MCP_SERVERS_SETTING_KEY, before, next);
      if (saved) return saved.value;
    }
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: "MCP registry changed concurrently; reload before retrying.",
    });
  }
