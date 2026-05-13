import type { OnboardingStartupState, UiActionState } from "@goatcitadel/contracts";

import {
  createCorrelationId,
  recordClientDiagnostic,
  setDevDiagnosticsActiveCorrelationId,
  setDevDiagnosticsGatewayReachable,
  setDevDiagnosticsLastRequestError,
} from "../state/dev-diagnostics-store";
import {
  ApiRequestError,
  BROWSER_MUTATION_INTENT_HEADER,
  BROWSER_MUTATION_INTENT_VALUE,
  MUTATING_METHODS,
  SAFE_REQUEST_RETRY_DELAYS_MS,
  SAFE_RETRY_METHODS,
  inferDefaultGatewayBaseUrl,
  inferOriginSurface,
  isApiRequestError,
  normalizeHttpMethod,
  parseApiError,
  shouldRetrySafeRequest,
  sleep,
  unwrapApiResponse,
} from "./http-internal";

const RAW_API_BASE = import.meta.env.VITE_GATEWAY_URL ?? inferDefaultGatewayBaseUrl();
export const API_BASE = normalizeGatewayBaseUrl(RAW_API_BASE);
const AUTH_STORAGE_KEY = "goatcitadel.gateway.auth";
const AUTH_STORAGE_MODE_KEY = "goatcitadel.gateway.auth.storageMode";
const LAST_ROUTE_STORAGE_KEY = "goatcitadel.shell.last-route";
let volatileGatewayBasicAuth: Pick<GatewayAuthState, "mode" | "username" | "password"> | undefined;

export interface GatewayAuthState {
  mode?: "none" | "token" | "basic";
  token?: string;
  username?: string;
  password?: string;
  tokenQueryParam?: string;
}

export type GatewayAuthStorageMode = "session" | "persistent";
export type GatewayAccessPreflightStatus = "ready" | "needs-auth" | "unreachable" | "misconfigured";

export interface GatewayBootstrapResult {
  consumed: boolean;
  source?: "fragment";
}

export interface GatewayAccessPreflightResult {
  status: GatewayAccessPreflightStatus;
  message: string;
  healthDetail: string;
  authMode?: GatewayAuthState["mode"];
  onboardingState?: OnboardingStartupState;
  rejectedStoredAuth?: boolean;
  bootstrapTokenRejected?: boolean;
  startupTiming?: GatewayStartupTiming;
}

export interface GatewayStartupPhaseTiming {
  key: "health" | "auth" | "shell";
  label: string;
  status: "success" | "error" | "skipped";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  detail: string;
}

export interface GatewayStartupTiming {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outcome: GatewayAccessPreflightStatus;
  phases: GatewayStartupPhaseTiming[];
}

export function normalizeGatewayBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  let end = trimmed.length;
  while (end > 0 && trimmed.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return trimmed.slice(0, end);
}

export function buildGatewayUrl(path: string, baseUrl = API_BASE): string {
  const normalizedBaseUrl = normalizeGatewayBaseUrl(baseUrl);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return new URL(normalizedPath, `${normalizedBaseUrl}/`).toString();
}

export function getGatewayApiBaseUrl(): string {
  return API_BASE;
}

