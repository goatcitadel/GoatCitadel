import {
  ValidationError,
  resolveMcpServerConnectionMode,
  type McpServerConnectionReview,
  type McpServerRecord,
} from "@goatcitadel/contracts";
import { assertMcpConnectionReview } from "./mcp-server-revision.js";
import { GATEWAY_OWNED_MCP_SERVER_IDS } from "./mcp-server-state-helpers.js";
import { buildUnsupportedMcpTransportMessage, isRuntimeSupportedMcpDefinition } from "./mcp-template-visibility.js";
import type { McpConnectionFence } from "./mcp-static-environment-service.js";

export interface McpConnectionActionReview extends McpServerConnectionReview {
  onCommitted?: () => void | Promise<void>;
}

export interface McpOAuthExchangeReview {
  fence: McpConnectionFence;
  onCommitted?: () => void | Promise<void>;
}

/** Validate before admission; these URLs are displayed and later opened or contacted explicitly. */
export function assertReviewedMcpOAuth(server: McpServerRecord): void {
  if (server.authType !== "oauth2" || !server.oauth?.authorizationUrl || !server.oauth.tokenUrl)
    throw new ValidationError({ message: "Reviewed OAuth requires saved authorization and token endpoints." });
  for (const value of [server.oauth.authorizationUrl, server.oauth.tokenUrl, server.oauth.redirectUri].filter(Boolean)) {
    let url: URL;
    try { url = new URL(value!); } catch { throw new ValidationError({ message: "Reviewed OAuth URLs must be absolute HTTP(S) URLs." }); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
      throw new ValidationError({ message: "Reviewed OAuth URLs must use HTTP(S) without embedded credentials or fragments." });
  }
}

export function assertReviewedStaticServer(server: McpServerRecord, review: McpServerConnectionReview): void {
  assertMcpConnectionReview(server, review);
  if (GATEWAY_OWNED_MCP_SERVER_IDS.has(server.serverId))
    throw new ValidationError({ message: "Gateway-owned MCP servers manage their own connection lifecycle." });
  if (resolveMcpServerConnectionMode(server) !== "static")
    throw new ValidationError({
      message: "Requester-scoped MCP connections require their authenticated requester owner.",
    });
  if (!isRuntimeSupportedMcpDefinition(server))
    throw new ValidationError({ message: buildUnsupportedMcpTransportMessage(server.transport) });
}
