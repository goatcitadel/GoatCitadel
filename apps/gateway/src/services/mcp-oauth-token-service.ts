import type { McpOAuthConfig, McpServerRecord } from "@goatcitadel/contracts";
import { fetchAllowlisted, normalizeSafeEnvKeyNames } from "@goatcitadel/policy-engine";
import type { SecretStoreService } from "./secret-store-service.js";
import type { McpAuthStateRecord } from "./mcp-server-admin-service.js";

export interface McpOAuthTokenServiceOptions {
  secretStore: Pick<SecretStoreService, "setSecret" | "getSecret" | "deleteSecret">;
  networkAllowlist: string[];
  env?: NodeJS.ProcessEnv;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: string;
  scope?: string;
  token_type?: string;
}

export class McpOAuthTokenService {
  private readonly env: NodeJS.ProcessEnv;

  public constructor(private readonly options: McpOAuthTokenServiceOptions) {
    this.env = options.env ?? process.env;
  }

  public async exchangeAuthorizationCode(
    server: McpServerRecord,
    code: string,
    stateRecord: McpAuthStateRecord,
  ): Promise<McpAuthStateRecord> {
    const oauth = requireOAuthConfig(server);
    const response = await this.requestToken(server, oauth, {
      grant_type: "authorization_code",
      code,
      redirect_uri: oauth.redirectUri?.trim() || "http://127.0.0.1:8787/api/v1/mcp/oauth/callback",
    });
    return this.persistTokenResponse(server.serverId, response, {
      ...stateRecord,
      oauthState: undefined,
      error: undefined,
      lastCodePreview: code.slice(0, 8),
    });
  }

  public async resolveAccessToken(
    server: McpServerRecord,
    stateRecord: McpAuthStateRecord | undefined,
  ): Promise<{ accessToken: string; state: McpAuthStateRecord }> {
    if (server.authType !== "oauth2") {
      throw new Error("MCP OAuth token resolution only applies to oauth2 servers.");
    }
    const current = stateRecord;
    if (!current?.accessTokenRef) {
      throw new Error("MCP OAuth token is missing; reconnect this server from Settings.");
    }
    const refreshNeeded = this.isRefreshNeeded(server.oauth, current);
    if (refreshNeeded) {
      if (!current.refreshTokenRef) {
        throw new Error("MCP OAuth token expired and no refresh token is available; reconnect this server.");
      }
      return this.refreshAccessToken(server, current);
    }
    const accessToken = this.readSecretRef(current.accessTokenRef);
    if (!accessToken) {
      throw new Error("MCP OAuth access token is unavailable in the OS secret store; reconnect this server.");
    }
    return { accessToken, state: current };
  }

  public deleteStoredTokens(serverId: string): void {
    for (const account of [accessTokenAccount(serverId), refreshTokenAccount(serverId)]) {
      try {
        this.options.secretStore.deleteSecret(account);
      } catch {
        // Deleting stale/nonexistent keychain entries is best effort.
      }
    }
  }

