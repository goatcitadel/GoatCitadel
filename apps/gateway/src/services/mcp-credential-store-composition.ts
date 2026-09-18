import type { McpServerStoreCtx } from "./mcp-server-store.js";
import { McpCredentialRetirementStore } from "./mcp-credential-retirement-store.js";
import { McpCredentialStagingStore } from "./mcp-credential-staging-store.js";

/** Both owners share the same transaction context and retained custody evidence. */
export function createMcpCredentialStores(ctx: McpServerStoreCtx) {
  const credentialRetirements = new McpCredentialRetirementStore(ctx,
    (serverId, ref) => credentialStaging.readCustody(serverId, ref),
    (serverId, ref) => credentialStaging.readWriteId(serverId, ref));
  const credentialStaging: McpCredentialStagingStore = new McpCredentialStagingStore(ctx, credentialRetirements);
  return { credentialStaging, credentialRetirements };
}