export function buildGatewayHeaders(
  path: string,
  method: string,
  correlationId: string,
  extraHeaders?: HeadersInit,
): HeadersInit {
  return {
    "Content-Type": "application/json",
    ...(method !== "GET" ? { "Idempotency-Key": crypto.randomUUID() } : {}),
    ...(MUTATING_METHODS.has(method) ? { [BROWSER_MUTATION_INTENT_HEADER]: BROWSER_MUTATION_INTENT_VALUE } : {}),
    ...readGatewayAuthHeaders(path),
    "x-goatcitadel-correlation-id": correlationId,
    "x-goatcitadel-origin-surface": inferOriginSurface(path),
    ...(extraHeaders ?? {}),
  };
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = normalizeHttpMethod(init?.method);
  const correlationId = createCorrelationId();
  const headers = buildGatewayHeaders(path, method, correlationId, init?.headers);
  recordClientDiagnostic({
    level: "info",
    category: "api",
    event: "request.start",
    message: `${method} ${path}`,
    correlationId,
    route: path,
  });
  const maxAttempts = SAFE_RETRY_METHODS.has(method) ? SAFE_REQUEST_RETRY_DELAYS_MS.length + 1 : 1;
  let lastError: ApiRequestError | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const res = await fetch(buildGatewayUrl(path), {
        ...init,
        headers: {
          ...headers,
        },
        method,
      });
      const responseCorrelationId = res.headers.get("x-goatcitadel-correlation-id") ?? correlationId;
      setDevDiagnosticsActiveCorrelationId(responseCorrelationId);
      setDevDiagnosticsGatewayReachable(true);

      if (!res.ok) {
        const text = await res.text();
        const parsed = parseApiError(text);
        lastError = new ApiRequestError(`API error ${res.status}: ${text}`, {
          kind: "http",
          method,
          path,
          status: res.status,
          body: parsed.body,
          bodyText: text,
          authMode: parsed.authMode,
        });
        if (shouldRetrySafeRequest(method, lastError) && attempt < maxAttempts - 1) {
          recordClientDiagnostic({
            level: "warn",
            category: "api",
            event: "request.retry",
            message: `${method} ${path} retrying after transient response`,
            correlationId: responseCorrelationId,
            route: path,
            context: {
              attempt: attempt + 1,
              status: res.status,
            },
          });
          await sleep(
            SAFE_REQUEST_RETRY_DELAYS_MS[attempt] ??
              SAFE_REQUEST_RETRY_DELAYS_MS[SAFE_REQUEST_RETRY_DELAYS_MS.length - 1] ??
              250,
          );
          continue;
        }
        setDevDiagnosticsLastRequestError(`${method} ${path}: ${res.status}`);
        recordClientDiagnostic({
          level: "error",
          category: "api",
          event: "request.error",
          message: `${method} ${path} failed (${res.status})`,
          correlationId: responseCorrelationId,
          route: path,
          context: {
            status: res.status,
            body: text.slice(0, 600),
          },
        });
        throw lastError;
      }

      setDevDiagnosticsLastRequestError(undefined);
      recordClientDiagnostic({
        level: "info",
        category: "api",
        event: "request.finish",
        message: `${method} ${path} completed`,
        correlationId: responseCorrelationId,
        route: path,
        context: {
          status: res.status,
        },
      });
      return unwrapApiResponse<T>(await res.json());
    } catch (error) {
      lastError =
        error instanceof ApiRequestError
          ? error
          : new ApiRequestError(`Network error ${method} ${path}: ${(error as Error).message}`, {
              kind: "network",
              method,
              path,
              cause: error,
            });
      if (shouldRetrySafeRequest(method, lastError) && attempt < maxAttempts - 1) {
        recordClientDiagnostic({
          level: "warn",
          category: "api",
          event: "request.retry",
          message: `${method} ${path} retrying after network failure`,
          correlationId,
          route: path,
          context: {
            attempt: attempt + 1,
            error: lastError.message,
          },
        });
        await sleep(
          SAFE_REQUEST_RETRY_DELAYS_MS[attempt] ??
            SAFE_REQUEST_RETRY_DELAYS_MS[SAFE_REQUEST_RETRY_DELAYS_MS.length - 1] ??
            250,
        );
        continue;
      }
      if (lastError.kind === "network") {
        setDevDiagnosticsGatewayReachable(false);
        setDevDiagnosticsLastRequestError(`${method} ${path}: network error`);
        recordClientDiagnostic({
          level: "error",
          category: "api",
          event: "request.network_error",
          message: `${method} ${path} failed before a response was received`,
          correlationId,
          route: path,
          context: {
            error: lastError.message,
          },
        });
      }
      throw lastError;
    }
  }

  throw lastError ?? new Error(`Unreachable request state for ${method} ${path}`);
}

export interface UiActionResult<T> {
  state: UiActionState;
  startedAt: string;
  finishedAt: string;
  data?: T;
  error?: string;
}

export async function runUiAction<T>(operation: () => Promise<T>): Promise<UiActionResult<T>> {
  const startedAt = new Date().toISOString();
  try {
    const data = await operation();
    return {
      state: "success",
      startedAt,
      finishedAt: new Date().toISOString(),
      data,
    };
  } catch (error) {
    return {
      state: "error",
      startedAt,
      finishedAt: new Date().toISOString(),
      error: (error as Error).message,
    };
  }
}

export function readGatewayAuthHeaders(_path: string): Record<string, string> {
  const auth = readGatewayAuthState();
  if (!auth) {
    return {};
  }

  if (auth.mode === "token" && auth.token?.trim()) {
    return {
      Authorization: `Bearer ${auth.token.trim()}`,
    };
  }
  if (auth.mode === "basic" && auth.username && auth.password) {
    const encoded = btoa(`${auth.username}:${auth.password}`);
    return {
      Authorization: `Basic ${encoded}`,
    };
  }

  if (auth.token?.trim()) {
    return {
      Authorization: `Bearer ${auth.token.trim()}`,
    };
  }
  return {};
}

