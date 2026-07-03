import { useSyncExternalStore } from "react";
import type {
  DevDiagnosticsCategory,
  DevDiagnosticsEvent,
  DevDiagnosticsLevel,
  RuntimeDiagnosticStatus,
} from "@goatcitadel/contracts";
import type { EventStreamConnectionState } from "../api/client";

interface DevDiagnosticsState {
  enabled: boolean;
  verbose: boolean;
  items: DevDiagnosticsEvent[];
  currentRoute: string;
  activeChatSessionId?: string;
  activeCorrelationId?: string;
  lastRequestError?: string;
  currentEffectsMode?: string;
  gatewayReachable?: boolean;
  sseState?: EventStreamConnectionState;
  latestTraceSummary?: Record<string, unknown>;
  startupSummary?: DevDiagnosticsStartupSummary;
}

export interface DevDiagnosticsStartupPhase {
  key: string;
  label: string;
  status: "success" | "error" | "skipped";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  detail: string;
}

export interface DevDiagnosticsStartupSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outcome: string;
  phases: DevDiagnosticsStartupPhase[];
}

interface DevDiagnosticsBridge {
  getSnapshot: () => DevDiagnosticsState;
  list: (filter?: DevDiagnosticsFilter) => DevDiagnosticsEvent[];
  buildBundle: (gatewayItems?: DevDiagnosticsEvent[]) => Record<string, unknown>;
  setCorrelationId: (correlationId?: string) => void;
  setChatSessionId: (sessionId?: string) => void;
}

declare global {
  interface Window {
    __goatcitadelDevDiagnostics?: DevDiagnosticsBridge;
  }
}

export interface DevDiagnosticsFilter {
  category?: string;
  correlationId?: string;
  level?: DevDiagnosticsLevel;
  runtimeKind?: string;
  runtimeStatus?: RuntimeDiagnosticStatus;
  runId?: string;
  toolName?: string;
  meetingSessionId?: string;
  limit?: number;
}

const DEFAULT_BUFFER_SIZE = 300;
const MAX_COPY_ITEMS = 100;
const HIGH_FREQUENCY_EVENT_THROTTLES = new Map<string, number>([
  ["sse:freshness", 5000],
  ["refresh:event", 1500],
  ["refresh:started", 1500],
  ["chat:thread.reconcile", 1200],
  ["chat:thread.render_path", 1200],
  ["chat:thread.preview_path", 1200],
]);

type Listener = () => void;

const listeners = new Set<Listener>();
const eventTimestamps = new Map<string, number>();

const diagnosticsEnabled = resolveDevDiagnosticsEnabled();
const verboseDiagnostics = resolveDevDiagnosticsVerbose();
const maxItems = resolveBufferSize(readEnv("VITE_GOATCITADEL_DEV_DIAGNOSTICS_CLIENT_BUFFER"), DEFAULT_BUFFER_SIZE);
const echoDiagnosticsToConsole = resolveConsoleDiagnosticsEchoEnabled();

let state: DevDiagnosticsState = {
  enabled: diagnosticsEnabled,
  verbose: verboseDiagnostics,
  items: [],
  currentRoute: typeof window === "undefined" ? "" : readWindowDiagnosticRoute(),
};

if (typeof window !== "undefined" && diagnosticsEnabled) {
  window.__goatcitadelDevDiagnostics = {
    getSnapshot: () => state,
    list: (filter?: DevDiagnosticsFilter) => listClientDiagnostics(filter),
    buildBundle: (gatewayItems?: DevDiagnosticsEvent[]) => buildDevDiagnosticsBundle(gatewayItems),
    setCorrelationId: (correlationId?: string) => setDevDiagnosticsActiveCorrelationId(correlationId),
    setChatSessionId: (sessionId?: string) => setDevDiagnosticsActiveChatSession(sessionId),
  };
}

export function useDevDiagnosticsState(): DevDiagnosticsState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function isDevDiagnosticsEnabled(): boolean {
  return state.enabled;
}

export function getCurrentDiagnosticsCorrelationId(): string | undefined {
  return state.activeCorrelationId;
}

export function getCurrentDiagnosticsRoute(): string {
  return state.currentRoute;
}

export function setDevDiagnosticsCurrentRoute(route: string): void {
  const sanitized = sanitizeDiagnosticRoute(route);
  if (!state.enabled || state.currentRoute === sanitized) {
    return;
  }
  state = {
    ...state,
    currentRoute: sanitized,
  };
  notify();
}

