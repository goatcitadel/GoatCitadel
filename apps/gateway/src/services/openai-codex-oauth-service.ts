import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { LlmProviderOAuthStatus } from "@goatcitadel/contracts";
import {
  SecretStoreService,
  SecretStoreUnavailableError,
  isSecretStoreUnavailableLikeError,
} from "./secret-store-service.js";
import { readBoundedResponseText } from "./bounded-response-reader.js";

const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
const OPENAI_AUTH_BASE_URL = "https://auth.openai.com";
const OPENAI_CODEX_AUTHORIZE_URL = `${OPENAI_AUTH_BASE_URL}/oauth/authorize`;
const OPENAI_CODEX_TOKEN_URL = `${OPENAI_AUTH_BASE_URL}/oauth/token`;
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_OAUTH_TIMEOUT_MS = 15 * 60_000;
const OPENAI_CODEX_OAUTH_DEFAULT_INTERVAL_MS = 5_000;
const OPENAI_CODEX_OAUTH_MIN_INTERVAL_MS = 1_000;
const OPENAI_CODEX_CALLBACK_HOST = "127.0.0.1";
const OPENAI_CODEX_CALLBACK_PORT = 1455;
const OPENAI_CODEX_CALLBACK_PATH = "/auth/callback";
const OPENAI_CODEX_OAUTH_ACCOUNT = "provider:openai-codex:oauth";
const OPENAI_CODEX_REFRESH_SKEW_MS = 60_000;
const OPENAI_CODEX_SCOPE = "openid profile email offline_access";
const OPENAI_CODEX_AUTH_CLAIM = "https://api.openai.com/auth";
const OPENAI_CODEX_PROFILE_CLAIM = "https://api.openai.com/profile";

export interface OpenAICodexOAuthStatus extends LlmProviderOAuthStatus {
  providerId: typeof OPENAI_CODEX_PROVIDER_ID;
  available: boolean;
}

export interface OpenAICodexDeviceStartResponse {
  flowId: string;
  providerId: typeof OPENAI_CODEX_PROVIDER_ID;
  verificationUrl: string;
  userCode?: string;
  expiresAt: string;
  pollAfterMs: number;
}

export interface OpenAICodexDevicePollResponse {
  flowId: string;
  providerId: typeof OPENAI_CODEX_PROVIDER_ID;
  status: "pending" | "connected" | "expired" | "failed";
  retryAfterMs?: number;
  accountLabel?: string;
  expiresAt?: string;
  requiresReauth?: boolean;
  error?: string;
}

interface OpenAICodexCallbackConfig {
  host: string;
  port: number;
  path: string;
  redirectUri: string;
}

interface PendingDeviceFlow {
  codeVerifier: string;
  state: string;
  authorizationCode?: string;
  error?: string;
  expiresAt: number;
  intervalMs: number;
}

interface OpenAICodexOAuthCredential {
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
  accountLabel?: string;
  updatedAt: number;
  requiresReauth?: boolean;
}

interface OAuthTokenPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

export class OpenAICodexOAuthService {
  private readonly pendingFlows = new Map<string, PendingDeviceFlow>();
  private readonly callbackConfig: OpenAICodexCallbackConfig;
  private callbackServer: Server | null = null;
  private callbackServerStart: Promise<void> | null = null;

  public constructor(
    private readonly secretStore: SecretStoreService,
    private readonly fetchFn: typeof fetch = fetch,
    callbackOptions: Partial<OpenAICodexCallbackConfig> = {},
  ) {
    const port = callbackOptions.port ?? OPENAI_CODEX_CALLBACK_PORT;
    const path = callbackOptions.path ?? OPENAI_CODEX_CALLBACK_PATH;
    this.callbackConfig = {
      host: callbackOptions.host ?? OPENAI_CODEX_CALLBACK_HOST,
      port,
      path,
      redirectUri: callbackOptions.redirectUri ?? `http://localhost:${port}${path}`,
    };
  }