function readGatewayAuthState(): GatewayAuthState | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  migrateLegacyGatewayAuthStorage();
  const stored =
    readStoredGatewayAuthStateFromStorage(window.sessionStorage) ??
    readStoredGatewayAuthStateFromStorage(window.localStorage);
  return mergeVolatileGatewayBasicAuth(stored);
}

export function getGatewayAuthStorageMode(): GatewayAuthStorageMode {
  if (typeof window === "undefined") {
    return "session";
  }
  const raw = window.localStorage.getItem(AUTH_STORAGE_MODE_KEY)?.trim().toLowerCase();
  return raw === "persistent" ? "persistent" : "session";
}

export function setGatewayAuthStorageMode(mode: GatewayAuthStorageMode): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(AUTH_STORAGE_MODE_KEY, mode);
  if (mode === "persistent") {
    const sessionRaw = window.sessionStorage.getItem(AUTH_STORAGE_KEY);
    if (sessionRaw) {
      window.localStorage.setItem(AUTH_STORAGE_KEY, sessionRaw);
    }
    return;
  }
  window.localStorage.removeItem(AUTH_STORAGE_KEY);
}

export function persistGatewayAuthState(state: GatewayAuthState, mode: GatewayAuthStorageMode = "session"): void {
  if (typeof window === "undefined") {
    return;
  }
  volatileGatewayBasicAuth = buildVolatileGatewayBasicAuth(state);
  const payload = buildPersistedGatewayAuthState(state);
  const raw = JSON.stringify(payload);
  window.sessionStorage.setItem(AUTH_STORAGE_KEY, raw);
  if (mode === "persistent") {
    window.localStorage.setItem(AUTH_STORAGE_KEY, raw);
  } else {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
  }
  window.localStorage.setItem(AUTH_STORAGE_MODE_KEY, mode);
}

export function clearGatewayAuthState(): void {
  if (typeof window === "undefined") {
    return;
  }
  volatileGatewayBasicAuth = undefined;
  window.sessionStorage.removeItem(AUTH_STORAGE_KEY);
  window.localStorage.removeItem(AUTH_STORAGE_KEY);
  window.localStorage.removeItem(LAST_ROUTE_STORAGE_KEY);
}

export function readStoredGatewayAuthState(): GatewayAuthState | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  migrateLegacyGatewayAuthStorage();
  return (
    readStoredGatewayAuthStateFromStorage(window.sessionStorage) ??
    readStoredGatewayAuthStateFromStorage(window.localStorage)
  );
}

