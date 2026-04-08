/**
 * Pure helpers extracted from MemoryPage.tsx (Step 10 page slimming).
 *
 * Stateless functions plus data-shape interfaces. No React/hooks.
 */

export interface WorkspaceFile {
  relativePath: string;
  size: number;
  modifiedAt: string;
}

export interface WorkspaceAreaSummary {
  area: string;
  files: WorkspaceFile[];
  totalBytes: number;
  latestModifiedAt?: string;
}

export interface MemoryMaintenancePolicyDraft {
  enabled: boolean;
  runMode: "manual" | "scheduled" | "hybrid";
  timingStrategy: "fixed" | "recommendation_first";
  timeZone: string;
  minHoursSinceLastSuccess: number;
  minChangedSessions: number;
  providerId: string;
  model: string;
  executionTarget: "auto" | "local" | "cloud";
  unavailableModelPolicy: "skip" | "error";
  scheduleEnabled: boolean;
  scheduleFrequency: "daily" | "weekly";
  scheduleHour: number;
  scheduleMinute: number;
  scheduleWeekday: number;
}

export function topLevelArea(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  const [first] = normalized.split("/");
  return first && first.length > 0 ? first : "(root)";
}

export function pickLatestTimestamp(current?: string, incoming?: string): string | undefined {
  if (!current) {
    return incoming;
  }
  if (!incoming) {
    return current;
  }
  return Date.parse(incoming) >= Date.parse(current) ? incoming : current;
}

export function summarizeAreas(files: WorkspaceFile[]): WorkspaceAreaSummary[] {
  const byArea = new Map<string, WorkspaceAreaSummary>();
  for (const file of files) {
    const area = topLevelArea(file.relativePath);
    const current = byArea.get(area) ?? {
      area,
      files: [],
      totalBytes: 0,
      latestModifiedAt: undefined,
    };
    current.files.push(file);
    current.totalBytes += file.size;
    current.latestModifiedAt = pickLatestTimestamp(current.latestModifiedAt, file.modifiedAt);
    byArea.set(area, current);
  }

  return [...byArea.values()].sort((left, right) => right.totalBytes - left.totalBytes);
}

export function summarizeMemorySubspaces(files: WorkspaceFile[]): WorkspaceAreaSummary[] {
  const memoryFiles = files.filter((file) => file.relativePath.startsWith("memory/"));
  const byArea = new Map<string, WorkspaceAreaSummary>();

  for (const file of memoryFiles) {
    const parts = file.relativePath.split("/");
    const area = parts[1] ? `memory/${parts[1]}` : "memory/(root)";
    const current = byArea.get(area) ?? {
      area,
      files: [],
      totalBytes: 0,
      latestModifiedAt: undefined,
    };
    current.files.push(file);
    current.totalBytes += file.size;
    current.latestModifiedAt = pickLatestTimestamp(current.latestModifiedAt, file.modifiedAt);
    byArea.set(area, current);
  }

  return [...byArea.values()].sort((left, right) => right.totalBytes - left.totalBytes);
}

export function isMemoryLifecycleAdminDisabledError(message: string): boolean {
  return message.includes("memoryLifecycleAdminV1Enabled") || message.includes("Feature flag");
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  }
  return `${bytes} B`;
}

export function describeQmdImpact(stats: {
  efficiencyLabel: "reduced" | "expanded" | "neutral";
  compressionPercent: number;
  expansionPercent: number;
}): string {
  if (stats.efficiencyLabel === "reduced") {
    return `Reduced ${stats.compressionPercent.toFixed(1)}%`;
  }
  if (stats.efficiencyLabel === "expanded") {
    return `Grew ${stats.expansionPercent.toFixed(1)}%`;
  }
  return "Stable";
}

export function formatTokenDelta(delta: number): string {
  if (delta > 0) {
    return `+${Math.round(delta)} tokens`;
  }
  if (delta < 0) {
    return `${Math.round(delta)} tokens`;
  }
  return "no change";
}

