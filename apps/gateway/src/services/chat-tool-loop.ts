import { randomUUID } from "node:crypto";
import type { ChatToolLoopGuardEventRecord, ChatToolRunRecord, ToolLoopDetectionConfig } from "@goatcitadel/contracts";
import type { ChatTurnTraceRecord } from "@goatcitadel/contracts";

interface ToolLoopHistoryEntry {
  toolName: string;
  signature: string;
  resultSignature?: string;
  status: ChatToolRunRecord["status"];
}

export interface ToolLoopGuardRuntimeState {
  config: ToolLoopDetectionConfig;
  history: ToolLoopHistoryEntry[];
  events: ChatToolLoopGuardEventRecord[];
}

export function createLoopGuardTrace(state: ToolLoopGuardRuntimeState): ChatTurnTraceRecord["loopGuard"] {
  if (!state.config.enabled && state.events.length === 0) {
    return undefined;
  }
  return {
    enabled: state.config.enabled,
    historySize: state.config.historySize,
    events: [...state.events],
  };
}

export function initializeToolLoopGuardState(config?: ToolLoopDetectionConfig): ToolLoopGuardRuntimeState {
  return {
    config: {
      enabled: config?.enabled ?? true,
      historySize: Math.max(2, config?.historySize ?? 8),
      warningThreshold: Math.max(2, config?.warningThreshold ?? 3),
      criticalThreshold: Math.max(2, config?.criticalThreshold ?? 4),
      globalThreshold: Math.max(2, config?.globalThreshold ?? 6),
      detectors: {
        repeated_same_call: config?.detectors?.repeated_same_call ?? true,
        no_progress_polling: config?.detectors?.no_progress_polling ?? true,
        ping_pong: config?.detectors?.ping_pong ?? true,
      },
    },
    history: [],
    events: [],
  };
}

export function detectToolLoopRisk(
  state: ToolLoopGuardRuntimeState,
  toolName: string,
  rawArgs: Record<string, unknown>,
): ChatToolLoopGuardEventRecord | undefined {
  if (!state.config.enabled) {
    return undefined;
  }
  const signature = `${toolName}:${stableStringify(rawArgs)}`;
  const recentHistory = state.history.slice(-state.config.historySize);
  const candidates: ChatToolLoopGuardEventRecord[] = [];
  const now = new Date().toISOString();

  // Polling-like tools are intentionally excluded from the args-only `repeated_same_call`
  // detector: identical inputs are expected for polling, so counting `toolName:args`
  // repetitions alone would suppress a legitimate poll whose results are still changing.
  // The progress-aware `no_progress_polling` detector governs these tools instead — it
  // already gates on `looksLikePollingTool(...)` and only trips when the result signature
  // stops changing, so genuinely stuck polls (identical results) are still caught.
  if (state.config.detectors.repeated_same_call && !looksLikePollingTool(toolName)) {
    const repetitionCount = recentHistory.filter((entry) => entry.signature === signature).length + 1;
    const severity = classifyToolLoopSeverity(state.config, repetitionCount);
    if (severity) {
      candidates.push({
        eventId: randomUUID(),
        detector: "repeated_same_call",
        severity,
        toolName,
        message: buildToolLoopGuardMessage(severity, toolName, repetitionCount, "repeated identical tool calls"),
        repetitionCount,
        historySize: state.config.historySize,
        suppressed: severity !== "warning",
        createdAt: now,
      });
    }
  }

  if (state.config.detectors.no_progress_polling) {
    const sameSignature = recentHistory.filter((entry) => entry.signature === signature);
    const repeatedResultSignature = sameSignature.at(-1)?.resultSignature;
    const noProgressCount = repeatedResultSignature
      ? sameSignature.filter((entry) => entry.resultSignature === repeatedResultSignature).length + 1
      : 0;
    const severity = noProgressCount > 0 ? classifyToolLoopSeverity(state.config, noProgressCount) : undefined;
    if (severity && looksLikePollingTool(toolName)) {
      candidates.push({
        eventId: randomUUID(),
        detector: "no_progress_polling",
        severity,
        toolName,
        message: buildToolLoopGuardMessage(
          severity,
          toolName,
          noProgressCount,
          "no-progress polling with identical outcomes",
        ),
        repetitionCount: noProgressCount,
        historySize: state.config.historySize,
        suppressed: severity !== "warning",
        createdAt: now,
      });
    }
  }

  if (state.config.detectors.ping_pong) {
    const pingPongCount = measurePingPongPattern(recentHistory, toolName);
    const severity = classifyToolLoopSeverity(state.config, pingPongCount);
    if (severity) {
      const partnerTool = recentHistory.at(-1)?.toolName;
      candidates.push({
        eventId: randomUUID(),
        detector: "ping_pong",
        severity,
        toolName,
        message: buildToolLoopGuardMessage(
          severity,
          toolName,
          pingPongCount,
          `ping-pong tool oscillation${partnerTool ? ` with ${partnerTool}` : ""}`,
        ),
        repetitionCount: pingPongCount,
        historySize: state.config.historySize,
        suppressed: severity !== "warning",
        createdAt: now,
      });
    }
  }

  return candidates.sort(compareLoopGuardEventsBySeverity).at(0);
}