  public getStatus(): OpenAICodexOAuthStatus {
    const available = this.secretStore.isAvailable();
    const credential = this.readCredential();
    return {
      providerId: OPENAI_CODEX_PROVIDER_ID,
      available,
      connected: Boolean(credential?.accessToken && !credential.requiresReauth),
      accountLabel: credential?.accountLabel,
      expiresAt: credential?.expiresAt ? new Date(credential.expiresAt).toISOString() : undefined,
      requiresReauth: credential?.requiresReauth,
    };
  }

  public async startDeviceFlow(): Promise<OpenAICodexDeviceStartResponse> {
    this.assertKeychainAvailable();
    this.purgeExpiredPendingFlows();
    await this.ensureCallbackServer();

    const flowId = randomUUID();
    const state = randomBytes(16).toString("hex");
    const pkce = createPkcePair();
    const expiresAt = Date.now() + OPENAI_CODEX_OAUTH_TIMEOUT_MS;

    this.pendingFlows.set(flowId, {
      codeVerifier: pkce.verifier,
      state,
      expiresAt,
      intervalMs: OPENAI_CODEX_OAUTH_DEFAULT_INTERVAL_MS,
    });

    return {
      flowId,
      providerId: OPENAI_CODEX_PROVIDER_ID,
      verificationUrl: this.buildAuthorizationUrl({ state, codeChallenge: pkce.challenge }),
      expiresAt: new Date(expiresAt).toISOString(),
      pollAfterMs: OPENAI_CODEX_OAUTH_DEFAULT_INTERVAL_MS,
    };
  }

  public async pollDeviceFlow(flowId: string): Promise<OpenAICodexDevicePollResponse> {
    this.assertKeychainAvailable();
    this.purgeExpiredPendingFlows();
    const flow = this.pendingFlows.get(flowId);
    if (!flow) {
      return {
        flowId,
        providerId: OPENAI_CODEX_PROVIDER_ID,
        status: "expired",
        requiresReauth: true,
      };
    }
    if (Date.now() >= flow.expiresAt) {
      this.pendingFlows.delete(flowId);
      return {
        flowId,
        providerId: OPENAI_CODEX_PROVIDER_ID,
        status: "expired",
        requiresReauth: true,
      };
    }
    if (flow.error) {
      this.pendingFlows.delete(flowId);
      return {
        flowId,
        providerId: OPENAI_CODEX_PROVIDER_ID,
        status: "failed",
        requiresReauth: true,
        error: flow.error,
      };
    }
    if (!flow.authorizationCode) {
      return {
        flowId,
        providerId: OPENAI_CODEX_PROVIDER_ID,
        status: "pending",
        retryAfterMs: resolveNextPollDelayMs(flow.intervalMs, flow.expiresAt),
      };
    }

    try {
      const credential = await this.exchangeAuthorizationCode(flow.authorizationCode, flow.codeVerifier);
      this.saveCredential(credential);
      this.pendingFlows.delete(flowId);
      return {
        flowId,
        providerId: OPENAI_CODEX_PROVIDER_ID,
        status: "connected",
        accountLabel: credential.accountLabel,
        expiresAt: credential.expiresAt ? new Date(credential.expiresAt).toISOString() : undefined,
      };
    } catch (error) {
      this.pendingFlows.delete(flowId);
      return {
        flowId,
        providerId: OPENAI_CODEX_PROVIDER_ID,
        status: "failed",
        requiresReauth: true,
        error: (error as Error).message,
      };
    }
  }

  public deleteCredential(): OpenAICodexOAuthStatus {
    this.assertKeychainAvailable();
    this.secretStore.deleteSecret(OPENAI_CODEX_OAUTH_ACCOUNT);
    return this.getStatus();
  }

  public close(): void {
    this.pendingFlows.clear();
    this.callbackServer?.close();
    this.callbackServer = null;
    this.callbackServerStart = null;
  }