export function dedupeTextOptions(values: Array<string | undefined | null>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function isLikelyLocalProvider(baseUrl?: string): boolean {
  const normalized = baseUrl?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(normalized);
}

export function describeMaintenanceProviderLocality(baseUrl?: string): string {
  return isLikelyLocalProvider(baseUrl) ? "local endpoint" : "remote endpoint";
}

export function describeMaintenanceUnavailablePolicy(
  policy: MemoryMaintenancePolicyDraft["unavailableModelPolicy"],
): string {
  return policy === "skip" ? "skip if unavailable" : "error if unavailable";
}

export function formatMemoryMaintenanceProviderOption(
  provider: {
    providerId: string;
    label: string;
    baseUrl: string;
  },
  isActive: boolean,
): string {
  const tags = [provider.label, describeMaintenanceProviderLocality(provider.baseUrl), isActive ? "active" : ""].filter(
    Boolean,
  );
  return `${provider.providerId} (${tags.join(" · ")})`;
}

export function toMemoryMaintenancePolicyDraft(policy: {
  enabled: boolean;
  runMode: MemoryMaintenancePolicyDraft["runMode"];
  timingStrategy: MemoryMaintenancePolicyDraft["timingStrategy"];
  timeZone: string;
  minHoursSinceLastSuccess: number;
  minChangedSessions: number;
  providerId?: string | null;
  model?: string | null;
  executionTarget: MemoryMaintenancePolicyDraft["executionTarget"];
  unavailableModelPolicy: MemoryMaintenancePolicyDraft["unavailableModelPolicy"];
  schedule?: {
    frequency: "daily" | "weekly";
    hour: number;
    minute: number;
    weekday?: number;
  } | null;
}): MemoryMaintenancePolicyDraft {
  const schedule = policy.schedule ?? { frequency: "daily" as const, hour: 3, minute: 0, weekday: 1 };
  return {
    enabled: policy.enabled,
    runMode: policy.runMode,
    timingStrategy: policy.timingStrategy,
    timeZone: policy.timeZone,
    minHoursSinceLastSuccess: policy.minHoursSinceLastSuccess,
    minChangedSessions: policy.minChangedSessions,
    providerId: policy.providerId ?? "",
    model: policy.model ?? "",
    executionTarget: policy.executionTarget,
    unavailableModelPolicy: policy.unavailableModelPolicy,
    scheduleEnabled: policy.runMode !== "manual",
    scheduleFrequency: schedule.frequency,
    scheduleHour: schedule.hour,
    scheduleMinute: schedule.minute,
    scheduleWeekday: schedule.weekday ?? 1,
  };
}

export function buildMemoryMaintenancePolicyPatch(draft: MemoryMaintenancePolicyDraft) {
  return {
    enabled: draft.enabled,
    runMode: draft.runMode,
    timingStrategy: draft.timingStrategy,
    timeZone: draft.timeZone.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    minHoursSinceLastSuccess: draft.minHoursSinceLastSuccess,
    minChangedSessions: draft.minChangedSessions,
    providerId: draft.providerId.trim() || null,
    model: draft.model.trim() || null,
    executionTarget: draft.executionTarget,
    unavailableModelPolicy: draft.unavailableModelPolicy,
    schedule:
      draft.runMode === "manual"
        ? null
        : {
            frequency: draft.scheduleFrequency,
            hour: draft.scheduleHour,
            minute: draft.scheduleMinute,
            weekday: draft.scheduleFrequency === "weekly" ? draft.scheduleWeekday : undefined,
          },
  };
}

export function clampNumber(rawValue: string, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

export function formatMaybeDateTime(value?: string): string {
  return value ? new Date(value).toLocaleString() : "-";
}

export function formatShortDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatJson(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2);
}

export function shortId(value: string, max = 12): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}
