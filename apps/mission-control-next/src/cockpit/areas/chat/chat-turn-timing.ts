import type { ChatTurnLifecycleStatus, ChatTurnTraceRecord } from "@goatcitadel/contracts";

const SETTLED_TURN_STATUSES: ReadonlySet<ChatTurnLifecycleStatus> = new Set([
  "completed",
  "partial",
  "failed",
  "cancelled",
]);

export type RecordedTurnTime = { kind: "recorded"; ms: number } | { kind: "not_finished" } | { kind: "not_recorded" };

/**
 * The turn's recorded start-to-finish time, including tool runs and any wait on an approval or a question.
 * `completion.latencyMs` is a different figure: the time spent inside model calls only (#499).
 */
export function recordedTurnTime(
  trace: Pick<ChatTurnTraceRecord, "status" | "startedAt" | "finishedAt">,
): RecordedTurnTime {
  if (!SETTLED_TURN_STATUSES.has(trace.status)) return { kind: "not_finished" };
  const started = Date.parse(trace.startedAt);
  const finished = trace.finishedAt ? Date.parse(trace.finishedAt) : Number.NaN;
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return { kind: "not_recorded" };
  return { kind: "recorded", ms: finished - started };
}
