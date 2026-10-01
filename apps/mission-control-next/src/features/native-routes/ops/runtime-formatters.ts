import type { useOpsRuntimeSnapshot } from "@goatcitadel/mission-control-shared/hooks/useOpsRuntimeSnapshot";
import type { ChipTone } from "../primitives";
type OpsRuntimeData = NonNullable<ReturnType<typeof useOpsRuntimeSnapshot>["data"]>;

export function formatHumanSessionTitle(item: {
  displayName?: string | null;
  title?: string | null;
  sessionId: string;
  channel?: string | null;
  lastActivityAt?: string | null;
}) {
  const explicit = item.displayName?.trim() || item.title?.trim();
  if (explicit && !/^sess[_-]/i.test(explicit)) {
    return explicit;
  }
  const channel = item.channel ? `${capitalize(item.channel)} session` : "Session";
  const when = item.lastActivityAt ? formatDateTime(item.lastActivityAt) : formatShortSessionId(item.sessionId);
  return `${channel} · ${when}`;
}

export function formatShortSessionId(sessionId: string) {
  return sessionId.replace(/^sess[_-]?/i, "session ").slice(0, 22);
}

export function capitalize(value: string) {
  return value ? `${value.slice(0, 1).toUpperCase()}${value.slice(1)}` : value;
}

export function humanizeEventLabel(value: string): string {
  const words = value
    .split(/[_.\s]+/)
    .filter(Boolean)
    .join(" ");
  return words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : words;
}

export function toneForActivityEvent(eventType: string, eventClass?: string | null): ChipTone {
  const haystack = `${eventType} ${eventClass ?? ""}`.toLowerCase();
  if (/error|failed|failure|degraded|critical/.test(haystack)) {
    return "danger";
  }
  if (/approval|review|decision|warn/.test(haystack)) {
    return "caution";
  }
  if (/runtime|daemon|mcp|gateway|schedule/.test(haystack)) {
    return "accent";
  }
  if (/ok|success|complete|ready/.test(haystack)) {
    return "safe";
  }
  return "muted";
}

export function describeQmdImpact(efficiencyLabel?: "reduced" | "expanded" | "neutral") {
  switch (efficiencyLabel) {
    case "reduced":
      return "Reduced";
    case "expanded":
      return "Expanded";
    default:
      return "Stable";
  }
}

export function formatTokenDelta(value: number) {
  if (!Number.isFinite(value) || value === 0) {
    return "no token delta";
  }
  const rounded = Math.round(value);
  return rounded > 0 ? `+${rounded} tokens` : `${rounded} tokens`;
}

export function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0m";
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

export function formatDateTime(value?: string | null) {
  if (!value) {
    return "Unknown";
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return "Unknown";
  }
  const date = new Date(parsed);
  const currentYear = new Date().getFullYear();
  const parts = new Intl.DateTimeFormat(undefined, {
    month: "numeric",
    day: "numeric",
    year: date.getFullYear() === currentYear ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const datePart =
    date.getFullYear() === currentYear
      ? `${get("month")}/${get("day")}`
      : `${get("month")}/${get("day")}/${get("year")}`;
  return `${datePart} ${get("hour")}:${get("minute")} ${get("dayPeriod")}`.trim();
}

export function formatActivityAge(value?: string | null, nowMs = Date.now()) {
  if (!value) {
    return "—";
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "—";
  }
  const seconds = Math.max(0, Math.floor((nowMs - timestamp) / 1000));
  if (seconds < 60) {
    return seconds === 0 ? "now" : `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

export function formatShortRunId(value?: string) {
  if (!value) {
    return "none";
  }
  return value.length > 12 ? `${value.slice(0, 8)}...` : value;
}

export function formatMilliseconds(value?: number) {
  if (!isFiniteNumber(value)) {
    return "unavailable";
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)}s`;
  }
  return `${Math.round(value)}ms`;
}

export function formatOptionalNumber(value?: number, suffix = "") {
  if (!isFiniteNumber(value)) {
    return "unavailable";
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)}${suffix}`;
}

export function formatOptionalUsd(value?: number) {
  if (!isFiniteNumber(value)) {
    return "unavailable";
  }
  return formatUsd(value);
}

export function formatParetoProviders(results?: OpsRuntimeData["evalProofRuns"][number]["results"]) {
  const labels = (results ?? [])
    .filter((item) => item.paretoOptimal)
    .map((item) => `${item.providerId}/${item.model}`)
    .slice(0, 2);
  if (labels.length === 0) {
    return "none";
  }
  return labels.length === 2 ? `${labels.join(", ")}${(results ?? []).length > 2 ? "..." : ""}` : labels[0]!;
}

export function averageNumbers(values: number[]) {
  if (values.length === 0) {
    return undefined;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let index = 0;
  let current = value;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  return `${current.toFixed(current >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(Number.isFinite(value) ? value : 0);
}

export function formatLoadAverage(values: number[]) {
  if (!values.length) {
    return "n/a";
  }
  return values
    .slice(0, 3)
    .map((value) => value.toFixed(2))
    .join(" / ");
}

export function formatOptionalBytes(value: number | undefined) {
  return value === undefined || !Number.isFinite(value) ? "unavailable" : formatBytes(value);
}

export function formatOptionalDuration(value: number | undefined) {
  return value === undefined || !Number.isFinite(value) ? "unavailable" : formatDuration(value);
}
