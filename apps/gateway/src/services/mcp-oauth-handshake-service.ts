import { randomUUID } from "node:crypto";
import type { McpOAuthStartResponse, McpServerRecord } from "@goatcitadel/contracts";
import { normalizeSafeEnvKeyNames } from "@goatcitadel/policy-engine";
import type { McpAuthStateRecord, McpAuthStateUpdate } from "./mcp-server-admin-service.js";

interface McpOAuthHandshakeHost {
  requireMcpServer(serverId: string): Promise<McpServerRecord>;
  prepareMcpStaticEnvironment?(server: McpServerRecord): Promise<McpServerRecord>;
  resolveMcpOAuthClientId?(server: McpServerRecord): Promise<string | undefined>;
  readMcpAuthState(): Promise<Record<string, McpAuthStateRecord>>;
  writeMcpAuthState(update: McpAuthStateUpdate): Promise<void>;
}

export async function startMcpOAuth(host: McpOAuthHandshakeHost, serverId: string): Promise<McpOAuthStartResponse> {
  let server = await host.requireMcpServer(serverId);
  if (server.authType !== "oauth2") {
    throw new Error("MCP OAuth can only be started for oauth2 servers.");
  }
  if (!server.oauth?.authorizationUrl?.trim() || !server.oauth.tokenUrl?.trim()) {
    throw new Error("MCP OAuth requires authorizationUrl and tokenUrl metadata.");
  }
  if (host.prepareMcpStaticEnvironment) server = await host.prepareMcpStaticEnvironment(server);
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
  const clientId = host.resolveMcpOAuthClientId
    ? await host.resolveMcpOAuthClientId(server)
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
  await host.writeMcpAuthState({ server, expected, next });
  return { authorizeUrl: authorizeUrl.toString(), state };
}

function resolveEnvValue(envKey?: string): string | undefined {
  const key = normalizeSafeEnvKeyNames(envKey ? [envKey] : [])[0];
  return key ? process.env[key]?.trim() || undefined : undefined;
}
