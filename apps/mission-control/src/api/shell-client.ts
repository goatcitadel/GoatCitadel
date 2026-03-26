import type {
  ApprovalRequest,
  ApprovalResolveInput,
  DeviceAccessRequestCreateInput,
  DeviceAccessRequestCreateResponse,
  DeviceAccessRequestStatusResponse,
  OnboardingState,
  RealtimeEvent,
  SseTokenIssueResponse,
  WorkspaceRecord,
} from "@goatcitadel/contracts";
import {
  createCorrelationId,
  recordClientDiagnostic,
  setDevDiagnosticsActiveCorrelationId,
  setDevDiagnosticsGatewayReachable,
  setDevDiagnosticsLastRequestError,
} from "../state/dev-diagnostics-store";

export type { RealtimeEvent } from "@goatcitadel/contracts";

const DEFAULT_GATEWAY_HOST = "127.0.0.1";
const DEFAULT_GATEWAY_PORT = 8787;
const DEFAULT_GATEWAY_HOST_ALLOWLIST: string[] = [];
const API_BASE = import.meta.env.VITE_GATEWAY_URL ?? inferDefaultGatewayBaseUrl();
const AUTH_STORAGE_KEY = "goatcitadel.gateway.auth";
const AUTH_STORAGE_MODE_KEY = "goatcitadel.gateway.auth.storageMode";
const EVENT_CURSOR_STORAGE_KEY = "goatcitadel.events.cursor.v1";
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const BROWSER_MUTATION_INTENT_HEADER = "x-goatcitadel-browser-intent";
const BROWSER_MUTATION_INTENT_VALUE = "mutation";

export interface GatewayAuthState {
  mode?: "none" | "token" | "basic";
  token?: string;
  username?: string;
  password?: string;
  tokenQueryParam?: string;
}

export type GatewayAuthStorageMode = "session" | "persistent";
export type GatewayAccessPreflightStatus = "ready" | "needs-auth" | "unreachable" | "misconfigured";
export type EventStreamConnectionState = "closed" | "connecting" | "open" | "retrying" | "error";

export interface GatewayBootstrapResult {
  consumed: boolean;
  source?: "fragment";
}

export interface GatewayAccessPreflightResult {
  status: GatewayAccessPreflightStatus;
  message: string;
  healthDetail: string;
  authMode?: GatewayAuthState["mode"];
  onboardingState?: OnboardingState;
  rejectedStoredAuth?: boolean;
  bootstrapTokenRejected?: boolean;
}

export interface EventStreamStatus {
  state: EventStreamConnectionState;
  reconnectAttempts: number;
  lastEventAt?: string;
  lastErrorAt?: string;
}

export interface WorkspacesResponse {
  items: WorkspaceRecord[];
  view?: "active" | "archived" | "all";
}

interface ParsedApiError {
  body?: unknown;
  authMode?: GatewayAuthState["mode"];
}

interface ApiRequestErrorOptions {
  kind: "http" | "network";
  method: string;
  path: string;
  status?: number;
  body?: unknown;
  bodyText?: string;
  authMode?: GatewayAuthState["mode"];
  cause?: unknown;
}

class ApiRequestError extends Error {
  public readonly kind: "http" | "network";

  public readonly method: string;

  public readonly path: string;

  public readonly status?: number;

  public readonly body?: unknown;

  public readonly bodyText?: string;

  public readonly authMode?: GatewayAuthState["mode"];