export function setDevDiagnosticsActiveChatSession(sessionId: string | undefined): void {
  const sanitized = sanitizeOptionalDiagnosticText(sessionId);
  if (!state.enabled || state.activeChatSessionId === sanitized) {
    return;
  }
  state = {
    ...state,
    activeChatSessionId: sanitized,
  };
  notify();
}

export function setDevDiagnosticsCurrentEffectsMode(effectsMode: string): void {
  const sanitized = sanitizeOptionalDiagnosticText(effectsMode);
  if (!state.enabled || state.currentEffectsMode === sanitized) {
    return;
  }
  state = {
    ...state,
    currentEffectsMode: sanitized,
  };
  notify();
}

export function setDevDiagnosticsSseState(connectionState: EventStreamConnectionState): void {
  if (!state.enabled || state.sseState === connectionState) {
    return;
  }
  state = {
    ...state,
    sseState: connectionState,
  };
  notify();
}

export function setDevDiagnosticsGatewayReachable(reachable: boolean): void {
  if (!state.enabled || state.gatewayReachable === reachable) {
    return;
  }
  state = {
    ...state,
    gatewayReachable: reachable,
  };
  notify();
}

export function setDevDiagnosticsLastRequestError(errorMessage: string | undefined): void {
  const sanitized = sanitizeOptionalDiagnosticText(errorMessage);
  if (!state.enabled || state.lastRequestError === sanitized) {
    return;
  }
  state = {
    ...state,
    lastRequestError: sanitized,
  };
  notify();
}

export function setDevDiagnosticsLatestTraceSummary(summary: Record<string, unknown> | undefined): void {
  if (!state.enabled) {
    return;
  }
  state = {
    ...state,
    latestTraceSummary: summary,
  };
  notify();
}

export function setDevDiagnosticsStartupSummary(summary: DevDiagnosticsStartupSummary | undefined): void {
  if (!state.enabled) {
    return;
  }
  state = {
    ...state,
    startupSummary: summary,
  };
  notify();
}

export function recordClientDiagnostic(input: {
  level: DevDiagnosticsLevel;
  category: DevDiagnosticsCategory | string;
  event: string;
  message: string;
  context?: Record<string, unknown>;
  correlationId?: string;
  sessionId?: string;
  chatId?: string;
  turnId?: string;
  runId?: string;
  taskId?: string;
  stepId?: string;
  toolRunId?: string;
  meetingSessionId?: string;
  route?: string;
  providerId?: string;
  modelId?: string;
  toolName?: string;
  durationMs?: number;
  runtimeKind?: string;
  runtimeStatus?: RuntimeDiagnosticStatus;
  runtimeError?: DevDiagnosticsEvent["runtimeError"];
}): DevDiagnosticsEvent | undefined {
  if (!state.enabled) {
    return undefined;
  }
  const throttleKey = `${input.category}:${input.event}`;
  const throttleMs = HIGH_FREQUENCY_EVENT_THROTTLES.get(throttleKey);
  if (typeof throttleMs === "number") {
    const now = Date.now();
    const last = eventTimestamps.get(throttleKey) ?? 0;
    if (now - last < throttleMs) {
      return undefined;
    }
    eventTimestamps.set(throttleKey, now);
  }
  const event: DevDiagnosticsEvent = {
    id: createCorrelationId(),
    timestamp: new Date().toISOString(),
    level: input.level,
    category: input.category,
    event: input.event,
    message: input.message,
    context: sanitizeContext(input.context),
    correlationId: sanitizeOptionalDiagnosticText(input.correlationId) ?? state.activeCorrelationId,
    sessionId: sanitizeOptionalDiagnosticText(input.sessionId) ?? state.activeChatSessionId,
    chatId: sanitizeOptionalDiagnosticText(input.chatId),
    turnId: sanitizeOptionalDiagnosticText(input.turnId),
    runId: sanitizeOptionalDiagnosticText(input.runId),
    taskId: sanitizeOptionalDiagnosticText(input.taskId),
    stepId: sanitizeOptionalDiagnosticText(input.stepId),
    toolRunId: sanitizeOptionalDiagnosticText(input.toolRunId),
    meetingSessionId: sanitizeOptionalDiagnosticText(input.meetingSessionId),
    route: sanitizeDiagnosticRoute(input.route ?? state.currentRoute),
    providerId: sanitizeOptionalDiagnosticText(input.providerId),
    modelId: sanitizeOptionalDiagnosticText(input.modelId),
    toolName: sanitizeOptionalDiagnosticText(input.toolName),
    durationMs: sanitizeDuration(input.durationMs),
    runtimeKind: sanitizeOptionalDiagnosticText(input.runtimeKind),
    runtimeStatus: input.runtimeStatus,
    runtimeError: sanitizeRuntimeError(input.runtimeError),
    source: "client",
  };
  state = {
    ...state,
    items: [...state.items, event].slice(-maxItems),
    activeCorrelationId: event.correlationId ?? state.activeCorrelationId,
  };
  if (state.verbose || event.level !== "debug") {
    debugLogDiagnosticEvent(event);
  }
  notify();
  return event;
}

