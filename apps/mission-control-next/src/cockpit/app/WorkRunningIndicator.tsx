import { useId, useRef } from "react";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import { useQuery } from "@tanstack/react-query";
import type { DurableRunRecord } from "@goatcitadel/contracts";
import { fetchDurableRunHistory } from "@goatcitadel/mission-control-shared/api/durable";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { durableRunWorkspaceId } from "../data/durable-run-scope";
import { projectWorkBoard } from "../areas/work/work-board";

const STATUSES = new Set(["queued", "running", "waiting", "paused", "completed", "cancelled", "failed", "dead_lettered"]);
const unavailable = { state: "unknown", label: "Interactive Chat/plan work unavailable", count: null } as const;
function displayRun(value: unknown): value is DurableRunRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.runId === "string" && Boolean(row.runId.trim()) && typeof row.workflowKey === "string"
    && typeof row.status === "string" && STATUSES.has(row.status) && typeof row.updatedAt === "string"
    && Number.isFinite(Date.parse(row.updatedAt)) && Boolean(row.payload) && typeof row.payload === "object" && !Array.isArray(row.payload)
    && (row.metadata === undefined || (Boolean(row.metadata) && typeof row.metadata === "object" && !Array.isArray(row.metadata)));
}
/** A bounded display of canonical interactive durable work, not a global execution count. */
export function summarizeRecentRunningWork(page: unknown, workspaceId: string) {
  if (!page || typeof page !== "object" || !("items" in page) || !Array.isArray(page.items)
    || page.items.length > 100 || !page.items.every(displayRun)) return unavailable;
  const rows = page.items;
  if (new Set(rows.map(row => row.runId)).size !== rows.length || rows.some(row => durableRunWorkspaceId(row) !== workspaceId)) return unavailable;
  const running = projectWorkBoard(rows, workspaceId).running.length;
  const partial = "nextCursor" in page && page.nextCursor !== undefined;
  if (partial && (typeof page.nextCursor !== "string" || !page.nextCursor)) return unavailable;
  if (running) return { state: "running", count: running, label: `${partial ? "At least " : ""}${running} queued or running interactive Chat/plan ${running === 1 ? "record" : "records"}${partial ? " in recent history" : ""}` };
  if (partial) return { state: "unknown", count: null, label: "Interactive Chat/plan work outside the recent history window is unknown" };
  return { state: "none", count: 0, label: "No queued or running interactive Chat/plan work recorded" };
}

/** `overlay` pins the dot to the icon's corner on the collapsed rail so it never squeezes the icon. */
export function WorkRunningIndicator({ workspaceId, overlay = false }: { workspaceId: string; overlay?: boolean }) {
  const installation = getGatewayApiBaseUrl();
  const visible = useMediaQuery("(min-width: 640px)");
  const instance = useId();
  const identity = JSON.stringify([installation, workspaceId, visible]);
  const view = useRef({ identity, generation: 0 });
  if (view.current.identity !== identity) view.current = { identity, generation: view.current.generation + 1 };
  const renderedView = view.current;
  const query = useQuery({ queryKey: ["tasks", "sidebar-recent-work", installation, workspaceId, instance, renderedView.generation],
    queryFn: async ({ signal }) => {
      const page = await fetchDurableRunHistory({ workspaceId, limit: 100 }, { signal });
      if (signal.aborted || view.current !== renderedView || getGatewayApiBaseUrl() !== installation)
        throw new Error("The running-work view is no longer current.");
      return page;
    }, enabled: visible && Boolean(workspaceId), staleTime: 30_000, gcTime: 0, refetchOnMount: "always" });
  const summary = visible && !query.isError && !query.isFetching && !query.isStale && getGatewayApiBaseUrl() === installation
    ? summarizeRecentRunningWork(query.data, workspaceId) : unavailable;
  return <span id="cockpit-work-running-summary" data-work-running={summary.state} title={summary.label}
    className={overlay ? "absolute right-1 top-1 inline-flex items-center" : "ml-auto inline-flex items-center"}>
    <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${summary.state === "running" ? "bg-status-running" : "bg-status-neutral"}`} />
    <span className="sr-only">{summary.label}</span>
  </span>;
}
