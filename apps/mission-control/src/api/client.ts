import type {
  AddonActionResponse,
  AddonCatalogEntry,
  AddonInstalledRecord,
  AddonInstallRequest,
  AddonStatusRecord,
  AddonUninstallResponse,
  AgentProfileArchiveInput,
  AgentProfileCreateInput,
  AgentProfileRecord,
  AgentProfileUpdateInput,
  AuthSettingsUpdateInput,
  DeviceAccessGrantListResponse,
  DeviceAccessGrantRevokeResponse,
  DiscordPairingRecord,
  DiscordRuntimeStatus,
  ApprovalBulkResolveResult,
  ApprovalReplaySnapshot,
  ApprovalRequest,
  A2UIProofLaneDraft,
  ExtensionStarterPackArtifactRecord,
  ExtensionStarterPackDraft,
  ExtensionSdkBriefDraft,
  AssemblyRunDetailResponse,
  AssemblyRunRecord,
  ChangeRiskEvaluationResponse,
  BrowserProofLaneDraft,
  ChannelCapabilities,
  ChannelRuntimeStatus,
  FollowOnProofLaneArtifactRecord,
  PackagingProofLaneDraft,
  VoiceProofLaneDraft,
  ChannelReactInput,
  ChannelReplyInput,
  ChannelSendInput,
  ChannelSetupDefinition,
  ChannelSetupDraft,
  ChannelSetupDraftCreateInput,
  ChannelSetupDraftUpdateInput,
  ChannelSetupFinalizeResult,
  ChannelSetupTestResult,
  ChannelSetupValidationResult,
  ChannelTypingInput,
  ChannelTypingResult,
  ChannelUnsendInput,
  ChatAttachmentRecord,
  ChatMode,
  ChatAttachmentPreviewResponse,
  ChatCitationRecord,
  ChatCancelTurnResponse,
  ChatDelegateRequest,
  ChatDelegateAcceptRequest,
  ChatDelegateSuggestRequest,
  ChatDelegateSuggestResponse,
  ChatDelegateResponse,
  ChatDelegationSuggestionRecord,
  ChatDelegationRunRecord,
  ChatDelegationStepRecord,
  ChatMessageRecord,
  ChatProjectRecord,
  ChatSendMessageRequest,
  ChatSendMessageResponse,
  ChatSessionBindingRecord,
  ChatSessionBulkArchiveResult,
  ChatSessionOrigin,
  ChatSessionPrefsRecord,
  ChatSessionPrefsPatch,
  ChatSessionRecord,
  ChatSpecialistCandidatePatchInput,
  ChatSpecialistCandidateRecord,
  ChatSpecialistCandidateSuggestionRecord,
  ChatStreamChunk,
  ChatThreadResponse,
  ChatThinkingLevel,
  ChatTurnTraceRecord,
  ChatWebMode,
  DocsIngestInput,
  EmbeddingIndexInput,
  EmbeddingQueryInput,
  GmailReadQuery,
  GmailSendInput,
  GatewayInstallTokenResolution,
  CalendarCreateEventInput,
  CalendarListQuery,
  MemoryContextPack,
  MemorySearchQuery,
  MemoryWriteInput,
  MemoryQmdStatsResponse,
  NpuModelManifest,
  NpuRuntimeStatus,
  OnboardingBootstrapInput,
  OnboardingBootstrapResult,
  OnboardingState,
  IntegrationFormSchema,
  IntegrationPluginRecord,
  McpInvokeResponse,
  McpOAuthStartResponse,
  McpTemplateDiscoveryResult,
  McpServerRecord,
  McpServerTemplateRecord,
  McpToolRecord,
  MediaCreateJobRequest,
  MediaJobRecord,
  RuntimeLifecycleResponse,
  SessionMeta,
  SessionSummary,
  SessionTimelineItem,
  SseTokenIssueResponse,
  ToolAccessEvaluateRequest,
  ToolAccessEvaluateResponse,
  ToolCatalogEntry,
  ToolGrantCreateInput,
  ToolGrantRecord,
  ToolInvokeResult,
  UiActionState,
  VoiceStatus,
  VoiceRuntimeInstallRequest,
  VoiceRuntimeStatus,
  VoiceTalkSessionRecord,
  VoiceTranscribeResponse,
  BackupCreateResponse,
  BackupManifestRecord,
  RetentionPolicy,
  RetentionPruneResult,
  ResearchRunRecord,
  ResearchSourceRecord,
  ResearchSummaryRecord,
  PromptPackRecord,
  PromptPackTestRecord,
  PromptPackRunRecord,
  PromptPackScoreRecord,
  PromptPackAutoScoreResult,
  PromptPackAutoScoreBatchResult,
  PromptPackBenchmarkStatusRecord,
  PromptPackReportRecord,
  PromptPackExportRecord,
  ReplayDiffSummary,
  ReplayOverrideDraft,
  DurableRunCreateRequest,
  DurableRunRecord,
  DurableRunTimelineEvent,
  MemoryItemRecord,
  MemoryLifecyclePatch,
  MemoryChangeEvent,
  MemoryMaintenancePolicyPatchInput,
  MemoryMaintenancePolicyRecord,
  MemoryMaintenanceProvenanceRecord,
  MemoryMaintenanceRecommendationRecord,
  MemoryMaintenanceRunNowInput,
  MemoryMaintenanceRunRecord,
  MemoryMaintenanceStatusRecord,
  ConnectorRecord,
  ConnectorDiagnosticReport,
  CronReviewItem,
  CronRunDiff,
  ReplayRegressionRun,
  ReplayRegressionResult,
  CapabilityTrendSeries,
  CapabilityGapEventRecord,
  ProactivePolicy,
  ProactiveRunRecord,
  LearnedMemoryConflictRecord,
  LearnedMemoryItemRecord,
  LearnedMemoryUpdateInput,
  DecisionAutoTuneRecord,
  DecisionReplayFindingRecord,
  DecisionReplayItemRecord,
  DecisionReplayRunRecord,
  SkillActivationPolicy,
  SkillListItem,
  SkillSourceListResponse,
  SkillSourceLookupResponse,
  SkillImportValidationResult,
  SkillImportHistoryRecord,
  SkillSourceProvider,
  SkillImportSourceType,
  SkillStateRecord,
  SkillRuntimeState,
  ObsidianIntegrationConfig,
  ObsidianIntegrationStatus,
  WeeklyImprovementReportRecord,
  RepairCandidateRecord,
  GuidanceBundleRecord,
  GuidanceDocType,
  GuidanceDocumentRecord,
  WorkspaceCreateInput,
  WorkspaceRecord,
  WorkspaceUpdateInput,
  DevDiagnosticsEvent,
  DevDiagnosticsLevel,
  DevDiagnosticsListResponse,
  CreateAssemblyRunInput,
  ModelReputation,
} from "@goatcitadel/contracts";
import type { FollowOnParityReport, OpenclawParityProgramReport } from "@goatcitadel/contracts";
import {
  createCorrelationId,
  recordClientDiagnostic,
  setDevDiagnosticsActiveCorrelationId,
  setDevDiagnosticsGatewayReachable,
  setDevDiagnosticsLastRequestError,
} from "../state/dev-diagnostics-store";

export type { GuidanceDocumentRecord };
export type { RuntimeLifecycleResponse, SessionSummary, SessionTimelineItem };
export type { ObsidianIntegrationConfig, ObsidianIntegrationStatus };
export type { ExtensionSdkBriefDraft };
export type { ExtensionStarterPackArtifactRecord, ExtensionStarterPackDraft };

const DEFAULT_GATEWAY_HOST = "127.0.0.1";
const DEFAULT_GATEWAY_PORT = 8787;
const DEFAULT_GATEWAY_HOST_ALLOWLIST: string[] = [];
const API_BASE = import.meta.env.VITE_GATEWAY_URL ?? inferDefaultGatewayBaseUrl();
const MAX_SSE_BUFFER_CHARS = 256_000;
const MAX_SSE_EVENT_PREVIEW_CHARS = 180;
const AUTH_STORAGE_KEY = "goatcitadel.gateway.auth";
const AUTH_STORAGE_MODE_KEY = "goatcitadel.gateway.auth.storageMode";
const EVENT_CURSOR_STORAGE_KEY = "goatcitadel.events.cursor.v1";
const EVENT_CLIENT_ID_STORAGE_KEY = "goatcitadel.events.client.v1";

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
  onboardingState?: OnboardingState;
  rejectedStoredAuth?: boolean;
  bootstrapTokenRejected?: boolean;
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

export class ApiRequestError extends Error {
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

export function isApiRequestError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError;
}

export function getGatewayApiBaseUrl(): string {
  return API_BASE;
}

const SAFE_RETRY_METHODS = new Set(["GET", "HEAD"]);
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const RETRYABLE_HTTP_STATUS_CODES = new Set([408, 429, 502, 503, 504]);
const SAFE_REQUEST_RETRY_DELAYS_MS = [250];
const BROWSER_MUTATION_INTENT_HEADER = "x-goatcitadel-browser-intent";
const BROWSER_MUTATION_INTENT_VALUE = "mutation";

function normalizeHttpMethod(method?: string): string {
  return (method ?? "GET").toUpperCase();
}

