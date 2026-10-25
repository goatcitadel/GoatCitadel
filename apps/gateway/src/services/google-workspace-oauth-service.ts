import { randomUUID } from "node:crypto";
import {
  ConflictError,
  GOOGLE_WORKSPACE_CAPABILITIES,
  GOOGLE_WORKSPACE_CAPABILITY_DEFINITIONS,
  GOOGLE_WORKSPACE_CATALOG_ID,
  ValidationError,
  getGoogleWorkspaceCapability,
  googleWorkspaceCapabilityForTool,
  googleWorkspaceScopesFor,
  isGoogleWorkspaceCapability,
  isGoogleWorkspaceCapabilityGranted,
  readEnabledGoogleWorkspaceCapabilities,
  type GoogleWorkspaceCapability,
  type GoogleWorkspaceClientSecretSource,
  type GoogleWorkspaceOAuthCompleteInput,
  type GoogleWorkspaceOAuthDisconnectResult,
  type GoogleWorkspaceOAuthStartInput,
  type GoogleWorkspaceOAuthStartResponse,
  type GoogleWorkspaceOAuthStatus,
  type IntegrationConnection,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { McpOAuthPkceStore } from "./mcp-oauth-discovery.js";
import { SecretStoreUnavailableError, isSecretStoreUnavailableLikeError } from "./secret-store-service.js";
import { isPermittedIntegrationSecretEnvVarName } from "./gateway/integration-secret-envvar-guard.js";
import {
  GOOGLE_AUTHORIZE_URL,
  GoogleOAuthClient,
  describeGoogleOAuthError,
  type GoogleOAuthLedgerStorage,
  type GoogleOAuthResponse,
} from "./google-workspace-oauth-client.js";

export const GOOGLE_OAUTH_CALLBACK_PATH = "/api/v1/integrations/google/oauth/callback";
const REFRESH_SKEW_MS = 5 * 60_000;
const FLOW_TTL_MS = 10 * 60_000;
const MAX_CLIENT_SECRET_CHARS = 512;
const CONNECTION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/;
const REAUTH_ERRORS = new Set(["invalid_grant", "invalid_client", "unauthorized_client"]);
const SETTINGS_PATH = "Settings › Connections › Integrations";
// Google sends `expires_in`; when it does not, assume its documented one-hour lifetime.
const DEFAULT_ACCESS_TOKEN_LIFETIME_MS = 60 * 60_000;

/** What the OS keychain holds for one connection. Only this service reads or writes it. */
interface GoogleWorkspaceCredential {
  version: 1;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
  grantedScopes: string[];
  accountLabel?: string;
  updatedAt: number;
  lastRefreshedAt?: number;
  requiresReauth?: boolean;
}

interface PendingGoogleFlow {
  state: string;
  clientId: string;
  redirectUri: string;
  capabilities: GoogleWorkspaceCapability[];
  scopes: string[];
  expiresAt: number;
}

type SecretStorePort = {
  isAvailable(): boolean;
  getSecret(account: string): string | undefined;
  setSecret(account: string, secret: string): void;
  deleteSecret(account: string): void;
};

export interface GoogleWorkspaceOAuthServiceOptions {
  secretStore: SecretStorePort;
  storage: GoogleOAuthLedgerStorage & Pick<AsyncStorage, "integrationConnections">;
  fetchFn?: typeof fetch;
  now?: () => number;
  /** Default loopback redirect; a connection may override it with `redirectUri`. */
  defaultRedirectUri?: string;
}

export function defaultGoogleOAuthRedirectUri(env: NodeJS.ProcessEnv = process.env): string {
  const port = Number(env.GATEWAY_PORT?.trim() || 8787);
  return `http://127.0.0.1:${Number.isInteger(port) && port > 0 && port < 65536 ? port : 8787}${GOOGLE_OAUTH_CALLBACK_PATH}`;
}

/**
 * Native Google sign-in for the Gmail and Calendar tools: Google's installed-app flow
 * (authorization code + PKCE S256 + loopback redirect), refresh before expiry, and revocation.
 * Tokens and the client secret live only in the OS keychain; connection config keeps the public
 * client ID and the per-capability switches.
 */
export class GoogleWorkspaceOAuthService {
  private readonly secretStore: SecretStorePort;
  private readonly connections: Pick<AsyncStorage["integrationConnections"], "get" | "update">;
  private readonly client: GoogleOAuthClient;
  private readonly now: () => number;
  private readonly defaultRedirectUri: string;
  private readonly pkce: McpOAuthPkceStore;
  private readonly flows = new Map<string, PendingGoogleFlow>();
  private readonly refreshes = new Map<string, Promise<void>>();
  /** Bumped by Disconnect: a completion that started earlier can no longer save its grant. */
  private readonly signOuts = new Map<string, number>();

  public constructor(options: GoogleWorkspaceOAuthServiceOptions) {
    const { secretStore, storage, fetchFn, now, defaultRedirectUri } = options;
    this.secretStore = secretStore;
    this.connections = storage.integrationConnections;
    this.client = new GoogleOAuthClient(storage, fetchFn);
    this.now = now ?? Date.now;
    this.defaultRedirectUri = defaultRedirectUri ?? defaultGoogleOAuthRedirectUri();
    this.pkce = new McpOAuthPkceStore(this.now);
  }

  public async getStatus(connectionId: string): Promise<GoogleWorkspaceOAuthStatus> {
    const connection = await this.requireConnection(connectionId);
    const keychainAvailable = this.keychainAvailable();
    const credential = keychainAvailable ? this.readCredential(connectionId) : undefined;
    const clientId = readClientId(connection.config);
    const enabled = readEnabledGoogleWorkspaceCapabilities(connection.config);
    const grantedScopes = credential?.grantedScopes ?? [];
    const sameClient = Boolean(credential && clientId && credential.clientId === clientId);
    return {
      connectionId,
      keychainAvailable,
      clientIdConfigured: Boolean(clientId),
      clientSecretSource: keychainAvailable ? this.clientSecretSource(connection) : envSecretSource(connection),
      redirectUri: this.redirectUriFor(connection),
      connected: Boolean(credential && sameClient && !credential.requiresReauth),
      requiresReauth: Boolean(credential && (!sameClient || credential.requiresReauth)),
      ...(credential?.accountLabel ? { accountLabel: credential.accountLabel } : {}),
      grantedScopes,
      ...(credential?.expiresAt ? { accessTokenExpiresAt: new Date(credential.expiresAt).toISOString() } : {}),
      ...(credential?.lastRefreshedAt ? { lastRefreshedAt: new Date(credential.lastRefreshedAt).toISOString() } : {}),
      capabilities: GOOGLE_WORKSPACE_CAPABILITY_DEFINITIONS.map((item) => ({
        capability: item.capability,
        scope: item.scope,
        write: item.write,
        enabled: enabled.includes(item.capability),
        granted: isGoogleWorkspaceCapabilityGranted(item.capability, grantedScopes),
      })),
      legacyAccessTokenConfigured: Boolean(
        readText(connection.config, "accessToken") || readText(connection.config, "accessTokenEnv"),
      ),
    };
  }

  /** Builds Google's consent URL for exactly the reviewed capabilities. Nothing leaves GoatCitadel here. */
  public async start(
    connectionId: string,
    input: GoogleWorkspaceOAuthStartInput,
  ): Promise<GoogleWorkspaceOAuthStartResponse> {
    const connection = await this.requireConnection(connectionId);
    this.assertKeychainAvailable();
    const capabilities = normalizeCapabilities(input.capabilities);
    const clientId = readClientId(connection.config);
    if (!clientId) {
      throw new ValidationError({
        field: "clientId",
        message: "Save the OAuth client ID of a Google Cloud Desktop app client on this connection first.",
      });
    }
    const clientSecret = input.clientSecret?.trim();
    if (clientSecret) {
      if (clientSecret.length > MAX_CLIENT_SECRET_CHARS || /[\s\p{Cc}]/u.test(clientSecret)) {
        throw new ValidationError({ field: "clientSecret", message: "That is not a Google OAuth client secret." });
      }
      this.writeSecret(clientSecretAccount(connectionId), clientSecret);
    }
    if (!this.resolveClientSecret(connection)) {
      throw new ValidationError({
        field: "clientSecret",
        message: "Add the client secret of the same Google Cloud Desktop app client before connecting.",
      });
    }
    const redirectUri = this.redirectUriFor(connection);
    const scopes = googleWorkspaceScopesFor(capabilities);
    const state = randomUUID();
    const pkce = this.pkce.create();
    const url = new URL(GOOGLE_AUTHORIZE_URL);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("access_type", "offline");
    // Installed apps get no incremental consent: every connect asks for the full reviewed set and a fresh refresh token.
    url.searchParams.set("prompt", "consent");
    const expiresAt = this.now() + FLOW_TTL_MS;
    this.flows.set(connectionId, { state, clientId, redirectUri, capabilities, scopes, expiresAt });
    this.pkce.remember(connectionId, state, pkce.verifier);
    return {
      connectionId,
      state,
      authorizeUrl: url.toString(),
      redirectUri,
      capabilities,
      scopes,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /** Exchanges the code from Google's redirect for tokens and records what Google actually granted. */
  public async complete(
    connectionId: string,
    input: GoogleWorkspaceOAuthCompleteInput,
  ): Promise<GoogleWorkspaceOAuthStatus> {
    const connection = await this.requireConnection(connectionId);
    this.assertKeychainAvailable();
    const flow = this.flows.get(connectionId);
    const verifier = this.pkce.read(connectionId, input.state);
    if (!flow || flow.state !== input.state || flow.expiresAt <= this.now() || !verifier) {
      throw new ConflictError({ message: "This Google sign-in is no longer pending. Start Connect Google again." });
    }
    // One use only: a replayed or late code can never reach Google twice.
    this.dropPendingFlow(connectionId);
    const signOut = this.signOuts.get(connectionId) ?? 0;
    if (readClientId(connection.config) !== flow.clientId) {
      throw new ConflictError({ message: "The OAuth client ID changed during sign-in. Start Connect Google again." });
    }
    const clientSecret = this.requireClientSecret(connection);
    const response = await this.client.exchange(connectionId, {
      code: input.code,
      client_id: flow.clientId,
      client_secret: clientSecret,
      redirect_uri: flow.redirectUri,
      code_verifier: verifier,
    });
    if (!response.ok) {
      throw new ValidationError({ message: `Google did not issue tokens (${describeGoogleOAuthError(response)}).` });
    }
    const tokens = readTokenResponse(response);
    if (!tokens.accessToken || !tokens.refreshToken) {
      throw new ValidationError({
        message:
          "Google returned no refresh token. Remove GoatCitadel under Third-party access in your Google Account, then connect again.",
      });
    }
    const grantedScopes = tokens.scopes ?? flow.scopes;
    const now = this.now();
    const accountLabel = isGoogleWorkspaceCapabilityGranted("gmail.read", grantedScopes)
      ? await this.client.readGmailAddress(tokens.accessToken)
      : undefined;
    if ((this.signOuts.get(connectionId) ?? 0) !== signOut) {
      // Disconnect won while Google answered: keep nothing and end the grant Google just issued.
      const { revoked } = await this.revokeGrant(connectionId, tokens.refreshToken);
      throw new ConflictError({
        message: `Google was disconnected before this sign-in finished, so nothing was saved${revoked ? " and Google ended the new grant" : ""}. Connect Google again if needed.`,
      });
    }
    this.saveCredential(connectionId, {
      version: 1,
      clientId: flow.clientId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt(now) ?? now + DEFAULT_ACCESS_TOKEN_LIFETIME_MS,
      grantedScopes,
      ...(accountLabel ? { accountLabel } : {}),
      updatedAt: now,
    });
    await this.updateConnection(connectionId, (current) => ({
      status: "connected",
      lastError: null,
      config: {
        ...current.config,
        ...Object.fromEntries(
          GOOGLE_WORKSPACE_CAPABILITY_DEFINITIONS.map((item) => [
            item.configKey,
            flow.capabilities.includes(item.capability) &&
              isGoogleWorkspaceCapabilityGranted(item.capability, grantedScopes),
          ]),
        ),
      },
    }));
    return await this.getStatus(connectionId);
  }

  /** Revokes the grant at Google, then always removes the local sign-in. The client secret stays for reconnecting. */
  public async disconnect(connectionId: string): Promise<GoogleWorkspaceOAuthDisconnectResult> {
    await this.requireConnection(connectionId);
    this.assertKeychainAvailable();
    this.signOut(connectionId);
    const { revoked, message } = await this.revokeAndForget(connectionId);
    await this.updateConnection(connectionId, () => ({ status: "disconnected", lastError: null }));
    return { status: await this.getStatus(connectionId), revoked, message };
  }

  /** Cleanup after the connection itself was deleted: revoke when possible and remove every keychain entry. */
  public async forgetConnection(connectionId: string): Promise<void> {
    if (!CONNECTION_ID_PATTERN.test(connectionId) || !this.keychainAvailable()) return;
    this.signOut(connectionId);
    await this.revokeAndForget(connectionId);
    this.removeSecret(clientSecretAccount(connectionId));
  }

  /** The integrations route methods, bound to this owner. */
  public routeMethods() {
    return {
      getGoogleWorkspaceOAuthStatus: (connectionId: string) => this.getStatus(connectionId),
      startGoogleWorkspaceOAuth: (connectionId: string, input: GoogleWorkspaceOAuthStartInput) =>
        this.start(connectionId, input),
      completeGoogleWorkspaceOAuth: (connectionId: string, input: GoogleWorkspaceOAuthCompleteInput) =>
        this.complete(connectionId, input),
      disconnectGoogleWorkspaceOAuth: (connectionId: string) => this.disconnect(connectionId),
    };
  }

  /**
   * Deletes a connection through `remove`, then revokes and forgets its Google sign-in when it was a
   * Google connection. A cleanup failure is reported and never undoes or fails the delete.
   */
  public async deleteConnection<T>(
    connectionId: string,
    remove: () => Promise<T>,
    onCleanupFailure: (error: unknown) => void,
  ): Promise<T> {
    const catalogId = await this.readConnection(connectionId).then(
      (connection) => connection.catalogId,
      () => undefined,
    );
    const deleted = await remove();
    if (catalogId === GOOGLE_WORKSPACE_CATALOG_ID) {
      try {
        await this.forgetConnection(connectionId);
      } catch (error) {
        onCleanupFailure(error);
      }
    }
    return deleted;
  }

  /** The tool executor's hook: an access token for the capability that `toolName` needs. */
  public async resolveToolAccessToken(input: { connectionId: string; toolName: string }): Promise<string> {
    const capability = googleWorkspaceCapabilityForTool(input.toolName);
    if (!capability) throw new Error(`blocked: ${input.toolName} is not a Google Workspace tool.`);
    return await this.resolveAccessToken(input.connectionId, capability);
  }

  /**
   * Checks the capability switch, the stored grant and its client, then returns a token that is
   * valid for at least five more minutes. Every refusal says `blocked:` so the comms executor
   * records it before any provider request.
   */
  public async resolveAccessToken(connectionId: string, capability: GoogleWorkspaceCapability): Promise<string> {
    return await this.resolveCheckedAccessToken(connectionId, capability, false);
  }

  private async resolveCheckedAccessToken(
    connectionId: string,
    capability: GoogleWorkspaceCapability,
    renewed: boolean,
  ): Promise<string> {
    const connection = await this.readConnection(connectionId);
    if (connection.catalogId !== GOOGLE_WORKSPACE_CATALOG_ID) {
      throw new Error("blocked: This connection is not a Google Workspace (Gmail and Calendar) connection.");
    }
    const definition = getGoogleWorkspaceCapability(capability);
    if (!readEnabledGoogleWorkspaceCapabilities(connection.config).includes(capability)) {
      throw new Error(
        `blocked: ${definition.label} is turned off for this Google connection. Turn it on in ${SETTINGS_PATH} and connect Google again.`,
      );
    }
    if (!this.keychainAvailable()) {
      throw new Error("blocked: The OS keychain that holds the Google sign-in is unavailable.");
    }
    const credential = this.readCredential(connectionId);
    if (!credential) {
      throw new Error(`blocked: Google sign-in is missing for this connection. Connect Google in ${SETTINGS_PATH}.`);
    }
    if (credential.requiresReauth || credential.clientId !== readClientId(connection.config)) {
      throw new Error(`blocked: Google sign-in needs to be renewed. Reconnect Google in ${SETTINGS_PATH}.`);
    }
    if (!isGoogleWorkspaceCapabilityGranted(capability, credential.grantedScopes)) {
      throw new Error(
        `blocked: Google did not grant ${definition.label} (${definition.scope}). Reconnect Google and allow it.`,
      );
    }
    if (credential.expiresAt && credential.expiresAt > this.now() + REFRESH_SKEW_MS) {
      return credential.accessToken;
    }
    if (renewed) {
      throw new Error(
        `blocked: Google sign-in changed while it was renewed. Try again, or reconnect Google in ${SETTINGS_PATH}.`,
      );
    }
    await this.refreshOnce(connection, credential);
    // Re-check this caller's capability, client and grant against whatever is stored now: a reconnect
    // during the refresh may have replaced the sign-in with different switches or scopes.
    return await this.resolveCheckedAccessToken(connectionId, capability, true);
  }

  /** Single flight per connection: concurrent tool calls share one refresh request. */
  private refreshOnce(connection: IntegrationConnection, credential: GoogleWorkspaceCredential): Promise<void> {
    const inflight = this.refreshes.get(connection.connectionId);
    if (inflight) return inflight;
    const pending = this.refresh(connection, credential).finally(() => this.refreshes.delete(connection.connectionId));
    this.refreshes.set(connection.connectionId, pending);
    return pending;
  }

  /** Saves the renewed token when the sign-in it renewed is still the stored one; callers re-check afterwards. */
  private async refresh(connection: IntegrationConnection, credential: GoogleWorkspaceCredential): Promise<void> {
    const connectionId = connection.connectionId;
    const clientSecret = this.resolveClientSecret(connection);
    if (!clientSecret) {
      throw new Error(`blocked: The Google OAuth client secret is missing. Add it in ${SETTINGS_PATH}.`);
    }
    const response = await this.client.refresh(connectionId, {
      refresh_token: credential.refreshToken,
      client_id: credential.clientId,
      client_secret: clientSecret,
    });
    if (!response.ok) {
      const reason = describeGoogleOAuthError(response);
      if (REAUTH_ERRORS.has(String(response.body.error)) && this.isStillStored(connectionId, credential)) {
        this.saveCredential(connectionId, { ...credential, requiresReauth: true, updatedAt: this.now() });
        throw new Error(
          `blocked: Google refused to renew the sign-in (${reason}). Reconnect Google in ${SETTINGS_PATH}.`,
        );
      }
      throw new Error(`Google token refresh failed (${reason}). Try again shortly.`);
    }
    const tokens = readTokenResponse(response);
    if (!tokens.accessToken) throw new Error("Google token refresh returned no access token. Try again shortly.");
    // A reconnect or disconnect replaced the sign-in mid-refresh: the newer state wins.
    if (!this.isStillStored(connectionId, credential)) return;
    const now = this.now();
    this.saveCredential(connectionId, {
      ...credential,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? credential.refreshToken,
      grantedScopes: tokens.scopes ?? credential.grantedScopes,
      expiresAt: tokens.expiresAt(now) ?? now + DEFAULT_ACCESS_TOKEN_LIFETIME_MS,
      updatedAt: now,
      lastRefreshedAt: now,
    });
  }

  private async revokeAndForget(connectionId: string): Promise<{ revoked: boolean; message: string }> {
    const credential = this.readCredential(connectionId);
    if (!credential) return { revoked: false, message: "No Google sign-in was stored for this connection." };
    let outcome: { revoked: boolean; message: string };
    try {
      const { revoked, reason } = await this.revokeGrant(connectionId, credential.refreshToken);
      outcome = revoked
        ? { revoked: true, message: "Google ended GoatCitadel's access for this account." }
        : { revoked: false, message: revokeFallbackMessage(reason) };
    } catch (error) {
      outcome = {
        revoked: false,
        message: revokeFallbackMessage(error instanceof Error ? error.message : "network error"),
      };
    }
    // The local sign-in goes regardless: the operator asked to disconnect.
    this.removeSecret(credentialAccount(connectionId));
    return outcome;
  }

  /** RFC 7009 revocation. A transport failure propagates; Google's refusal is returned as its reason. */
  private async revokeGrant(connectionId: string, token: string): Promise<{ revoked: boolean; reason: string }> {
    const response = await this.client.revoke(connectionId, token);
    // 400 invalid_token means Google already ended this grant.
    return response.ok || response.body.error === "invalid_token"
      ? { revoked: true, reason: "" }
      : { revoked: false, reason: describeGoogleOAuthError(response) };
  }

  /** Forgets any pending Connect for this connection and fences completions that already started. */
  private signOut(connectionId: string): void {
    this.dropPendingFlow(connectionId);
    this.signOuts.set(connectionId, (this.signOuts.get(connectionId) ?? 0) + 1);
  }

  private dropPendingFlow(connectionId: string): void {
    this.flows.delete(connectionId);
    this.pkce.discard(connectionId);
  }

  private async requireConnection(connectionId: string): Promise<IntegrationConnection> {
    if (!CONNECTION_ID_PATTERN.test(connectionId)) {
      throw new ValidationError({ field: "connectionId", message: "Unknown integration connection." });
    }
    const connection = await this.readConnection(connectionId);
    if (connection.catalogId !== GOOGLE_WORKSPACE_CATALOG_ID) {
      throw new ValidationError({
        field: "connectionId",
        message: "Google sign-in is only available on a Gmail and Google Calendar connection.",
      });
    }
    return connection;
  }

  private async updateConnection(
    connectionId: string,
    patch: (current: IntegrationConnection) => {
      status: IntegrationConnection["status"];
      lastError: null;
      config?: Record<string, unknown>;
    },
  ): Promise<void> {
    const current = await this.readConnection(connectionId);
    await this.connections.update(connectionId, {
      expectedRevision: current.revision,
      ...patch(current),
    });
  }

  private assertKeychainAvailable(): void {
    if (!this.keychainAvailable()) {
      throw new SecretStoreUnavailableError("The OS keychain is required to keep a Google sign-in.");
    }
  }

  private redirectUriFor(connection: IntegrationConnection): string {
    const configured = readText(connection.config, "redirectUri");
    return configured && isLoopbackCallback(configured) ? configured : this.defaultRedirectUri;
  }

  private clientSecretSource(connection: IntegrationConnection): GoogleWorkspaceClientSecretSource {
    return this.readSecret(clientSecretAccount(connection.connectionId)) ? "keychain" : envSecretSource(connection);
  }

  private resolveClientSecret(connection: IntegrationConnection): string | undefined {
    return this.readSecret(clientSecretAccount(connection.connectionId)) ?? readEnvClientSecret(connection);
  }

  private requireClientSecret(connection: IntegrationConnection): string {
    const secret = this.resolveClientSecret(connection);
    if (!secret) {
      throw new ValidationError({ field: "clientSecret", message: "The Google OAuth client secret is missing." });
    }
    return secret;
  }

  private keychainAvailable(): boolean {
    return this.secretStore.isAvailable();
  }

  private writeSecret(account: string, value: string): void {
    this.secretStore.setSecret(account, value);
  }

  private removeSecret(account: string): void {
    this.secretStore.deleteSecret(account);
  }

  private readConnection(connectionId: string): Promise<IntegrationConnection> {
    return this.connections.get(connectionId);
  }

  private readSecret(account: string): string | undefined {
    try {
      return this.secretStore.getSecret(account)?.trim() || undefined;
    } catch (error) {
      if (isSecretStoreUnavailableLikeError(error)) return undefined;
      throw error;
    }
  }

  private readCredential(connectionId: string): GoogleWorkspaceCredential | undefined {
    const raw = this.readSecret(credentialAccount(connectionId));
    if (!raw) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isCredential(parsed) ? parsed : undefined;
    } catch {
      // A damaged keychain entry reads as no sign-in; connecting again replaces it.
      return undefined;
    }
  }

  private saveCredential(connectionId: string, credential: GoogleWorkspaceCredential): void {
    this.writeSecret(credentialAccount(connectionId), JSON.stringify(credential));
  }

  private isStillStored(connectionId: string, credential: GoogleWorkspaceCredential): boolean {
    const current = this.readCredential(connectionId);
    return (
      current?.refreshToken === credential.refreshToken &&
      current.accessToken === credential.accessToken &&
      !current.requiresReauth
    );
  }
}

function credentialAccount(connectionId: string): string {
  return `integration:google-workspace:${connectionId}:oauth`;
}

function clientSecretAccount(connectionId: string): string {
  return `integration:google-workspace:${connectionId}:client-secret`;
}

function readText(config: Record<string, unknown>, key: string): string | undefined {
  const value = Object.hasOwn(config, key) ? config[key] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readClientId(config: Record<string, unknown>): string | undefined {
  const clientId = readText(config, "clientId");
  return clientId && /^[A-Za-z0-9._-]{8,256}$/u.test(clientId) ? clientId : undefined;
}

function readEnvClientSecret(connection: IntegrationConnection): string | undefined {
  const envName = readText(connection.config, "clientSecretEnv");
  if (!envName || !isPermittedIntegrationSecretEnvVarName(envName, connection.catalogId)) return undefined;
  return process.env[envName]?.trim() || undefined;
}

function envSecretSource(connection: IntegrationConnection): GoogleWorkspaceClientSecretSource {
  return readEnvClientSecret(connection) ? "env" : "none";
}

/** A loopback HTTP redirect to this Gateway's callback path, the only redirect a Desktop app client may use. */
function isLoopbackCallback(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) &&
      url.pathname === GOOGLE_OAUTH_CALLBACK_PATH &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function normalizeCapabilities(value: unknown): GoogleWorkspaceCapability[] {
  const requested = Array.isArray(value) ? value : [];
  if (!requested.length || !requested.every(isGoogleWorkspaceCapability)) {
    throw new ValidationError({
      field: "capabilities",
      message: "Choose at least one of Gmail read, Gmail send, Calendar read or Calendar write.",
    });
  }
  return GOOGLE_WORKSPACE_CAPABILITIES.filter((capability) => requested.includes(capability));
}

function readTokenResponse(response: GoogleOAuthResponse) {
  const text = (key: string) => {
    const value = response.body[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const expiresIn = Number(response.body.expires_in);
  const scopes = text("scope")?.split(/\s+/u).filter(Boolean);
  return {
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    scopes: scopes?.length ? scopes : undefined,
    expiresAt: (now: number) => (Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : undefined),
  };
}

function revokeFallbackMessage(reason: string): string {
  return `GoatCitadel removed its stored sign-in, but Google did not confirm the revocation (${reason}). Remove GoatCitadel under Third-party access in your Google Account to be sure.`;
}

function isCredential(value: unknown): value is GoogleWorkspaceCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.clientId === "string" &&
    typeof record.accessToken === "string" &&
    typeof record.refreshToken === "string" &&
    Array.isArray(record.grantedScopes) &&
    record.grantedScopes.every((scope) => typeof scope === "string")
  );
}
