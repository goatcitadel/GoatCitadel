import type { FastifyInstance } from "fastify";
import { createOAuthCallbackHandoff } from "./oauth-callback-handoff.js";

export const MCP_OAUTH_CALLBACK_PATH = "/api/v1/mcp/oauth/callback";
/**
 * Mission Control route that receives the hand-off (Capabilities › Connectors › Advanced setup, which opens MCP
 * servers); the code travels only in the URL fragment.
 */
export const MCP_OAUTH_RETURN_ROUTE = "/capabilities/connectors/advanced";
export const MCP_OAUTH_RETURN_FRAGMENT = "mcp-oauth-return";

const handoff = createOAuthCallbackHandoff({
  path: MCP_OAUTH_CALLBACK_PATH,
  returnRoute: MCP_OAUTH_RETURN_ROUTE,
  fragment: MCP_OAUTH_RETURN_FRAGMENT,
  unknownHint:
    "To finish it by hand, copy the code and state from this page's address bar into the server's OAuth controls in Settings.",
});

/**
 * Remembers which allowed Mission Control origin started this sign-in, so the provider's
 * redirect can hand the code back there. This stores no code and grants no authority:
 * the operator still completes the exchange through the reviewed completion step.
 */
export function rememberMcpOAuthReturn(state: string, origin: string | undefined, now = Date.now()): void {
  handoff.remember(state, origin, now);
}

export function __resetMcpOAuthReturnsForTests(): void {
  handoff.reset();
}

export function registerMcpOAuthCallbackRoute(fastify: FastifyInstance): void {
  handoff.register(fastify);
}