  public constructor(message: string, options: ApiRequestErrorOptions) {
    super(message);
    this.name = "ApiRequestError";
    this.kind = options.kind;
    this.method = options.method;
    this.path = options.path;
    this.status = options.status;
    this.body = options.body;
    this.bodyText = options.bodyText;
    this.authMode = options.authMode;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

interface EventStreamSubscriber {
  onEvent: (event: RealtimeEvent) => void;
  onStateChange?: (state: EventStreamConnectionState) => void;
  onStatusChange?: (status: EventStreamStatus) => void;
}

const eventStreamSubscribers = new Set<EventStreamSubscriber>();
let sharedEventSource: EventSource | null = null;
let eventReconnectTimer: number | null = null;
let eventConnectionState: EventStreamConnectionState = "closed";
let eventConnectAttempt = 0;
let eventConnectInFlight = false;
let reconnectAttempts = 0;
let lastEventAt: string | undefined;
let lastErrorAt: string | undefined;

export function getGatewayApiBaseUrl(): string {
  return API_BASE;
}

export function isTrustedGatewayHost(hostname: string, rawAllowlist?: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) {
    return false;
  }
  if (
    host === "localhost"
    || host === "127.0.0.1"
    || host === "::1"
    || host === "[::1]"
    || host.endsWith(".ts.net")
  ) {
    return true;
  }
  if (isPrivateOrCarrierGradeIpv4(host)) {
    return true;
  }
  const allowlist = (rawAllowlist ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const mergedAllowlist = [...DEFAULT_GATEWAY_HOST_ALLOWLIST, ...allowlist];
  return mergedAllowlist.some((entry) => {
    if (entry.startsWith(".")) {
      return host.endsWith(entry);
    }
    return host === entry;
  });
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

export function persistGatewayAuthState(
  state: GatewayAuthState,
  mode: GatewayAuthStorageMode = "session",
): void {
  if (typeof window === "undefined") {
    return;
  }
  const payload: GatewayAuthState = {
    mode: state.mode,
    token: state.token?.trim() || undefined,
    username: state.username?.trim() || undefined,
    password: state.password || undefined,
    tokenQueryParam: state.tokenQueryParam ?? "access_token",
  };
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
  window.sessionStorage.removeItem(AUTH_STORAGE_KEY);
  window.localStorage.removeItem(AUTH_STORAGE_KEY);
}

export function readStoredGatewayAuthState(): GatewayAuthState | undefined {
  return readGatewayAuthState();
}

export function consumeGatewayAccessBootstrapFromLocation(): GatewayBootstrapResult {
  if (typeof window === "undefined") {
    return { consumed: false };
  }

  const rawHash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  if (!rawHash || !rawHash.includes("=")) {
    return { consumed: false };
  }

  const hashParams = new URLSearchParams(rawHash);
  const token = hashParams.get("access_token")?.trim();
  if (!token) {
    return { consumed: false };
  }

  persistGatewayAuthState({
    mode: "token",
    token,
    tokenQueryParam: "access_token",
  }, "session");

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
  const health = await probeGatewayHealth();
  if (!health.ok) {
    return {
      status: "unreachable",
      message: "Mission Control cannot reach the gateway yet.",
      healthDetail: health.detail,
    };
  }

  const hadStoredAuth = Boolean(readStoredGatewayAuthState());
  const usedBootstrap = Boolean(options.bootstrap?.consumed);

  try {
    const onboardingState = await request<OnboardingState>("/api/v1/onboarding/state");
    return {
      status: "ready",
      message: "Gateway reachability and access checks passed.",
      healthDetail: health.detail,
      onboardingState,
    };
  } catch (error) {
    if (error instanceof ApiRequestError) {
      if (error.status === 401 || error.status === 403) {
        if (hadStoredAuth || usedBootstrap) {
          clearGatewayAuthState();
        }
        return {
          status: "needs-auth",
          message: usedBootstrap
            ? "The remote access link token was rejected. Enter the current gateway credentials."
            : hadStoredAuth
              ? "Saved gateway credentials were rejected. Enter the current gateway credentials."
              : "Gateway credentials are required to continue.",
          healthDetail: health.detail,
          authMode: error.authMode,
          rejectedStoredAuth: hadStoredAuth,
          bootstrapTokenRejected: usedBootstrap,
        };
      }

      if (error.status === 503) {
        return {
          status: "misconfigured",
          message: readApiErrorMessage(error.body) || "Gateway auth is configured incorrectly on the server.",
          healthDetail: health.detail,
          authMode: error.authMode,
        };
      }

      if (error.kind === "network") {
        return {
          status: "unreachable",
          message: "Gateway health responded, but authenticated API access still failed.",
          healthDetail: error.message,
        };
      }

      return {
        status: "misconfigured",
        message: readApiErrorMessage(error.body) || error.message,
        healthDetail: health.detail,
        authMode: error.authMode,
      };
    }

    return {
      status: "misconfigured",
      message: (error as Error).message,
      healthDetail: health.detail,
    };
  }
}

export async function fetchWorkspaces(
  view: "active" | "archived" | "all" = "active",
  limit = 200,
): Promise<WorkspacesResponse> {
  const query = new URLSearchParams({
    view,
    limit: String(Math.max(1, Math.min(limit, 500))),
  });
  return request<WorkspacesResponse>(`/api/v1/workspaces?${query.toString()}`);
}

export async function createGatewayDeviceAccessRequest(
  input: DeviceAccessRequestCreateInput,
): Promise<DeviceAccessRequestCreateResponse> {
  return request<DeviceAccessRequestCreateResponse>("/api/v1/auth/device-requests", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function pollGatewayDeviceAccessRequestStatus(
  requestId: string,
  requestSecret: string,
): Promise<DeviceAccessRequestStatusResponse> {
  return request<DeviceAccessRequestStatusResponse>(`/api/v1/auth/device-requests/${encodeURIComponent(requestId)}/status`, {
    headers: {
      "x-goatcitadel-device-request-secret": requestSecret,
    },
  });
}

export async function resolveApproval(
  approvalId: string,
  input: ApprovalResolveInput,
): Promise<{ approval: ApprovalRequest }> {
  return request<{ approval: ApprovalRequest }>(`/api/v1/approvals/${encodeURIComponent(approvalId)}/resolve`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function resolveApprovalWithRemoteToken(
  token: string,
  decision: "approve" | "reject",
): Promise<{ approval: ApprovalRequest }> {
  return request<{ approval: ApprovalRequest }>("/api/v1/approvals/remote-resolve", {
    method: "POST",
    body: JSON.stringify({
      token,
      decision,
    }),
  });
}

export function connectEventStream(
  onEvent: (event: RealtimeEvent) => void,
  onStateChange?: (state: EventStreamConnectionState) => void,
  onStatusChange?: (status: EventStreamStatus) => void,
): () => void {
  const subscriber: EventStreamSubscriber = { onEvent, onStateChange, onStatusChange };
  eventStreamSubscribers.add(subscriber);
  notifyEventStreamState(subscriber, eventConnectionState);
  notifyEventStreamStatus(subscriber, buildEventStreamStatus());
  void ensureEventStreamConnected();

  return () => {
    eventStreamSubscribers.delete(subscriber);
    if (eventStreamSubscribers.size === 0) {
      eventConnectAttempt += 1;
      closeSharedEventSource();
      clearReconnectTimer();
      setEventConnectionState("closed");
      reconnectAttempts = 0;
      lastEventAt = undefined;
      lastErrorAt = undefined;
    }
  };
}

function unwrapApiResponse<T>(payload: unknown): T {
  if (
    payload
    && typeof payload === "object"
    && "data" in payload
    && ("success" in payload || "meta" in payload)
  ) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}

function inferDefaultGatewayBaseUrl(): string {
  if (typeof window === "undefined") {
    return `http://${DEFAULT_GATEWAY_HOST}:${DEFAULT_GATEWAY_PORT}`;
  }
  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  const host = window.location.hostname || DEFAULT_GATEWAY_HOST;
  if (isTrustedGatewayHost(host, import.meta.env.VITE_GATEWAY_ALLOWED_HOSTS)) {
    return `${protocol}//${host}:${DEFAULT_GATEWAY_PORT}`;
  }
  console.warn(
    `[goatcitadel] refusing inferred gateway host "${host}" because it is not trusted; `
    + `falling back to ${DEFAULT_GATEWAY_HOST}:${DEFAULT_GATEWAY_PORT}. Set VITE_GATEWAY_ALLOWED_HOSTS to override.`,
  );
  return `${protocol}//${DEFAULT_GATEWAY_HOST}:${DEFAULT_GATEWAY_PORT}`;
}

function isPrivateOrCarrierGradeIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => !Number.isFinite(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const a = octets[0] ?? -1;
  const b = octets[1] ?? -1;
  if (a === 10 || a === 127) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  return a === 100 && b >= 64 && b <= 127;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const authHeaders = readGatewayAuthHeaders(path);
  const method = (init?.method ?? "GET").toUpperCase();
  const correlationId = createCorrelationId();
  const headers = {
    "Content-Type": "application/json",
    ...(method !== "GET" ? { "Idempotency-Key": crypto.randomUUID() } : {}),
    ...(MUTATING_METHODS.has(method) ? { [BROWSER_MUTATION_INTENT_HEADER]: BROWSER_MUTATION_INTENT_VALUE } : {}),
    ...authHeaders,
    "x-goatcitadel-correlation-id": correlationId,
    "x-goatcitadel-origin-surface": inferOriginSurface(path),
    ...(extraHeaders ?? {}),
  };
}

function shouldRetrySafeRequest(method: string, error?: ApiRequestError): boolean {
  if (!SAFE_RETRY_METHODS.has(method) || !error) {
    return false;
  }
  if (error.kind === "network") {
    return true;
  }
  return error.status !== undefined && RETRYABLE_HTTP_STATUS_CODES.has(error.status);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      headers: {
        ...headers,
      },
      ...init,
      method,
    });
  } catch (error) {
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
        error: (error as Error).message,
      },
    });
    throw new ApiRequestError(`Network error ${method} ${path}: ${(error as Error).message}`, {
      kind: "network",
      method,
      path,
      cause: error,
    });
  }
  const responseCorrelationId = response.headers.get("x-goatcitadel-correlation-id") ?? correlationId;
  setDevDiagnosticsActiveCorrelationId(responseCorrelationId);
  setDevDiagnosticsGatewayReachable(true);

      if (!response.ok) {
        const text = await response.text();
        const parsed = parseApiError(text);
        lastError = new ApiRequestError(`API error ${response.status}: ${text}`, {
          kind: "http",
          method,
          path,
          status: response.status,
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
              status: response.status,
            },
          });
          await sleep(SAFE_REQUEST_RETRY_DELAYS_MS[attempt] ?? SAFE_REQUEST_RETRY_DELAYS_MS[SAFE_REQUEST_RETRY_DELAYS_MS.length - 1] ?? 250);
          continue;
        }
        setDevDiagnosticsLastRequestError(`${method} ${path}: ${response.status}`);
        recordClientDiagnostic({
          level: "error",
          category: "api",
          event: "request.error",
          message: `${method} ${path} failed (${response.status})`,
          correlationId: responseCorrelationId,
          route: path,
          context: {
            status: response.status,
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
          status: response.status,
        },
      });
      return unwrapApiResponse<T>(await response.json());
    } catch (error) {
      lastError = error instanceof ApiRequestError
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
        await sleep(SAFE_REQUEST_RETRY_DELAYS_MS[attempt] ?? SAFE_REQUEST_RETRY_DELAYS_MS[SAFE_REQUEST_RETRY_DELAYS_MS.length - 1] ?? 250);
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

function readGatewayAuthHeaders(_path: string): Record<string, string> {
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
  try {
    const sessionRaw = window.sessionStorage.getItem(AUTH_STORAGE_KEY);
    if (sessionRaw) {
      return JSON.parse(sessionRaw) as GatewayAuthState;
    }
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) {
      return undefined;
    }
    return JSON.parse(raw) as GatewayAuthState;
  } catch {
    return undefined;
  }
}

