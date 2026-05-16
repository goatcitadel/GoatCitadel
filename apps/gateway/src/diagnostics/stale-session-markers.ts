export type RuntimeSessionState = "active" | "stale";

const TERMINAL_STATUSES = new Set(["sent", "failed", "stale", "completed", "rejected", "approved", "skipped"]);

export interface StaleableRecord {
  readonly id?: string;
  readonly lastHeartbeatAt?: string;
  readonly updatedAt?: string;
  readonly status?: string;
}

export interface MarkOptions {
  readonly now: number;
  readonly thresholdMs: number;
}

export const DEFAULT_STALE_THRESHOLD_MS = 90_000;

export function markStaleSessions<T extends StaleableRecord>(
  records: readonly T[],
  options: MarkOptions,
): readonly (T & { runtimeState: RuntimeSessionState })[] {
  return records.map((r) => ({
    ...r,
    runtimeState: computeState(r, options),
  }));
}

function computeState(record: StaleableRecord, options: MarkOptions): RuntimeSessionState {
  if (record.status && TERMINAL_STATUSES.has(record.status)) {
    return "active";
  }
  const heartbeatRaw = record.lastHeartbeatAt ?? record.updatedAt;
  if (!heartbeatRaw) {
    return "active";
  }
  const heartbeatMs = Date.parse(heartbeatRaw);
  if (!Number.isFinite(heartbeatMs)) {
    return "active";
  }
  return options.now - heartbeatMs > options.thresholdMs ? "stale" : "active";
}
