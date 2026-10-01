import { useEffect, useRef } from "react";
import type { DurableBackgroundTaskItem, DurableBackgroundTaskRailResponse } from "@goatcitadel/contracts";
import { isTerminalStatus } from "./useDurableBackgroundTaskRail";

export type BackgroundTaskSettledCallback = (task: DurableBackgroundTaskItem) => boolean | Promise<boolean>;

const BACKGROUND_REPORT_REFRESH_RETRY_MS = 1_000;
const BACKGROUND_REPORT_REFRESH_MAX_ATTEMPTS = 3;

export function useBackgroundTaskSettledRefresh(
  snapshot: DurableBackgroundTaskRailResponse | null,
  scopeKey: string,
  onBackgroundTaskSettled: BackgroundTaskSettledCallback | undefined,
): void {
  type RefreshAttempt = {
    count: number;
    task: DurableBackgroundTaskItem;
    timer?: ReturnType<typeof setTimeout>;
  };
  const callbackRef = useRef(onBackgroundTaskSettled);
  callbackRef.current = onBackgroundTaskSettled;
  const attempts = useRef<{ scopeKey: string; entries: Map<string, RefreshAttempt> }>({
    scopeKey,
    entries: new Map(),
  });

  useEffect(() => {
    if (attempts.current.scopeKey !== scopeKey) {
      for (const entry of attempts.current.entries.values()) {
        if (entry.timer) clearTimeout(entry.timer);
      }
      attempts.current = { scopeKey, entries: new Map() };
    }
    return () => {
      if (attempts.current.scopeKey !== scopeKey) return;
      for (const entry of attempts.current.entries.values()) {
        if (entry.timer) clearTimeout(entry.timer);
      }
      attempts.current = { scopeKey: "", entries: new Map() };
    };
  }, [scopeKey]);

  useEffect(() => {
    if (!snapshot || !callbackRef.current) return;
    for (const task of snapshot.tasks) {
      if (task.attention.state !== "background" || !isTerminalStatus(task.canonicalStatus)) continue;
      const attemptKey = [task.watcherId, task.childRunId, task.childVersion ?? "", task.canonicalStatus].join(
        "\u0000",
      );
      const existing = attempts.current.entries.get(attemptKey);
      if (existing) {
        existing.task = task;
        continue;
      }
      const entry: RefreshAttempt = { count: 0, task };
      attempts.current.entries.set(attemptKey, entry);
      const refreshReport = (): void => {
        const activeEntry = attempts.current.entries.get(attemptKey);
        if (attempts.current.scopeKey !== scopeKey || activeEntry !== entry) return;
        entry.timer = undefined;
        entry.count += 1;
        const callback = callbackRef.current;
        if (!callback) return;
        void Promise.resolve(callback(entry.task))
          .then((accepted) => {
            if (
              !accepted &&
              entry.count < BACKGROUND_REPORT_REFRESH_MAX_ATTEMPTS &&
              attempts.current.scopeKey === scopeKey &&
              attempts.current.entries.get(attemptKey) === entry
            ) {
              entry.timer = setTimeout(refreshReport, BACKGROUND_REPORT_REFRESH_RETRY_MS);
            }
          })
          .catch(() => {
            if (
              entry.count < BACKGROUND_REPORT_REFRESH_MAX_ATTEMPTS &&
              attempts.current.scopeKey === scopeKey &&
              attempts.current.entries.get(attemptKey) === entry
            ) {
              entry.timer = setTimeout(refreshReport, BACKGROUND_REPORT_REFRESH_RETRY_MS);
            }
          });
      };
      refreshReport();
    }
  }, [scopeKey, snapshot]);
}
