import type { OpenAICodexDeviceStartResponse } from "@goatcitadel/mission-control-shared/api/client";

const OPENAI_CODEX_OAUTH_FLOW_STORAGE_KEY = "goatcitadel:openai-codex:oauth-flow";

const OPENAI_CODEX_AUTH_HOST = "auth.openai.com";

export const OPENAI_CODEX_MIN_POLL_MS = 1_000;

const OPENAI_CODEX_DEFAULT_POLL_MS = 5_000;

export function isTrustedOpenAICodexVerificationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === OPENAI_CODEX_AUTH_HOST;
  } catch {
    return false;
  }
}

export function normalizeOpenAICodexPollDelayMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(value, OPENAI_CODEX_MIN_POLL_MS)
    : OPENAI_CODEX_DEFAULT_POLL_MS;
}

export function isStoredOpenAICodexOAuthFlow(value: unknown): value is OpenAICodexDeviceStartResponse {
  const candidate = value as OpenAICodexDeviceStartResponse;
  const expiresAt = Date.parse(candidate?.expiresAt);
  const userCode = candidate?.userCode;
  return (
    candidate?.providerId === "openai-codex" &&
    typeof candidate.flowId === "string" &&
    candidate.flowId.trim().length > 0 &&
    typeof candidate.verificationUrl === "string" &&
    isTrustedOpenAICodexVerificationUrl(candidate.verificationUrl) &&
    (userCode === undefined || (typeof userCode === "string" && userCode.trim().length > 0)) &&
    typeof candidate.expiresAt === "string" &&
    Number.isFinite(expiresAt) &&
    expiresAt > Date.now() &&
    typeof candidate.pollAfterMs === "number" &&
    Number.isFinite(candidate.pollAfterMs) &&
    candidate.pollAfterMs > 0
  );
}

export function removeStoredOpenAICodexOAuthFlow(storage: Storage | undefined): void {
  try {
    storage?.removeItem(OPENAI_CODEX_OAUTH_FLOW_STORAGE_KEY);
  } catch {
    // Ignore unavailable browser storage.
  }
}

function getBrowserStorage(kind: "localStorage" | "sessionStorage"): Storage | undefined {
  try {
    return globalThis[kind];
  } catch {
    return undefined;
  }
}

export function readStoredOpenAICodexOAuthFlowFrom(
  storage: Storage | undefined,
): OpenAICodexDeviceStartResponse | null {
  try {
    const raw = storage?.getItem(OPENAI_CODEX_OAUTH_FLOW_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isStoredOpenAICodexOAuthFlow(parsed)) {
      removeStoredOpenAICodexOAuthFlow(storage);
      return null;
    }
    return parsed;
  } catch {
    removeStoredOpenAICodexOAuthFlow(storage);
    return null;
  }
}

export function readStoredOpenAICodexOAuthFlow(): OpenAICodexDeviceStartResponse | null {
  const sessionFlow = readStoredOpenAICodexOAuthFlowFrom(getBrowserStorage("sessionStorage"));
  const localFlow = readStoredOpenAICodexOAuthFlowFrom(getBrowserStorage("localStorage"));
  return sessionFlow ?? localFlow;
}

export function writeStoredOpenAICodexOAuthFlow(flow: OpenAICodexDeviceStartResponse): void {
  try {
    getBrowserStorage("localStorage")?.setItem(OPENAI_CODEX_OAUTH_FLOW_STORAGE_KEY, JSON.stringify(flow));
    getBrowserStorage("sessionStorage")?.setItem(OPENAI_CODEX_OAUTH_FLOW_STORAGE_KEY, JSON.stringify(flow));
  } catch {
    // Browser storage is a convenience for refresh recovery; pairing still works without it.
  }
}

export function clearStoredOpenAICodexOAuthFlow(): void {
  removeStoredOpenAICodexOAuthFlow(getBrowserStorage("localStorage"));
  removeStoredOpenAICodexOAuthFlow(getBrowserStorage("sessionStorage"));
}

export function formatOpenAICodexOAuthExpiry(flow: OpenAICodexDeviceStartResponse | null): string | null {
  if (!flow) {
    return null;
  }
  const expiresAt = Date.parse(flow.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    return null;
  }
  const minutes = Math.max(1, Math.ceil((expiresAt - Date.now()) / 60_000));
  if (minutes > 240) {
    return null;
  }
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