export function rememberToolLoopHistory(state: ToolLoopGuardRuntimeState, toolRun: ChatToolRunRecord): void {
  if (!state.config.enabled) {
    return;
  }
  state.history.push({
    toolName: toolRun.toolName,
    signature: `${toolRun.toolName}:${stableStringify(toolRun.args ?? {})}`,
    resultSignature: normalizeToolResultSignature(toolRun),
    status: toolRun.status,
  });
  if (state.history.length > state.config.historySize) {
    state.history.splice(0, state.history.length - state.config.historySize);
  }
}

function classifyToolLoopSeverity(
  config: ToolLoopDetectionConfig,
  repetitionCount: number,
): ChatToolLoopGuardEventRecord["severity"] | undefined {
  if (repetitionCount >= config.globalThreshold) {
    return "global_circuit_breaker";
  }
  if (repetitionCount >= config.criticalThreshold) {
    return "critical";
  }
  if (repetitionCount >= config.warningThreshold) {
    return "warning";
  }
  return undefined;
}

function buildToolLoopGuardMessage(
  severity: ChatToolLoopGuardEventRecord["severity"],
  toolName: string,
  repetitionCount: number,
  patternLabel: string,
): string {
  const prefix =
    severity === "warning"
      ? "Loop guard warning"
      : severity === "critical"
        ? "Loop guard suppressed further tool execution"
        : "Loop guard tripped the global circuit breaker";
  return `${prefix} for ${toolName}: ${patternLabel} (${repetitionCount} observations).`;
}

function compareLoopGuardEventsBySeverity(
  left: ChatToolLoopGuardEventRecord,
  right: ChatToolLoopGuardEventRecord,
): number {
  const rank: Record<ChatToolLoopGuardEventRecord["severity"], number> = {
    warning: 1,
    critical: 2,
    global_circuit_breaker: 3,
  };
  return rank[right.severity] - rank[left.severity] || right.repetitionCount - left.repetitionCount;
}

function measurePingPongPattern(history: ToolLoopHistoryEntry[], nextToolName: string): number {
  if (history.length < 3) {
    return 0;
  }
  const names = [...history.map((entry) => entry.toolName), nextToolName];
  const distinct = [...new Set(names.slice(-4))];
  if (distinct.length !== 2) {
    return 0;
  }
  let count = 1;
  let previous = names.at(-1);
  for (let index = names.length - 2; index >= 0; index -= 1) {
    const current = names[index];
    if (!current || current === previous) {
      break;
    }
    count += 1;
    previous = current;
  }
  return count >= 4 ? count : 0;
}

function normalizeToolResultSignature(toolRun: ChatToolRunRecord): string {
  if (toolRun.status === "failed" || toolRun.status === "blocked") {
    return `${toolRun.status}:${normalizeFailureSignature(toolRun.error)}`;
  }
  if (toolRun.status === "approval_required") {
    return "approval_required";
  }
  return `${toolRun.status}:${stableStringify(toolRun.result ?? {})}`;
}

function looksLikePollingTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized.includes("status") ||
    normalized.includes("poll") ||
    normalized.includes("wait") ||
    normalized.includes("check") ||
    normalized.includes("list") ||
    normalized.includes("get")
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function normalizeFailureSignature(value: string | undefined): string {
  if (!value) {
    return "unknown";
  }
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