export function consumeGatewayAccessBootstrapFromLocation(): GatewayBootstrapResult {
  if (typeof window === "undefined") {
    return { consumed: false };
  }

  const rawHash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  if (!rawHash || !rawHash.includes("=")) {
    return { consumed: false };
  }

  const hashParams = new URLSearchParams(rawHash);
  const token = hashParams.get("access_token")?.trim();
  if (!token) {
    return { consumed: false };
  }

  persistGatewayAuthState(
    {
      mode: "token",
      token,
      tokenQueryParam: "access_token",
    },
    "session",
  );

  hashParams.delete("access_token");
  const nextHash = hashParams.toString();
  const nextUrl = new URL(window.location.href);
  nextUrl.hash = nextHash ? `#${nextHash}` : "";
  window.history.replaceState(null, "", `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
  return {
    consumed: true,
    source: "fragment",
  };
}

export async function preflightGatewayAccess(
  options: { bootstrap?: GatewayBootstrapResult } = {},
): Promise<GatewayAccessPreflightResult> {
  const startupStartedAt = createIsoTimestamp();
  const startupStartedMs = getMonotonicNow();
  const hadStoredAuth = Boolean(readStoredGatewayAuthState());
  const usedBootstrap = Boolean(options.bootstrap?.consumed);
  const phases: GatewayStartupPhaseTiming[] = [];

  const skippedHealthPhase = createStartupPhase({
    key: "health",
    label: "Health check",
    status: "skipped",
    startedAt: startupStartedAt,
    finishedAt: startupStartedAt,
    durationMs: 0,
    detail: "Skipped during startup because the authenticated startup probe also proves gateway reachability.",
  });
  phases.push(skippedHealthPhase);
  recordStartupPhaseDiagnostic(skippedHealthPhase);

  const authStartedAt = createIsoTimestamp();
  const authStartedMs = getMonotonicNow();

  try {
    const onboardingState = await request<OnboardingStartupState>("/api/v1/onboarding/startup");
    const authPhase = createStartupPhase({
      key: "auth",
      label: "Access check",
      status: "success",
      startedAt: authStartedAt,
      finishedAt: createIsoTimestamp(),
      durationMs: getDurationMs(authStartedMs),
      detail: "Authenticated startup probe succeeded.",
    });
    phases.push(authPhase);
    recordStartupPhaseDiagnostic(authPhase);
    return {
      status: "ready",
      message: "Gateway reachability and access checks passed.",
      healthDetail: authPhase.detail,
      onboardingState,
      startupTiming: createStartupTiming("ready", startupStartedAt, startupStartedMs, phases),
    };
  } catch (error) {
    const authPhase = createStartupPhase({
      key: "auth",
      label: "Access check",
      status: "error",
      startedAt: authStartedAt,
      finishedAt: createIsoTimestamp(),
      durationMs: getDurationMs(authStartedMs),
      detail: summarizeStartupProbeFailure(error),
    });
    phases.push(authPhase);
    recordStartupPhaseDiagnostic(authPhase);

    if (isApiRequestError(error)) {
      if (error.kind === "network") {
        return {
          status: "unreachable",
          message: "Gateway is unreachable. Start the gateway and try again.",
          healthDetail: authPhase.detail,
          rejectedStoredAuth: false,
          bootstrapTokenRejected: false,
          startupTiming: createStartupTiming("unreachable", startupStartedAt, startupStartedMs, phases),
        };
      }

      if (error.status === 401 || error.status === 403) {
        if (usedBootstrap) {
          clearGatewayAuthState();
          return {
            status: "needs-auth",
            message: "The gateway rejected the one-time access token from the URL.",
            healthDetail: authPhase.detail,
            authMode: error.authMode,
            rejectedStoredAuth: false,
            bootstrapTokenRejected: true,
            startupTiming: createStartupTiming("needs-auth", startupStartedAt, startupStartedMs, phases),
          };
        }

        if (hadStoredAuth) {
          clearGatewayAuthState();
          return {
            status: "needs-auth",
            message: "Stored gateway credentials were rejected. Re-enter them to continue.",
            healthDetail: authPhase.detail,
            authMode: error.authMode,
            rejectedStoredAuth: true,
            bootstrapTokenRejected: false,
            startupTiming: createStartupTiming("needs-auth", startupStartedAt, startupStartedMs, phases),
          };
        }

        return {
          status: "needs-auth",
          message: "Gateway authentication is required before Mission Control can connect.",
          healthDetail: authPhase.detail,
          authMode: error.authMode,
          rejectedStoredAuth: false,
          bootstrapTokenRejected: false,
          startupTiming: createStartupTiming("needs-auth", startupStartedAt, startupStartedMs, phases),
        };
      }

      if (error.status === 404) {
        return {
          status: "misconfigured",
          message: "Gateway startup endpoints are unavailable. Check the Mission Control gateway URL.",
          healthDetail: authPhase.detail,
          startupTiming: createStartupTiming("misconfigured", startupStartedAt, startupStartedMs, phases),
        };
      }

      if (error.status === 500) {
        return {
          status: "misconfigured",
          message: readApiErrorMessage(error.body) || "Gateway auth is configured incorrectly on the server.",
          healthDetail: authPhase.detail,
          authMode: error.authMode,
          startupTiming: createStartupTiming("misconfigured", startupStartedAt, startupStartedMs, phases),
        };
      }

      return {
        status: "misconfigured",
        message: readApiErrorMessage(error.body) || error.message,
        healthDetail: authPhase.detail,
        authMode: error.authMode,
        startupTiming: createStartupTiming("misconfigured", startupStartedAt, startupStartedMs, phases),
      };
    }

    return {
      status: "misconfigured",
      message: (error as Error).message,
      healthDetail: authPhase.detail,
      startupTiming: createStartupTiming("misconfigured", startupStartedAt, startupStartedMs, phases),
    };
  }
}

function createIsoTimestamp(): string {
  return new Date().toISOString();
}

function getMonotonicNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function getDurationMs(startedAtMs: number): number {
  return Math.max(0, Math.round(getMonotonicNow() - startedAtMs));
}

function createStartupPhase(phase: GatewayStartupPhaseTiming): GatewayStartupPhaseTiming {
  return phase;
}

function createStartupTiming(
  outcome: GatewayAccessPreflightStatus,
  startedAt: string,
  startedAtMs: number,
  phases: GatewayStartupPhaseTiming[],
): GatewayStartupTiming {
  return {
    startedAt,
    finishedAt: createIsoTimestamp(),
    durationMs: getDurationMs(startedAtMs),
    outcome,
    phases,
  };
}

function recordStartupPhaseDiagnostic(phase: GatewayStartupPhaseTiming): void {
  recordClientDiagnostic({
    level: phase.status === "error" ? "error" : "info",
    category: "startup",
    event: `startup.${phase.key}.${phase.status}`,
    message: `${phase.label} ${phase.status} in ${phase.durationMs} ms`,
    context: {
      key: phase.key,
      label: phase.label,
      status: phase.status,
      detail: phase.detail,
      durationMs: phase.durationMs,
      startedAt: phase.startedAt,
      finishedAt: phase.finishedAt,
    },
  });
}

function summarizeStartupProbeFailure(error: unknown): string {
  if (isApiRequestError(error)) {
    if (error.kind === "network") {
      return `Gateway startup probe failed before a response was received: ${error.message}`;
    }
    if (error.status === 401 || error.status === 403) {
      return `Authenticated startup probe reached the gateway, but credentials were rejected (${error.status}).`;
    }
    return `Authenticated startup probe failed with HTTP ${error.status ?? "unknown"}.`;
  }
  return `Gateway startup probe failed: ${(error as Error).message}`;
}

function migrateLegacyGatewayAuthStorage(): void {
  if (typeof window === "undefined") {
    return;
  }
  if (window.sessionStorage.getItem(AUTH_STORAGE_KEY)) {
    return;
  }
  if (getGatewayAuthStorageMode() !== "persistent") {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
    return;
  }
  readStoredGatewayAuthStateFromStorage(window.localStorage);
}

function readApiErrorMessage(body: unknown): string | undefined {
  if (typeof body === "string") {
    return body;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const candidate = (body as { error?: unknown }).error;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

function readStoredGatewayAuthStateFromStorage(storage: Storage): GatewayAuthState | undefined {
  const raw = storage.getItem(AUTH_STORAGE_KEY);
  if (!raw) {
    return undefined;
  }
  const parsed = parseStoredGatewayAuthState(raw);
  if (!parsed) {
    storage.removeItem(AUTH_STORAGE_KEY);
    return undefined;
  }
  if (storedGatewayAuthContainsPassword(raw)) {
    storage.removeItem(AUTH_STORAGE_KEY);
  }
  return parsed;
}

function parseStoredGatewayAuthState(raw: string): GatewayAuthState | undefined {
  try {
    return normalizeStoredGatewayAuthState(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function storedGatewayAuthContainsPassword(raw: string): boolean {
  try {
    const value = JSON.parse(raw);
    return Boolean(
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.prototype.hasOwnProperty.call(value, "password"),
    );
  } catch {
    return false;
  }
}

function normalizeStoredGatewayAuthState(value: unknown): GatewayAuthState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as GatewayAuthState;
  const normalized: GatewayAuthState = {
    mode:
      candidate.mode === "none" || candidate.mode === "token" || candidate.mode === "basic"
        ? candidate.mode
        : undefined,
    token: trimStoredAuthField(candidate.token),
    username: trimStoredAuthField(candidate.username),
    tokenQueryParam: trimStoredAuthField(candidate.tokenQueryParam) ?? "access_token",
  };
  return normalized.mode || normalized.token || normalized.username ? normalized : undefined;
}

function buildPersistedGatewayAuthState(state: GatewayAuthState): GatewayAuthState {
  return {
    mode: state.mode,
    token: trimStoredAuthField(state.token),
    username: trimStoredAuthField(state.username),
    tokenQueryParam: trimStoredAuthField(state.tokenQueryParam) ?? "access_token",
  };
}

function buildVolatileGatewayBasicAuth(
  state: GatewayAuthState,
): Pick<GatewayAuthState, "mode" | "username" | "password"> | undefined {
  const username = trimStoredAuthField(state.username);
  const password = trimStoredAuthField(state.password);
  if (state.mode !== "basic" || !username || !password) {
    return undefined;
  }
  return {
    mode: "basic",
    username,
    password,
  };
}

function mergeVolatileGatewayBasicAuth(stored: GatewayAuthState | undefined): GatewayAuthState | undefined {
  if (
    stored?.mode !== "basic" ||
    !stored.username ||
    !volatileGatewayBasicAuth?.password ||
    stored.username !== volatileGatewayBasicAuth.username
  ) {
    return stored;
  }
  return {
    ...stored,
    password: volatileGatewayBasicAuth.password,
  };
}

function trimStoredAuthField(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