function migrateLegacyGatewayAuthStorage(): void {
  if (typeof window === "undefined") {
    return;
  }
  const sessionRaw = window.sessionStorage.getItem(AUTH_STORAGE_KEY);
  const localRaw = window.localStorage.getItem(AUTH_STORAGE_KEY);
  if (sessionRaw || !localRaw) {
    return;
  }
  window.sessionStorage.setItem(AUTH_STORAGE_KEY, localRaw);
  if (getGatewayAuthStorageMode() !== "persistent") {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
  }
}

function parseApiError(text: string): ParsedApiError {
  if (!text) {
    return {};
  }
  try {
    const body = JSON.parse(text) as unknown;
    return {
      body,
      authMode: normalizeAuthMode(body),
    };
  } catch {
    return {
      body: text,
    };
  }
}

function normalizeAuthMode(value: unknown): GatewayAuthState["mode"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const authMode = (value as { authMode?: unknown }).authMode;
  return authMode === "none" || authMode === "token" || authMode === "basic"
    ? authMode
    : undefined;
}

function readApiErrorMessage(body: unknown): string | undefined {
  if (typeof body === "string") {
    return body;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const candidate = (body as { error?: unknown }).error;
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim()
    : undefined;
}

async function probeGatewayHealth(): Promise<{ ok: boolean; detail: string }> {
  const correlationId = createCorrelationId();
  recordClientDiagnostic({
    level: "info",
    category: "api",
    event: "request.start",
    message: "GET /health",
    correlationId,
    route: "/health",
  });

  try {
    const response = await fetch(`${API_BASE}/health`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "x-goatcitadel-correlation-id": correlationId,
        "x-goatcitadel-origin-surface": "app",
      },
    });
    const responseCorrelationId = response.headers.get("x-goatcitadel-correlation-id") ?? correlationId;
    setDevDiagnosticsActiveCorrelationId(responseCorrelationId);

    if (!response.ok) {
      const detail = `Health probe failed with HTTP ${response.status}.`;
      setDevDiagnosticsGatewayReachable(false);
      setDevDiagnosticsLastRequestError(`GET /health: ${response.status}`);
      recordClientDiagnostic({
        level: "error",
        category: "api",
        event: "request.error",
        message: `GET /health failed (${response.status})`,
        correlationId: responseCorrelationId,
        route: "/health",
        context: {
          status: response.status,
        },
      });
      return { ok: false, detail };
    }

    setDevDiagnosticsGatewayReachable(true);
    setDevDiagnosticsLastRequestError(undefined);
    recordClientDiagnostic({
      level: "info",
      category: "api",
      event: "request.finish",
      message: "GET /health completed",
      correlationId: responseCorrelationId,
      route: "/health",
      context: {
        status: response.status,
      },
    });
    return {
      ok: true,
      detail: `Gateway health check OK (${response.status}).`,
    };
  } catch (error) {
    setDevDiagnosticsGatewayReachable(false);
    setDevDiagnosticsLastRequestError("GET /health: network error");
    recordClientDiagnostic({
      level: "error",
      category: "api",
      event: "request.network_error",
      message: "GET /health failed before a response was received",
      correlationId,
      route: "/health",
      context: {
        error: (error as Error).message,
      },
    });
    return {
      ok: false,
      detail: `Gateway health probe failed: ${(error as Error).message}`,
    };
  }
}

