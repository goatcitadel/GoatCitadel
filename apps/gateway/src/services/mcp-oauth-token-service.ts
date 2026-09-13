import { randomUUID } from "node:crypto";
import type { McpOAuthConfig, McpOAuthReadiness, McpServerRecord } from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
import { fetchAllowlisted, normalizeSafeEnvKeyNames } from "@goatcitadel/policy-engine";
import { readBoundedResponseJson } from "./bounded-response-reader.js";
import type { SecretStoreService } from "./secret-store-service.js";
import type { McpAuthStateRecord } from "./mcp-server-admin-service.js";

export interface McpOAuthTokenServiceOptions {
  secretStore: Pick<SecretStoreService, "setSecret" | "getSecret" | "deleteSecret"> & Partial<Pick<SecretStoreService, "setSecretForCustody">>;
  networkAllowlist: string[];
  env?: NodeJS.ProcessEnv;
  environmentResolver?: (server: McpServerRecord) => Promise<NodeJS.ProcessEnv>;
  stageCredentials?: (serverId: string, refs: readonly string[], write: (custodyId?: string) => undefined) => Promise<void>;
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
    beforeRequest?: () => Promise<void>,
  ): Promise<McpAuthStateRecord> {
    if (server.authType !== "oauth2") throw new Error("MCP OAuth exchange requires oauth2 configuration.");
    const oauth = requireOAuthConfig(server);
    const response = await this.requestToken(
      server,
      oauth,
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: oauth.redirectUri?.trim() || "http://127.0.0.1:8787/api/v1/mcp/oauth/callback",
      },
      beforeRequest,
    );
    return this.persistTokenResponse(server.serverId, response, {
      ...stateRecord,
      // A new authorization grant must not inherit the previous grant's refresh token or scopes.
      refreshTokenRef: undefined,
      scopes: oauth.scopes,
      oauthState: undefined,
      error: undefined,
      lastCodePreview: undefined,
    });
  }

  public async resolveAccessToken(
    server: McpServerRecord,
    stateRecord: McpAuthStateRecord | undefined,
    beforeRequest?: () => Promise<void>,
  ): Promise<{ accessToken: string; state: McpAuthStateRecord }> {
    const current = this.readCurrentAccessToken(server, stateRecord);
    if (current) return current;
    return this.refreshAccessToken(server, stateRecord!, beforeRequest);
  }

  /** Reads a usable credential without dispatching or authorizing a refresh. */
  public readCurrentAccessToken(
    server: McpServerRecord,
    stateRecord: McpAuthStateRecord | undefined,
  ): { accessToken: string; state: McpAuthStateRecord } | undefined {
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
      return undefined;
    }
    const accessToken = this.readSecretRef(current.accessTokenRef, server.serverId, "access-token");
    if (!accessToken) {
      throw new Error("MCP OAuth access token is unavailable in the OS secret store; reconnect this server.");
    }
    return { accessToken, state: current };
  }

  public deleteStoredTokens(serverId: string, state?: McpAuthStateRecord): void {
    const accounts = new Set([accessTokenAccount(serverId), refreshTokenAccount(serverId)]);
    for (const [kind, ref] of [
      ["access-token", state?.accessTokenRef],
      ["refresh-token", state?.refreshTokenRef],
    ] as const) {
      if (ref && isMcpOAuthTokenRefForServer(ref, serverId, kind)) accounts.add(accountFromTokenRef(ref)!);
    }
    this.deleteOwnedAccounts(accounts);
  }

  /** Call only after canonical publication succeeds; uncertain publication retains all versions. */
  public retireReplacedTokens(
    serverId: string,
    previous: McpAuthStateRecord | undefined,
    current: McpAuthStateRecord,
  ): void {
    const retained = new Set([current.accessTokenRef, current.refreshTokenRef]);
    const accounts = new Set<string>();
    for (const [kind, ref] of [
      ["access-token", previous?.accessTokenRef],
      ["refresh-token", previous?.refreshTokenRef],
    ] as const) {
      if (ref && !retained.has(ref) && isMcpOAuthTokenRefForServer(ref, serverId, kind))
        accounts.add(accountFromTokenRef(ref)!);
    }
    this.deleteOwnedAccounts(accounts);
  }

  private deleteOwnedAccounts(accounts: Set<string>): void {
    for (const account of accounts) {
      try {
        this.options.secretStore.deleteSecret(account);
      } catch {
        // Cleanup cannot turn an acknowledged auth publication into a retryable failure.
        logger.warn("MCP OAuth token cleanup could not remove a retired credential entry.");
      }
    }
  }

  private async refreshAccessToken(
    server: McpServerRecord,
    stateRecord: McpAuthStateRecord,
    beforeRequest?: () => Promise<void>,
  ): Promise<{ accessToken: string; state: McpAuthStateRecord }> {
    const oauth = requireOAuthConfig(server);
    const refreshToken = stateRecord.refreshTokenRef
      ? this.readSecretRef(stateRecord.refreshTokenRef, server.serverId, "refresh-token")
      : undefined;
    if (!refreshToken) {
      throw new Error("MCP OAuth refresh token is unavailable in the OS secret store; reconnect this server.");
    }
    const response = await this.requestToken(
      server,
      oauth,
      {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      },
      beforeRequest,
    );
    const state = await this.persistTokenResponse(server.serverId, response, {
      ...stateRecord,
      // persistTokenResponse derives the new refreshTokenRef from response.refresh_token;
      // here we only carry the existing ref forward as the previous value.
      refreshTokenRef: stateRecord.refreshTokenRef,
      error: undefined,
    });
    const accessToken = this.readSecretRef(state.accessTokenRef, server.serverId, "access-token");
    if (!accessToken) {
      throw new Error("MCP OAuth refresh did not persist an access token.");
    }
    return { accessToken, state };
  }

  private async requestToken(
    server: McpServerRecord,
    oauth: Required<Pick<McpOAuthConfig, "tokenUrl">> & McpOAuthConfig,
    params: Record<string, string>,
    beforeRequest?: () => Promise<void>,
  ): Promise<TokenResponse> {
    if (!beforeRequest) throw new Error("MCP OAuth token requests require a durable boundary owner.");
    const tokenUrl = oauth.tokenUrl.trim();
    const body = new URLSearchParams(params);
    const environment = this.options.environmentResolver ? await this.options.environmentResolver(server) : this.env;
    const clientId = readEnv(environment, oauth.clientIdEnv);
    const clientSecret = readEnv(environment, oauth.clientSecretEnv);
    if (clientId) {
      body.set("client_id", clientId);
    }
    if (clientSecret) {
      body.set("client_secret", clientSecret);
    }
    if (oauth.scopes?.length && !body.has("scope")) {
      body.set("scope", oauth.scopes.join(" "));
    }
    await beforeRequest();
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
    const parsed = await readBoundedResponseJson<TokenResponse>(response, {
      maxBytes: 64 * 1024,
      timeoutMs: 5_000,
      label: "MCP OAuth token",
    });
    if (!parsed.access_token?.trim()) {
      throw new Error(`MCP OAuth token endpoint for ${server.label} did not return an access token.`);
    }
    return parsed;
  }

  private async persistTokenResponse(
    serverId: string,
    response: TokenResponse,
    previous: McpAuthStateRecord,
  ): Promise<McpAuthStateRecord> {
    const now = new Date().toISOString();
    const version = randomUUID();
    const accessAccount = `${accessTokenAccount(serverId)}:${version}`;
    const refreshAccount = `${refreshTokenAccount(serverId)}:${version}`;
    const refreshToken = response.refresh_token?.trim();
    const write = (custodyId?: string): undefined => {
      const save = (account: string, value: string): void => {
        if (custodyId === undefined) this.options.secretStore.setSecret(account, value);
        else {
          if (!this.options.secretStore.setSecretForCustody) throw new Error("MCP credential writer requires its OS custody owner.");
          this.options.secretStore.setSecretForCustody(account, value, custodyId);
        }
      };
      save(accessAccount, response.access_token!.trim());
      if (refreshToken) save(refreshAccount, refreshToken);
    };
    try {
      if (this.options.stageCredentials) {
        await this.options.stageCredentials(serverId,
          [tokenRefFromAccount(accessAccount), ...(refreshToken ? [tokenRefFromAccount(refreshAccount)] : [])], write);
      } else write();
    } catch (error) {
      // Composed writes retain their exact terminal/unknown state for durable cleanup.
      if (!this.options.stageCredentials) this.deleteOwnedAccounts(new Set([accessAccount, refreshAccount]));
      throw error;
    }
    return {
      ...previous,
      accessTokenRef: tokenRefFromAccount(accessAccount),
      refreshTokenRef: refreshToken ? tokenRefFromAccount(refreshAccount) : previous.refreshTokenRef,
      tokenExpiresAt: resolveTokenExpiresAt(response),
      scopes: normalizeScopes(response.scope) ?? previous.scopes,
      resourceIndicator: `mcp://${serverId}`,
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

  private readSecretRef(
    ref: string | undefined,
    serverId: string,
    kind: "access-token" | "refresh-token",
  ): string | undefined {
    if (ref && !isMcpOAuthTokenRefForServer(ref, serverId, kind)) {
      throw new Error("MCP OAuth token reference belongs to a different authority.");
    }
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
  if (stateRecord?.tokenRequest) {
    return {
      authType: "oauth2",
      readiness: "needs_auth",
      error:
        stateRecord.error ??
        "OAuth token request is pending; if it cannot finish, reconnect this server from Settings.",
      updatedAt: stateRecord.updatedAt,
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

/**
 * Readiness states that MUST fail closed at invoke time: the operator has to
 * (re)connect before any tool call can run. `missing_oauth_config` is treated
 * as a configuration error rather than a stale-auth condition — it cannot be
 * fixed by reconnecting — so it is surfaced separately. `not_required` and
 * `ready` flow through to the runtime unchanged.
 */
const INVOKE_BLOCKED_AUTH_READINESS: ReadonlySet<McpOAuthReadiness> = new Set<McpOAuthReadiness>([
  "needs_auth",
  "expired",
]);

/**
 * Whether the given OAuth readiness must block a tool invocation (fail-closed on
 * stale or missing auth). Returns `true` for `needs_auth` / `expired`.
 */
export function isMcpAuthReadinessInvokeBlocked(readiness: McpOAuthReadiness | undefined): boolean {
  return readiness !== undefined && INVOKE_BLOCKED_AUTH_READINESS.has(readiness);
}

/**
 * Resolve the effective OAuth readiness for an MCP server at invoke time.
 *
 * Prefers the already-projected public `authState.readiness` (populated when the
 * server record is read), falling back to recomputing it from the live auth-state
 * record so callers that only hold a raw record still fail closed correctly.
 */
export function resolveMcpInvokeAuthReadiness(
  server: McpServerRecord,
  stateRecord?: McpAuthStateRecord,
): McpOAuthReadiness {
  if (server.authState?.readiness) {
    return server.authState.readiness;
  }
  return buildPublicMcpAuthState(server, stateRecord).readiness;
}

/**
 * Build the actionable, fail-closed error message shown when an MCP tool
 * invocation is rejected because the server's auth is stale or missing.
 */
export function buildMcpStaleAuthInvokeError(
  server: Pick<McpServerRecord, "serverId" | "label">,
  readiness: McpOAuthReadiness,
): string {
  const reason = readiness === "expired" ? "its OAuth token has expired" : "it has not been authenticated";
  return (
    `MCP server ${server.label} (${server.serverId}) needs re-authentication because ${reason}; ` +
    `reconnect it from Settings before invoking its tools.`
  );
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

export function isMcpOAuthTokenRefForServer(
  ref: string,
  serverId: string,
  kind: "access-token" | "refresh-token",
): boolean {
  const base = `keychain:goatcitadel:mcp:${serverId}:${kind}`;
  return (
    ref === base ||
    (ref.startsWith(`${base}:`) &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(ref.slice(base.length + 1)))
  );
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