function sanitizeDiagnosticRoute(route: string): string {
  const normalized = normalizeDiagnosticRouteInput(route);
  if (!normalized) {
    return "";
  }

  try {
    const url = new URL(normalized, "http://goatcitadel.local");
    stripSensitiveRouteParams(url.searchParams);

    const rawHash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
    if (rawHash.includes("=")) {
      const hashParams = new URLSearchParams(rawHash);
      stripSensitiveRouteParams(hashParams);
      const nextHash = hashParams.toString();
      url.hash = nextHash ? `#${nextHash}` : "";
    }

    return normalizeDiagnosticRouteInput(`${url.pathname}${url.search}${url.hash}`) ?? "";
  } catch {
    return (
      normalized
        .replace(
          /([?#&])(?:access_token|auth_token|refresh_token|session_token|api_key|apikey|client_secret|password)=[^&#]*/giu,
          "$1",
        )
        .replace(/[?#&]$/u, "") || ""
    ).trim();
  }
}

function stripSensitiveRouteParams(params: URLSearchParams): void {
  for (const name of Array.from(params.keys())) {
    if (/^(access_token|auth_token|refresh_token|session_token|api_key|apikey|client_secret|password)$/iu.test(name)) {
      params.delete(name);
    }
  }
}

export function setDevDiagnosticsActiveCorrelationId(correlationId: string | undefined): void {
  const sanitized = sanitizeOptionalDiagnosticText(correlationId);
  if (!state.enabled || !sanitized || state.activeCorrelationId === sanitized) {
    return;
  }
  state = {
    ...state,
    activeCorrelationId: sanitized,
  };
  notify();
}

export function listClientDiagnostics(filter: DevDiagnosticsFilter = {}): DevDiagnosticsEvent[] {
  if (!state.enabled) {
    return [];
  }
  const limit = Math.max(1, filter.limit ?? state.items.length);
  return state.items
    .filter((item) => {
      if (filter.level && item.level !== filter.level) {
        return false;
      }
      if (filter.category && item.category !== filter.category) {
        return false;
      }
      if (filter.correlationId && item.correlationId !== filter.correlationId) {
        return false;
      }
      if (filter.runtimeKind && item.runtimeKind !== filter.runtimeKind) {
        return false;
      }
      if (filter.runtimeStatus && item.runtimeStatus !== filter.runtimeStatus) {
        return false;
      }
      if (filter.runId && item.runId !== filter.runId) {
        return false;
      }
      if (filter.toolName && item.toolName !== filter.toolName) {
        return false;
      }
      if (filter.meetingSessionId && item.meetingSessionId !== filter.meetingSessionId) {
        return false;
      }
      return true;
    })
    .slice(-limit)
    .reverse();
}

export function clearClientDiagnostics(): void {
  if (!state.enabled) {
    return;
  }
  state = {
    ...state,
    items: [],
  };
  notify();
}

export function buildDevDiagnosticsBundle(gatewayItems: DevDiagnosticsEvent[] = []): Record<string, unknown> {
  const clientItems = listClientDiagnostics({ limit: MAX_COPY_ITEMS });
  const runtimeDiagnostics = [...gatewayItems, ...clientItems]
    .filter((item) => item.runtimeKind || item.runtimeStatus || item.runId || item.toolName || item.meetingSessionId)
    .slice(0, MAX_COPY_ITEMS);
  return {
    generatedAt: new Date().toISOString(),
    route: state.currentRoute,
    activeChatSessionId: state.activeChatSessionId,
    activeCorrelationId: state.activeCorrelationId,
    lastRequestError: state.lastRequestError,
    currentEffectsMode: state.currentEffectsMode,
    gatewayReachable: state.gatewayReachable,
    sseState: state.sseState,
    latestTraceSummary: state.latestTraceSummary,
    startupSummary: state.startupSummary,
    browserDiagnostics: clientItems,
    gatewayDiagnostics: gatewayItems.slice(0, MAX_COPY_ITEMS),
    runtimeDiagnostics,
  };
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): DevDiagnosticsState {
  return state;
}

function readWindowDiagnosticRoute(): string {
  if (typeof window === "undefined") {
    return "";
  }
  return sanitizeDiagnosticRoute(
    `${readWindowLocationPart(window.location?.pathname)}${readWindowLocationPart(window.location?.search)}${readWindowLocationPart(window.location?.hash)}`,
  );
}

function readWindowLocationPart(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeDiagnosticRouteInput(route: unknown): string | undefined {
  if (typeof route !== "string") {
    return undefined;
  }
  const trimmed = route.trim();
  if (!trimmed || trimmed === "undefined" || trimmed === "null" || trimmed === "NaN") {
    return undefined;
  }
  return trimmed;
}

function sanitizeOptionalDiagnosticText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === "undefined" || trimmed === "null" || trimmed === "NaN") {
    return undefined;
  }
  return trimmed;
}

function sanitizeDuration(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.round(value);
}

function sanitizeRuntimeError(value: unknown): DevDiagnosticsEvent["runtimeError"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const error = value as NonNullable<DevDiagnosticsEvent["runtimeError"]>;
  const message = sanitizeOptionalDiagnosticText(error.message);
  if (!message) {
    return undefined;
  }
  return {
    name: sanitizeOptionalDiagnosticText(error.name),
    message,
    code: sanitizeOptionalDiagnosticText(error.code),
    retryable: typeof error.retryable === "boolean" ? error.retryable : undefined,
  };
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function resolveDevDiagnosticsEnabled(): boolean {
  const override = readEnv("VITE_GOATCITADEL_DEV_DIAGNOSTICS_ENABLED")?.toLowerCase();
  if (override === "true" || override === "1" || override === "yes" || override === "on") {
    return true;
  }
  if (override === "false" || override === "0" || override === "no" || override === "off") {
    return false;
  }
  return Boolean(import.meta.env.DEV);
}

function resolveDevDiagnosticsVerbose(): boolean {
  const override = readEnv("VITE_GOATCITADEL_DEV_DIAGNOSTICS_VERBOSE")?.toLowerCase();
  if (override === "true" || override === "1" || override === "yes" || override === "on") {
    return true;
  }
  return false;
}

function resolveBufferSize(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(2000, parsed);
}

function readEnv(key: string): string | undefined {
  return (import.meta.env[key] as string | undefined)?.trim() || undefined;
}

function debugLogDiagnosticEvent(event: DevDiagnosticsEvent): void {
  if (!echoDiagnosticsToConsole) {
    return;
  }
  // eslint-disable-next-line no-console
  console.debug("[goatcitadel:dev-diagnostics]", event);
}

function resolveConsoleDiagnosticsEchoEnabled(): boolean {
  return !isTestRuntime();
}

function isTestRuntime(): boolean {
  return import.meta.env.MODE === "test";
}

const SENSITIVE_KEY_PATTERN =
  /^(api[_-]?key|apiKey|access[_-]?token|accessToken|client[_-]?secret|clientSecret|token|secret|password|authorization|private[_-]?key|privateKey|credential|bearer|refresh[_-]?token|refreshToken|session[_-]?token|sessionToken|auth[_-]?token|authToken)$/i;
const SENSITIVE_VALUE_PATTERN = /^(bearer\s+|sk-|ghp_|grat_|Basic\s+)/i;

function sanitizeContext(context: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!context) {
    return undefined;
  }
  return JSON.parse(
    JSON.stringify(context, (key, value: unknown) => {
      if (typeof value === "string") {
        if (SENSITIVE_VALUE_PATTERN.test(value) || (key && SENSITIVE_KEY_PATTERN.test(key))) {
          return "[redacted]";
        }
      }
      return value;
    }),
  ) as Record<string, unknown>;
}

export function createCorrelationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