async function buildEventStreamUrl(): Promise<string> {
  const url = new URL(`${API_BASE}/api/v1/events/stream`);
  const lastCursor = readStoredRealtimeCursor();
  if (lastCursor !== undefined) {
    url.searchParams.set("afterCursor", String(lastCursor));
  } else {
    url.searchParams.set("replay", "20");
  }

  const auth = readGatewayAuthState();
  if (!auth) {
    return url.toString();
  }

  if (
    auth.mode === "token"
    || auth.mode === "basic"
    || Boolean(auth.token?.trim())
    || Boolean(auth.username && auth.password)
  ) {
    try {
      const issued = await request<SseTokenIssueResponse>("/api/v1/auth/sse-token", {
        method: "POST",
        body: JSON.stringify({}),
      });
      url.searchParams.set("sse_token", issued.token);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 400) {
        return url.toString();
      }
      throw error;
    }
  }

  return url.toString();
}

async function ensureEventStreamConnected(): Promise<void> {
  if (sharedEventSource || eventConnectInFlight || eventStreamSubscribers.size === 0 || typeof window === "undefined") {
    return;
  }

  eventConnectInFlight = true;
  const connectAttempt = ++eventConnectAttempt;
  setEventConnectionState("connecting");
  recordClientDiagnostic({
    level: "info",
    category: "sse",
    event: "connect",
    message: "Connecting to realtime events",
  });

  let streamUrl = "";
  try {
    streamUrl = await buildEventStreamUrl();
  } catch {
    eventConnectInFlight = false;
    if (connectAttempt !== eventConnectAttempt || eventStreamSubscribers.size === 0) {
      return;
    }
    lastErrorAt = new Date().toISOString();
    setEventConnectionState("error");
    scheduleReconnect();
    return;
  }

  eventConnectInFlight = false;
  if (connectAttempt !== eventConnectAttempt || eventStreamSubscribers.size === 0) {
    return;
  }

  const source = new EventSource(streamUrl);
  sharedEventSource = source;

  source.onopen = () => {
    if (sharedEventSource !== source) {
      return;
    }
    clearReconnectTimer();
    reconnectAttempts = 0;
    setEventConnectionState("open");
    recordClientDiagnostic({
      level: "info",
      category: "sse",
      event: "open",
      message: "Realtime event stream connected",
    });
  };

  source.onmessage = (event) => {
    if (sharedEventSource !== source) {
      return;
    }
    try {
      const payload = JSON.parse(event.data) as RealtimeEvent;
      if (typeof payload.sequence === "number" && Number.isFinite(payload.sequence)) {
        persistRealtimeCursor(payload.sequence);
      }
      lastEventAt = payload.timestamp || new Date().toISOString();
      recordClientDiagnostic({
        level: "debug",
        category: "sse",
        event: "freshness",
        message: payload.eventType,
        context: {
          source: payload.source,
          eventId: payload.eventId,
        },
      });
      notifyEventStreamStatusToAll();
      for (const subscriber of eventStreamSubscribers) {
        subscriber.onEvent(payload);
      }
    } catch {
      // Ignore malformed stream payloads.
    }
  };

  source.addEventListener("replay-gap", (event) => {
    if (sharedEventSource !== source) {
      return;
    }
    clearStoredRealtimeCursor();
    lastErrorAt = new Date().toISOString();
    const payload = buildReplayGapRealtimeEvent(event.data);
    notifyEventStreamStatusToAll();
    for (const subscriber of eventStreamSubscribers) {
      subscriber.onEvent(payload);
    }
  });

  source.onerror = () => {
    if (sharedEventSource !== source) {
      return;
    }
    closeSharedEventSource();
    if (eventStreamSubscribers.size === 0) {
      setEventConnectionState("closed");
      return;
    }
    lastErrorAt = new Date().toISOString();
    setEventConnectionState("error");
    recordClientDiagnostic({
      level: "warn",
      category: "sse",
      event: "error",
      message: "Realtime event stream encountered an error",
    });
    scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  if (eventReconnectTimer !== null || typeof window === "undefined") {
    return;
  }

  reconnectAttempts += 1;
  setEventConnectionState("retrying");
  recordClientDiagnostic({
    level: "warn",
    category: "sse",
    event: "retry",
    message: "Scheduling realtime event reconnect",
    context: {
      reconnectAttempts,
    },
  });
  const delay = computeReconnectDelay(reconnectAttempts);

  eventReconnectTimer = window.setTimeout(() => {
    eventReconnectTimer = null;
    void ensureEventStreamConnected();
  }, delay);
}

function closeSharedEventSource(): void {
  eventConnectInFlight = false;
  if (!sharedEventSource) {
    return;
  }
  recordClientDiagnostic({
    level: "info",
    category: "sse",
    event: "close",
    message: "Realtime event stream closed",
  });
  sharedEventSource.close();
  sharedEventSource = null;
}

function clearReconnectTimer(): void {
  if (eventReconnectTimer === null || typeof window === "undefined") {
    return;
  }
  window.clearTimeout(eventReconnectTimer);
  eventReconnectTimer = null;
}

function setEventConnectionState(state: EventStreamConnectionState): void {
  eventConnectionState = state;
  for (const subscriber of eventStreamSubscribers) {
    notifyEventStreamState(subscriber, state);
    notifyEventStreamStatus(subscriber, buildEventStreamStatus());
  }
}

function notifyEventStreamState(subscriber: EventStreamSubscriber, state: EventStreamConnectionState): void {
  subscriber.onStateChange?.(state);
}

function notifyEventStreamStatusToAll(): void {
  const status = buildEventStreamStatus();
  for (const subscriber of eventStreamSubscribers) {
    notifyEventStreamStatus(subscriber, status);
  }
}

function notifyEventStreamStatus(subscriber: EventStreamSubscriber, status: EventStreamStatus): void {
  subscriber.onStatusChange?.(status);
}

function buildEventStreamStatus(): EventStreamStatus {
  return {
    state: eventConnectionState,
    reconnectAttempts,
    lastEventAt,
    lastErrorAt,
  };
}

function readStoredRealtimeCursor(): number | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const raw = window.localStorage.getItem(EVENT_CURSOR_STORAGE_KEY)?.trim();
  if (!raw || !/^\d+$/.test(raw)) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function persistRealtimeCursor(sequence: number): void {
  if (typeof window === "undefined" || !Number.isFinite(sequence) || sequence <= 0) {
    return;
  }
  window.localStorage.setItem(EVENT_CURSOR_STORAGE_KEY, String(sequence));
}

function clearStoredRealtimeCursor(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(EVENT_CURSOR_STORAGE_KEY);
}

function buildReplayGapRealtimeEvent(rawPayload: string): RealtimeEvent {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(rawPayload) as Record<string, unknown>;
  } catch {
    payload = { error: "replay_gap" };
  }
  return {
    eventId: `replay-gap-${Date.now()}`,
    sequence: Number(payload.oldestCursor ?? 0),
    eventType: "system",
    source: "events",
    timestamp: new Date().toISOString(),
    originSurface: "mission-control-web",
    payload: {
      kind: "replay_gap",
      ...payload,
    },
  };
}

function computeReconnectDelay(attempt: number): number {
  const clampedAttempt = Math.max(1, attempt);
  const base = Math.min(30_000, 1000 * (2 ** (clampedAttempt - 1)));
  const jitter = Math.floor(Math.random() * 500);
  return Math.min(30_000, base + jitter);
}

function inferOriginSurface(path: string): string {
  if (path.startsWith("/api/v1/chat")) {
    return "chat";
  }
  if (path.startsWith("/api/v1/addons")) {
    return "addons";
  }
  if (path.startsWith("/api/v1/voice")) {
    return "voice";
  }
  if (path.startsWith("/api/v1/mcp")) {
    return "mcp";
  }
  if (path.startsWith("/api/v1/integrations")) {
    return "integrations";
  }
  return "app";
}