  private async refreshAccessToken(
    server: McpServerRecord,
    stateRecord: McpAuthStateRecord,
  ): Promise<{ accessToken: string; state: McpAuthStateRecord }> {
    const oauth = requireOAuthConfig(server);
    const refreshToken = stateRecord.refreshTokenRef ? this.readSecretRef(stateRecord.refreshTokenRef) : undefined;
    if (!refreshToken) {
      throw new Error("MCP OAuth refresh token is unavailable in the OS secret store; reconnect this server.");
    }
    const response = await this.requestToken(server, oauth, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    const state = this.persistTokenResponse(server.serverId, response, {
      ...stateRecord,
      refreshTokenRef: response.refresh_token ? stateRecord.refreshTokenRef : stateRecord.refreshTokenRef,
      error: undefined,
    });
    const accessToken = this.readSecretRef(state.accessTokenRef);
    if (!accessToken) {
      throw new Error("MCP OAuth refresh did not persist an access token.");
    }
    return { accessToken, state };
  }

  private async requestToken(
    server: McpServerRecord,
    oauth: Required<Pick<McpOAuthConfig, "tokenUrl">> & McpOAuthConfig,
    params: Record<string, string>,
  ): Promise<TokenResponse> {
    const tokenUrl = oauth.tokenUrl.trim();
    const body = new URLSearchParams(params);
    const clientId = readEnv(this.env, oauth.clientIdEnv);
    const clientSecret = readEnv(this.env, oauth.clientSecretEnv);
    if (clientId) {
      body.set("client_id", clientId);
    }
    if (clientSecret) {
      body.set("client_secret", clientSecret);
    }
    if (oauth.scopes?.length && !body.has("scope")) {
      body.set("scope", oauth.scopes.join(" "));
    }
    const response = await fetchAllowlisted(tokenUrl, {
      allowlist: this.options.networkAllowlist,
      timeoutMs: 15000,
      init: {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      },
    });
    if (!response.ok) {
      throw new Error(`MCP OAuth token endpoint for ${server.label} returned HTTP ${response.status}.`);
    }
    const parsed = (await response.json()) as TokenResponse;
    if (!parsed.access_token?.trim()) {
      throw new Error(`MCP OAuth token endpoint for ${server.label} did not return an access token.`);
    }
    return parsed;
  }

  private persistTokenResponse(
    serverId: string,
    response: TokenResponse,
    previous: McpAuthStateRecord,
  ): McpAuthStateRecord {
    const now = new Date().toISOString();
    const accessAccount = accessTokenAccount(serverId);
    const refreshAccount = refreshTokenAccount(serverId);
    this.options.secretStore.setSecret(accessAccount, response.access_token!.trim());
    const refreshToken = response.refresh_token?.trim();
    if (refreshToken) {
      this.options.secretStore.setSecret(refreshAccount, refreshToken);
    }
    return {
      ...previous,
      accessTokenRef: tokenRefFromAccount(accessAccount),
      refreshTokenRef: refreshToken || previous.refreshTokenRef ? tokenRefFromAccount(refreshAccount) : undefined,
      tokenExpiresAt: resolveTokenExpiresAt(response),
      scopes: normalizeScopes(response.scope) ?? previous.scopes,
      updatedAt: now,
      lastRefreshedAt: now,
      error: undefined,
    };
  }

  private isRefreshNeeded(oauth: McpOAuthConfig | undefined, stateRecord: McpAuthStateRecord): boolean {
    if (!stateRecord.tokenExpiresAt) {
      return false;
    }
    const skewMs = Math.max(oauth?.tokenRefreshSkewSeconds ?? 300, 0) * 1000;
    return Date.parse(stateRecord.tokenExpiresAt) - skewMs <= Date.now();
  }

  private readSecretRef(ref: string | undefined): string | undefined {
    const account = accountFromTokenRef(ref);
    return account ? this.options.secretStore.getSecret(account)?.trim() || undefined : undefined;
  }
}

export function buildPublicMcpAuthState(
  server: McpServerRecord,
  stateRecord: McpAuthStateRecord | undefined,
): NonNullable<McpServerRecord["authState"]> {
  if (server.authType !== "oauth2") {
    return {
      authType: server.authType,
      readiness: "not_required",
    };
  }
  if (!server.oauth?.authorizationUrl?.trim() || !server.oauth.tokenUrl?.trim()) {
    return {
      authType: "oauth2",
      readiness: "missing_oauth_config",
      error: stateRecord?.error,
      updatedAt: stateRecord?.updatedAt,
    };
  }
  if (!stateRecord?.accessTokenRef) {
    return {
      authType: "oauth2",
      readiness: "needs_auth",
      scopes: stateRecord?.scopes,
      updatedAt: stateRecord?.updatedAt,
      error: stateRecord?.error,
    };
  }
  const expired = Boolean(stateRecord.tokenExpiresAt && Date.parse(stateRecord.tokenExpiresAt) <= Date.now());
  return {
    authType: "oauth2",
    readiness: expired ? "expired" : "ready",
    accessTokenRef: stateRecord.accessTokenRef,
    refreshTokenRef: stateRecord.refreshTokenRef,
    tokenExpiresAt: stateRecord.tokenExpiresAt,
    scopes: stateRecord.scopes,
    updatedAt: stateRecord.updatedAt,
    lastRefreshedAt: stateRecord.lastRefreshedAt,
    error: stateRecord.error,
  };
}

function requireOAuthConfig(server: McpServerRecord): Required<Pick<McpOAuthConfig, "tokenUrl">> & McpOAuthConfig {
  if (!server.oauth?.tokenUrl?.trim()) {
    throw new Error("MCP OAuth tokenUrl is not configured for this server.");
  }
  return {
    ...server.oauth,
    tokenUrl: server.oauth.tokenUrl,
  };
}

function readEnv(env: NodeJS.ProcessEnv, key?: string): string | undefined {
  const normalized = normalizeSafeEnvKeyNames(key ? [key] : [])[0];
  return normalized ? env[normalized]?.trim() || undefined : undefined;
}

function resolveTokenExpiresAt(response: TokenResponse): string | undefined {
  if (response.expires_at?.trim()) {
    return response.expires_at.trim();
  }
  if (typeof response.expires_in === "number" && Number.isFinite(response.expires_in)) {
    return new Date(Date.now() + response.expires_in * 1000).toISOString();
  }
  return undefined;
}

function normalizeScopes(scope?: string): string[] | undefined {
  const scopes = scope
    ?.split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return scopes?.length ? scopes : undefined;
}

function accessTokenAccount(serverId: string): string {
  return `mcp:${serverId}:access-token`;
}

function refreshTokenAccount(serverId: string): string {
  return `mcp:${serverId}:refresh-token`;
}

function tokenRefFromAccount(account: string): string {
  return `keychain:goatcitadel:${account}`;
}

function accountFromTokenRef(ref: string | undefined): string | undefined {
  const prefix = "keychain:goatcitadel:";
  return ref?.startsWith(prefix) ? ref.slice(prefix.length) : undefined;
}