  public async resolveAccessToken(): Promise<string> {
    const credential = this.readCredential();
    if (!credential?.accessToken || !credential.refreshToken || credential.requiresReauth) {
      throw new Error("OpenAI Codex OAuth is not connected. Connect ChatGPT OAuth in Settings first.");
    }
    if (!credential.expiresAt || credential.expiresAt > Date.now() + OPENAI_CODEX_REFRESH_SKEW_MS) {
      return credential.accessToken;
    }
    try {
      const refreshed = await this.refreshCredential(credential);
      this.saveCredential(refreshed);
      return refreshed.accessToken;
    } catch (error) {
      this.saveCredential({
        ...credential,
        requiresReauth: true,
        updatedAt: Date.now(),
      });
      throw new Error("OpenAI Codex OAuth token refresh failed. Reconnect ChatGPT OAuth in Settings.", {
        cause: error,
      });
    }
  }

  private assertKeychainAvailable(): void {
    if (!this.secretStore.isAvailable()) {
      throw new SecretStoreUnavailableError("OS keychain backend is required for OpenAI Codex OAuth.");
    }
  }

  private readCredential(): OpenAICodexOAuthCredential | undefined {
    try {
      const raw = this.secretStore.getSecret(OPENAI_CODEX_OAUTH_ACCOUNT);
      if (!raw) {
        return undefined;
      }
      const parsed = parseJsonObject(raw);
      return isOpenAICodexOAuthCredential(parsed) ? parsed : undefined;
    } catch (error) {
      if (isSecretStoreUnavailableLikeError(error)) {
        return undefined;
      }
      return undefined;
    }
  }

  private saveCredential(credential: OpenAICodexOAuthCredential): void {
    this.secretStore.setSecret(OPENAI_CODEX_OAUTH_ACCOUNT, JSON.stringify(credential));
  }

  private async ensureCallbackServer(): Promise<void> {
    if (this.callbackServer?.listening) {
      return;
    }
    if (this.callbackServerStart) {
      return this.callbackServerStart;
    }

    const server = createServer((request, response) => this.handleOAuthCallback(request, response));
    this.callbackServer = server;
    this.callbackServerStart = new Promise((resolve, reject) => {
      const handleError = (error: Error & { code?: unknown }) => {
        server.off("listening", handleListening);
        this.callbackServer = null;
        this.callbackServerStart = null;
        const code = typeof error.code === "string" ? ` (${error.code})` : "";
        reject(
          new Error(
            `OpenAI Codex OAuth could not start the local callback server at http://${this.callbackConfig.host}:${this.callbackConfig.port}${this.callbackConfig.path}${code}. Close anything using that port and start ChatGPT login again.`,
          ),
        );
      };
      const handleListening = () => {
        server.off("error", handleError);
        resolve();
      };
      server.once("error", handleError);
      server.once("listening", handleListening);
      server.listen(this.callbackConfig.port, this.callbackConfig.host);
    });

    return this.callbackServerStart;
  }

  private handleOAuthCallback(request: IncomingMessage, response: ServerResponse): void {
    try {
      const url = new URL(request.url ?? "", "http://localhost");
      if (url.pathname !== this.callbackConfig.path) {
        writeOAuthHtml(response, 404, "OpenAI Codex login", "Callback route not found.");
        return;
      }

      const state = trimNonEmptyString(url.searchParams.get("state"));
      this.purgeExpiredPendingFlows();
      const flowEntry = state ? this.findPendingFlowByState(state) : undefined;
      if (!flowEntry) {
        writeOAuthHtml(response, 400, "OpenAI Codex login", "This login request is no longer active.");
        return;
      }

      const { flowId, flow } = flowEntry;
      if (Date.now() >= flow.expiresAt) {
        this.pendingFlows.delete(flowId);
        writeOAuthHtml(response, 400, "OpenAI Codex login", "This login request expired. Start ChatGPT login again.");
        return;
      }

      const authorizationError = trimNonEmptyString(url.searchParams.get("error"));
      if (authorizationError) {
        const description = trimNonEmptyString(url.searchParams.get("error_description"));
        flow.error = description ? `${authorizationError}: ${description}` : authorizationError;
        writeOAuthHtml(response, 400, "OpenAI Codex login", "OpenAI rejected the login request.");
        return;
      }

      const authorizationCode = trimNonEmptyString(url.searchParams.get("code"));
      if (!authorizationCode) {
        flow.error = "OpenAI callback did not include an authorization code.";
        writeOAuthHtml(response, 400, "OpenAI Codex login", "OpenAI did not return an authorization code.");
        return;
      }

      flow.authorizationCode = authorizationCode;
      writeOAuthHtml(
        response,
        200,
        "OpenAI Codex login complete",
        "OpenAI authentication completed. You can close this window and return to GoatCitadel.",
      );
    } catch {
      writeOAuthHtml(response, 500, "OpenAI Codex login", "Internal error while processing OAuth callback.");
    }
  }

