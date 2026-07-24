import type { AgenticDiagnosticSignal, AgenticRunListItem, AgenticRunStatus, TaskStatus } from "@goatcitadel/contracts";

const STALE_RUN_AFTER_MS = 30 * 60 * 1000;

export type KanbanColumnId = "queued" | "running" | "needs_attention" | "closed";

export type KanbanStatusTone = "neutral" | "active" | "warning" | "danger" | "success";

export interface KanbanCardModel {
  taskId: string;
  revision?: number;
  runId: string;
  title: string;
  column: KanbanColumnId;
  surfaceLabel: string;
  statusLabel: string;
  statusTone: KanbanStatusTone;
  updatedDisplay: string;
  stale: boolean;
  attentionReason?: string;
  diagnosticSummary: { info: number; warning: number; critical: number };
  unresolvedDiagnostics: AgenticDiagnosticSignal[];
  contextMode?: string;
  profileId?: string;
}

export function toKanbanColumn(
  runStatus: AgenticRunStatus | undefined,
  taskStatus: TaskStatus | string | undefined,
  options: { updatedAt?: string; now?: () => number } = {},
): KanbanColumnId {
  if (isStaleActiveRun(runStatus, options.updatedAt, options.now)) {
    return "needs_attention";
  }
  if (runStatus === "queued" || runStatus === "planning") {
    return "queued";
  }
  if (runStatus === "running") {
    return "running";
  }
  if (runStatus === "completed") {
    return "closed";
  }
  if (runStatus === "approval_required" || runStatus === "paused") {
    return "needs_attention";
  }
  if (runStatus === "failed" || runStatus === "cancelled" || runStatus === "stopped_by_limit") {
    return "needs_attention";
  }
  if (taskStatus === "done") {
    return "closed";
  }
  if (taskStatus === "in_progress" || taskStatus === "testing") {
    return "running";
  }
  if (taskStatus === "blocked" || taskStatus === "review") {
    return "needs_attention";
  }
  return "queued";
}

export interface ToKanbanCardOptions {
  now?: () => number;
}

export function toKanbanCard(run: AgenticRunListItem, options: ToKanbanCardOptions = {}): KanbanCardModel {
  const nowMs = options.now ? options.now() : Date.now();
  const unresolvedDiagnostics = (run.diagnostics ?? []).filter((diagnostic) => !diagnostic.resolvedAt);
  const diagnosticSummary = { info: 0, warning: 0, critical: 0 };
  for (const diagnostic of unresolvedDiagnostics) {
    diagnosticSummary[diagnostic.severity] += 1;
  }
  const column = toKanbanColumn(run.status, run.taskStatus, { updatedAt: run.updatedAt, now: options.now });
  const stale = isStaleActiveRun(run.status, run.updatedAt, options.now);
  return {
    taskId: run.taskId,
    revision: run.taskRevision,
    runId: run.runId,
    title: run.title,
    column,
    surfaceLabel: run.surface ? formatLabel(run.surface) : "Unknown surface",
    statusLabel: stale ? "Stale" : formatStatusLabel(run.status ?? run.taskStatus),
    statusTone: getStatusTone(column, run.status),
    updatedDisplay: formatAge(run.updatedAt, nowMs),
    stale,
    attentionReason: getAttentionReason(run.status, run.taskStatus, stale),
    diagnosticSummary,
    unresolvedDiagnostics,
    contextMode: run.contextMode,
    profileId: run.profileId,
  };
}

function isStaleActiveRun(
  status: AgenticRunStatus | undefined,
  updatedAt: string | undefined,
  now: (() => number) | undefined,
): boolean {
  if (status !== "queued" && status !== "planning" && status !== "running") {
    return false;
  }
  const updatedMs = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  if (!Number.isFinite(updatedMs)) {
    return false;
  }
  return (now ? now() : Date.now()) - updatedMs > STALE_RUN_AFTER_MS;
}

function getStatusTone(column: KanbanColumnId, runStatus?: AgenticRunStatus): KanbanStatusTone {
  if (column === "running") return "active";
  if (column === "needs_attention") {
    // Hard failures read differently from soft attention states (stale,
    // paused, waiting for approval) so a failed run is not a neutral-looking
    // chip next to a merely idle one.
    return runStatus === "failed" || runStatus === "cancelled" || runStatus === "stopped_by_limit"
      ? "danger"
      : "warning";
  }
  if (column === "closed") return "success";
  return "neutral";
}

function getAttentionReason(
  runStatus: AgenticRunStatus | undefined,
  taskStatus: TaskStatus | string | undefined,
  stale: boolean,
): string | undefined {
  if (stale) {
    return "No recent run update.";
  }
  if (runStatus === "approval_required") {
    return "Waiting for operator approval.";
  }
  if (runStatus === "paused") {
    return "Paused by runtime state.";
  }
  if (runStatus === "failed") {
    return "Run failed.";
  }
  if (runStatus === "cancelled") {
    return "Run was cancelled.";
  }
  if (runStatus === "stopped_by_limit") {
    return "Stopped by limit.";
  }
  if (taskStatus === "blocked") {
    return "Task is blocked.";
  }
  if (taskStatus === "review") {
    return "Task is waiting for review.";
  }
  return undefined;
}

function formatStatusLabel(status: AgenticRunStatus | TaskStatus | string | undefined): string {
  return status ? formatLabel(status) : "Unknown";
}

function formatLabel(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatAge(timestamp: string, nowMs: number): string {
  const updatedMs = Date.parse(timestamp);
  if (!Number.isFinite(updatedMs)) {
    return "unknown";
  }
  const seconds = Math.max(0, Math.round((nowMs - updatedMs) / 1000));
  if (seconds < 60) {
    return `${seconds}s idle`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m idle`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h idle`;
  }
  return `${Math.round(hours / 24)}d idle`;
}
