import { randomUUID } from "node:crypto";
import type { LlmProviderOAuthStatus } from "@goatcitadel/contracts";
import {
  SecretStoreService,
  SecretStoreUnavailableError,
  isSecretStoreUnavailableLikeError,
} from "./secret-store-service.js";

const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
const OPENAI_AUTH_BASE_URL = "https://auth.openai.com";
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_DEVICE_CODE_TIMEOUT_MS = 15 * 60_000;
const OPENAI_CODEX_DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000;
const OPENAI_CODEX_DEVICE_CODE_MIN_INTERVAL_MS = 1_000;
const OPENAI_CODEX_DEVICE_CALLBACK_URL = `${OPENAI_AUTH_BASE_URL}/deviceauth/callback`;
const OPENAI_CODEX_OAUTH_ACCOUNT = "provider:openai-codex:oauth";
const OPENAI_CODEX_REFRESH_SKEW_MS = 60_000;

export interface OpenAICodexOAuthStatus extends LlmProviderOAuthStatus {
  providerId: typeof OPENAI_CODEX_PROVIDER_ID;
  available: boolean;
}

export interface OpenAICodexDeviceStartResponse {
  flowId: string;
  providerId: typeof OPENAI_CODEX_PROVIDER_ID;
  verificationUrl: string;
  userCode: string;
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

interface PendingDeviceFlow {
  deviceAuthId: string;
  userCode: string;
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

interface DeviceCodeUserCodePayload {
  device_auth_id?: unknown;
  user_code?: unknown;
  usercode?: unknown;
  interval?: unknown;
}

interface DeviceCodeTokenPayload {
  authorization_code?: unknown;
  code_verifier?: unknown;
}

interface OAuthTokenPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

export class OpenAICodexOAuthService {
  private readonly pendingFlows = new Map<string, PendingDeviceFlow>();

  public constructor(
    private readonly secretStore: SecretStoreService,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

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
    const response = await this.fetchFn(`${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: OPENAI_CODEX_CLIENT_ID,
      }),
      redirect: "manual",
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(formatOpenAIAuthError("OpenAI Codex device-code start failed", response, bodyText));
    }

    const body = parseJsonObject(bodyText) as DeviceCodeUserCodePayload | null;
    const deviceAuthId = trimNonEmptyString(body?.device_auth_id);
    const userCode = trimNonEmptyString(body?.user_code) ?? trimNonEmptyString(body?.usercode);
    if (!deviceAuthId || !userCode) {
      throw new Error("OpenAI Codex device-code response was missing the device id or user code.");
    }

    const flowId = randomUUID();
    const intervalMs = normalizePositiveMilliseconds(body?.interval) ?? OPENAI_CODEX_DEVICE_CODE_DEFAULT_INTERVAL_MS;
    const expiresAt = Date.now() + OPENAI_CODEX_DEVICE_CODE_TIMEOUT_MS;
    this.pendingFlows.set(flowId, {
      deviceAuthId,
      userCode,
      expiresAt,
      intervalMs,
    });

    return {
      flowId,
      providerId: OPENAI_CODEX_PROVIDER_ID,
      verificationUrl: `${OPENAI_AUTH_BASE_URL}/codex/device`,
      userCode,
      expiresAt: new Date(expiresAt).toISOString(),
      pollAfterMs: intervalMs,
    };
  }

  public async pollDeviceFlow(flowId: string): Promise<OpenAICodexDevicePollResponse> {
    this.assertKeychainAvailable();
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

    const response = await this.fetchFn(`${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        device_auth_id: flow.deviceAuthId,
        user_code: flow.userCode,
      }),
      redirect: "manual",
    });
    const bodyText = await response.text();
    if (response.status === 403 || response.status === 404) {
      return {
        flowId,
        providerId: OPENAI_CODEX_PROVIDER_ID,
        status: "pending",
        retryAfterMs: resolveNextPollDelayMs(flow.intervalMs, flow.expiresAt),
      };
    }
    if (!response.ok) {
      return {
        flowId,
        providerId: OPENAI_CODEX_PROVIDER_ID,
        status: "failed",
        requiresReauth: true,
        error: formatOpenAIAuthError("OpenAI Codex device authorization failed", response, bodyText),
      };
    }

    const body = parseJsonObject(bodyText) as DeviceCodeTokenPayload | null;
    const authorizationCode = trimNonEmptyString(body?.authorization_code);
    const codeVerifier = trimNonEmptyString(body?.code_verifier);
    if (!authorizationCode || !codeVerifier) {
      return {
        flowId,
        providerId: OPENAI_CODEX_PROVIDER_ID,
        status: "failed",
        requiresReauth: true,
        error: "OpenAI Codex device authorization response was missing the exchange code.",
      };
    }

    try {
      const credential = await this.exchangeAuthorizationCode(authorizationCode, codeVerifier);
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

  private async exchangeAuthorizationCode(
    authorizationCode: string,
    codeVerifier: string,
  ): Promise<OpenAICodexOAuthCredential> {
    const body = await this.postOAuthToken(
      new URLSearchParams({
        grant_type: "authorization_code",
        code: authorizationCode,
        redirect_uri: OPENAI_CODEX_DEVICE_CALLBACK_URL,
        client_id: OPENAI_CODEX_CLIENT_ID,
        code_verifier: codeVerifier,
      }),
      "OpenAI Codex device token exchange failed",
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
    const response = await this.fetchFn(`${OPENAI_AUTH_BASE_URL}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
      redirect: "manual",
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(formatOpenAIAuthError(prefix, response, bodyText));
    }
    const body = parseJsonObject(bodyText);
    return (body ?? {}) as OAuthTokenPayload;
  }
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

function normalizePositiveMilliseconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value * 1000);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const seconds = Number.parseInt(value.trim(), 10);
    return seconds > 0 ? seconds * 1000 : undefined;
  }
  return undefined;
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
  return Math.min(Math.max(intervalMs, OPENAI_CODEX_DEVICE_CODE_MIN_INTERVAL_MS), remainingMs);
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
  const profile = payload?.["https://api.openai.com/profile"];
  const email =
    profile && typeof profile === "object" ? trimNonEmptyString((profile as { email?: unknown }).email) : undefined;
  if (email) {
    return { accountLabel: email };
  }
  const sub = trimNonEmptyString(payload?.sub);
  return sub ? { accountLabel: `id-${Buffer.from(sub).toString("base64url").slice(0, 12)}` } : {};
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