  private findPendingFlowByState(state: string): { flowId: string; flow: PendingDeviceFlow } | undefined {
    for (const [flowId, flow] of this.pendingFlows) {
      if (flow.state === state) {
        return { flowId, flow };
      }
    }
    return undefined;
  }

  private purgeExpiredPendingFlows(now = Date.now()): void {
    for (const [flowId, flow] of this.pendingFlows.entries()) {
      if (now >= flow.expiresAt) {
        this.pendingFlows.delete(flowId);
      }
    }
  }

  private buildAuthorizationUrl(params: { state: string; codeChallenge: string }): string {
    const url = new URL(OPENAI_CODEX_AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", OPENAI_CODEX_CLIENT_ID);
    url.searchParams.set("redirect_uri", this.callbackConfig.redirectUri);
    url.searchParams.set("scope", OPENAI_CODEX_SCOPE);
    url.searchParams.set("code_challenge", params.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", params.state);
    url.searchParams.set("id_token_add_organizations", "true");
    url.searchParams.set("codex_cli_simplified_flow", "true");
    url.searchParams.set("originator", "pi");
    return url.toString();
  }

  private async exchangeAuthorizationCode(
    authorizationCode: string,
    codeVerifier: string,
  ): Promise<OpenAICodexOAuthCredential> {
    const body = await this.postOAuthToken(
      new URLSearchParams({
        grant_type: "authorization_code",
        code: authorizationCode,
        redirect_uri: this.callbackConfig.redirectUri,
        client_id: OPENAI_CODEX_CLIENT_ID,
        code_verifier: codeVerifier,
      }),
      "OpenAI Codex OAuth token exchange failed",
    );
    const accessToken = trimNonEmptyString(body.access_token);
    const refreshToken = trimNonEmptyString(body.refresh_token);
    if (!accessToken || !refreshToken) {
      throw new Error("OpenAI Codex token exchange succeeded but did not return OAuth tokens.");
    }
    return buildCredentialFromTokens({ accessToken, refreshToken, expiresIn: body.expires_in });
  }

  private async refreshCredential(credential: OpenAICodexOAuthCredential): Promise<OpenAICodexOAuthCredential> {
    const body = await this.postOAuthToken(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
        client_id: OPENAI_CODEX_CLIENT_ID,
      }),
      "OpenAI Codex token refresh failed",
    );
    const accessToken = trimNonEmptyString(body.access_token);
    if (!accessToken) {
      throw new Error("OpenAI Codex token refresh did not return an access token.");
    }
    return buildCredentialFromTokens({
      accessToken,
      refreshToken: trimNonEmptyString(body.refresh_token) ?? credential.refreshToken,
      expiresIn: body.expires_in,
    });
  }

  private async postOAuthToken(params: URLSearchParams, prefix: string): Promise<OAuthTokenPayload> {
    const response = await this.fetchFn(OPENAI_CODEX_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
      redirect: "manual",
    });
    const bodyText = await readBoundedResponseText(response, {
      maxBytes: 64 * 1024,
      timeoutMs: 5_000,
      label: "OpenAI Codex OAuth",
    });
    if (!response.ok) {
      throw new Error(formatOpenAIAuthError(prefix, response, bodyText));
    }
    const body = parseJsonObject(bodyText);
    return (body ?? {}) as OAuthTokenPayload;
  }
}

