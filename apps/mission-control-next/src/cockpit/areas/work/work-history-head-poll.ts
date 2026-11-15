import { useEffect } from "react";
import { useQueryClient, type QueryClient, type InfiniteData } from "@tanstack/react-query";
import type { DurableRunHistoryPage, TaskRecord } from "@goatcitadel/contracts";
import { fetchDurableRunHistory } from "@goatcitadel/mission-control-shared/api/durable";
import { fetchTasks } from "@goatcitadel/mission-control-shared/api/tasks";
import { isFinishedRunStatus } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { getEventStreamStatus } from "@goatcitadel/mission-control-shared/state/event-stream-status-store";
import { queryKeys } from "../../data/query-keys";
import { WORK_HISTORY_FALLBACK_MS } from "./work-queries";

type TaskPage = { items: TaskRecord[]; nextCursor?: string };
type Pages<T> = InfiniteData<T, string>;

const TASK_PAGE_SIZE = 200;
const RUN_PAGE_SIZE = 100;

function loadedPages<T>(client: QueryClient, queryKey: readonly unknown[]): Pages<T> | undefined {
  const query = client.getQueryCache().find({ queryKey, exact: true });
  if (!query || query.getObserversCount() === 0) return undefined;
  const data = query.state.data as Pages<T> | undefined;
  return data && data.pages.length > 1 ? data : undefined;
}

function sameTaskPage(cached: TaskPage, head: TaskPage): boolean {
  return (
    cached.items.length === head.items.length &&
    cached.items.every(
      (item, i) => item.taskId === head.items[i]?.taskId && item.updatedAt === head.items[i]?.updatedAt,
    )
  );
}

function sameRunPage(cached: DurableRunHistoryPage, head: DurableRunHistoryPage): boolean {
  return (
    cached.items.length === head.items.length &&
    cached.items.every(
      (item, i) =>
        item.runId === head.items[i]?.runId &&
        item.status === head.items[i]?.status &&
        item.updatedAt === head.items[i]?.updatedAt,
    )
  );
}

function hasUnfinishedOlderRun(data: Pages<DurableRunHistoryPage>): boolean {
  return data.pages.slice(1).some((page) => page.items.some((run) => !isFinishedRunStatus(run.status)));
}

async function checkTasks(client: QueryClient, workspaceId: string, signal: AbortSignal): Promise<void> {
  const queryKey = queryKeys.workTasks(workspaceId);
  const cached = loadedPages<TaskPage>(client, queryKey);
  if (!cached) return;
  const head = await fetchTasks(undefined, workspaceId, { limit: TASK_PAGE_SIZE, cursor: undefined, signal });
  if (signal.aborted) return;
  if (!sameTaskPage(cached.pages[0]!, head)) await client.invalidateQueries({ queryKey, exact: true });
}

async function checkRuns(client: QueryClient, workspaceId: string, signal: AbortSignal): Promise<void> {
  const queryKey = queryKeys.durableRunHistory(workspaceId);
  const cached = loadedPages<DurableRunHistoryPage>(client, queryKey);
  if (!cached) return;
  const head = await fetchDurableRunHistory({ workspaceId, limit: RUN_PAGE_SIZE, cursor: undefined }, { signal });
  if (signal.aborted) return;
  if (!sameRunPage(cached.pages[0]!, head) || hasUnfinishedOlderRun(cached))
    await client.invalidateQueries({ queryKey, exact: true });
}

/**
 * While the live connection is open, a list with several pages loaded is not refetched page by page on a timer.
 * This reads only its first page every WORK_HISTORY_FALLBACK_MS and refetches every loaded page when that page
 * differs (tasks are listed newest change first, so any change shows there) or a loaded older run may still change.
 */
export function useWorkHistoryHeadPoll(workspaceId: string): void {
  const client = useQueryClient();
  useEffect(() => {
    const controller = new AbortController();
    const timer = setInterval(() => {
      if (getEventStreamStatus().state !== "open") return;
      for (const check of [checkTasks, checkRuns]) {
        check(client, workspaceId, controller.signal).catch(() => {
          // A failed head read is not an error to show: the next tick or a realtime event reads again.
        });
      }
    }, WORK_HISTORY_FALLBACK_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [client, workspaceId]);
}
