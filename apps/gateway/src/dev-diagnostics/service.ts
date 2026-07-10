import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type {
  DevDiagnosticsCategory,
  DevDiagnosticsEvent,
  DevDiagnosticsLevel,
  DevDiagnosticsListResponse,
  RuntimeDiagnosticStatus,
  RuntimeDiagnosticEventInput,
} from "@goatcitadel/contracts";
import { redactStructuredSecrets } from "@goatcitadel/contracts";

interface DevDiagnosticsContext {
  correlationId?: string;
  route?: string;
  sessionId?: string;
  chatId?: string;
  turnId?: string;
  runId?: string;
  taskId?: string;
  providerId?: string;
  modelId?: string;
}

interface DevDiagnosticsFilter {
  level?: DevDiagnosticsLevel;
  category?: string;
  correlationId?: string;
  runtimeKind?: string;
  runtimeStatus?: RuntimeDiagnosticStatus;
  runId?: string;
  toolName?: string;
  meetingSessionId?: string;
  limit?: number;
}

interface DevDiagnosticsRecordInput {
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
  runtimeStatus?: DevDiagnosticsEvent["runtimeStatus"];
  runtimeError?: DevDiagnosticsEvent["runtimeError"];
}

const DEFAULT_BUFFER_SIZE = 300;
const REDACTED = "[redacted]";
const MAX_CONTEXT_DEPTH = 5;
const ARGV_LIKE_KEY_PATTERN = /^(?:argv|args|execArgv|commandArgs|command_argv)$/i;
const SECRET_ARG_FLAG_PATTERN =
  /^--?(?:api[-_]?key|apikey|token|access[-_]?token|refresh[-_]?token|client[-_]?secret|secret|password|authorization|proxy-authorization)(?:=|$)/i;

const diagnosticsContextStorage = new AsyncLocalStorage<DevDiagnosticsContext>();

type DevDiagnosticsListener = (event: DevDiagnosticsEvent) => void;

export interface DevDiagnosticsExporter {
  export(event: DevDiagnosticsEvent): void | Promise<void>;
}

export function runWithDevDiagnosticsContext<T>(context: DevDiagnosticsContext, callback: () => T): T {
  return diagnosticsContextStorage.run(context, callback);
}

export function enterDevDiagnosticsContext(context: DevDiagnosticsContext): void {
  const current = diagnosticsContextStorage.getStore() ?? {};
  diagnosticsContextStorage.enterWith({
    ...current,
    ...context,
  });
}

export function getDevDiagnosticsContext(): DevDiagnosticsContext | undefined {
  return diagnosticsContextStorage.getStore();
}

export function resolveDevDiagnosticsEnabled(): boolean {
  const override = process.env.GOATCITADEL_DEV_DIAGNOSTICS_ENABLED?.trim().toLowerCase();
  if (override === "true" || override === "1" || override === "yes" || override === "on") {
    return true;
  }
  if (override === "false" || override === "0" || override === "no" || override === "off") {
    return false;
  }
  return process.env.NODE_ENV !== "production";
}

export function resolveDevDiagnosticsVerbose(): boolean {
  const override = process.env.GOATCITADEL_DEV_DIAGNOSTICS_VERBOSE?.trim().toLowerCase();
  if (override === "true" || override === "1" || override === "yes" || override === "on") {
    return true;
  }
  if (override === "false" || override === "0" || override === "no" || override === "off") {
    return false;
  }
  return false;
}

export function resolveDevDiagnosticsBufferSize(raw: string | undefined, fallback = DEFAULT_BUFFER_SIZE): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(5000, parsed);
}

export class GatewayDevDiagnosticsService {
  private readonly listeners = new Set<DevDiagnosticsListener>();
  private readonly exporters = new Set<DevDiagnosticsExporter>();
  private readonly items: DevDiagnosticsEvent[] = [];

  public constructor(
    private readonly enabled: boolean,
    private logger: FastifyBaseLogger | undefined,
    private readonly verbose: boolean,
    private readonly maxItems = DEFAULT_BUFFER_SIZE,
  ) {}

