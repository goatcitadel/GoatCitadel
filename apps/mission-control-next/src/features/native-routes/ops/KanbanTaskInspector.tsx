import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { useState } from "react";
import type { AgenticRunListItem } from "@goatcitadel/contracts";
import { fetchTaskActivities, fetchTaskDeliverables } from "@goatcitadel/mission-control-shared/api/tasks";
import { NativeList } from "../NativeRoutePageLayout";
import { NativeButton } from "../primitives";
import { nativeLoad, nativeLoadIssues, useAsyncLoad, formatDateTime } from "../shared/native-helpers";
import { LibraryLoadWarnings } from "../shared/library-primitives";
import type { NativeRoutePagesProps } from "../types";
export function KanbanTaskInspector({
  run,
  task,
  ...props
}: NativeRoutePagesProps & { run?: AgenticRunListItem; task?: TaskRecord }) {
  const [view, setView] = useState<"task" | "deliverables" | "history">("task");
  const id = task?.taskId ?? run?.taskId;
  const detail = useAsyncLoad(async () => {
    if (!id || view === "task") return { issues: [], rows: [] };
    if (view === "deliverables") {
      const result = await nativeLoad(
        "Task deliverables",
        fetchTaskDeliverables(id, props.activeWorkspaceId, props.activeCitadelId),
        { items: [] },
      );
      return {
        issues: nativeLoadIssues([result]),
        rows: result.data.items.map((item) => ({
          title: item.title,
          meta: item.deliverableType,
          body: [item.path, item.description].filter(Boolean).join(" · "),
        })),
      };
    }
    const result = await nativeLoad(
      "Task history",
      fetchTaskActivities(id, props.activeWorkspaceId, props.activeCitadelId),
      { items: [] },
    );
    return {
      issues: nativeLoadIssues([result]),
      rows: result.data.items.map((item) => ({
        title: item.message,
        meta: [item.activityType, formatDateTime(item.createdAt)].join(" · "),
      })),
    };
  }, [id, view, props.activeWorkspaceId, props.activeCitadelId]);
  if (!id) return <p>The selected task is unavailable. Refresh the board before choosing another record.</p>;
  const sessionId = run?.parentSessionId ?? task?.proactiveContext?.sessionId;
  return (
    <>
      <div className="mc-next-settings-filter-bar" role="group" aria-label="Task detail views">
        {(["task", "deliverables", "history"] as const).map((tab) => (
          <NativeButton key={tab} variant="ghost" aria-pressed={view === tab} onClick={() => setView(tab)}>
            {tab === "task" ? "Task" : tab === "deliverables" ? "Deliverables" : "History"}
          </NativeButton>
        ))}
      </div>
      {view === "task" ? (
        <>
          <p>{task?.description ?? run?.summary ?? "No description recorded."}</p>
          <dl className="mc-next-worker-record">
            {[
              ["Task", id],
              ["Task status", task?.status ?? run?.taskStatus ?? "Unavailable"],
              ["Revision", task?.revision ?? run?.taskRevision ?? "Unavailable"],
              ["Owner", task?.assignedAgentId ?? "Not reported"],
              ["Priority", task?.priority ?? "Not reported"],
              ["Run", run?.runId ?? task?.agenticContext?.runId ?? "No run attached"],
              ["Run state", run?.status ?? task?.agenticContext?.status ?? "Not reported"],
              ["Context", run?.contextMode ?? "Not reported"],
              ["Profile", run?.profileId ?? "Not reported"],
              ["Updated", task?.updatedAt ?? run?.updatedAt ?? "Unavailable"],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <NativeList
            items={(run?.diagnostics ?? []).map((item) => ({
              title: item.title,
              meta: item.severity + (item.resolvedAt ? " · resolved" : ""),
              body: item.summary,
            }))}
            emptyLabel="No diagnostics were returned."
          />
          {sessionId ? (
            <NativeButton onClick={() => props.navigate({ area: "chat", sessionId, theme: props.route.theme })}>
              Open in Chat
            </NativeButton>
          ) : (
            <p>No linked Chat session is recorded.</p>
          )}
          {run?.runId ? (
            <NativeButton
              variant="outline"
              onClick={() =>
                props.navigate({
                  area: "ops",
                  section: "sessions",
                  view: "run-detail",
                  runId: run.runId,
                  theme: props.route.theme,
                })
              }
            >
              Run evidence
            </NativeButton>
          ) : null}
        </>
      ) : (
        <>
          <LibraryLoadWarnings issues={detail.data?.issues ?? []} onRetry={detail.reload} />
          {detail.loading ? (
            <p role="status">Loading {view}…</p>
          ) : (
            <NativeList
              items={detail.data?.rows ?? []}
              emptyLabel={detail.data?.issues.length ? "This source is unavailable." : "No records returned."}
              virtualized
              maxHeight="min(65vh, 40rem)"
            />
          )}
        </>
      )}
    </>
  );
}