function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function base64Url(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function buildCredentialFromTokens(params: {
  accessToken: string;
  refreshToken: string;
  expiresIn?: unknown;
}): OpenAICodexOAuthCredential {
  const expiresInMs = normalizeTokenLifetimeMs(params.expiresIn);
  const expiresAt =
    expiresInMs !== undefined ? Date.now() + expiresInMs : resolveCodexAccessTokenExpiry(params.accessToken);
  const identity = resolveCodexAuthIdentity(params.accessToken);
  return {
    accessToken: params.accessToken,
    refreshToken: params.refreshToken,
    expiresAt,
    accountLabel: identity.accountLabel,
    updatedAt: Date.now(),
  };
}

function normalizeTokenLifetimeMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value * 1000);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10) * 1000;
  }
  return undefined;
}

function resolveNextPollDelayMs(intervalMs: number, deadlineMs: number): number {
  const remainingMs = Math.max(0, deadlineMs - Date.now());
  return Math.min(Math.max(intervalMs, OPENAI_CODEX_OAUTH_MIN_INTERVAL_MS), remainingMs);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function trimNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sanitizeOAuthErrorText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 400);
}

function formatOpenAIAuthError(prefix: string, response: Response, bodyText: string): string {
  const body = parseJsonObject(bodyText);
  const error = trimNonEmptyString(body?.error);
  const description = trimNonEmptyString(body?.error_description);
  if (error && description) {
    return `${prefix}: ${sanitizeOAuthErrorText(error)} (${sanitizeOAuthErrorText(description)})`;
  }
  if (error) {
    return `${prefix}: ${sanitizeOAuthErrorText(error)}`;
  }
  const snippet = sanitizeOAuthErrorText(bodyText);
  return snippet ? `${prefix}: HTTP ${response.status} ${snippet}` : `${prefix}: HTTP ${response.status}`;
}

function isOpenAICodexOAuthCredential(value: unknown): value is OpenAICodexOAuthCredential {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as OpenAICodexOAuthCredential;
  return typeof candidate.accessToken === "string" && typeof candidate.refreshToken === "string";
}

function resolveCodexAccessTokenExpiry(accessToken: string): number | undefined {
  const payload = decodeCodexJwtPayload(accessToken);
  const exp = normalizeFutureEpochSeconds(payload?.exp);
  return exp ? exp * 1000 : undefined;
}

function resolveCodexAuthIdentity(accessToken: string): { accountLabel?: string } {
  const payload = decodeCodexJwtPayload(accessToken);
  const profile = payload?.[OPENAI_CODEX_PROFILE_CLAIM];
  const email =
    profile && typeof profile === "object" ? trimNonEmptyString((profile as { email?: unknown }).email) : undefined;
  if (email) {
    return { accountLabel: email };
  }

  const auth = payload?.[OPENAI_CODEX_AUTH_CLAIM];
  const chatGptAccountId =
    auth && typeof auth === "object"
      ? trimNonEmptyString((auth as { chatgpt_account_id?: unknown }).chatgpt_account_id)
      : undefined;
  if (chatGptAccountId) {
    return { accountLabel: `chatgpt-${shortHash(chatGptAccountId)}` };
  }

  const sub = trimNonEmptyString(payload?.sub);
  return sub ? { accountLabel: `id-${shortHash(sub)}` } : {};
}

function decodeCodexJwtPayload(accessToken: string): Record<string, unknown> | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3) {
    return null;
  }
  try {
    const decoded = Buffer.from(parts[1] ?? "", "base64url").toString("utf8");
    return parseJsonObject(decoded);
  } catch {
    return null;
  }
}

function normalizeFutureEpochSeconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return undefined;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("base64url").slice(0, 12);
}

function writeOAuthHtml(response: ServerResponse, statusCode: number, title: string, body: string): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #071016; color: #e7f6f2; }
      main { max-width: 520px; padding: 32px; border: 1px solid #1f3d45; background: #0b1720; border-radius: 12px; }
      h1 { margin: 0 0 12px; font-size: 22px; }
      p { margin: 0; color: #b7cbc8; line-height: 1.5; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(body)}</p>
    </main>
  </body>
</html>`);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
