import type { SessionMeta } from "@goatcitadel/contracts";
import {
  presentPendingApprovals,
  sourceFailed,
  type OpsRuntimeData,
} from "../../../features/native-routes/ops/runtime-overview-model";
import type { Metric } from "../../ui/MetricList";
import { presentChannel } from "./system-vocabulary";

export const SESSIONS_SOURCE_LABELS: Readonly<Record<string, string>> = {
  sessions: "Session list",
  dashboard: "Dashboard summary",
};

/** An explicit name, unless it is a raw session id; otherwise the channel names the conversation. */
export function sessionTitle(item: SessionMeta): string {
  const explicit = item.displayName?.trim();
  return explicit && !/^sess[_-]/i.test(explicit) ? explicit : `${presentChannel(item.channel)} conversation`;
}

function listed(data: OpsRuntimeData): SessionMeta[] {
  return data.sessions?.length ? data.sessions : (data.dashboard?.sessions ?? []);
}

/** A failed session source with nothing to show is a failure, never a calm empty list. */
export function recentSessionList(data: OpsRuntimeData): { state: "failed" } | { state: "ok"; items: SessionMeta[] } {
  const items = listed(data);
  return !items.length && sourceFailed(data, "sessions") ? { state: "failed" } : { state: "ok", items };
}

export function findSession(data: OpsRuntimeData, sessionId: string): SessionMeta | undefined {
  return listed(data).find((item) => item.sessionId === sessionId);
}

/** Installation-wide counts from the dashboard summary; a missing summary reads Unknown, never 0. */
export function sessionsAcrossWorkspaces(data: OpsRuntimeData, hostPendingApprovals?: number): Metric[] {
  const dashboard = sourceFailed(data, "dashboard") ? null : data.dashboard;
  const count = (value: number | undefined) => (dashboard && typeof value === "number" ? String(value) : "Unknown");
  const pending = presentPendingApprovals(dashboard ? data : { ...data, dashboard: null }, hostPendingApprovals);
  return [
    { term: pending.label, value: pending.value },
    { term: "Active subagents", value: count(dashboard?.activeSubagents) },
    { term: "Recent events", value: count(dashboard?.recentEvents?.length) },
  ];
}