function buildGatewayHeaders(path: string, method: string, correlationId: string, extraHeaders?: HeadersInit): HeadersInit {
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
      const res = await fetch(`${API_BASE}${path}`, {
        headers: {
          ...headers,
        },
        ...init,
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
          await sleep(SAFE_REQUEST_RETRY_DELAYS_MS[attempt] ?? SAFE_REQUEST_RETRY_DELAYS_MS[SAFE_REQUEST_RETRY_DELAYS_MS.length - 1] ?? 250);
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
    // ignore auth parse errors
  }
  return undefined;
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
    if (isApiRequestError(error)) {
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

export interface SessionsResponse {
  items: SessionMeta[];
  nextCursor?: string;
}

export interface ApprovalsResponse {
  items: ApprovalRequest[];
}

export type ApprovalReplayResponse = ApprovalReplaySnapshot;

export interface ApprovalResolveResponse {
  approval: ApprovalRequest;
  executedAction?: ToolInvokeResult;
  replay: ApprovalReplayResponse;
  durableRunId?: string;
}

export interface CostSummaryResponse {
  scope: string;
  from: string;
  to: string;
  usageAvailability?: {
    trackedEvents: number;
    unknownEvents: number;
    totalAgentEvents: number;
  };
  items: Array<{
    key: string;
    tokenInput: number;
    tokenOutput: number;
    tokenCachedInput: number;
    tokenTotal: number;
    costUsd: number;
  }>;
}

export interface TaskRecord {
  taskId: string;
  title: string;
  description?: string;
  status: "planning" | "inbox" | "assigned" | "in_progress" | "testing" | "review" | "done" | "blocked";
  priority: "low" | "normal" | "high" | "urgent";
  assignedAgentId?: string;
  createdBy?: string;
  dueAt?: string;
  deletedAt?: string;
  deletedBy?: string;
  deleteReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskActivityRecord {
  activityId: string;
  taskId: string;
  agentId?: string;
  activityType: "spawned" | "updated" | "completed" | "file_created" | "status_changed" | "comment";
  message: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface TaskDeliverableRecord {
  deliverableId: string;
  taskId: string;
  deliverableType: "file" | "url" | "artifact";
  title: string;
  path?: string;
  description?: string;
  createdAt: string;
}

export interface TaskSubagentSession {
  subagentSessionId: string;
  taskId: string;
  agentSessionId: string;
  agentName?: string;
  status: "active" | "completed" | "failed" | "killed";
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

export interface RealtimeEvent {
  eventId: string;
  sequence: number;
  eventType: string;
  source: string;
  timestamp: string;
  eventClass?: "domain_fact" | "operational_signal" | "ui_notification";
  eventAuthority?: "retained_stream" | "durable_history" | "derived_projection";
  links?: {
    sessionId?: string;
    turnId?: string;
    runId?: string;
    approvalId?: string;
    taskId?: string;
    workspaceId?: string;
    connectorId?: string;
    tokenId?: string;
    messageId?: string;
  };
  correlationId?: string;
  traceId?: string;
  originSurface?: string;
  payload: Record<string, unknown>;
}

export interface DashboardStateResponse {
  timestamp: string;
  sessions: SessionsResponse["items"];
  pendingApprovals: number;
  activeSubagents: number;
  taskStatusCounts: Array<{ status: string; count: number }>;
  recentEvents: RealtimeEvent[];
  dailyCostUsd: number;
}

export interface SystemVitalsResponse {
  hostname: string;
  platform: string;
  release: string;
  uptimeSeconds: number;
  loadAverage: number[];
  cpuCount: number;
  memoryTotalBytes: number;
  memoryFreeBytes: number;
  memoryUsedBytes: number;
  processRssBytes: number;
  processHeapUsedBytes: number;
}

export type {
  A2UIProofLaneDraft,
  BrowserProofLaneDraft,
  FollowOnParityReport,
  FollowOnProofLaneArtifactRecord,
  OpenclawParityProgramReport,
  PackagingProofLaneDraft,
  VoiceProofLaneDraft,
};

export interface CronJobsResponse {
  items: Array<{
    jobId: string;
    name: string;
    schedule: string;
    enabled: boolean;
    lastRunAt?: string;
    nextRunAt?: string;
    updatedAt?: string;
  }>;
}

export interface CronJobRecordResponse {
  jobId: string;
  name: string;
  schedule: string;
  enabled: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  updatedAt?: string;
}

export interface OperatorsResponse {
  items: Array<{
    operatorId: string;
    sessionCount: number;
    activeSessions: number;
    lastActivityAt?: string;
  }>;
}

export interface AgentsResponse {
  items: AgentProfileRecord[];
  view?: "active" | "archived" | "all";
}

export interface RuntimeSettingsResponse {
  environment: string;
  deploymentProfile: "local_dev" | "trusted_local" | "remote_hardened";
  defaultToolProfile: string;
  budgetMode: "saver" | "balanced" | "power";
  workspaceDir: string;
  writeJailRoots: string[];
  readOnlyRoots: string[];
  readAccessMode?: "roots_only" | "approval_required" | "full_disk";
  networkAllowlist: string[];
  approvalExplainer: {
    enabled: boolean;
    mode: "async";
    minRiskLevel: "caution" | "danger" | "nuclear";
    providerId?: string;
    model?: string;
    timeoutMs: number;
    maxPayloadChars: number;
  };
  memory: {
    enabled: boolean;
    qmd: {
      enabled: boolean;
      applyToChat: boolean;
      applyToOrchestration: boolean;
      minPromptChars: number;
      maxContextTokens: number;
      cacheTtlSeconds: number;
      distillerProviderId?: string;
      distillerModel?: string;
    };
  };
  auth: {
    mode: "none" | "token" | "basic";
    allowLoopbackBypass: boolean;
    tokenConfigured: boolean;
    basicConfigured: boolean;
  };
  llm: {
    activeProviderId: string;
    activeModel: string;
    providers: Array<{
      providerId: string;
      label: string;
      baseUrl: string;
      apiStyle: "openai-chat-completions" | "openai-responses" | "anthropic-messages";
      resolvedApiStyle?: "openai-chat-completions" | "openai-responses" | "anthropic-messages";
      defaultModel: string;
      hasApiKey: boolean;
      apiKeySource: "inline" | "env" | "keychain" | "none";
      hasKeychainSecret?: boolean;
      apiKeyRef?: string;
      capabilities?: {
        vision: boolean;
        audio: boolean;
        video: boolean;
        toolCalling: boolean;
        jsonMode: boolean;
      };
    }>;
  };
  mesh: {
    enabled: boolean;
    mode: "lan" | "wan" | "tailnet";
    nodeId: string;
    mdns: boolean;
    staticPeers: string[];
    requireMtls: boolean;
    tailnetEnabled: boolean;
  };
  npu: {
    enabled: boolean;
    autoStart: boolean;
    sidecarUrl: string;
    status: NpuRuntimeStatus;
  };
  features: {
    durableKernelV1Enabled: boolean;
    memoryMaintenanceV1Enabled: boolean;
    replayOverridesV1Enabled: boolean;
    memoryLifecycleAdminV1Enabled: boolean;
    connectorDiagnosticsV1Enabled: boolean;
    computerUseGuardrailsV1Enabled: boolean;
    bankrBuiltinEnabled: boolean;
    cronReviewQueueV1Enabled: boolean;
    replayRegressionV1Enabled: boolean;
  };
}

export interface OnboardingCompleteResponse {
  state: OnboardingState;
}

export interface IntegrationCatalogEntry {
  catalogId: string;
  kind: "channel" | "model_provider" | "productivity" | "automation" | "platform";
  key: string;
  label: string;
  description: string;
  maturity: "native" | "plugin" | "disabled" | "beta" | "planned";
  runtimeAvailability?: "runnable" | "blocked";
  authMethods: string[];
  capabilities: string[];
  docsUrl?: string;
  formSchema?: IntegrationFormSchema;
  pluginId?: string;
}

export interface IntegrationConnection {
  connectionId: string;
  catalogId: string;
  kind: "channel" | "model_provider" | "productivity" | "automation" | "platform";
  key: string;
  label: string;
  enabled: boolean;
  status: "connected" | "disconnected" | "error" | "paused";
  config: Record<string, unknown>;
  pluginId?: string;
  pluginVersion?: string;
  pluginEnabled?: boolean;
  createdAt: string;
  updatedAt: string;
  lastSyncAt?: string;
  lastError?: string;
}

export interface LlmChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    index: number;
    finish_reason?: string | null;
    message?: {
      role?: string;
      content?: string | null;
      [key: string]: unknown;
    };
  }>;
  usage?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MeshStatusResponse {
  enabled: boolean;
  mode: "lan" | "wan" | "tailnet";
  localNodeId: string;
  tailnetEnabled: boolean;
  nodesOnline: number;
  activeLeases: number;
  ownedSessions: number;
}

export interface MeshNodeRecord {
  nodeId: string;
  label?: string;
  advertiseAddress?: string;
  transport: "lan" | "wan" | "tailnet";
  status: "online" | "suspect" | "offline";
  capabilities: string[];
  tlsFingerprint?: string;
  joinedAt: string;
  lastSeenAt: string;
}

export interface MeshLeaseRecord {
  leaseKey: string;
  holderNodeId: string;
  fencingToken: number;
  expiresAt: string;
  updatedAt: string;
}

export interface MeshSessionOwnerRecord {
  sessionId: string;
  ownerNodeId: string;
  epoch: number;
  claimedAt: string;
  updatedAt: string;
}

export interface MeshReplicationOffsetRecord {
  consumerNodeId: string;
  sourceNodeId: string;
  lastReplicationId?: string;
  updatedAt: string;
}

export async function fetchSessions(): Promise<SessionsResponse> {
  return request<SessionsResponse>("/api/v1/sessions?limit=50");
}

export async function fetchSessionSummary(sessionId: string): Promise<SessionSummary> {
  return request<SessionSummary>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/summary`);
}

export async function fetchSessionTimeline(sessionId: string, limit = 200): Promise<{ items: SessionTimelineItem[] }> {
  return request<{ items: SessionTimelineItem[] }>(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/timeline?limit=${Math.max(1, Math.min(limit, 1000))}`,
  );
}

export async function fetchRuntimeLifecycle(input: {
  sessionId?: string;
  turnId?: string;
  runId?: string;
  approvalId?: string;
  taskId?: string;
}): Promise<RuntimeLifecycleResponse> {
  const query = new URLSearchParams();
  if (input.sessionId) query.set("sessionId", input.sessionId);
  if (input.turnId) query.set("turnId", input.turnId);
  if (input.runId) query.set("runId", input.runId);
  if (input.approvalId) query.set("approvalId", input.approvalId);
  if (input.taskId) query.set("taskId", input.taskId);
  return request<RuntimeLifecycleResponse>(`/api/v1/runtime/lifecycle?${query.toString()}`);
}

export interface ChatProjectsResponse {
  items: ChatProjectRecord[];
  view?: "active" | "archived" | "all";
}

export interface ChatSessionsResponse {
  items: ChatSessionRecord[];
  nextCursor?: string;
}

export interface ChatMessagesResponse {
  items: ChatMessageRecord[];
}

export interface WorkspacesResponse {
  items: WorkspaceRecord[];
  view?: "active" | "archived" | "all";
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

export async function createWorkspace(input: WorkspaceCreateInput): Promise<WorkspaceRecord> {
  return request<WorkspaceRecord>("/api/v1/workspaces", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateWorkspace(workspaceId: string, input: WorkspaceUpdateInput): Promise<WorkspaceRecord> {
  return request<WorkspaceRecord>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function archiveWorkspace(workspaceId: string): Promise<WorkspaceRecord> {
  return request<WorkspaceRecord>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/archive`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function restoreWorkspace(workspaceId: string): Promise<WorkspaceRecord> {
  return request<WorkspaceRecord>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/restore`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchGlobalGuidance(): Promise<{ items: GuidanceDocumentRecord[] }> {
  return request<{ items: GuidanceDocumentRecord[] }>("/api/v1/guidance/global");
}

export async function updateGlobalGuidance(
  docType: GuidanceDocType,
  content: string,
): Promise<GuidanceDocumentRecord> {
  return request<GuidanceDocumentRecord>(`/api/v1/guidance/global/${encodeURIComponent(docType)}`, {
    method: "PUT",
    body: JSON.stringify({ content }),
  });
}

export async function fetchWorkspaceGuidance(workspaceId: string): Promise<GuidanceBundleRecord> {
  return request<GuidanceBundleRecord>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/guidance`);
}

export async function updateWorkspaceGuidance(
  workspaceId: string,
  docType: GuidanceDocType,
  content: string,
): Promise<GuidanceDocumentRecord> {
  return request<GuidanceDocumentRecord>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/guidance/${encodeURIComponent(docType)}`,
    {
      method: "PUT",
      body: JSON.stringify({ content }),
    },
  );
}

export async function fetchChatProjects(
  view: "active" | "archived" | "all" = "active",
  limit = 300,
  workspaceId?: string,
): Promise<ChatProjectsResponse> {
  const query = new URLSearchParams();
  query.set("view", view);
  query.set("limit", String(limit));
  if (workspaceId?.trim()) {
    query.set("workspaceId", workspaceId.trim());
  }
  return request<ChatProjectsResponse>(`/api/v1/chat/projects?${query.toString()}`);
}

export async function createChatProject(input: {
  workspaceId?: string;
  name: string;
  description?: string;
  workspacePath: string;
  color?: string;
}): Promise<ChatProjectRecord> {
  return request<ChatProjectRecord>("/api/v1/chat/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateChatProject(projectId: string, input: {
  workspaceId?: string;
  name?: string;
  description?: string;
  workspacePath?: string;
  color?: string;
}): Promise<ChatProjectRecord> {
  return request<ChatProjectRecord>(`/api/v1/chat/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function archiveChatProject(projectId: string): Promise<ChatProjectRecord> {
  return request<ChatProjectRecord>(`/api/v1/chat/projects/${encodeURIComponent(projectId)}/archive`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function restoreChatProject(projectId: string): Promise<ChatProjectRecord> {
  return request<ChatProjectRecord>(`/api/v1/chat/projects/${encodeURIComponent(projectId)}/restore`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function hardDeleteChatProject(projectId: string): Promise<{ deleted: boolean; projectId: string; mode: "hard" }> {
  return request<{ deleted: boolean; projectId: string; mode: "hard" }>(
    `/api/v1/chat/projects/${encodeURIComponent(projectId)}?mode=hard`,
    {
      method: "DELETE",
      body: JSON.stringify({}),
    },
  );
}

export async function fetchChatSessions(input?: {
  scope?: "mission" | "external" | "all";
  workspaceId?: string;
  projectId?: string;
  q?: string;
  view?: "active" | "archived" | "all";
  limit?: number;
  cursor?: string;
  includeHidden?: boolean;
}): Promise<ChatSessionsResponse> {
  const query = new URLSearchParams();
  if (input?.scope) query.set("scope", input.scope);
  if (input?.workspaceId) query.set("workspaceId", input.workspaceId);
  if (input?.projectId) query.set("projectId", input.projectId);
  if (input?.q) query.set("q", input.q);
  if (input?.view) query.set("view", input.view);
  if (input?.includeHidden !== undefined) query.set("includeHidden", String(input.includeHidden));
  query.set("limit", String(input?.limit ?? 200));
  if (input?.cursor) query.set("cursor", input.cursor);
  return request<ChatSessionsResponse>(`/api/v1/chat/sessions?${query.toString()}`);
}

export async function createChatSession(input?: {
  workspaceId?: string;
  title?: string;
  projectId?: string;
  mode?: ChatMode;
  origin?: ChatSessionOrigin;
  includeInHistory?: boolean;
}): Promise<ChatSessionRecord> {
  return request<ChatSessionRecord>("/api/v1/chat/sessions", {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

export async function archiveWorkspaceChatSessions(input?: {
  workspaceId?: string;
  scope?: "mission" | "external" | "all";
  includeHidden?: boolean;
}): Promise<ChatSessionBulkArchiveResult> {
  return request<ChatSessionBulkArchiveResult>("/api/v1/chat/sessions/archive-bulk", {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

export async function updateChatSession(sessionId: string, input: { title?: string }): Promise<ChatSessionRecord> {
  return request<ChatSessionRecord>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deleteChatSession(sessionId: string): Promise<{ deleted: boolean; sessionId: string }> {
  return request<{ deleted: boolean; sessionId: string }>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
}

export async function pinChatSession(sessionId: string): Promise<ChatSessionRecord> {
  return request<ChatSessionRecord>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/pin`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function unpinChatSession(sessionId: string): Promise<ChatSessionRecord> {
  return request<ChatSessionRecord>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/unpin`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function archiveChatSession(sessionId: string): Promise<ChatSessionRecord> {
  return request<ChatSessionRecord>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/archive`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function restoreChatSession(sessionId: string): Promise<ChatSessionRecord> {
  return request<ChatSessionRecord>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/restore`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function assignChatSessionProject(sessionId: string, projectId?: string): Promise<ChatSessionRecord> {
  return request<ChatSessionRecord>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/project`, {
    method: "POST",
    body: JSON.stringify({ projectId }),
  });
}

export async function setChatSessionBinding(sessionId: string, input: {
  transport: "llm" | "integration";
  connectionId?: string;
  target?: string;
  writable?: boolean;
}): Promise<ChatSessionBindingRecord> {
  return request<ChatSessionBindingRecord>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/binding`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchChatSessionBinding(sessionId: string): Promise<{ item: ChatSessionBindingRecord | null }> {
  return request<{ item: ChatSessionBindingRecord | null }>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/binding`);
}

export async function fetchChatMessages(sessionId: string, limit = 200, cursor?: string): Promise<ChatMessagesResponse> {
  const query = new URLSearchParams();
  query.set("limit", String(Math.max(1, Math.min(limit, 1000))));
  if (cursor) {
    query.set("cursor", cursor);
  }
  return request<ChatMessagesResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/messages?${query.toString()}`,
  );
}

export async function fetchChatThread(sessionId: string): Promise<ChatThreadResponse> {
  return request<ChatThreadResponse>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/thread`);
}

export async function sendAgentChatMessage(sessionId: string, input: ChatSendMessageRequest): Promise<ChatSendMessageResponse> {
  return request<ChatSendMessageResponse>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/agent-send`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function streamAgentChatMessage(
  sessionId: string,
  input: ChatSendMessageRequest,
  onChunk: (chunk: ChatStreamChunk) => void,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const path = `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/agent-send/stream`;
  const correlationId = createCorrelationId();
  recordClientDiagnostic({
    level: "info",
    category: "chat",
    event: "stream.start",
    message: "Agent chat stream started",
    correlationId,
    sessionId,
    route: path,
  });
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    signal: options.signal,
    headers: buildGatewayHeaders(path, "POST", correlationId, {
      "x-goatcitadel-session-id": sessionId,
    }),
    body: JSON.stringify(input),
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
    recordClientDiagnostic({
      level: "error",
      category: "chat",
      event: "stream.error",
      message: `Agent chat stream failed (${response.status})`,
      correlationId,
      sessionId,
      route: path,
      context: { status: response.status, body: text.slice(0, 600) },
    });
    throw new Error(`API error ${response.status}: ${text}`);
  }
  await consumeSseResponse(response.body, (chunk) => {
    if (chunk.type === "error") {
      recordClientDiagnostic({
        level: "error",
        category: "chat",
        event: "stream.chunk_error",
        message: "Agent chat stream emitted an error chunk",
        correlationId,
        sessionId,
        route: path,
        turnId: chunk.turnId,
      });
    }
    onChunk(chunk);
  }, options.signal);
  recordClientDiagnostic({
    level: "info",
    category: "chat",
    event: "stream.complete",
    message: "Agent chat stream completed",
    correlationId,
    sessionId,
    route: path,
  });
}

export async function selectChatBranchTurn(sessionId: string, turnId: string): Promise<ChatThreadResponse> {
  return request<ChatThreadResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/select`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function retryChatTurn(
  sessionId: string,
  turnId: string,
  input?: Partial<ChatSendMessageRequest>,
): Promise<ChatSendMessageResponse> {
  return request<ChatSendMessageResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/retry`,
    {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    },
  );
}

export async function streamRetryChatTurn(
  sessionId: string,
  turnId: string,
  input: Partial<ChatSendMessageRequest>,
  onChunk: (chunk: ChatStreamChunk) => void,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const path = `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/retry/stream`;
  const correlationId = createCorrelationId();
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    signal: options.signal,
    headers: buildGatewayHeaders(path, "POST", correlationId, {
      "x-goatcitadel-session-id": sessionId,
    }),
    body: JSON.stringify(input),
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }
  await consumeSseResponse(response.body, onChunk, options.signal);
}

export async function editChatTurn(
  sessionId: string,
  turnId: string,
  input: ChatSendMessageRequest,
): Promise<ChatSendMessageResponse> {
  return request<ChatSendMessageResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/edit`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function streamEditChatTurn(
  sessionId: string,
  turnId: string,
  input: ChatSendMessageRequest,
  onChunk: (chunk: ChatStreamChunk) => void,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const path = `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/edit/stream`;
  const correlationId = createCorrelationId();
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    signal: options.signal,
    headers: buildGatewayHeaders(path, "POST", correlationId, {
      "x-goatcitadel-session-id": sessionId,
    }),
    body: JSON.stringify(input),
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }
  await consumeSseResponse(response.body, onChunk, options.signal);
}

export async function resumeChatTurnStream(
  sessionId: string,
  turnId: string,
  onChunk: (chunk: ChatStreamChunk) => void,
  options: { signal?: AbortSignal; sinceEventId?: string } = {},
): Promise<void> {
  const query = new URLSearchParams();
  if (options.sinceEventId) {
    query.set("sinceEventId", options.sinceEventId);
  }
  const path = `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/stream${query.size > 0 ? `?${query.toString()}` : ""}`;
  const correlationId = createCorrelationId();
  const response = await fetch(`${API_BASE}${path}`, {
    method: "GET",
    signal: options.signal,
    headers: buildGatewayHeaders(path, "GET", correlationId, {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      "x-goatcitadel-session-id": sessionId,
      ...(options.sinceEventId ? { "Last-Event-ID": options.sinceEventId } : {}),
    }),
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }
  await consumeSseResponse(response.body, onChunk, options.signal);
}

export async function cancelChatTurn(
  sessionId: string,
  turnId: string,
  cancelledBy?: string,
): Promise<ChatCancelTurnResponse> {
  return request<ChatCancelTurnResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/cancel`,
    {
      method: "POST",
      body: JSON.stringify(cancelledBy ? { cancelledBy } : {}),
    },
  );
}

export async function fetchChatSessionPrefs(sessionId: string): Promise<ChatSessionPrefsRecord> {
  return request<ChatSessionPrefsRecord>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/prefs`);
}

export async function updateChatSessionPrefs(
  sessionId: string,
  input: ChatSessionPrefsPatch,
): Promise<ChatSessionPrefsRecord> {
  return request<ChatSessionPrefsRecord>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/prefs`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export interface ChatProactiveStatusResponse {
  policy: ProactivePolicy;
  idleSeconds: number;
  hasRunningTurn: boolean;
  pendingSuggestions: number;
  actionsLastHour: number;
  lastRun?: ProactiveRunRecord;
}

export async function fetchChatProactiveStatus(sessionId: string): Promise<ChatProactiveStatusResponse> {
  return request<ChatProactiveStatusResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/proactive/status`,
  );
}

export async function updateChatProactivePolicy(
  sessionId: string,
  input: Partial<{
    proactiveMode: ProactivePolicy["mode"];
    autonomyBudget: Partial<ProactivePolicy["autonomyBudget"]>;
    retrievalMode: ProactivePolicy["retrievalMode"];
    reflectionMode: ProactivePolicy["reflectionMode"];
  }>,
): Promise<ProactivePolicy> {
  return request<ProactivePolicy>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/proactive/policy`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function triggerChatProactive(
  sessionId: string,
  input?: {
    source?: "scheduler" | "manual" | "chat";
    reason?: string;
  },
): Promise<ProactiveRunRecord> {
  return request<ProactiveRunRecord>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/proactive/trigger`, {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

export async function fetchChatProactiveRuns(sessionId: string, limit = 50): Promise<{ items: ProactiveRunRecord[] }> {
  return request<{ items: ProactiveRunRecord[] }>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/proactive/runs?limit=${Math.max(1, Math.min(limit, 500))}`,
  );
}

export async function fetchChatLearnedMemory(
  sessionId: string,
  limit = 200,
): Promise<{
  items: LearnedMemoryItemRecord[];
  conflicts: LearnedMemoryConflictRecord[];
}> {
  return request<{
    items: LearnedMemoryItemRecord[];
    conflicts: LearnedMemoryConflictRecord[];
  }>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/learned-memory?limit=${Math.max(1, Math.min(limit, 1000))}`,
  );
}

export async function updateChatLearnedMemoryItem(
  sessionId: string,
  itemId: string,
  input: LearnedMemoryUpdateInput,
): Promise<LearnedMemoryItemRecord> {
  return request<LearnedMemoryItemRecord>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/learned-memory/${encodeURIComponent(itemId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
}

export async function rebuildChatLearnedMemory(
  sessionId: string,
): Promise<{
  rebuiltAt: string;
  items: LearnedMemoryItemRecord[];
  conflicts: LearnedMemoryConflictRecord[];
}> {
  return request<{
    rebuiltAt: string;
    items: LearnedMemoryItemRecord[];
    conflicts: LearnedMemoryConflictRecord[];
  }>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/learned-memory/rebuild`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchChatSpecialistCandidates(
  sessionId: string,
  limit = 200,
): Promise<{ items: ChatSpecialistCandidateRecord[] }> {
  return request<{ items: ChatSpecialistCandidateRecord[] }>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/specialist-candidates?limit=${Math.max(1, Math.min(limit, 500))}`,
  );
}

export async function createChatSpecialistCandidate(
  sessionId: string,
  input: {
    turnId?: string;
    suggestion: ChatSpecialistCandidateSuggestionRecord;
  },
): Promise<ChatSpecialistCandidateRecord> {
  return request<ChatSpecialistCandidateRecord>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/specialist-candidates`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function updateChatSpecialistCandidate(
  sessionId: string,
  candidateId: string,
  input: ChatSpecialistCandidatePatchInput,
): Promise<ChatSpecialistCandidateRecord> {
  return request<ChatSpecialistCandidateRecord>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/specialist-candidates/${encodeURIComponent(candidateId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
}

export async function suggestChatDelegation(
  sessionId: string,
  input: ChatDelegateSuggestRequest = {},
): Promise<ChatDelegateSuggestResponse> {
  return request<ChatDelegateSuggestResponse>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/delegate/suggest`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function acceptChatDelegation(
  sessionId: string,
  input: ChatDelegateAcceptRequest,
): Promise<ChatDelegateResponse> {
  return request<ChatDelegateResponse>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/delegate/accept`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchChatCommandCatalog(): Promise<{
  items: Array<{ command: string; usage: string; description: string }>;
}> {
  return request<{ items: Array<{ command: string; usage: string; description: string }> }>("/api/v1/chat/catalog/commands");
}

export async function parseChatCommand(
  sessionId: string,
  commandText: string,
): Promise<{
  ok: boolean;
  command: string;
  args: string[];
  message: string;
  prefs?: ChatSessionPrefsRecord;
  research?: ResearchSummaryRecord;
  session?: ChatSessionRecord;
}> {
  return request(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/commands/parse`, {
    method: "POST",
    body: JSON.stringify({ commandText }),
  });
}

export async function runChatResearch(
  sessionId: string,
  input: {
    query: string;
    mode?: "quick" | "deep";
    providerId?: string;
    model?: string;
  },
): Promise<ResearchSummaryRecord> {
  return request<ResearchSummaryRecord>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/research/run`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchChatResearchRun(
  sessionId: string,
  runId: string,
): Promise<{
  run: ResearchRunRecord;
  sources: ResearchSourceRecord[];
}> {
  return request<{ run: ResearchRunRecord; sources: ResearchSourceRecord[] }>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/research/${encodeURIComponent(runId)}`,
  );
}

export async function runChatDelegation(
  sessionId: string,
  input: ChatDelegateRequest,
): Promise<ChatDelegateResponse> {
  return request<ChatDelegateResponse>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/delegate`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface ChatDelegationStreamChunk {
  type: "status" | "step" | "done" | "error";
  runId?: string;
  taskId?: string;
  message?: string;
  step?: {
    stepId: string;
    runId: string;
    role: string;
    status: string;
    index: number;
    startedAt: string;
    finishedAt?: string;
    durationMs?: number;
    output?: string;
    error?: string;
  };
  result?: ChatDelegateResponse;
  error?: string;
}

export async function streamChatDelegation(
  sessionId: string,
  input: ChatDelegateRequest,
  onChunk: (chunk: ChatDelegationStreamChunk) => void,
): Promise<void> {
  const path = `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/delegate/stream`;
  const correlationId = createCorrelationId();
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: buildGatewayHeaders(path, "POST", correlationId, {
      "x-goatcitadel-session-id": sessionId,
    }),
    body: JSON.stringify(input),
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }
  let streamError: string | null = null;
  for await (const dataText of iterateSsePayloads(response.body)) {
    const chunk = parseSseJson<ChatDelegationStreamChunk>(dataText);
    onChunk(chunk);
    if (chunk.type === "error") {
      streamError = chunk.error || "Streaming request failed.";
    }
  }
  if (streamError) {
    throw new Error(streamError);
  }
}

export async function fetchChatDelegationRun(
  sessionId: string,
  runId: string,
): Promise<{
  run: ChatDelegationRunRecord;
  steps: ChatDelegationStepRecord[];
}> {
  return request(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/delegations/${encodeURIComponent(runId)}`);
}

export async function importPromptPack(input: {
  content: string;
  name?: string;
  sourceLabel?: string;
  packId?: string;
}): Promise<{
  pack: PromptPackRecord;
  tests: PromptPackTestRecord[];
}> {
  return request("/api/v1/prompt-packs/import", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchPromptPacks(limit = 200): Promise<{ items: PromptPackRecord[] }> {
  return request<{ items: PromptPackRecord[] }>(`/api/v1/prompt-packs?limit=${Math.max(1, Math.min(limit, 2000))}`);
}

export async function fetchPromptPackTests(packId: string, limit = 2000): Promise<{ items: PromptPackTestRecord[] }> {
  return request<{ items: PromptPackTestRecord[] }>(
    `/api/v1/prompt-packs/${encodeURIComponent(packId)}/tests?limit=${Math.max(1, Math.min(limit, 2000))}`,
  );
}

export async function runPromptPackTest(
  packId: string,
  testId: string,
  input?: {
    sessionId?: string;
    providerId?: string;
    model?: string;
    placeholderValues?: Record<string, string>;
  },
): Promise<PromptPackRunRecord> {
  return request<PromptPackRunRecord>(`/api/v1/prompt-packs/${encodeURIComponent(packId)}/tests/${encodeURIComponent(testId)}/run`, {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

export async function scorePromptPackTest(
  packId: string,
  testId: string,
  input: {
    runId: string;
    routingScore: 0 | 1 | 2;
    honestyScore: 0 | 1 | 2;
    handoffScore: 0 | 1 | 2;
    robustnessScore: 0 | 1 | 2;
    usabilityScore: 0 | 1 | 2;
    notes?: string;
  },
): Promise<PromptPackScoreRecord> {
  return request<PromptPackScoreRecord>(`/api/v1/prompt-packs/${encodeURIComponent(packId)}/tests/${encodeURIComponent(testId)}/score`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function autoScorePromptPackTest(
  packId: string,
  testId: string,
  input?: {
    runId?: string;
    providerId?: string;
    model?: string;
    force?: boolean;
  },
): Promise<PromptPackAutoScoreResult> {
  return request<PromptPackAutoScoreResult>(
    `/api/v1/prompt-packs/${encodeURIComponent(packId)}/tests/${encodeURIComponent(testId)}/auto-score`,
    {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    },
  );
}

export async function autoScorePromptPackBatch(
  packId: string,
  input?: {
    onlyUnscored?: boolean;
    limit?: number;
    providerId?: string;
    model?: string;
    force?: boolean;
  },
): Promise<PromptPackAutoScoreBatchResult> {
  return request<PromptPackAutoScoreBatchResult>(
    `/api/v1/prompt-packs/${encodeURIComponent(packId)}/auto-score`,
    {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    },
  );
}

export async function fetchPromptPackReport(packId: string): Promise<PromptPackReportRecord> {
  return request<PromptPackReportRecord>(`/api/v1/prompt-packs/${encodeURIComponent(packId)}/report`);
}

export async function runPromptPackBenchmark(
  packId: string,
  input: {
    testCodes: string[];
    providers: Array<{
      providerId: string;
      model: string;
    }>;
  },
): Promise<{ benchmarkRunId: string }> {
  return request<{ benchmarkRunId: string }>(
    `/api/v1/prompt-packs/${encodeURIComponent(packId)}/benchmark/run`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function fetchPromptPackBenchmark(
  benchmarkRunId: string,
): Promise<PromptPackBenchmarkStatusRecord> {
  return request<PromptPackBenchmarkStatusRecord>(
    `/api/v1/prompt-packs/benchmark/${encodeURIComponent(benchmarkRunId)}`,
  );
}

export async function runPromptPackReplayRegression(
  packId: string,
  input: {
    testCodes: string[];
    baselineRef?: string;
  },
): Promise<{ regressionRunId: string }> {
  return request<{ regressionRunId: string }>(
    `/api/v1/prompt-packs/${encodeURIComponent(packId)}/replay-regression/run`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function fetchPromptPackReplayRegressionStatus(
  runId: string,
): Promise<{ run: ReplayRegressionRun; results: ReplayRegressionResult[] }> {
  return request<{ run: ReplayRegressionRun; results: ReplayRegressionResult[] }>(
    `/api/v1/prompt-packs/replay-regression/${encodeURIComponent(runId)}`,
  );
}

export async function fetchPromptPackTrends(packId: string): Promise<{ items: CapabilityTrendSeries[] }> {
  return request<{ items: CapabilityTrendSeries[] }>(
    `/api/v1/prompt-packs/${encodeURIComponent(packId)}/trends`,
  );
}

export async function fetchPromptPackExport(packId: string): Promise<PromptPackExportRecord> {
  return request<PromptPackExportRecord>(`/api/v1/prompt-packs/${encodeURIComponent(packId)}/export`);
}

export async function exportPromptPackReport(
  packId: string,
  input?: { includeHistory?: boolean },
): Promise<PromptPackExportRecord> {
  return request<PromptPackExportRecord>(`/api/v1/prompt-packs/${encodeURIComponent(packId)}/export`, {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

export async function resetPromptPack(
  packId: string,
  input?: {
    clearRuns?: boolean;
    clearScores?: boolean;
  },
): Promise<{
  packId: string;
  deletedRuns: number;
  deletedScores: number;
  export: PromptPackExportRecord;
}> {
  return request<{
    packId: string;
    deletedRuns: number;
    deletedScores: number;
    export: PromptPackExportRecord;
  }>(`/api/v1/prompt-packs/${encodeURIComponent(packId)}/reset`, {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

export async function fetchImprovementReports(limit = 24): Promise<{ items: WeeklyImprovementReportRecord[] }> {
  return request<{ items: WeeklyImprovementReportRecord[] }>(
    `/api/v1/improvement/reports?limit=${Math.max(1, Math.min(limit, 260))}`,
  );
}

export async function fetchImprovementReport(reportId: string): Promise<WeeklyImprovementReportRecord> {
  return request<WeeklyImprovementReportRecord>(`/api/v1/improvement/reports/${encodeURIComponent(reportId)}`);
}

export async function runImprovementReplay(input?: {
  sampleSize?: number;
}): Promise<{
  run: DecisionReplayRunRecord;
  report?: WeeklyImprovementReportRecord;
}> {
  return request<{
    run: DecisionReplayRunRecord;
    report?: WeeklyImprovementReportRecord;
  }>("/api/v1/improvement/replay/run", {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

export async function fetchImprovementReplayRuns(limit = 40): Promise<{ items: DecisionReplayRunRecord[] }> {
  return request<{ items: DecisionReplayRunRecord[] }>(
    `/api/v1/improvement/replay/runs?limit=${Math.max(1, Math.min(limit, 300))}`,
  );
}

export async function fetchCapabilityGapEvents(limit = 100): Promise<{ items: CapabilityGapEventRecord[] }> {
  return request<{ items: CapabilityGapEventRecord[] }>(
    `/api/v1/improvement/capability-gaps?limit=${Math.max(1, Math.min(limit, 500))}`,
  );
}

export async function fetchRepairCandidates(limit = 60): Promise<{ items: RepairCandidateRecord[] }> {
  return request<{ items: RepairCandidateRecord[] }>(
    `/api/v1/improvement/repair-candidates?limit=${Math.max(1, Math.min(limit, 300))}`,
  );
}

export async function updateRepairCandidateValidation(
  candidateId: string,
  input: {
    status: RepairCandidateRecord["validationStatus"];
    summary?: string;
  },
): Promise<RepairCandidateRecord> {
  return request<RepairCandidateRecord>(`/api/v1/improvement/repair-candidates/${encodeURIComponent(candidateId)}/validation`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function fetchImprovementReplayRun(runId: string): Promise<{
  run: DecisionReplayRunRecord;
  items: DecisionReplayItemRecord[];
  findings: DecisionReplayFindingRecord[];
  autoTunes: DecisionAutoTuneRecord[];
  report?: WeeklyImprovementReportRecord;
}> {
  return request<{
    run: DecisionReplayRunRecord;
    items: DecisionReplayItemRecord[];
    findings: DecisionReplayFindingRecord[];
    autoTunes: DecisionAutoTuneRecord[];
    report?: WeeklyImprovementReportRecord;
  }>(`/api/v1/improvement/replay/runs/${encodeURIComponent(runId)}`);
}

export async function draftReplayOverride(
  runId: string,
  input: {
    overrides: ReplayOverrideDraft["overrides"];
    capabilityGapEventId?: string;
    repairCandidateId?: string;
  },
): Promise<ReplayOverrideDraft> {
  return request<ReplayOverrideDraft>(`/api/v1/replay/runs/${encodeURIComponent(runId)}/draft`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function executeReplayOverride(
  runId: string,
  input: {
    overrides: ReplayOverrideDraft["overrides"];
    capabilityGapEventId?: string;
    repairCandidateId?: string;
  },
): Promise<ReplayOverrideDraft> {
  return request<ReplayOverrideDraft>(`/api/v1/replay/runs/${encodeURIComponent(runId)}/execute`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchReplayDiff(replayRunId: string): Promise<ReplayDiffSummary> {
  return request<ReplayDiffSummary>(`/api/v1/replay/${encodeURIComponent(replayRunId)}/diff`);
}

export async function approveImprovementAutoTune(tuneId: string): Promise<DecisionAutoTuneRecord> {
  return request<DecisionAutoTuneRecord>(`/api/v1/improvement/autotune/${encodeURIComponent(tuneId)}/approve`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function revertImprovementAutoTune(tuneId: string): Promise<DecisionAutoTuneRecord> {
  return request<DecisionAutoTuneRecord>(`/api/v1/improvement/autotune/${encodeURIComponent(tuneId)}/revert`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function approveChatTool(sessionId: string, approvalId: string): Promise<{ ok: boolean; approvalId: string }> {
  return request<{ ok: boolean; approvalId: string }>("/api/v1/chat/tools/approve", {
    method: "POST",
    body: JSON.stringify({ sessionId, approvalId }),
  });
}

export async function denyChatTool(sessionId: string, approvalId: string): Promise<{ ok: boolean; approvalId: string }> {
  return request<{ ok: boolean; approvalId: string }>("/api/v1/chat/tools/deny", {
    method: "POST",
    body: JSON.stringify({ sessionId, approvalId }),
  });
}

export async function uploadChatAttachment(input: {
  sessionId: string;
  projectId?: string;
  file: File;
}): Promise<ChatAttachmentRecord> {
  const bytesBase64 = await encodeFileBase64(input.file);
  return request<ChatAttachmentRecord>("/api/v1/chat/attachments", {
    method: "POST",
    body: JSON.stringify({
      sessionId: input.sessionId,
      projectId: input.projectId,
      fileName: input.file.name,
      mimeType: input.file.type || "application/octet-stream",
      bytesBase64,
    }),
  });
}

export async function fetchChatAttachment(attachmentId: string): Promise<ChatAttachmentRecord> {
  return request<ChatAttachmentRecord>(`/api/v1/chat/attachments/${encodeURIComponent(attachmentId)}`);
}

async function encodeFileBase64(file: File): Promise<string> {
  if (typeof FileReader !== "undefined") {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error("Failed to read attachment."));
      reader.onload = () => {
        if (typeof reader.result !== "string") {
          reject(new Error("Failed to encode attachment."));
          return;
        }
        const comma = reader.result.indexOf(",");
        resolve(comma >= 0 ? reader.result.slice(comma + 1) : reader.result);
      };
      reader.readAsDataURL(file);
    });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

export async function downloadChatAttachment(attachmentId: string): Promise<{ blob: Blob; fileName: string; mimeType: string }> {
  const meta = await fetchChatAttachment(attachmentId);
  const authHeaders = readGatewayAuthHeaders(`/api/v1/chat/attachments/${encodeURIComponent(attachmentId)}/content`);
  const response = await fetch(`${API_BASE}/api/v1/chat/attachments/${encodeURIComponent(attachmentId)}/content?disposition=attachment`, {
    headers: authHeaders,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }
  const blob = await response.blob();
  return {
    blob,
    fileName: meta.fileName,
    mimeType: meta.mimeType,
  };
}

export async function fetchChatAttachmentPreview(attachmentId: string): Promise<ChatAttachmentPreviewResponse> {
  return request<ChatAttachmentPreviewResponse>(`/api/v1/chat/attachments/${encodeURIComponent(attachmentId)}/preview`);
}

export async function createMediaJob(input: MediaCreateJobRequest): Promise<MediaJobRecord> {
  return request<MediaJobRecord>("/api/v1/media/jobs", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchMediaJob(jobId: string): Promise<MediaJobRecord> {
  return request<MediaJobRecord>(`/api/v1/media/jobs/${encodeURIComponent(jobId)}`);
}

export async function fetchMediaJobs(sessionId?: string): Promise<{ items: MediaJobRecord[] }> {
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  return request<{ items: MediaJobRecord[] }>(`/api/v1/media/jobs${query}`);
}

export async function fetchRetentionPolicy(): Promise<RetentionPolicy> {
  return request<RetentionPolicy>("/api/v1/admin/retention");
}

export async function updateRetentionPolicy(input: Partial<RetentionPolicy>): Promise<RetentionPolicy> {
  return request<RetentionPolicy>("/api/v1/admin/retention", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function pruneRetention(dryRun = true): Promise<RetentionPruneResult> {
  return request<RetentionPruneResult>("/api/v1/admin/retention/prune", {
    method: "POST",
    body: JSON.stringify({ dryRun }),
  });
}

export async function listBackups(limit = 50): Promise<{ items: BackupManifestRecord[] }> {
  return request<{ items: BackupManifestRecord[] }>(`/api/v1/admin/backups?limit=${limit}`);
}

export async function createBackup(input?: { name?: string; outputPath?: string }): Promise<BackupCreateResponse> {
  return request<BackupCreateResponse>("/api/v1/admin/backups/create", {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

export async function restoreBackup(filePath: string, confirm = false): Promise<{ restored: boolean; backupId?: string; filesRestored: number }> {
  return request<{ restored: boolean; backupId?: string; filesRestored: number }>("/api/v1/admin/backups/restore", {
    method: "POST",
    body: JSON.stringify({ filePath, confirm }),
  });
}

async function consumeSseResponse(
  body: ReadableStream<Uint8Array>,
  onChunk: (chunk: ChatStreamChunk) => void,
  signal?: AbortSignal,
): Promise<void> {
  let streamError: string | null = null;
  for await (const dataText of iterateSsePayloads(body, signal)) {
    const parsed = parseSseJson<ChatStreamChunk>(dataText);
    onChunk(parsed);
    if (parsed.type === "error") {
      streamError = parsed.error || "Streaming request failed.";
    }
  }
  if (streamError) {
    throw new Error(streamError);
  }
}

async function* iterateSsePayloads(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) {
        throw createAbortError();
      }
      const { value, done } = await reader.read();
      if (done) {
        buffer = appendSseBuffer(buffer, decoder.decode());
        break;
      }
      buffer = appendSseBuffer(buffer, decoder.decode(value, { stream: true }));
      while (true) {
        const separatorIndex = buffer.indexOf("\n\n");
        if (separatorIndex < 0) {
          break;
        }
        const rawEvent = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const dataText = extractSseDataText(rawEvent);
        if (dataText) {
          yield dataText;
        }
      }
    }
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (buffer.trim()) {
    throw new Error(`Streaming response ended before a complete SSE event was received: ${previewSseText(buffer)}`);
  }
}

function appendSseBuffer(buffer: string, chunk: string): string {
  if (!chunk) {
    return buffer;
  }
  const next = buffer + chunk;
  if (next.length > MAX_SSE_BUFFER_CHARS) {
    throw new Error("Streaming response exceeded the SSE buffer limit before a complete event was received.");
  }
  return next;
}

function extractSseDataText(rawEvent: string): string | null {
  const dataLines = rawEvent
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  if (dataLines.length === 0) {
    return null;
  }
  return dataLines.join("\n");
}

function parseSseJson<T>(dataText: string): T {
  try {
    return JSON.parse(dataText) as T;
  } catch {
    throw new Error(`Malformed SSE event payload: ${previewSseText(dataText)}`);
  }
}

function previewSseText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "(empty)";
  }
  if (trimmed.length <= MAX_SSE_EVENT_PREVIEW_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_SSE_EVENT_PREVIEW_CHARS)}...`;
}

function createAbortError(): Error {
  try {
    return new DOMException("The operation was aborted.", "AbortError");
  } catch {
    const error = new Error("The operation was aborted.");
    error.name = "AbortError";
    return error;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : typeof error === "object"
      && error !== null
      && "name" in error
      && (error as { name?: string }).name === "AbortError";
}

export async function fetchApprovals(status = "pending"): Promise<ApprovalsResponse> {
  return request<ApprovalsResponse>(`/api/v1/approvals?status=${encodeURIComponent(status)}`);
}

export async function resolveApproval(
  approvalId: string,
  decision: "approve" | "reject",
): Promise<ApprovalResolveResponse> {
  return request<ApprovalResolveResponse>(`/api/v1/approvals/${approvalId}/resolve`, {
    method: "POST",
    body: JSON.stringify({
      decision,
      resolvedBy: "operator",
    }),
  });
}

export async function resolveApprovalsBulk(input: {
  decision: "approve" | "reject";
  resolvedBy?: string;
  resolutionNote?: string;
  status?: "pending";
}): Promise<ApprovalBulkResolveResult> {
  return request<ApprovalBulkResolveResult>("/api/v1/approvals/bulk-resolve", {
    method: "POST",
    body: JSON.stringify({
      ...input,
      resolvedBy: input.resolvedBy ?? "operator",
    }),
  });
}

export async function resolveApprovalWithRemoteToken(
  token: string,
  decision: "approve" | "reject",
): Promise<{ approval: ApprovalRequest; executedAction?: ToolInvokeResult }> {
  return request("/api/v1/approvals/remote-resolve", {
    method: "POST",
    body: JSON.stringify({
      token,
      decision,
    }),
  });
}

export async function fetchApprovalReplay(approvalId: string): Promise<ApprovalReplayResponse> {
  return request<ApprovalReplayResponse>(`/api/v1/approvals/${approvalId}/replay`);
}

export async function fetchCostSummary(
  scope: "day" | "session" | "agent" | "task" = "day",
): Promise<CostSummaryResponse> {
  return request<CostSummaryResponse>(`/api/v1/costs/summary?scope=${scope}`);
}

export async function runCheaper(): Promise<{ mode: string; actions: string[] }> {
  return request<{ mode: string; actions: string[] }>("/api/v1/costs/run-cheaper", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchToolCatalog(): Promise<{ items: ToolCatalogEntry[] }> {
  return request<{ items: ToolCatalogEntry[] }>("/api/v1/tools/catalog");
}

export async function evaluateToolAccess(input: ToolAccessEvaluateRequest): Promise<ToolAccessEvaluateResponse> {
  return request<ToolAccessEvaluateResponse>("/api/v1/tools/access/evaluate", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchToolGrants(input?: {
  scope?: "global" | "session" | "agent" | "task";
  scopeRef?: string;
  limit?: number;
}): Promise<{ items: ToolGrantRecord[] }> {
  const search = new URLSearchParams();
  if (input?.scope) {
    search.set("scope", input.scope);
  }
  if (input?.scopeRef) {
    search.set("scopeRef", input.scopeRef);
  }
  search.set("limit", String(input?.limit ?? 300));
  return request<{ items: ToolGrantRecord[] }>(`/api/v1/tools/grants?${search.toString()}`);
}

export async function createToolGrant(input: ToolGrantCreateInput): Promise<ToolGrantRecord> {
  return request<ToolGrantRecord>("/api/v1/tools/grants", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function revokeToolGrant(grantId: string): Promise<{ revoked: boolean; grantId: string }> {
  return request<{ revoked: boolean; grantId: string }>(`/api/v1/tools/grants/${encodeURIComponent(grantId)}/revoke`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function invokeTool(input: {
  toolName: string;
  args: Record<string, unknown>;
  agentId: string;
  sessionId: string;
  taskId?: string;
  dryRun?: boolean;
  consentContext?: {
    operatorId?: string;
    source?: "ui" | "tui" | "agent";
    reason?: string;
  };
}): Promise<ToolInvokeResult> {
  return request<ToolInvokeResult>("/api/v1/tools/invoke", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function commsSend(input: ChannelSendInput): Promise<ToolInvokeResult | Record<string, unknown>> {
  return request<ToolInvokeResult | Record<string, unknown>>("/api/v1/comms/send", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function commsReply(input: ChannelReplyInput): Promise<ToolInvokeResult | Record<string, unknown>> {
  return request<ToolInvokeResult | Record<string, unknown>>("/api/v1/comms/reply", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function commsReact(input: ChannelReactInput): Promise<ToolInvokeResult | Record<string, unknown>> {
  return request<ToolInvokeResult | Record<string, unknown>>("/api/v1/comms/react", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function commsUnsend(input: ChannelUnsendInput): Promise<ToolInvokeResult | Record<string, unknown>> {
  return request<ToolInvokeResult | Record<string, unknown>>("/api/v1/comms/unsend", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function commsTyping(input: ChannelTypingInput): Promise<ChannelTypingResult> {
  return request<ChannelTypingResult>("/api/v1/comms/typing", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchChannelCapabilities(connectionId: string): Promise<ChannelCapabilities> {
  return request<ChannelCapabilities>(`/api/v1/comms/capabilities/${encodeURIComponent(connectionId)}`);
}

export async function fetchChannelRuntimeStatus(connectionId: string): Promise<ChannelRuntimeStatus> {
  return request<ChannelRuntimeStatus>(`/api/v1/comms/runtime/${encodeURIComponent(connectionId)}`);
}

export async function fetchChannelDiagnostics(connectionId: string): Promise<ConnectorDiagnosticReport> {
  return request<ConnectorDiagnosticReport>(`/api/v1/comms/diagnostics/${encodeURIComponent(connectionId)}`);
}

export async function commsGmailRead(input: GmailReadQuery): Promise<ToolInvokeResult | Record<string, unknown>> {
  return request<ToolInvokeResult | Record<string, unknown>>("/api/v1/comms/gmail/read", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function commsGmailSend(input: GmailSendInput): Promise<ToolInvokeResult | Record<string, unknown>> {
  return request<ToolInvokeResult | Record<string, unknown>>("/api/v1/comms/gmail/send", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function commsCalendarList(input: CalendarListQuery): Promise<ToolInvokeResult | Record<string, unknown>> {
  return request<ToolInvokeResult | Record<string, unknown>>("/api/v1/comms/calendar/list", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function commsCalendarCreate(input: CalendarCreateEventInput): Promise<ToolInvokeResult | Record<string, unknown>> {
  return request<ToolInvokeResult | Record<string, unknown>>("/api/v1/comms/calendar/create", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function knowledgeMemoryWrite(input: MemoryWriteInput): Promise<ToolInvokeResult | Record<string, unknown>> {
  return request<ToolInvokeResult | Record<string, unknown>>("/api/v1/knowledge/memory/write", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function knowledgeMemorySearch(input: MemorySearchQuery): Promise<ToolInvokeResult | Record<string, unknown>> {
  return request<ToolInvokeResult | Record<string, unknown>>("/api/v1/knowledge/memory/search", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function knowledgeDocsIngest(input: DocsIngestInput): Promise<ToolInvokeResult | Record<string, unknown>> {
  return request<ToolInvokeResult | Record<string, unknown>>("/api/v1/knowledge/docs/ingest", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function knowledgeEmbeddingsIndex(input: EmbeddingIndexInput): Promise<ToolInvokeResult | Record<string, unknown>> {
  return request<ToolInvokeResult | Record<string, unknown>>("/api/v1/knowledge/embeddings/index", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function knowledgeEmbeddingsQuery(input: EmbeddingQueryInput): Promise<ToolInvokeResult | Record<string, unknown>> {
  return request<ToolInvokeResult | Record<string, unknown>>("/api/v1/knowledge/embeddings/query", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchTasks(
  status?: TaskRecord["status"],
  workspaceId?: string,
): Promise<{ items: TaskRecord[]; nextCursor?: string }> {
  const query = new URLSearchParams({ limit: "100", view: "active" });
  if (status) {
    query.set("status", status);
  }
  if (workspaceId?.trim()) {
    query.set("workspaceId", workspaceId.trim());
  }
  return request<{ items: TaskRecord[]; nextCursor?: string }>(`/api/v1/tasks?${query.toString()}`);
}

export async function fetchTasksByView(
  view: "active" | "trash" | "all",
  status?: TaskRecord["status"],
  workspaceId?: string,
): Promise<{ items: TaskRecord[]; nextCursor?: string; view: "active" | "trash" | "all" }> {
  const query = new URLSearchParams({ limit: "100", view });
  if (status) {
    query.set("status", status);
  }
  if (workspaceId?.trim()) {
    query.set("workspaceId", workspaceId.trim());
  }
  return request<{ items: TaskRecord[]; nextCursor?: string; view: "active" | "trash" | "all" }>(
    `/api/v1/tasks?${query.toString()}`,
  );
}

export async function createTask(input: {
  workspaceId?: string;
  title: string;
  description?: string;
  priority?: TaskRecord["priority"];
}): Promise<TaskRecord> {
  return request<TaskRecord>("/api/v1/tasks", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateTask(
  taskId: string,
  input: Partial<Pick<TaskRecord, "status" | "priority" | "title" | "description" | "dueAt">> & {
    assignedAgentId?: string | null;
  },
): Promise<TaskRecord> {
  return request<TaskRecord>(`/api/v1/tasks/${encodeURIComponent(taskId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deleteTask(
  taskId: string,
  input?: { mode?: "soft" | "hard"; deletedBy?: string; deleteReason?: string; confirmToken?: string },
): Promise<{ deleted: boolean; taskId: string; mode: "soft" | "hard" }> {
  const mode = input?.mode ?? "soft";
  return request<{ deleted: boolean; taskId: string; mode: "soft" | "hard" }>(
    `/api/v1/tasks/${encodeURIComponent(taskId)}?mode=${mode}`,
    {
      method: "DELETE",
      body: JSON.stringify({
        mode,
        deletedBy: input?.deletedBy,
        deleteReason: input?.deleteReason,
        confirmToken: input?.confirmToken,
      }),
    },
  );
}

export async function restoreTask(taskId: string): Promise<{ restored: boolean; taskId: string }> {
  return request<{ restored: boolean; taskId: string }>(`/api/v1/tasks/${encodeURIComponent(taskId)}/restore`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchTaskActivities(taskId: string): Promise<{ items: TaskActivityRecord[] }> {
  return request<{ items: TaskActivityRecord[] }>(`/api/v1/tasks/${encodeURIComponent(taskId)}/activities`);
}

export async function addTaskActivity(
  taskId: string,
  input: {
    message: string;
    activityType?: TaskActivityRecord["activityType"];
    agentId?: string;
  },
): Promise<TaskActivityRecord> {
  return request<TaskActivityRecord>(`/api/v1/tasks/${encodeURIComponent(taskId)}/activities`, {
    method: "POST",
    body: JSON.stringify({
      activityType: input.activityType ?? "comment",
      message: input.message,
      agentId: input.agentId,
    }),
  });
}

export async function fetchTaskDeliverables(taskId: string): Promise<{ items: TaskDeliverableRecord[] }> {
  return request<{ items: TaskDeliverableRecord[] }>(`/api/v1/tasks/${encodeURIComponent(taskId)}/deliverables`);
}

export async function addTaskDeliverable(
  taskId: string,
  input: {
    title: string;
    deliverableType?: TaskDeliverableRecord["deliverableType"];
    path?: string;
    description?: string;
  },
): Promise<TaskDeliverableRecord> {
  return request<TaskDeliverableRecord>(`/api/v1/tasks/${encodeURIComponent(taskId)}/deliverables`, {
    method: "POST",
    body: JSON.stringify({
      deliverableType: input.deliverableType ?? "artifact",
      title: input.title,
      path: input.path,
      description: input.description,
    }),
  });
}

export async function fetchTaskSubagents(taskId: string): Promise<{ items: TaskSubagentSession[] }> {
  return request<{ items: TaskSubagentSession[] }>(`/api/v1/tasks/${encodeURIComponent(taskId)}/subagents`);
}

export async function registerTaskSubagent(
  taskId: string,
  input: { agentSessionId: string; agentName?: string },
): Promise<TaskSubagentSession> {
  return request<TaskSubagentSession>(`/api/v1/tasks/${encodeURIComponent(taskId)}/subagents`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateTaskSubagent(
  agentSessionId: string,
  input: { status?: TaskSubagentSession["status"]; endedAt?: string },
): Promise<TaskSubagentSession> {
  return request<TaskSubagentSession>(`/api/v1/subagents/${encodeURIComponent(agentSessionId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function fetchRealtimeEvents(
  limit = 100,
  cursor?: string,
): Promise<{ items: RealtimeEvent[]; nextCursor?: string }> {
  const query = new URLSearchParams({
    limit: String(limit),
  });
  if (cursor?.trim()) {
    query.set("cursor", cursor.trim());
  }
  return request<{ items: RealtimeEvent[]; nextCursor?: string }>(`/api/v1/events?${query.toString()}`);
}

export async function fetchDashboardState(): Promise<DashboardStateResponse> {
  return request<DashboardStateResponse>("/api/v1/dashboard/state");
}

export async function fetchSystemVitals(): Promise<SystemVitalsResponse> {
  return request<SystemVitalsResponse>("/api/v1/system/vitals");
}

export async function fetchFollowOnParityReport(): Promise<FollowOnParityReport> {
  return request<FollowOnParityReport>("/api/v1/system/follow-on-parity");
}

export async function fetchOpenclawParityReport(): Promise<OpenclawParityProgramReport> {
  return request<OpenclawParityProgramReport>("/api/v1/system/openclaw-parity");
}

export async function fetchBrowserProofLaneDraft(): Promise<BrowserProofLaneDraft> {
  return request<BrowserProofLaneDraft>("/api/v1/system/follow-on-parity/browser-proof-lane");
}

export async function exportBrowserProofLaneDraft(): Promise<FollowOnProofLaneArtifactRecord> {
  return request<FollowOnProofLaneArtifactRecord>("/api/v1/system/follow-on-parity/browser-proof-lane/export", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchPackagingProofLaneDraft(): Promise<PackagingProofLaneDraft> {
  return request<PackagingProofLaneDraft>("/api/v1/system/follow-on-parity/packaging-proof-lane");
}

export async function exportPackagingProofLaneDraft(): Promise<FollowOnProofLaneArtifactRecord> {
  return request<FollowOnProofLaneArtifactRecord>("/api/v1/system/follow-on-parity/packaging-proof-lane/export", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchA2UIProofLaneDraft(): Promise<A2UIProofLaneDraft> {
  return request<A2UIProofLaneDraft>("/api/v1/system/follow-on-parity/a2ui-proof-lane");
}

export async function fetchVoiceProofLaneDraft(): Promise<VoiceProofLaneDraft> {
  return request<VoiceProofLaneDraft>("/api/v1/system/follow-on-parity/voice-proof-lane");
}

export async function exportVoiceProofLaneDraft(): Promise<FollowOnProofLaneArtifactRecord> {
  return request<FollowOnProofLaneArtifactRecord>("/api/v1/system/follow-on-parity/voice-proof-lane/export", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function exportA2UIProofLaneDraft(): Promise<FollowOnProofLaneArtifactRecord> {
  return request<FollowOnProofLaneArtifactRecord>("/api/v1/system/follow-on-parity/a2ui-proof-lane/export", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function exportCompanionBootstrapBrief(): Promise<FollowOnProofLaneArtifactRecord> {
  return request<FollowOnProofLaneArtifactRecord>("/api/v1/system/follow-on-parity/companion-bootstrap-brief/export", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchExtensionSdkBrief(): Promise<ExtensionSdkBriefDraft> {
  return request<ExtensionSdkBriefDraft>("/api/v1/system/follow-on-parity/extension-sdk-brief");
}

export async function exportExtensionSdkBrief(): Promise<FollowOnProofLaneArtifactRecord> {
  return request<FollowOnProofLaneArtifactRecord>("/api/v1/system/follow-on-parity/extension-sdk-brief/export", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchExtensionStarterPack(): Promise<ExtensionStarterPackDraft> {
  return request<ExtensionStarterPackDraft>("/api/v1/system/follow-on-parity/extension-starter-pack");
}

export async function exportExtensionStarterPack(): Promise<ExtensionStarterPackArtifactRecord> {
  return request<ExtensionStarterPackArtifactRecord>("/api/v1/system/follow-on-parity/extension-starter-pack/export", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchCronJobs(): Promise<CronJobsResponse> {
  return request<CronJobsResponse>("/api/v1/cron/jobs");
}

export async function fetchCronJob(jobId: string): Promise<CronJobRecordResponse> {
  return request<CronJobRecordResponse>(`/api/v1/cron/jobs/${encodeURIComponent(jobId)}`);
}

export async function createCronJob(input: {
  jobId: string;
  name: string;
  schedule: string;
  enabled?: boolean;
}): Promise<CronJobRecordResponse> {
  return request<CronJobRecordResponse>("/api/v1/cron/jobs", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateCronJob(
  jobId: string,
  input: {
    name?: string;
    schedule?: string;
    enabled?: boolean;
  },
): Promise<CronJobRecordResponse> {
  return request<CronJobRecordResponse>(`/api/v1/cron/jobs/${encodeURIComponent(jobId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function startCronJob(jobId: string): Promise<CronJobRecordResponse> {
  return request<CronJobRecordResponse>(`/api/v1/cron/jobs/${encodeURIComponent(jobId)}/start`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function pauseCronJob(jobId: string): Promise<CronJobRecordResponse> {
  return request<CronJobRecordResponse>(`/api/v1/cron/jobs/${encodeURIComponent(jobId)}/pause`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function runCronJobNow(jobId: string): Promise<{ jobId: string; status: "ok" }> {
  return request<{ jobId: string; status: "ok" }>(`/api/v1/cron/jobs/${encodeURIComponent(jobId)}/run`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchCronReviewQueue(limit = 200): Promise<{ items: CronReviewItem[] }> {
  return request<{ items: CronReviewItem[] }>(
    `/api/v1/cron/review-queue?limit=${Math.max(1, Math.min(limit, 1000))}`,
  );
}

export async function retryCronReviewQueueItem(itemId: string): Promise<CronReviewItem> {
  return request<CronReviewItem>(`/api/v1/cron/review-queue/${encodeURIComponent(itemId)}/retry`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchCronRunDiff(runId: string): Promise<CronRunDiff> {
  return request<CronRunDiff>(`/api/v1/cron/runs/${encodeURIComponent(runId)}/diff`);
}

export async function deleteCronJob(jobId: string): Promise<{ deleted: boolean; jobId: string }> {
  return request<{ deleted: boolean; jobId: string }>(`/api/v1/cron/jobs/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
  });
}

export async function createDurableRun(input: DurableRunCreateRequest): Promise<DurableRunRecord> {
  return request<DurableRunRecord>("/api/v1/durable/runs", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchDurableRun(runId: string): Promise<DurableRunRecord> {
  return request<DurableRunRecord>(`/api/v1/durable/runs/${encodeURIComponent(runId)}`);
}

export async function fetchDurableRunTimeline(runId: string, limit = 300): Promise<{ items: DurableRunTimelineEvent[] }> {
  return request<{ items: DurableRunTimelineEvent[] }>(
    `/api/v1/durable/runs/${encodeURIComponent(runId)}/timeline?limit=${Math.max(1, Math.min(limit, 2000))}`,
  );
}

export async function pauseDurableRun(runId: string, actorId?: string): Promise<DurableRunRecord> {
  return request<DurableRunRecord>(`/api/v1/durable/runs/${encodeURIComponent(runId)}/pause`, {
    method: "POST",
    body: JSON.stringify({ actorId }),
  });
}

export async function resumeDurableRun(runId: string, actorId?: string): Promise<DurableRunRecord> {
  return request<DurableRunRecord>(`/api/v1/durable/runs/${encodeURIComponent(runId)}/resume`, {
    method: "POST",
    body: JSON.stringify({ actorId }),
  });
}

export async function cancelDurableRun(runId: string, actorId?: string): Promise<DurableRunRecord> {
  return request<DurableRunRecord>(`/api/v1/durable/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
    body: JSON.stringify({ actorId }),
  });
}

export async function retryDurableRun(runId: string, input?: { reason?: string; actorId?: string }): Promise<DurableRunRecord> {
  return request<DurableRunRecord>(`/api/v1/durable/runs/${encodeURIComponent(runId)}/retry`, {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

export async function wakeDurableRun(
  runId: string,
  input: { eventKey: string; payload?: Record<string, unknown>; correlationId?: string },
): Promise<DurableRunRecord> {
  return request<DurableRunRecord>(`/api/v1/durable/runs/${encodeURIComponent(runId)}/events/wake`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function recoverDurableDeadLetter(entryId: string, actorId?: string): Promise<DurableRunRecord> {
  return request<DurableRunRecord>(`/api/v1/durable/dead-letters/${encodeURIComponent(entryId)}/recover`, {
    method: "POST",
    body: JSON.stringify({ actorId }),
  });
}

export async function fetchOperators(): Promise<OperatorsResponse> {
  return request<OperatorsResponse>("/api/v1/operators");
}

export async function fetchMemoryFiles(dir = "memory"): Promise<{ items: Array<{ relativePath: string; size: number; modifiedAt: string }> }> {
  return request<{ items: Array<{ relativePath: string; size: number; modifiedAt: string }> }>(
    `/api/v1/memory/files?dir=${encodeURIComponent(dir)}`,
  );
}

export async function fetchAgents(
  view: "active" | "archived" | "all" = "active",
  limit = 300,
): Promise<AgentsResponse> {
  return request<AgentsResponse>(`/api/v1/agents?view=${encodeURIComponent(view)}&limit=${limit}`);
}

export async function fetchAgent(agentId: string): Promise<AgentProfileRecord> {
  return request<AgentProfileRecord>(`/api/v1/agents/${encodeURIComponent(agentId)}`);
}

export async function createAgentProfile(input: AgentProfileCreateInput): Promise<AgentProfileRecord> {
  return request<AgentProfileRecord>("/api/v1/agents", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateAgentProfile(
  agentId: string,
  input: AgentProfileUpdateInput,
): Promise<AgentProfileRecord> {
  return request<AgentProfileRecord>(`/api/v1/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function archiveAgentProfile(
  agentId: string,
  input?: AgentProfileArchiveInput,
): Promise<AgentProfileRecord> {
  return request<AgentProfileRecord>(`/api/v1/agents/${encodeURIComponent(agentId)}/archive`, {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

export async function restoreAgentProfile(agentId: string): Promise<AgentProfileRecord> {
  return request<AgentProfileRecord>(`/api/v1/agents/${encodeURIComponent(agentId)}/restore`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function hardDeleteAgentProfile(agentId: string): Promise<{ deleted: boolean; agentId: string; mode: "hard" }> {
  return request<{ deleted: boolean; agentId: string; mode: "hard" }>(
    `/api/v1/agents/${encodeURIComponent(agentId)}?mode=hard`,
    {
      method: "DELETE",
      body: JSON.stringify({}),
    },
  );
}

export async function fetchFilesList(
  dir = ".",
  limit = 1000,
): Promise<{ items: Array<{ relativePath: string; size: number; modifiedAt: string }> }> {
  return request<{ items: Array<{ relativePath: string; size: number; modifiedAt: string }> }>(
    `/api/v1/files/list?dir=${encodeURIComponent(dir)}&limit=${limit}`,
  );
}

export async function fetchPathSuggestions(
  root = ".",
  limit = 150,
): Promise<{ items: string[] }> {
  return request<{ items: string[] }>(
    `/api/v1/files/path-suggestions?root=${encodeURIComponent(root)}&limit=${Math.max(1, Math.min(limit, 500))}`,
  );
}

export interface FileTemplate {
  templateId: string;
  title: string;
  description: string;
  defaultPath: string;
  body: string;
}

export async function fetchFileTemplates(): Promise<{ items: FileTemplate[] }> {
  return request<{ items: FileTemplate[] }>("/api/v1/files/templates");
}

export async function createFileFromTemplate(
  templateId: string,
  targetPath?: string,
): Promise<{ relativePath: string; fullPath: string; bytes: number }> {
  return request<{ relativePath: string; fullPath: string; bytes: number }>(
    `/api/v1/files/templates/${encodeURIComponent(templateId)}/create`,
    {
      method: "POST",
      body: JSON.stringify({ targetPath }),
    },
  );
}

export async function uploadFile(relativePath: string, content: string): Promise<{ relativePath: string; fullPath: string; bytes: number }> {
  return request<{ relativePath: string; fullPath: string; bytes: number }>("/api/v1/files/upload", {
    method: "POST",
    body: JSON.stringify({ relativePath, content }),
  });
}

export async function downloadFile(relativePath: string): Promise<{
  relativePath: string;
  fullPath: string;
  size: number;
  modifiedAt: string;
  contentType: string;
  encoding: string;
  content: string;
}> {
  return request(`/api/v1/files/download?relativePath=${encodeURIComponent(relativePath)}`);
}

export async function fetchSkills(): Promise<{ items: SkillListItem[] }> {
  return request("/api/v1/skills");
}

export async function reloadSkills(): Promise<{ items: SkillListItem[] }> {
  return request("/api/v1/skills/reload", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchSkillSources(query?: {
  q?: string;
  limit?: number;
}): Promise<SkillSourceListResponse> {
  const params = new URLSearchParams();
  if (query?.q?.trim()) {
    params.set("q", query.q.trim());
  }
  if (query?.limit) {
    params.set("limit", String(Math.max(1, Math.min(query.limit, 100))));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return request<SkillSourceListResponse>(`/api/v1/skills/sources${suffix}`);
}

export async function fetchSkillLookup(query: {
  q: string;
  limit?: number;
}): Promise<SkillSourceLookupResponse> {
  const params = new URLSearchParams();
  params.set("q", query.q.trim());
  if (query.limit) {
    params.set("limit", String(Math.max(1, Math.min(query.limit, 100))));
  }
  return request<SkillSourceLookupResponse>(`/api/v1/skills/lookup?${params.toString()}`);
}

export async function validateSkillImport(input: {
  sourceRef: string;
  sourceType?: SkillImportSourceType;
  sourceProvider?: SkillSourceProvider;
}): Promise<SkillImportValidationResult> {
  return request<SkillImportValidationResult>("/api/v1/skills/import/validate", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function installSkillImport(input: {
  sourceRef: string;
  sourceType?: SkillImportSourceType;
  sourceProvider?: SkillSourceProvider;
  force?: boolean;
  confirmHighRisk?: boolean;
}): Promise<{
  validation: SkillImportValidationResult;
  installedPath: string;
  sourceManifestPath: string;
  installedSkillId?: string;
}> {
  return request<{
    validation: SkillImportValidationResult;
    installedPath: string;
    sourceManifestPath: string;
    installedSkillId?: string;
  }>("/api/v1/skills/import/install", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchSkillImportHistory(limit = 100): Promise<{ items: SkillImportHistoryRecord[] }> {
  const boundedLimit = Math.max(1, Math.min(limit, 300));
  return request<{ items: SkillImportHistoryRecord[] }>(
    `/api/v1/skills/import/history?limit=${boundedLimit}`,
  );
}

export async function updateSkillState(
  skillId: string,
  input: { state: SkillRuntimeState; note?: string },
): Promise<SkillStateRecord> {
  return request<SkillStateRecord>(`/api/v1/skills/${encodeURIComponent(skillId)}/state`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function bulkUpdateSkillState(input: {
  skillIds: string[];
  state: SkillRuntimeState;
  note?: string;
}): Promise<{ items: SkillStateRecord[] }> {
  return request<{ items: SkillStateRecord[] }>("/api/v1/skills/bulk-state", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchSkillActivationPolicies(): Promise<SkillActivationPolicy> {
  return request<SkillActivationPolicy>("/api/v1/skills/activation-policies");
}

export async function patchSkillActivationPolicies(
  input: Partial<SkillActivationPolicy>,
): Promise<SkillActivationPolicy> {
  return request<SkillActivationPolicy>("/api/v1/skills/activation-policies", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function fetchSettings(): Promise<RuntimeSettingsResponse> {
  return request<RuntimeSettingsResponse>("/api/v1/settings");
}

export async function fetchDeviceAccessGrants(
  view: "active" | "all" = "active",
): Promise<DeviceAccessGrantListResponse> {
  return request<DeviceAccessGrantListResponse>(`/api/v1/auth/devices?view=${encodeURIComponent(view)}`);
}

export async function revokeDeviceAccessGrant(grantId: string): Promise<DeviceAccessGrantRevokeResponse> {
  return request<DeviceAccessGrantRevokeResponse>(`/api/v1/auth/devices/${encodeURIComponent(grantId)}/revoke`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchAddonsCatalog(): Promise<{ items: AddonCatalogEntry[] }> {
  return request<{ items: AddonCatalogEntry[] }>("/api/v1/addons/catalog");
}

export async function fetchInstalledAddons(): Promise<{ items: AddonInstalledRecord[] }> {
  return request<{ items: AddonInstalledRecord[] }>("/api/v1/addons/installed");
}

export async function fetchAddonStatus(addonId: string): Promise<AddonStatusRecord> {
  return request<AddonStatusRecord>(`/api/v1/addons/${encodeURIComponent(addonId)}/status`);
}

export async function installAddon(addonId: string, input: AddonInstallRequest): Promise<AddonActionResponse> {
  return request<AddonActionResponse>(`/api/v1/addons/${encodeURIComponent(addonId)}/install`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateAddon(addonId: string): Promise<AddonActionResponse> {
  return request<AddonActionResponse>(`/api/v1/addons/${encodeURIComponent(addonId)}/update`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function launchAddon(addonId: string): Promise<AddonActionResponse> {
  return request<AddonActionResponse>(`/api/v1/addons/${encodeURIComponent(addonId)}/launch`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function stopAddon(addonId: string): Promise<AddonActionResponse> {
  return request<AddonActionResponse>(`/api/v1/addons/${encodeURIComponent(addonId)}/stop`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function uninstallAddon(addonId: string): Promise<AddonUninstallResponse> {
  return request<AddonUninstallResponse>(`/api/v1/addons/${encodeURIComponent(addonId)}/uninstall`, {
    method: "DELETE",
  });
}

export async function fetchOnboardingState(): Promise<OnboardingState> {
  return request<OnboardingState>("/api/v1/onboarding/state");
}

export async function bootstrapOnboarding(input: OnboardingBootstrapInput): Promise<OnboardingBootstrapResult> {
  return request<OnboardingBootstrapResult>("/api/v1/onboarding/bootstrap", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function completeOnboarding(completedBy?: string): Promise<OnboardingCompleteResponse> {
  return request<OnboardingCompleteResponse>("/api/v1/onboarding/complete", {
    method: "POST",
    body: JSON.stringify({
      completedBy,
    }),
  });
}

export async function resolveGatewayInstallToken(input?: {
  token?: string;
  generateWhenMissing?: boolean;
  persistToEnv?: boolean;
}): Promise<GatewayInstallTokenResolution> {
  return request<GatewayInstallTokenResolution>("/api/v1/auth/install-token", {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

export async function patchSettings(input: {
  deploymentProfile?: "local_dev" | "trusted_local" | "remote_hardened";
  defaultToolProfile?: string;
  budgetMode?: "saver" | "balanced" | "power";
  readAccessMode?: "roots_only" | "approval_required" | "full_disk";
  networkAllowlist?: string[];
  auth?: AuthSettingsUpdateInput;
  llm?: {
    activeProviderId?: string;
    activeModel?: string;
    upsertProvider?: {
      providerId: string;
      label?: string;
      baseUrl?: string;
      apiStyle?: "openai-chat-completions" | "openai-responses" | "anthropic-messages";
      defaultModel?: string;
      apiKey?: string;
      apiKeyEnv?: string;
      headers?: Record<string, string>;
    };
  };
  memory?: {
    enabled?: boolean;
    qmdEnabled?: boolean;
    qmdApplyToChat?: boolean;
    qmdApplyToOrchestration?: boolean;
    qmdMaxContextTokens?: number;
    qmdMinPromptChars?: number;
    qmdCacheTtlSeconds?: number;
    qmdDistillerProviderId?: string;
    qmdDistillerModel?: string;
  };
  mesh?: {
    enabled?: boolean;
    mode?: "lan" | "wan" | "tailnet";
    nodeId?: string;
    mdns?: boolean;
    staticPeers?: string[];
    requireMtls?: boolean;
    tailnetEnabled?: boolean;
  };
  npu?: {
    enabled?: boolean;
    autoStart?: boolean;
    sidecarUrl?: string;
  };
  features?: Partial<RuntimeSettingsResponse["features"]>;
}): Promise<RuntimeSettingsResponse> {
  return request<RuntimeSettingsResponse>("/api/v1/settings", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function composeMemoryContext(input: {
  scope: "chat" | "orchestration";
  prompt: string;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  phaseId?: string;
  workspace?: string;
  maxContextTokens?: number;
  forceRefresh?: boolean;
}): Promise<MemoryContextPack> {
  return request<MemoryContextPack>("/api/v1/memory/context/compose", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchMemoryContext(contextId: string): Promise<MemoryContextPack> {
  return request<MemoryContextPack>(`/api/v1/memory/context/${encodeURIComponent(contextId)}`);
}

export async function fetchMemoryQmdStats(from?: string, to?: string, limit = 60): Promise<MemoryQmdStatsResponse & { recent: MemoryContextPack[] }> {
  const search = new URLSearchParams();
  if (from) search.set("from", from);
  if (to) search.set("to", to);
  search.set("limit", String(limit));
  return request<MemoryQmdStatsResponse & { recent: MemoryContextPack[] }>(
    `/api/v1/memory/qmd/stats?${search.toString()}`,
  );
}

export async function fetchMemoryItems(input?: {
  namespace?: string;
  status?: "active" | "forgotten" | "all";
  query?: string;
  limit?: number;
}): Promise<{ items: MemoryItemRecord[] }> {
  const params = new URLSearchParams();
  if (input?.namespace) params.set("namespace", input.namespace);
  if (input?.status) params.set("status", input.status);
  if (input?.query) params.set("query", input.query);
  params.set("limit", String(Math.max(1, Math.min(input?.limit ?? 200, 500))));
  return request<{ items: MemoryItemRecord[] }>(`/api/v1/memory/items?${params.toString()}`);
}

export async function patchMemoryItem(
  itemId: string,
  patch: MemoryLifecyclePatch & { actorId?: string },
): Promise<MemoryItemRecord> {
  return request<MemoryItemRecord>(`/api/v1/memory/items/${encodeURIComponent(itemId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function forgetMemoryItem(itemId: string, actorId?: string): Promise<MemoryItemRecord> {
  return request<MemoryItemRecord>(`/api/v1/memory/items/${encodeURIComponent(itemId)}/forget`, {
    method: "POST",
    body: JSON.stringify({ actorId }),
  });
}

export async function fetchMemoryItemHistory(itemId: string, limit = 200): Promise<{ items: MemoryChangeEvent[] }> {
  return request<{ items: MemoryChangeEvent[] }>(
    `/api/v1/memory/items/${encodeURIComponent(itemId)}/history?limit=${Math.max(1, Math.min(limit, 2000))}`,
  );
}

export async function fetchMemoryMaintenancePolicy(workspaceId?: string): Promise<MemoryMaintenancePolicyRecord> {
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return request<MemoryMaintenancePolicyRecord>(`/api/v1/memory/maintenance/policy${query}`);
}

export async function patchMemoryMaintenancePolicy(
  workspaceId: string | undefined,
  patch: MemoryMaintenancePolicyPatchInput,
): Promise<MemoryMaintenancePolicyRecord> {
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return request<MemoryMaintenancePolicyRecord>(`/api/v1/memory/maintenance/policy${query}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function fetchMemoryMaintenanceStatus(workspaceId?: string): Promise<MemoryMaintenanceStatusRecord> {
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return request<MemoryMaintenanceStatusRecord>(`/api/v1/memory/maintenance/status${query}`);
}

export async function fetchMemoryMaintenanceRuns(
  workspaceId?: string,
  limit = 50,
): Promise<{ items: MemoryMaintenanceRunRecord[] }> {
  const search = new URLSearchParams();
  if (workspaceId) {
    search.set("workspaceId", workspaceId);
  }
  search.set("limit", String(Math.max(1, Math.min(limit, 500))));
  return request<{ items: MemoryMaintenanceRunRecord[] }>(`/api/v1/memory/maintenance/runs?${search.toString()}`);
}

export async function runMemoryMaintenanceNow(input: MemoryMaintenanceRunNowInput): Promise<MemoryMaintenanceRunRecord> {
  return request<MemoryMaintenanceRunRecord>("/api/v1/memory/maintenance/run-now", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchMemoryMaintenanceRunProvenance(runId: string): Promise<MemoryMaintenanceProvenanceRecord> {
  return request<MemoryMaintenanceProvenanceRecord>(
    `/api/v1/memory/maintenance/runs/${encodeURIComponent(runId)}/provenance`,
  );
}

export async function fetchMemoryMaintenanceRecommendations(
  workspaceId?: string,
  limit = 50,
): Promise<{ items: MemoryMaintenanceRecommendationRecord[] }> {
  const search = new URLSearchParams();
  if (workspaceId) {
    search.set("workspaceId", workspaceId);
  }
  search.set("limit", String(Math.max(1, Math.min(limit, 500))));
  return request<{ items: MemoryMaintenanceRecommendationRecord[] }>(
    `/api/v1/memory/maintenance/recommendations?${search.toString()}`,
  );
}

export async function acceptMemoryMaintenanceRecommendation(recommendationId: string): Promise<MemoryMaintenanceRecommendationRecord> {
  return request<MemoryMaintenanceRecommendationRecord>(
    `/api/v1/memory/maintenance/recommendations/${encodeURIComponent(recommendationId)}/accept`,
    { method: "POST" },
  );
}

export async function rejectMemoryMaintenanceRecommendation(recommendationId: string): Promise<MemoryMaintenanceRecommendationRecord> {
  return request<MemoryMaintenanceRecommendationRecord>(
    `/api/v1/memory/maintenance/recommendations/${encodeURIComponent(recommendationId)}/reject`,
    { method: "POST" },
  );
}

export async function forgetMemory(input: {
  itemIds?: string[];
  namespace?: string;
  query?: string;
  actorId?: string;
}): Promise<{ forgottenCount: number; itemIds: string[] }> {
  return request<{ forgottenCount: number; itemIds: string[] }>("/api/v1/memory/forget", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchOrchestrationRunContext(runId: string): Promise<{ items: MemoryContextPack[] }> {
  return request<{ items: MemoryContextPack[] }>(
    `/api/v1/orchestration/runs/${encodeURIComponent(runId)}/context`,
  );
}

export async function fetchIntegrationCatalog(
  kind?: IntegrationCatalogEntry["kind"],
): Promise<{ items: IntegrationCatalogEntry[] }> {
  const query = kind ? `?kind=${encodeURIComponent(kind)}` : "";
  return request(`/api/v1/integrations/catalog${query}`);
}

export async function fetchChannelSetupDefinitions(): Promise<{ items: ChannelSetupDefinition[] }> {
  return request<{ items: ChannelSetupDefinition[] }>("/api/v1/channels/setup-definitions");
}

export async function fetchChannelSetupDefinition(catalogId: string): Promise<ChannelSetupDefinition> {
  return request<ChannelSetupDefinition>(
    `/api/v1/channels/catalog/${encodeURIComponent(catalogId)}/setup-definition`,
  );
}

export async function fetchChannelSetupDrafts(query?: {
  catalogId?: string;
  connectionId?: string;
  limit?: number;
}): Promise<{ items: ChannelSetupDraft[] }> {
  const params = new URLSearchParams();
  if (query?.catalogId) {
    params.set("catalogId", query.catalogId);
  }
  if (query?.connectionId) {
    params.set("connectionId", query.connectionId);
  }
  if (typeof query?.limit === "number") {
    params.set("limit", String(query.limit));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return request<{ items: ChannelSetupDraft[] }>(`/api/v1/channels/drafts${suffix}`);
}

export async function createChannelSetupDraft(
  input: ChannelSetupDraftCreateInput,
): Promise<ChannelSetupDraft> {
  return request<ChannelSetupDraft>("/api/v1/channels/drafts", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateChannelSetupDraft(
  draftId: string,
  input: ChannelSetupDraftUpdateInput,
): Promise<ChannelSetupDraft> {
  return request<ChannelSetupDraft>(`/api/v1/channels/drafts/${encodeURIComponent(draftId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function validateChannelSetupDraft(draftId: string): Promise<ChannelSetupValidationResult> {
  return request<ChannelSetupValidationResult>(`/api/v1/channels/drafts/${encodeURIComponent(draftId)}/validate`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function testChannelSetupDraft(draftId: string): Promise<ChannelSetupTestResult> {
  return request<ChannelSetupTestResult>(`/api/v1/channels/drafts/${encodeURIComponent(draftId)}/test`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function finalizeChannelSetupDraft(draftId: string): Promise<ChannelSetupFinalizeResult> {
  return request<ChannelSetupFinalizeResult>(`/api/v1/channels/drafts/${encodeURIComponent(draftId)}/finalize`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function createChannelRepairDraft(connectionId: string): Promise<ChannelSetupDraft> {
  return request<ChannelSetupDraft>(
    `/api/v1/channels/connections/${encodeURIComponent(connectionId)}/repair-draft`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function createChannelRotateSecretDraft(connectionId: string): Promise<ChannelSetupDraft> {
  return request<ChannelSetupDraft>(
    `/api/v1/channels/connections/${encodeURIComponent(connectionId)}/rotate-secret-draft`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function retestChannelConnection(connectionId: string): Promise<ChannelSetupTestResult> {
  return request<ChannelSetupTestResult>(
    `/api/v1/channels/connections/${encodeURIComponent(connectionId)}/retest`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function fetchIntegrationFormSchema(catalogId: string): Promise<IntegrationFormSchema> {
  return request<IntegrationFormSchema>(
    `/api/v1/integrations/catalog/${encodeURIComponent(catalogId)}/form-schema`,
  );
}

export async function fetchIntegrationConnections(
  kind?: IntegrationConnection["kind"],
): Promise<{ items: IntegrationConnection[] }> {
  const query = kind ? `?kind=${encodeURIComponent(kind)}&limit=300` : "?limit=300";
  return request(`/api/v1/integrations/connections${query}`);
}

export async function fetchConnectorRecords(
  connectorType?: ConnectorRecord["connectorType"],
): Promise<{ items: ConnectorRecord[] }> {
  const query = connectorType ? `?connectorType=${encodeURIComponent(connectorType)}` : "";
  return request<{ items: ConnectorRecord[] }>(`/api/v1/connectors${query}`);
}

export async function createIntegrationConnection(input: {
  catalogId: string;
  label?: string;
  enabled?: boolean;
  status?: IntegrationConnection["status"];
  config?: Record<string, unknown>;
}): Promise<IntegrationConnection> {
  return request("/api/v1/integrations/connections", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateIntegrationConnection(
  connectionId: string,
  input: {
    label?: string;
    enabled?: boolean;
    status?: IntegrationConnection["status"];
    config?: Record<string, unknown>;
    lastSyncAt?: string;
    lastError?: string;
  },
): Promise<IntegrationConnection> {
  return request(`/api/v1/integrations/connections/${encodeURIComponent(connectionId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deleteIntegrationConnection(connectionId: string): Promise<{ deleted: boolean }> {
  return request(`/api/v1/integrations/connections/${encodeURIComponent(connectionId)}`, {
    method: "DELETE",
    body: JSON.stringify({}),
  });
}

export async function fetchIntegrationConnectionDiagnostics(connectionId: string): Promise<ConnectorDiagnosticReport> {
  return request<ConnectorDiagnosticReport>(
    `/api/v1/integrations/connections/${encodeURIComponent(connectionId)}/diagnostics`,
  );
}

export async function fetchDiscordPairings(connectionId: string): Promise<{
  runtime?: DiscordRuntimeStatus;
  items: DiscordPairingRecord[];
}> {
  return request<{
    runtime?: DiscordRuntimeStatus;
    items: DiscordPairingRecord[];
  }>(`/api/v1/integrations/connections/${encodeURIComponent(connectionId)}/discord/pairings`);
}

export async function approveDiscordPairing(connectionId: string, pairingId: string): Promise<DiscordPairingRecord> {
  return request<DiscordPairingRecord>(
    `/api/v1/integrations/connections/${encodeURIComponent(connectionId)}/discord/pairings/${encodeURIComponent(pairingId)}/approve`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function revokeDiscordPairing(connectionId: string, pairingId: string): Promise<DiscordPairingRecord> {
  return request<DiscordPairingRecord>(
    `/api/v1/integrations/connections/${encodeURIComponent(connectionId)}/discord/pairings/${encodeURIComponent(pairingId)}/revoke`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function reconnectDiscordRuntime(connectionId: string): Promise<DiscordRuntimeStatus | undefined> {
  return request<DiscordRuntimeStatus | undefined>(
    `/api/v1/integrations/connections/${encodeURIComponent(connectionId)}/discord/reconnect`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function fetchIntegrationPlugins(): Promise<{ items: IntegrationPluginRecord[] }> {
  return request<{ items: IntegrationPluginRecord[] }>("/api/v1/integrations/plugins");
}

export async function installIntegrationPlugin(input: {
  source: string;
  pluginId?: string;
}): Promise<IntegrationPluginRecord> {
  return request<IntegrationPluginRecord>("/api/v1/integrations/plugins/install", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function enableIntegrationPlugin(pluginId: string): Promise<IntegrationPluginRecord> {
  return request<IntegrationPluginRecord>(`/api/v1/integrations/plugins/${encodeURIComponent(pluginId)}/enable`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function disableIntegrationPlugin(pluginId: string): Promise<IntegrationPluginRecord> {
  return request<IntegrationPluginRecord>(`/api/v1/integrations/plugins/${encodeURIComponent(pluginId)}/disable`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchObsidianIntegrationStatus(): Promise<ObsidianIntegrationStatus> {
  return request<ObsidianIntegrationStatus>("/api/v1/integrations/obsidian/status");
}

export async function patchObsidianIntegrationConfig(
  input: Partial<ObsidianIntegrationConfig>,
): Promise<ObsidianIntegrationConfig> {
  return request<ObsidianIntegrationConfig>("/api/v1/integrations/obsidian/config", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function testObsidianIntegration(): Promise<ObsidianIntegrationStatus> {
  return request<ObsidianIntegrationStatus>("/api/v1/integrations/obsidian/test", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function searchObsidianNotes(
  input: { query: string; limit?: number },
): Promise<{ items: Array<{ relativePath: string; title: string; snippet: string; score: number }> }> {
  return request<{ items: Array<{ relativePath: string; title: string; snippet: string; score: number }> }>(
    "/api/v1/integrations/obsidian/search",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function readObsidianNote(pathValue: string): Promise<{ relativePath: string; content: string }> {
  return request<{ relativePath: string; content: string }>(
    `/api/v1/integrations/obsidian/note?path=${encodeURIComponent(pathValue)}`,
  );
}

export async function appendObsidianNote(input: {
  path: string;
  markdownBlock: string;
}): Promise<{ relativePath: string; appendedAt: string }> {
  return request<{ relativePath: string; appendedAt: string }>("/api/v1/integrations/obsidian/append", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function captureObsidianInboxEntry(input: {
  id: string;
  request: string;
  type?: string;
  priority?: string;
  neededBy?: string;
  owner?: string;
  state?: string;
  taskLink?: string;
  decisionLink?: string;
  notes?: string;
}): Promise<{ relativePath: string; appendedAt: string; row: string }> {
  return request<{ relativePath: string; appendedAt: string; row: string }>(
    "/api/v1/integrations/obsidian/inbox/capture",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function fetchLlmConfig(): Promise<RuntimeSettingsResponse["llm"]> {
  return request<RuntimeSettingsResponse["llm"]>("/api/v1/llm/config");
}

export async function fetchLlmModels(providerId?: string): Promise<{ items: Array<{ id: string; ownedBy?: string; created?: number }> }> {
  const query = providerId ? `?providerId=${encodeURIComponent(providerId)}` : "";
  return request(`/api/v1/llm/models${query}`);
}

export async function fetchAssemblyRuns(limit = 50): Promise<{ items: AssemblyRunRecord[] }> {
  return request(`/api/v1/assembly/runs?limit=${limit}`);
}

export async function createAssemblyRun(input: CreateAssemblyRunInput): Promise<AssemblyRunRecord> {
  return request("/api/v1/assembly/runs", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchAssemblyRunDetail(runId: string): Promise<AssemblyRunDetailResponse> {
  return request(`/api/v1/assembly/runs/${encodeURIComponent(runId)}`);
}

export async function fetchAssemblyReputations(limit = 50): Promise<{ items: ModelReputation[] }> {
  return request(`/api/v1/assembly/reputation?limit=${limit}`);
}

export async function previewLlmModels(input: {
  providerId: string;
  baseUrl: string;
  apiStyle?: "openai-chat-completions" | "openai-responses" | "anthropic-messages";
  apiKey?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
}, options?: { signal?: AbortSignal }): Promise<{
  items: Array<{ id: string; ownedBy?: string; created?: number }>;
  source: "remote" | "fallback";
  warning?: string;
}> {
  return request("/api/v1/llm/models/preview", {
    method: "POST",
    body: JSON.stringify(input),
    signal: options?.signal,
  });
}

export async function createLlmChatCompletion(input: {
  providerId?: string;
  model?: string;
  messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
  memory?: {
    enabled?: boolean;
    mode?: "qmd" | "off";
    sessionId?: string;
    taskId?: string;
    workspace?: string;
    maxContextTokens?: number;
    forceRefresh?: boolean;
  };
  temperature?: number;
  max_tokens?: number;
}): Promise<LlmChatCompletionResponse> {
  return request<LlmChatCompletionResponse>("/api/v1/llm/chat-completions", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface ProviderSecretStatus {
  providerId: string;
  hasSecret: boolean;
  source: "none" | "keychain" | "env" | "inline";
}

export async function fetchProviderSecretStatus(
  providerId: string,
  options?: { signal?: AbortSignal },
): Promise<ProviderSecretStatus> {
  return request<ProviderSecretStatus>(
    `/api/v1/secrets/providers/${encodeURIComponent(providerId)}/status`,
    { signal: options?.signal },
  );
}

export async function saveProviderSecret(providerId: string, apiKey: string): Promise<ProviderSecretStatus> {
  return request<ProviderSecretStatus>(`/api/v1/secrets/providers/${encodeURIComponent(providerId)}`, {
    method: "POST",
    body: JSON.stringify({ apiKey }),
  });
}

export async function deleteProviderSecret(providerId: string): Promise<ProviderSecretStatus> {
  return request<ProviderSecretStatus>(`/api/v1/secrets/providers/${encodeURIComponent(providerId)}`, {
    method: "DELETE",
    body: JSON.stringify({}),
  });
}

export async function fetchMeshStatus(): Promise<MeshStatusResponse> {
  return request<MeshStatusResponse>("/api/v1/mesh/status");
}

export async function fetchMeshNodes(limit = 200): Promise<{ items: MeshNodeRecord[] }> {
  return request<{ items: MeshNodeRecord[] }>(`/api/v1/mesh/nodes?limit=${limit}`);
}

export async function fetchMeshLeases(limit = 200): Promise<{ items: MeshLeaseRecord[] }> {
  return request<{ items: MeshLeaseRecord[] }>(`/api/v1/mesh/leases?limit=${limit}`);
}

export async function fetchMeshSessionOwners(limit = 500): Promise<{ items: MeshSessionOwnerRecord[] }> {
  return request<{ items: MeshSessionOwnerRecord[] }>(`/api/v1/mesh/sessions/owners?limit=${limit}`);
}

export async function fetchMeshReplicationOffsets(limit = 500): Promise<{ items: MeshReplicationOffsetRecord[] }> {
  return request<{ items: MeshReplicationOffsetRecord[] }>(`/api/v1/mesh/replication/offsets?limit=${limit}`);
}

export async function fetchNpuStatus(): Promise<NpuRuntimeStatus> {
  return request<NpuRuntimeStatus>("/api/v1/npu/status");
}

export async function fetchNpuModels(): Promise<{ items: NpuModelManifest[] }> {
  return request<{ items: NpuModelManifest[] }>("/api/v1/npu/models");
}

export async function startNpuRuntime(): Promise<NpuRuntimeStatus> {
  return request<NpuRuntimeStatus>("/api/v1/npu/start", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function stopNpuRuntime(): Promise<NpuRuntimeStatus> {
  return request<NpuRuntimeStatus>("/api/v1/npu/stop", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function refreshNpuRuntime(): Promise<NpuRuntimeStatus> {
  return request<NpuRuntimeStatus>("/api/v1/npu/refresh", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchMcpServers(): Promise<{ items: McpServerRecord[] }> {
  return request<{ items: McpServerRecord[] }>("/api/v1/mcp/servers");
}

export async function fetchMcpTemplates(): Promise<{ items: Array<McpServerTemplateRecord & { installed: boolean }> }> {
  return request<{ items: Array<McpServerTemplateRecord & { installed: boolean }> }>("/api/v1/mcp/templates");
}

export async function fetchMcpTemplateDiscovery(): Promise<{ items: McpTemplateDiscoveryResult[] }> {
  return request<{ items: McpTemplateDiscoveryResult[] }>("/api/v1/mcp/templates/discovery");
}

export async function createMcpServer(input: {
  label: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  authType?: "none" | "token" | "oauth2";
  enabled?: boolean;
  category?: McpServerRecord["category"];
  trustTier?: McpServerRecord["trustTier"];
  costTier?: McpServerRecord["costTier"];
  policy?: Partial<McpServerRecord["policy"]>;
  verifiedAt?: string;
}): Promise<McpServerRecord> {
  return request<McpServerRecord>("/api/v1/mcp/servers", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateMcpServer(
  serverId: string,
  input: {
    label?: string;
    command?: string;
    args?: string[];
    url?: string;
    authType?: "none" | "token" | "oauth2";
    enabled?: boolean;
    category?: McpServerRecord["category"];
    trustTier?: McpServerRecord["trustTier"];
    costTier?: McpServerRecord["costTier"];
    policy?: Partial<McpServerRecord["policy"]>;
    verifiedAt?: string;
  },
): Promise<McpServerRecord> {
  return request<McpServerRecord>(`/api/v1/mcp/servers/${encodeURIComponent(serverId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function updateMcpServerPolicy(
  serverId: string,
  policy: Partial<McpServerRecord["policy"]>,
): Promise<McpServerRecord> {
  return request<McpServerRecord>(`/api/v1/mcp/servers/${encodeURIComponent(serverId)}/policy`, {
    method: "PATCH",
    body: JSON.stringify(policy),
  });
}

export async function deleteMcpServer(serverId: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(`/api/v1/mcp/servers/${encodeURIComponent(serverId)}`, {
    method: "DELETE",
    body: JSON.stringify({}),
  });
}

export async function connectMcpServer(serverId: string): Promise<McpServerRecord> {
  return request<McpServerRecord>(`/api/v1/mcp/servers/${encodeURIComponent(serverId)}/connect`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function disconnectMcpServer(serverId: string): Promise<McpServerRecord> {
  return request<McpServerRecord>(`/api/v1/mcp/servers/${encodeURIComponent(serverId)}/disconnect`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function startMcpOAuth(serverId: string): Promise<McpOAuthStartResponse> {
  return request<McpOAuthStartResponse>(`/api/v1/mcp/servers/${encodeURIComponent(serverId)}/oauth/start`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function completeMcpOAuth(serverId: string, input: { code: string; state?: string }): Promise<McpServerRecord> {
  return request<McpServerRecord>(`/api/v1/mcp/servers/${encodeURIComponent(serverId)}/oauth/complete`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchMcpTools(serverId: string): Promise<{ items: McpToolRecord[] }> {
  return request<{ items: McpToolRecord[] }>(`/api/v1/mcp/servers/${encodeURIComponent(serverId)}/tools`);
}

export async function invokeMcpTool(input: {
  serverId: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  agentId?: string;
  sessionId?: string;
  taskId?: string;
}): Promise<McpInvokeResponse> {
  return request<McpInvokeResponse>("/api/v1/mcp/invoke", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function runMcpServerHealthCheck(serverId: string): Promise<ConnectorDiagnosticReport> {
  return request<ConnectorDiagnosticReport>(`/api/v1/mcp/servers/${encodeURIComponent(serverId)}/health-check`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function transcribeVoice(input: {
  bytesBase64: string;
  mimeType?: string;
  language?: string;
}): Promise<VoiceTranscribeResponse> {
  return request<VoiceTranscribeResponse>("/api/v1/voice/transcribe", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchVoiceStatus(): Promise<VoiceStatus> {
  return request<VoiceStatus>("/api/v1/voice/status");
}

export async function fetchVoiceRuntimeStatus(): Promise<VoiceRuntimeStatus> {
  return request<VoiceRuntimeStatus>("/api/v1/voice/runtime");
}

export async function fetchVoiceTalkSessions(limit = 10): Promise<VoiceTalkSessionRecord[]> {
  const query = new URLSearchParams({ limit: String(limit) });
  const response = await request<{ items: VoiceTalkSessionRecord[] }>(`/api/v1/voice/talk/sessions?${query.toString()}`);
  return response.items;
}

export async function installVoiceRuntime(input: VoiceRuntimeInstallRequest = {}): Promise<VoiceRuntimeStatus> {
  return request<VoiceRuntimeStatus>("/api/v1/voice/runtime/install", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function selectVoiceRuntimeModel(modelId: string): Promise<VoiceRuntimeStatus> {
  return request<VoiceRuntimeStatus>(`/api/v1/voice/runtime/models/${encodeURIComponent(modelId)}/select`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function removeVoiceRuntimeModel(modelId: string): Promise<VoiceRuntimeStatus> {
  return request<VoiceRuntimeStatus>(`/api/v1/voice/runtime/models/${encodeURIComponent(modelId)}`, {
    method: "DELETE",
    body: JSON.stringify({}),
  });
}

export async function startVoiceTalkSession(input?: {
  mode?: "push_to_talk" | "wake";
  sessionId?: string;
}): Promise<VoiceTalkSessionRecord> {
  return request<VoiceTalkSessionRecord>("/api/v1/voice/talk/sessions", {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

export async function stopVoiceTalkSession(talkSessionId: string): Promise<VoiceTalkSessionRecord> {
  return request<VoiceTalkSessionRecord>(`/api/v1/voice/talk/sessions/${encodeURIComponent(talkSessionId)}/stop`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function startVoiceWake(): Promise<VoiceStatus["wake"]> {
  return request<VoiceStatus["wake"]>("/api/v1/voice/wake/start", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function stopVoiceWake(): Promise<VoiceStatus["wake"]> {
  return request<VoiceStatus["wake"]>("/api/v1/voice/wake/stop", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchDaemonStatus(): Promise<{
  running: boolean;
  pid: number;
  uptimeSeconds: number;
  host: string;
  state: "running" | "stopped";
  lastCommandAt?: string;
  requestedState?: "running" | "stopped";
  supported: boolean;
  controllable: boolean;
  controlMessage: string;
}> {
  return request<{
    running: boolean;
    pid: number;
    uptimeSeconds: number;
    host: string;
    state: "running" | "stopped";
    lastCommandAt?: string;
    requestedState?: "running" | "stopped";
    supported: boolean;
    controllable: boolean;
    controlMessage: string;
  }>("/api/v1/daemon/status");
}

export async function startDaemon(): Promise<{
  accepted: boolean;
  reason: string;
  status: Awaited<ReturnType<typeof fetchDaemonStatus>>;
}> {
  return request<{
    accepted: boolean;
    reason: string;
    status: Awaited<ReturnType<typeof fetchDaemonStatus>>;
  }>("/api/v1/daemon/start", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function stopDaemon(): Promise<{
  accepted: boolean;
  reason: string;
  status: Awaited<ReturnType<typeof fetchDaemonStatus>>;
}> {
  return request<{
    accepted: boolean;
    reason: string;
    status: Awaited<ReturnType<typeof fetchDaemonStatus>>;
  }>("/api/v1/daemon/stop", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function restartDaemon(): Promise<{
  accepted: boolean;
  reason: string;
  status: Awaited<ReturnType<typeof fetchDaemonStatus>>;
}> {
  return request<{
    accepted: boolean;
    reason: string;
    status: Awaited<ReturnType<typeof fetchDaemonStatus>>;
  }>("/api/v1/daemon/restart", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchDaemonLogs(tail = 200): Promise<{
  items: Array<{ timestamp: string; level: "info" | "warn" | "error"; message: string }>;
}> {
  return request<{
    items: Array<{ timestamp: string; level: "info" | "warn" | "error"; message: string }>;
  }>(`/api/v1/daemon/logs?tail=${Math.max(1, Math.min(2000, tail))}`);
}

export async function evaluateUiChangeRisk(input: {
  pageId: string;
  changes: Array<{ field: string; from: unknown; to: unknown }>;
}, options?: { signal?: AbortSignal }): Promise<ChangeRiskEvaluationResponse> {
  return request<ChangeRiskEvaluationResponse>("/api/v1/ui/change-risk/evaluate", {
    method: "POST",
    body: JSON.stringify(input),
    signal: options?.signal,
  });
}

export type EventStreamConnectionState = "connecting" | "open" | "retrying" | "error" | "closed";

export interface EventStreamStatus {
  state: EventStreamConnectionState;
  reconnectAttempts: number;
  lastEventAt?: string;
  lastErrorAt?: string;
  leaseId?: string;
  clientId?: string;
  gatewayNodeId?: string;
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
let activeEventStreamLeaseId: string | undefined;
let activeEventStreamClientId: string | undefined;
let activeEventStreamGatewayNodeId: string | undefined;

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
      activeEventStreamLeaseId = undefined;
      activeEventStreamClientId = undefined;
      activeEventStreamGatewayNodeId = undefined;
    }
  };
}

async function buildEventStreamUrl(): Promise<string> {
  const url = new URL(`${API_BASE}/api/v1/events/stream`);
  const clientId = getOrCreateRealtimeClientId();
  activeEventStreamClientId = clientId;
  url.searchParams.set("clientId", clientId);
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
      if (isApiRequestError(error) && error.status === 400) {
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

  source.onmessage = (evt) => {
    if (sharedEventSource !== source) {
      return;
    }
    try {
      const event = JSON.parse(evt.data) as RealtimeEvent;
      if (typeof event.sequence === "number" && Number.isFinite(event.sequence)) {
        persistRealtimeCursor(event.sequence);
      }
      lastEventAt = event.timestamp || new Date().toISOString();
      recordClientDiagnostic({
        level: "debug",
        category: "sse",
        event: "freshness",
        message: event.eventType,
        context: {
          source: event.source,
          eventId: event.eventId,
        },
      });
      notifyEventStreamStatusToAll();
      for (const subscriber of eventStreamSubscribers) {
        subscriber.onEvent(event);
      }
    } catch {
      // ignore malformed messages
    }
  };

  source.addEventListener("replay-gap", (evt) => {
    if (sharedEventSource !== source) {
      return;
    }
    activeEventStreamLeaseId = undefined;
    clearStoredRealtimeCursor();
    lastErrorAt = new Date().toISOString();
    const replayGapEvent = buildReplayGapRealtimeEvent(evt.data);
    notifyEventStreamStatusToAll();
    for (const subscriber of eventStreamSubscribers) {
      subscriber.onEvent(replayGapEvent);
    }
  });

  source.addEventListener("stream-ready", (evt) => {
    if (sharedEventSource !== source) {
      return;
    }
    try {
      const payload = JSON.parse(evt.data) as {
        leaseId?: string;
        clientId?: string;
        gatewayNodeId?: string;
      };
      activeEventStreamLeaseId = typeof payload.leaseId === "string" ? payload.leaseId : undefined;
      activeEventStreamClientId = typeof payload.clientId === "string"
        ? payload.clientId
        : activeEventStreamClientId;
      activeEventStreamGatewayNodeId = typeof payload.gatewayNodeId === "string"
        ? payload.gatewayNodeId
        : undefined;
      notifyEventStreamStatusToAll();
    } catch {
      // ignore malformed readiness payloads
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

export async function fetchDevDiagnostics(params: {
  level?: DevDiagnosticsLevel;
  category?: string;
  correlationId?: string;
  limit?: number;
} = {}): Promise<DevDiagnosticsListResponse> {
  const query = new URLSearchParams();
  if (params.level) {
    query.set("level", params.level);
  }
  if (params.category) {
    query.set("category", params.category);
  }
  if (params.correlationId) {
    query.set("correlationId", params.correlationId);
  }
  if (params.limit) {
    query.set("limit", String(params.limit));
  }
  return request<DevDiagnosticsListResponse>(`/api/v1/dev/diagnostics${query.size > 0 ? `?${query.toString()}` : ""}`);
}

export function connectDevDiagnosticsStream(onEvent: (event: DevDiagnosticsEvent) => void): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }
  const url = `${API_BASE}/api/v1/dev/diagnostics/stream?replay=50`;
  const source = new EventSource(url);
  source.onmessage = (event) => {
    try {
      onEvent(JSON.parse(event.data) as DevDiagnosticsEvent);
      setDevDiagnosticsGatewayReachable(true);
    } catch {
      // ignore malformed diagnostics
    }
  };
  source.onerror = () => {
    setDevDiagnosticsGatewayReachable(false);
    source.close();
  };
  return () => source.close();
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

function computeReconnectDelay(attempt: number): number {
  const clampedAttempt = Math.max(1, attempt);
  const base = Math.min(30_000, 1000 * (2 ** (clampedAttempt - 1)));
  const jitter = Math.floor(Math.random() * 500);
  return Math.min(30_000, base + jitter);
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
    leaseId: activeEventStreamLeaseId,
    clientId: activeEventStreamClientId,
    gatewayNodeId: activeEventStreamGatewayNodeId,
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

function getOrCreateRealtimeClientId(): string {
  if (typeof window === "undefined") {
    return crypto.randomUUID();
  }
  const existing = window.localStorage.getItem(EVENT_CLIENT_ID_STORAGE_KEY)?.trim();
  if (existing) {
    return existing;
  }
  const next = crypto.randomUUID();
  window.localStorage.setItem(EVENT_CLIENT_ID_STORAGE_KEY, next);
  return next;
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
    eventClass: "ui_notification",
    eventAuthority: "retained_stream",
    correlationId: undefined,
    traceId: undefined,
    originSurface: "mission-control-web",
    payload: {
      kind: "replay_gap",
      ...payload,
    },
  };
}

