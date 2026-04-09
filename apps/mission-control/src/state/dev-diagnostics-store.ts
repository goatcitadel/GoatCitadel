import { useSyncExternalStore } from "react";
import type { DevDiagnosticsCategory, DevDiagnosticsEvent, DevDiagnosticsLevel } from "@goatcitadel/contracts";
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
]);

type Listener = () => void;

const listeners = new Set<Listener>();
const eventTimestamps = new Map<string, number>();

const diagnosticsEnabled = resolveDevDiagnosticsEnabled();
const verboseDiagnostics = resolveDevDiagnosticsVerbose();
const maxItems = resolveBufferSize(readEnv("VITE_GOATCITADEL_DEV_DIAGNOSTICS_CLIENT_BUFFER"), DEFAULT_BUFFER_SIZE);

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
  route?: string;
  providerId?: string;
  modelId?: string;
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
    route: sanitizeDiagnosticRoute(input.route ?? state.currentRoute),
    providerId: sanitizeOptionalDiagnosticText(input.providerId),
    modelId: sanitizeOptionalDiagnosticText(input.modelId),
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
    url.searchParams.delete("access_token");

    const rawHash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
    if (rawHash.includes("=")) {
      const hashParams = new URLSearchParams(rawHash);
      hashParams.delete("access_token");
      const nextHash = hashParams.toString();
      url.hash = nextHash ? `#${nextHash}` : "";
    }

    return normalizeDiagnosticRouteInput(`${url.pathname}${url.search}${url.hash}`) ?? "";
  } catch {
    return (normalized.replace(/([?#&])access_token=[^&#]*/giu, "$1").replace(/[?#&]$/u, "") || "").trim();
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
  return import.meta.env.DEV;
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
  // eslint-disable-next-line no-console
  console.debug("[goatcitadel:dev-diagnostics]", event);
}

function sanitizeContext(context: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!context) {
    return undefined;
  }
  return JSON.parse(
    JSON.stringify(context, (_key, value: unknown) => {
      if (typeof value === "string" && /^bearer\s+/i.test(value)) {
        return "[redacted]";
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
