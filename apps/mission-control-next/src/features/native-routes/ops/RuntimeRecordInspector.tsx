import { runtimeEventKey } from "./runtime-overview-model";
import { formatHumanSessionTitle, humanizeEventLabel, formatDateTime } from "./runtime-formatters";
import { ImprovementReportDetails } from "./ImprovementReportDetails";
import { RecordEvidence } from "../shared/RecordEvidence";
import { DetailInspector } from "../../../components/DetailInspector";
import { EmptyState, NativeButton, NoticeBanner } from "../primitives";
import { useOpsRuntimeSnapshot } from "@goatcitadel/mission-control-shared/hooks/useOpsRuntimeSnapshot";
import { type AppRoute } from "@next/app/route-model";
import type { NativeRoutePagesProps } from "../types";
import type { RuntimeInspection, RuntimePanelSetter } from "./runtime-panel-types";

export function RuntimeRecordInspector({
  inspection,
  setInspection,
  activeWorkspaceId,
  data,
  runtime,
  navigate,
  route,
  section,
  setReadNotifications,
  handleRunSchedule,
  handleCancelSchedule,
  scheduleBusy,
  schedulePendingCancelId,
  setSchedulePendingCancelId,
  scheduleNotice,
  scheduleLockedMessage,
}: {
  inspection: RuntimeInspection | null;
  setInspection: RuntimePanelSetter<RuntimeInspection | null>;
  activeWorkspaceId: string;
  data: ReturnType<typeof useOpsRuntimeSnapshot>["data"];
  runtime: Pick<ReturnType<typeof useOpsRuntimeSnapshot>, "isStale">;
  navigate: NativeRoutePagesProps["navigate"];
  route: NativeRoutePagesProps["route"];
  section: NonNullable<AppRoute["section"]>;
  setReadNotifications: RuntimePanelSetter<string[]>;
  handleRunSchedule: (jobId: string) => Promise<void>;
  handleCancelSchedule: (jobId: string, revision: number) => Promise<void>;
  scheduleBusy: { jobId: string; action: "run" | "cancel" } | null;
  schedulePendingCancelId: string | null;
  setSchedulePendingCancelId: RuntimePanelSetter<string | null>;
  scheduleNotice: { tone: "info" | "success" | "error"; message: string } | null;
  scheduleLockedMessage?: string;
}) {
  const inspectedSession =
    inspection?.kind === "session"
      ? (data?.sessions.length ? data.sessions : (data?.dashboard?.sessions ?? [])).find(
          (item) => item.sessionId === inspection.id,
        )
      : null;
  const inspectedEvent =
    inspection?.kind === "event"
      ? data?.timeline?.events?.items?.find((item) => runtimeEventKey(item) === inspection.id)
      : null;
  const inspectedJob =
    inspection?.kind === "schedule"
      ? data?.timeline?.scheduler?.jobs?.find((item) => item.jobId === inspection.id)
      : null;

  return (
    <DetailInspector
      open={Boolean(inspection && inspection.scope === activeWorkspaceId)}
      title={
        inspectedSession
          ? formatHumanSessionTitle(inspectedSession)
          : inspectedEvent
            ? humanizeEventLabel(inspectedEvent.eventType)
            : (inspectedJob?.name ?? "Record details")
      }
      onClose={() => setInspection(null)}
    >
      {runtime.isStale ? (
        <NoticeBanner tone="warning" message="This evidence is stale. Refresh to check the current state." />
      ) : null}
      {inspectedSession ? (
        <>
          <dl>
            <dt>Session</dt>
            <dd>{inspectedSession.sessionId}</dd>
            <dt>Channel</dt>
            <dd>{inspectedSession.channel}</dd>
            <dt>Last activity</dt>
            <dd>{formatDateTime(inspectedSession.lastActivityAt)}</dd>
          </dl>
          <NativeButton
            onClick={() => navigate({ area: "chat", sessionId: inspectedSession.sessionId, theme: route.theme })}
          >
            Open Chat
          </NativeButton>
          <details>
            <summary>Retained session fields</summary>
            <pre>{JSON.stringify(inspectedSession, null, 2)}</pre>
          </details>
        </>
      ) : null}
      {inspectedEvent ? (
        <>
          <p>Activity event detail: retained signal; this feed is not the complete historical record.</p>
          <dl>
            <dt>Event</dt>
            <dd>{inspectedEvent.eventId ?? "Unavailable"}</dd>
            <dt>Source</dt>
            <dd>{inspectedEvent.source || "unknown"}</dd>
            <dt>Class</dt>
            <dd>{inspectedEvent.eventClass || "unspecified"}</dd>
            <dt>Timestamp</dt>
            <dd>{formatDateTime(inspectedEvent.timestamp)}</dd>
          </dl>
          {section === "notifications" ? (
            <NativeButton
              variant="outline"
              onClick={() =>
                setReadNotifications((current) => current.filter((id) => id !== runtimeEventKey(inspectedEvent)))
              }
            >
              Mark unread
            </NativeButton>
          ) : null}
          <details>
            <summary>Retained event fields</summary>
            <pre>{JSON.stringify(inspectedEvent, null, 2)}</pre>
          </details>
        </>
      ) : null}
      {inspectedJob ? (
        <>
          {scheduleLockedMessage ? <NoticeBanner tone="warning" message={scheduleLockedMessage} /> : null}
          <p>Run now has no atomic configuration revision check. Its acknowledgement does not prove completion.</p>
          <dl>
            <dt>Schedule</dt>
            <dd>{inspectedJob.schedule}</dd>
            <dt>Action</dt>
            <dd>{inspectedJob.action}</dd>
            <dt>State</dt>
            <dd>{inspectedJob.enabled ? "Enabled" : "Disabled"}</dd>
            <dt>Next run</dt>
            <dd>{inspectedJob.nextRunAt ? formatDateTime(inspectedJob.nextRunAt) : "Not scheduled"}</dd>
            <dt>Last run</dt>
            <dd>{inspectedJob.lastRunStatus ?? "Unavailable"}</dd>
            <dt>Revision</dt>
            <dd>{inspectedJob.revision ?? "Unavailable"}</dd>
          </dl>
          {((item) => (
            <>
              <NativeButton
                variant="outline"
                onClick={() => void handleRunSchedule(item.jobId)}
                disabled={scheduleBusy !== null || Boolean(scheduleLockedMessage)}
                aria-label={`Run ${item.name} now`}
              >
                {scheduleBusy?.jobId === item.jobId && scheduleBusy.action === "run" ? "Running..." : "Run now"}
              </NativeButton>
              {schedulePendingCancelId === item.jobId ? (
                <>
                  <NativeButton
                    variant="destructive"
                    onClick={() => void handleCancelSchedule(item.jobId, item.revision)}
                    disabled={
                      scheduleBusy !== null || Boolean(scheduleLockedMessage) || !Number.isInteger(item.revision)
                    }
                    aria-label={`Confirm cancel ${item.name}`}
                  >
                    {scheduleBusy?.jobId === item.jobId && scheduleBusy.action === "cancel"
                      ? "Cancelling..."
                      : "Confirm cancel"}
                  </NativeButton>
                  <NativeButton
                    variant="ghost"
                    onClick={() => setSchedulePendingCancelId(null)}
                    disabled={scheduleBusy !== null}
                  >
                    Keep schedule
                  </NativeButton>
                </>
              ) : (
                <NativeButton
                  variant="outline"
                  onClick={() => setSchedulePendingCancelId(item.jobId)}
                  disabled={scheduleBusy !== null || Boolean(scheduleLockedMessage) || !Number.isInteger(item.revision)}
                  title={Number.isInteger(item.revision) ? undefined : "Canonical schedule revision unavailable"}
                  aria-label={`Cancel ${item.name}`}
                >
                  Cancel schedule
                </NativeButton>
              )}
            </>
          ))(inspectedJob)}
          {scheduleNotice ? <NoticeBanner tone={scheduleNotice.tone} message={scheduleNotice.message} /> : null}
          <details>
            <summary>Schedule evidence</summary>
            <pre>{JSON.stringify(inspectedJob, null, 2)}</pre>
          </details>
        </>
      ) : null}
      {inspection?.kind === "report" ? <ImprovementReportDetails key={inspection.id} reportId={inspection.id} /> : null}
      {inspection?.kind === "replay" ? (
        <RecordEvidence value={data?.timeline?.improvement?.replayRuns?.find((item) => item.runId === inspection.id)} />
      ) : null}
      {!inspectedSession &&
      !inspectedEvent &&
      !inspectedJob &&
      inspection?.kind !== "report" &&
      inspection?.kind !== "replay" ? (
        <EmptyState title="This record is unavailable in the current response." />
      ) : null}
    </DetailInspector>
  );
}