  public setLogger(logger: FastifyBaseLogger | undefined): void {
    this.logger = logger;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public list(filter: DevDiagnosticsFilter = {}): DevDiagnosticsListResponse {
    if (!this.enabled) {
      return { items: [] };
    }
    const limit = Math.max(1, filter.limit ?? 100);
    const filtered = this.items.filter((item) => {
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
    });
    return {
      items: filtered.slice(-limit).reverse(),
    };
  }

  public subscribe(listener: DevDiagnosticsListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public registerExporter(exporter: DevDiagnosticsExporter): () => void {
    this.exporters.add(exporter);
    return () => {
      this.exporters.delete(exporter);
    };
  }

  public record(input: DevDiagnosticsRecordInput): DevDiagnosticsEvent | undefined {
    if (!this.enabled) {
      return undefined;
    }

    const inherited = diagnosticsContextStorage.getStore() ?? {};
    const event: DevDiagnosticsEvent = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      level: input.level,
      category: input.category,
      event: input.event,
      message: sanitizeDiagnosticValue(input.message) as string,
      context: input.context ? (sanitizeDiagnosticValue(input.context) as Record<string, unknown>) : undefined,
      correlationId: input.correlationId ?? inherited.correlationId,
      sessionId: input.sessionId ?? inherited.sessionId,
      chatId: input.chatId ?? inherited.chatId,
      turnId: input.turnId ?? inherited.turnId,
      runId: input.runId ?? inherited.runId,
      taskId: input.taskId ?? inherited.taskId,
      stepId: input.stepId,
      toolRunId: input.toolRunId,
      meetingSessionId: input.meetingSessionId,
      route: input.route ?? inherited.route,
      providerId: input.providerId ?? inherited.providerId,
      modelId: input.modelId ?? inherited.modelId,
      toolName: input.toolName,
      durationMs: input.durationMs,
      runtimeKind: input.runtimeKind,
      runtimeStatus: input.runtimeStatus,
      runtimeError: input.runtimeError
        ? (sanitizeDiagnosticValue(input.runtimeError) as DevDiagnosticsEvent["runtimeError"])
        : undefined,
      source: "gateway",
    };

    this.items.push(event);
    if (this.items.length > this.maxItems) {
      this.items.splice(0, this.items.length - this.maxItems);
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger?.warn(
          {
            diagnostics: true,
            event: event.event,
            listenerError: error instanceof Error ? error.message : String(error),
          },
          "Dev diagnostics listener threw while handling an event",
        );
      }
    }
    for (const exporter of this.exporters) {
      try {
        const result = exporter.export(event);
        if (result && typeof result.catch === "function") {
          result.catch((error: unknown) => {
            this.logger?.warn(
              {
                diagnostics: true,
                event: event.event,
                exporterError: error instanceof Error ? error.message : String(error),
              },
              "Dev diagnostics exporter rejected while handling an event",
            );
          });
        }
      } catch (error) {
        this.logger?.warn(
          {
            diagnostics: true,
            event: event.event,
            exporterError: error instanceof Error ? error.message : String(error),
          },
          "Dev diagnostics exporter threw while handling an event",
        );
      }
    }

    if (this.logger && (this.verbose || event.level !== "debug")) {
      const payload = {
        diagnostics: true,
        category: event.category,
        event: event.event,
        correlationId: event.correlationId,
        sessionId: event.sessionId,
        turnId: event.turnId,
        runId: event.runId,
        taskId: event.taskId,
        route: event.route,
        providerId: event.providerId,
        modelId: event.modelId,
        toolName: event.toolName,
        runtimeKind: event.runtimeKind,
        runtimeStatus: event.runtimeStatus,
        context: event.context,
      };
      switch (event.level) {
        case "error":
          this.logger.error(payload, event.message);
          break;
        case "warn":
          this.logger.warn(payload, event.message);
          break;
        case "info":
          this.logger.info(payload, event.message);
          break;
        default:
          this.logger.debug(payload, event.message);
          break;
      }
    }

    return event;
  }

