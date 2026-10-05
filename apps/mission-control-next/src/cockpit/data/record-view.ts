import type { UseQueryResult } from "@tanstack/react-query";

/**
 * How a panel shows one record read. A background refetch is not "no data": the last good record,
 * its actions and any open dialog stay while the read is checked again, and a failed recheck keeps
 * the record beside the error. Only an explicit reset (after a decision) drops it.
 */
export type RecordPhase = "loading" | "checking" | "error" | "ready";

export interface RecordView<T> {
  /** Last good record; undefined only before the first success or after a reset. */
  record: T | undefined;
  /** loading = no data yet; checking = background refetch with data; error = failed, maybe with stale data. */
  phase: RecordPhase;
  /** The record shown is from before a failed or in-flight refetch. */
  stale: boolean;
  /** `dataUpdatedAt` of the record shown. */
  checkedAt: number | undefined;
}

export type RecordQuery<D> = Pick<UseQueryResult<D>, "data" | "isPending" | "isFetching" | "isError" | "dataUpdatedAt">;

export function recordView<T, D>(query: RecordQuery<D>, select: (data: D) => T | undefined): RecordView<T>;
export function recordView<D>(query: RecordQuery<D>): RecordView<D>;
export function recordView<T, D>(
  query: RecordQuery<D>,
  select: (data: D) => T | undefined = (data) => data as unknown as T,
): RecordView<T> {
  const hasData = query.data !== undefined;
  const record = hasData ? select(query.data as D) : undefined;
  // A disabled read with no data is not loading: there is simply nothing to show yet.
  const phase: RecordPhase = query.isError
    ? "error"
    : query.isPending
      ? query.isFetching
        ? "loading"
        : "ready"
      : query.isFetching
        ? "checking"
        : "ready";
  return {
    record,
    phase,
    stale: record !== undefined && (query.isError || query.isFetching),
    checkedAt: hasData && query.dataUpdatedAt > 0 ? query.dataUpdatedAt : undefined,
  };
}

/**
 * The read has answered, so "this record is gone" copy may show when `record` is empty: not while the
 * first read runs, and not when the only answer is an error.
 */
export function recordAnswered(view: RecordView<unknown>): boolean {
  return view.phase === "ready" || view.phase === "checking" || (view.phase === "error" && view.record !== undefined);
}

/** "10:42" in the viewer's locale. */
export function recordTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** "Showing the last version from 10:42." when an error left an older record on screen. */
export function lastVersionNote(view: RecordView<unknown>): string | undefined {
  if (view.phase !== "error" || view.record === undefined) return undefined;
  return view.checkedAt ? `Showing the last version from ${recordTime(view.checkedAt)}.` : "Showing the last version.";
}

export const CHECKING_FOR_CHANGES = "Checking for changes…";
