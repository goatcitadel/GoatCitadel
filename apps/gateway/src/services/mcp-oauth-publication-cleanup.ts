import { logger } from "@goatcitadel/gateway-core";
import type { McpOAuthTokenService } from "./mcp-oauth-token-service.js";
import type { McpAuthStateRecord } from "./mcp-server-admin-service.js";

interface McpOAuthPublicationCleanupDependencies {
  readonly tokenService: Pick<McpOAuthTokenService, "retireReplacedTokens">;
  readonly reconcileRetiredCredentials?: () => Promise<void>;
}

/** Run only after canonical publication. Cleanup failure cannot retry the exchange. */
export async function cleanupPublishedMcpOAuthCredentials(
  deps: McpOAuthPublicationCleanupDependencies,
  serverId: string,
  expected: McpAuthStateRecord | undefined,
  published: McpAuthStateRecord,
): Promise<void> {
  if (deps.reconcileRetiredCredentials) {
    try { await deps.reconcileRetiredCredentials(); }
    catch {
      // Publication already committed; cleanup cannot authorize another request.
      logger.warn("MCP OAuth retained credential cleanup requires reconciliation.");
    }
  } else deps.tokenService.retireReplacedTokens(serverId, expected, published);
}