  public recordRuntime(input: RuntimeDiagnosticEventInput): DevDiagnosticsEvent | undefined {
    const context: Record<string, unknown> = {
      ...(input.metadata ?? {}),
      status: input.status,
      kind: input.kind,
      durationMs: input.durationMs,
      error: input.error,
    };
    return this.record({
      level: input.level ?? levelForRuntimeStatus(input.status),
      category: input.category ?? categoryForRuntimeKind(input.kind),
      event: input.event ?? input.kind,
      message: input.message,
      context,
      correlationId: input.correlationId,
      sessionId: input.linkage?.sessionId,
      chatId: input.linkage?.chatId,
      turnId: input.linkage?.turnId,
      runId: input.linkage?.runId,
      taskId: input.linkage?.taskId,
      stepId: input.linkage?.stepId,
      toolRunId: input.linkage?.toolRunId,
      meetingSessionId: input.linkage?.meetingSessionId,
      providerId: input.providerId,
      modelId: input.modelId,
      toolName: input.toolName,
      durationMs: input.durationMs,
      runtimeKind: input.kind,
      runtimeStatus: input.status,
      runtimeError: input.error,
    });
  }
}

function levelForRuntimeStatus(status: RuntimeDiagnosticEventInput["status"]): DevDiagnosticsLevel {
  if (status === "failed") {
    return "error";
  }
  if (status === "blocked" || status === "degraded") {
    return "warn";
  }
  return status === "running" ? "debug" : "info";
}

function categoryForRuntimeKind(kind: RuntimeDiagnosticEventInput["kind"]): DevDiagnosticsCategory | string {
  if (kind.startsWith("model.")) {
    return "model";
  }
  if (kind.startsWith("tool.")) {
    return "tools";
  }
  if (kind.startsWith("meet.")) {
    return "meet";
  }
  if (kind.startsWith("voice.")) {
    return "voice";
  }
  if (kind.startsWith("mcp.")) {
    return "mcp";
  }
  if (kind.startsWith("chat.")) {
    return "chat";
  }
  if (kind.startsWith("delegation.")) {
    return "orchestration";
  }
  if (kind.startsWith("dependency.")) {
    return "dependency";
  }
  return "runtime";
}

function sanitizeDiagnosticValue(value: unknown): unknown {
  const capped = capAndSanitizeDiagnosticArgv(value, 0);
  const projected = redactStructuredSecrets(capped, {
    marker: REDACTED,
    circularMarker: "[circular]",
    redactEnvAssignmentsAsWhole: true,
  }).value;
  return collapseDiagnosticBearerMarkers(projected);
}

function capAndSanitizeDiagnosticArgv(value: unknown, depth: number, key?: string): unknown {
  if (depth >= MAX_CONTEXT_DEPTH) {
    return "[max-depth]";
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return key && ARGV_LIKE_KEY_PATTERN.test(key)
      ? sanitizeDiagnosticArgv(value, depth)
      : value.map((item) => capAndSanitizeDiagnosticArgv(item, depth + 1));
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [childKey, nested] of Object.entries(value)) {
      result[childKey] = capAndSanitizeDiagnosticArgv(nested, depth + 1, childKey);
    }
    return result;
  }
  return value;
}

function sanitizeDiagnosticArgv(value: unknown[], depth: number): unknown[] {
  let redactNext = false;
  return value.map((entry) => {
    if (redactNext) {
      redactNext = false;
      return REDACTED;
    }
    if (typeof entry !== "string") {
      return capAndSanitizeDiagnosticArgv(entry, depth + 1);
    }
    if (!SECRET_ARG_FLAG_PATTERN.test(entry)) {
      return entry;
    }
    const equalsIndex = entry.indexOf("=");
    if (equalsIndex >= 0) {
      return `${entry.slice(0, equalsIndex + 1)}${REDACTED}`;
    }
    redactNext = true;
    return entry;
  });
}

function collapseDiagnosticBearerMarkers(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\bBearer\s+\[redacted\]/gi, REDACTED);
  }
  if (Array.isArray(value)) {
    return value.map(collapseDiagnosticBearerMarkers);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      collapseDiagnosticBearerMarkers(nested),
    ]),
  );
}
