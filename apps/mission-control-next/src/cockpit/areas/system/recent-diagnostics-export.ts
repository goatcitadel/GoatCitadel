import type { DevDiagnosticsEvent } from "@goatcitadel/contracts";

type DaemonLog = { timestamp: string; level: "info" | "warn" | "error"; message: string };

export interface RecentSource<T> {
  items?: readonly T[];
  failed: boolean;
  fetchedAt: number;
}

function sourceStatus(source: RecentSource<unknown>) {
  return {
    state: source.items ? (source.failed ? "stale" : "available") : "unavailable",
    ...(source.fetchedAt > 0 ? { fetchedAt: new Date(source.fetchedAt).toISOString() } : {}),
  };
}

/** Export the bounded fields the Diagnostics page actually shows. */
export function buildRecentDiagnosticsExport(input: {
  generatedAt: string;
  events: RecentSource<DevDiagnosticsEvent>;
  logs: RecentSource<DaemonLog>;
}) {
  return {
    schemaVersion: "goatcitadel.recent-diagnostics.v1",
    generatedAt: input.generatedAt,
    description:
      "Recent client and Gateway diagnostic events and daemon logs. Each source is limited to 100 received entries; this is not complete history.",
    sourceStatus: {
      diagnosticEvents: sourceStatus(input.events),
      daemonLogs: sourceStatus(input.logs),
    },
    diagnosticEvents:
      input.events.items?.slice(0, 100).map(({ id, timestamp, level, category, event, message, source }) => ({
        id,
        timestamp,
        level,
        category,
        event,
        message,
        source,
      })) ?? null,
    daemonLogs:
      input.logs.items?.slice(0, 100).map(({ timestamp, level, message }) => ({ timestamp, level, message })) ?? null,
  };
}
