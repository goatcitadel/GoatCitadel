import type { DevDiagnosticsLevel } from "@goatcitadel/contracts";
import { recordClientDiagnostic } from "@goatcitadel/mission-control-shared/state/dev-diagnostics-store";

type RouteDiagnosticInput = {
  level?: DevDiagnosticsLevel;
  event: string;
  message: string;
  context?: Record<string, unknown>;
  route?: string;
  durationMs?: number;
};

const SENSITIVE_CONTEXT_KEYS = /token|secret|password|key|credential|authorization|prompt|body/i;
const MAX_CONTEXT_TEXT_LENGTH = 180;

export function recordRouteDiagnostic(input: RouteDiagnosticInput): void {
  recordClientDiagnostic({
    level: input.level ?? "debug",
    category: "ui",
    event: input.event,
    message: input.message,
    context: sanitizeRouteDiagnosticContext(input.context),
    route: input.route,
    durationMs: input.durationMs,
  });
}

export function recordRouteDataLoad(input: {
  route: string;
  label: string;
  startedAt: number;
  itemCount?: number;
  selectedId?: string;
  issueCount?: number;
}): void {
  recordRouteDiagnostic({
    level: input.issueCount ? "warn" : "debug",
    event: "native.route.data.loaded",
    message: `${input.label} route data loaded.`,
    route: input.route,
    durationMs: Math.max(0, Math.round(readNow() - input.startedAt)),
    context: {
      label: input.label,
      itemCount: input.itemCount ?? 0,
      selectedId: input.selectedId,
      issueCount: input.issueCount ?? 0,
    },
  });
}

export function readRouteDiagnosticNow(): number {
  return readNow();
}

export function recordRouteAction(route: string, action: string, context?: Record<string, unknown>): void {
  recordRouteDiagnostic({
    level: "info",
    event: "native.route.action",
    message: `Native route action: ${action}.`,
    route,
    context: {
      action,
      ...context,
    },
  });
}

function sanitizeRouteDiagnosticContext(
  context: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!context) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => [
      key,
      SENSITIVE_CONTEXT_KEYS.test(key) ? "[redacted]" : sanitizeRouteDiagnosticValue(value),
    ]),
  );
}

function sanitizeRouteDiagnosticValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_CONTEXT_TEXT_LENGTH ? `${value.slice(0, MAX_CONTEXT_TEXT_LENGTH)}...` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 12).map((item) => sanitizeRouteDiagnosticValue(item));
  }
  if (value && typeof value === "object") {
    return sanitizeRouteDiagnosticContext(value as Record<string, unknown>);
  }
  return value;
}

function readNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}
