import { randomUUID } from "node:crypto";
import type { McpOAuthStartResponse, McpServerRecord, McpServerConnectionReview } from "@goatcitadel/contracts";
import { normalizeSafeEnvKeyNames } from "@goatcitadel/policy-engine";
import type { McpAuthStateRecord, McpAuthStateUpdate } from "./mcp-server-admin-service.js";
import type { McpConnectionFence } from "./mcp-static-environment-service.js";
import { assertMcpConnectionReview, mcpServerRevision } from "./mcp-server-revision.js";
import { sameConfiguration } from "./mcp-server-state-helpers.js";
import { isDeepStrictEqual } from "node:util";
import { buildPublicMcpAuthState } from "./mcp-oauth-token-service.js";

interface McpOAuthHandshakeHost {
  requireMcpServer(serverId: string): Promise<McpServerRecord>;
  prepareMcpStaticEnvironment?(server: McpServerRecord, fence?: McpConnectionFence): Promise<McpServerRecord>;
  resolveMcpOAuthClientId?(server: McpServerRecord, fence?: McpConnectionFence): Promise<string | undefined>;
  readMcpAuthState(): Promise<Record<string, McpAuthStateRecord>>;
  writeMcpAuthState(update: McpAuthStateUpdate): Promise<void>;
}

export async function startMcpOAuth(host: McpOAuthHandshakeHost, serverId: string,
  review?: { server: McpServerRecord; reviewed: McpServerConnectionReview }): Promise<McpOAuthStartResponse> {
  const admitted = review ? structuredClone(review) : undefined;
  let server = admitted?.server ?? await host.requireMcpServer(serverId);
  const fence = admitted ? Object.freeze({ expectedConnectionRevision: server.connectionRevision! }) : undefined;
  if (admitted && !server.connectionRevision) throw new Error("Reviewed OAuth admission has no connection generation.");
  if (server.authType !== "oauth2") {
    throw new Error("MCP OAuth can only be started for oauth2 servers.");
  }
  if (!server.oauth?.authorizationUrl?.trim() || !server.oauth.tokenUrl?.trim()) {
    throw new Error("MCP OAuth requires authorizationUrl and tokenUrl metadata.");
  }
  const prepare = host.prepareMcpStaticEnvironment;
  if (prepare) server = fence ? await prepare.call(host, server, fence) : await prepare.call(host, server);
  if (fence && server.connectionRevision !== fence.expectedConnectionRevision) throw new Error("Reviewed OAuth admission was superseded.");
  const state = randomUUID();
  const oauth = server.oauth;
  if (server.authType !== "oauth2" || !oauth?.authorizationUrl?.trim() || !oauth.tokenUrl?.trim()) {
    throw new Error("MCP OAuth configuration changed while preparing its environment.");
  }
  const callback = oauth.redirectUri?.trim() || "http://127.0.0.1:8787/api/v1/mcp/oauth/callback";
  const authorizeUrl = new URL(oauth.authorizationUrl);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("redirect_uri", callback);
  const resolveClientId = host.resolveMcpOAuthClientId;
  const clientId = resolveClientId
    ? await (fence ? resolveClientId.call(host, server, fence) : resolveClientId.call(host, server))
    : resolveEnvValue(oauth.clientIdEnv);
  if (clientId) {
    authorizeUrl.searchParams.set("client_id", clientId);
  }
  if (oauth.scopes?.length) {
    authorizeUrl.searchParams.set("scope", oauth.scopes.join(" "));
  }
  const expected = (await host.readMcpAuthState())[serverId];
  const next = {
    ...expected,
    // Reconnect explicitly abandons the old grant, including an uncertain token request.
    // A late request can no longer publish against this new handshake.
    accessTokenRef: undefined,
    refreshTokenRef: undefined,
    tokenExpiresAt: undefined,
    scopes: undefined,
    resourceIndicator: undefined,
    tokenRequest: undefined,
    lastCodePreview: undefined,
    oauthState: state,
    error: undefined,
    updatedAt: new Date().toISOString(),
  };
  await host.writeMcpAuthState({ server, expected, next, ...(fence ? { fence } : {}) });
  if (admitted) {
    const current = await host.requireMcpServer(serverId);
    const auth = (await host.readMcpAuthState())[serverId];
    assertMcpConnectionReview(current, { expectedRevision: mcpServerRevision(current), expectedConnectionRevision: fence!.expectedConnectionRevision });
    if (!sameConfiguration(current, server) || !isDeepStrictEqual(auth, JSON.parse(JSON.stringify(next)))
      || !isDeepStrictEqual(current.authState, buildPublicMcpAuthState(current, auth)))
      throw new Error("Reviewed OAuth initialization changed before acknowledgement.");
    return { authorizeUrl: authorizeUrl.toString(), state, review: { version: 1, reviewed: admitted.reviewed, server: current } };
  }
  return { authorizeUrl: authorizeUrl.toString(), state };
}

function resolveEnvValue(envKey?: string): string | undefined {
  const key = normalizeSafeEnvKeyNames(envKey ? [envKey] : [])[0];
  return key ? process.env[key]?.trim() || undefined : undefined;
}
