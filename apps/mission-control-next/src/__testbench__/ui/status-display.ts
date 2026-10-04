import type { CheckRunStatus, RunState, StatusCounts, StepStatus } from "../runner/state";
import type { CheckKind } from "../runner/types";

export type StatusTone = "success" | "warning" | "critical" | "muted" | "neutral" | "live";

export interface StatusDisplay {
  readonly icon: string;
  readonly label: string;
  readonly tone: StatusTone;
}

export const STATUS_DISPLAY: Readonly<Record<CheckRunStatus, StatusDisplay>> = {
  "not-run": { icon: "○", label: "not run", tone: "neutral" },
  queued: { icon: "…", label: "queued", tone: "muted" },
  running: { icon: "◌", label: "running", tone: "live" },
  pass: { icon: "✓", label: "pass", tone: "success" },
  fail: { icon: "✕", label: "fail", tone: "critical" },
  blocked: { icon: "◐", label: "blocked", tone: "warning" },
  skipped: { icon: "–", label: "skipped", tone: "muted" },
  cancelled: { icon: "■", label: "cancelled", tone: "muted" },
};

export const STEP_ICON: Readonly<Record<StepStatus, string>> = { running: "◌", pass: "✓", fail: "✕" };

export const KIND_LABELS: Readonly<Record<CheckKind, string>> = { auto: "auto", probe: "probe", journey: "journey" };

export function formatDuration(milliseconds: number): string {
  return milliseconds < 1_000 ? `${milliseconds} ms` : `${(milliseconds / 1_000).toFixed(1)} s`;
}

export function formatEvidence(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    // Fallback for values JSON cannot encode: show their string form.
    return String(value);
  }
}

export function describeRunEnd(state: RunState, counts: StatusCounts): string {
  if (state.running || state.endReason === undefined) {
    return "";
  }

  const baseMessage = `${counts.pass} pass, ${counts.fail} fail, ${counts.blocked} blocked, ${counts.skipped} skipped`;

  switch (state.endReason) {
    case "completed":
      return `Run completed: ${baseMessage}.`;
    case "stopped":
      return `Run stopped: ${baseMessage}, ${counts.cancelled} cancelled.`;
    case "unreachable":
      return `Run halted because the gateway became unreachable: ${baseMessage}, ${counts["not-run"]} not run.`;
  }
}
