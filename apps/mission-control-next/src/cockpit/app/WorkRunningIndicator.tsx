import { useQuery } from "@tanstack/react-query";
import type { DurableRunRecord } from "@goatcitadel/contracts";
import { fetchDurableRunHistory } from "@goatcitadel/mission-control-shared/api/durable";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { durableRunWorkspaceId } from "../data/durable-run-scope";
import { recordTime, recordView } from "../data/record-view";
import { projectWorkBoard } from "../areas/work/work-board";

const STATUSES = new Set([
  "queued",
  "running",
  "waiting",
  "paused",
  "completed",
  "cancelled",
  "failed",
  "dead_lettered",
]);
const unavailable = { state: "unknown", label: "Interactive Chat/plan work unavailable", count: null } as const;
function displayRun(value: unknown): value is DurableRunRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.runId === "string" &&
    Boolean(row.runId.trim()) &&
    typeof row.workflowKey === "string" &&
    typeof row.status === "string" &&
    STATUSES.has(row.status) &&
    typeof row.updatedAt === "string" &&
    Number.isFinite(Date.parse(row.updatedAt)) &&
    Boolean(row.payload) &&
    typeof row.payload === "object" &&
    !Array.isArray(row.payload) &&
    (row.metadata === undefined ||
      (Boolean(row.metadata) && typeof row.metadata === "object" && !Array.isArray(row.metadata)))
  );
}
/** A bounded display of canonical interactive durable work, not a global execution count. */
export function summarizeRecentRunningWork(page: unknown, workspaceId: string) {
  if (
    !page ||
    typeof page !== "object" ||
    !("items" in page) ||
    !Array.isArray(page.items) ||
    page.items.length > 100 ||
    !page.items.every(displayRun)
  )
    return unavailable;
  const rows = page.items;
  if (
    new Set(rows.map((row) => row.runId)).size !== rows.length ||
    rows.some((row) => durableRunWorkspaceId(row) !== workspaceId)
  )
    return unavailable;
  const running = projectWorkBoard(rows, workspaceId).running.length;
  const partial = "nextCursor" in page && page.nextCursor !== undefined;
  if (partial && (typeof page.nextCursor !== "string" || !page.nextCursor)) return unavailable;
  if (running)
    return {
      state: "running",
      count: running,
      label: `${partial ? "At least " : ""}${running} queued or running interactive Chat/plan ${running === 1 ? "record" : "records"}${partial ? " in recent history" : ""}`,
    };
  if (partial)
    return {
      state: "unknown",
      count: null,
      label: "Interactive Chat/plan work outside the recent history window is unknown",
    };
  return { state: "none", count: 0, label: "No queued or running interactive Chat/plan work recorded" };
}

const DOT_CLASS = {
  running: "bg-status-running animate-pulse-live",
  unknown: "border border-status-neutral bg-transparent",
} as const;

/**
 * One shared read per installation and workspace. It keeps the last good summary while it is read
 * again or after a failed read (NV-19), and polls only while work is running; events refresh it otherwise.
 * It reads whenever it is rendered: the shell renders it in the sidebar or, on phones, in the Work tab.
 * `overlay` pins the dot to the icon's corner on the collapsed rail so it never squeezes the icon;
 * `showCount` shows the running count instead of a dot (the phone Work tab).
 */
export function WorkRunningIndicator({
  workspaceId,
  overlay = false,
  showCount = false,
}: {
  workspaceId: string;
  overlay?: boolean;
  showCount?: boolean;
}) {
  const installation = getGatewayApiBaseUrl();
  const query = useQuery({
    queryKey: ["tasks", "sidebar-recent-work", installation, workspaceId],
    queryFn: async ({ signal }) => {
      const page = await fetchDurableRunHistory({ workspaceId, limit: 100 }, { signal });
      if (signal.aborted || getGatewayApiBaseUrl() !== installation)
        throw new Error("The running-work view is no longer current.");
      return page;
    },
    enabled: Boolean(workspaceId),
    staleTime: 30_000,
    refetchInterval: (current) =>
      summarizeRecentRunningWork(current.state.data, workspaceId).state === "running" ? 30_000 : false,
  });
  const view = recordView(query, (page) => summarizeRecentRunningWork(page, workspaceId));
  const summary = getGatewayApiBaseUrl() === installation ? (view.record ?? unavailable) : unavailable;
  const stale = summary !== unavailable && (view.stale || query.isStale) && view.checkedAt !== undefined;
  const title = stale ? `${summary.label} · as of ${recordTime(view.checkedAt!)}` : summary.label;
  return (
    <span
      id="cockpit-work-running-summary"
      data-work-running={summary.state}
      title={title}
      className={overlay ? "absolute right-1 top-1 inline-flex items-center" : "ml-auto inline-flex items-center"}
    >
      {showCount && summary.state === "running" && summary.count ? (
        <span
          aria-hidden="true"
          className="min-w-4 rounded-full border border-status-running bg-raised px-0.5 text-center text-xs font-semibold text-fg"
        >
          {summary.count}
        </span>
      ) : summary.state !== "none" ? (
        <span
          aria-hidden="true"
          className={`size-2 shrink-0 rounded-full ${summary.state === "running" ? DOT_CLASS.running : DOT_CLASS.unknown}`}
        />
      ) : null}
      <span className="sr-only">{title}</span>
    </span>
  );
}
