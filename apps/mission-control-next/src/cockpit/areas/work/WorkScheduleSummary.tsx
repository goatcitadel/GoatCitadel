import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import type { ScheduleAction } from "../../../features/native-routes/ops/schedule-operation";
import type { CronJobRecordResponse } from "@goatcitadel/mission-control-shared/api/types";
import { Button } from "../../ui/Button";
import { scheduleCadence, scheduleTimezoneSummary } from "./schedule-cadence";

export function formattedTime(iso: string | undefined): string {
  if (!iso) return "Not reported by the Gateway";
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed)
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(parsed)
    : "Time unavailable";
}

export function WorkScheduleListItem({ job, onReview }: { job: CronJobRecordResponse; onReview: () => void }) {
  return (
    <li className="rounded-lg border border-line bg-raised p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-fg">{job.name}</h2>
          <p className="mt-1 text-xs text-fg-muted">{humanizeToken(job.action)}</p>
        </div>
        <span className="rounded-full border border-line px-2 py-0.5 text-xs text-fg-secondary">
          {job.enabled ? "Enabled" : "Paused"}
        </span>
      </div>
      <p className="mt-2 text-sm text-fg-secondary">
        {scheduleCadence(job.schedule)} · {scheduleTimezoneSummary(job.schedule)}
        <br />
        Next run: {job.enabled ? formattedTime(job.nextRunAt) : "Paused"}
      </p>
      <p className="mt-2 text-sm text-fg-secondary">
        Last outcome:{" "}
        {job.lastRunStatus === "failed" ? "Failed" : job.lastRunStatus === "ok" ? "Succeeded" : "Not reported"}
        {job.failureCount ? ` · ${job.failureCount} recorded failures` : ""}
        {job.backoffUntil ? ` · Backoff until ${formattedTime(job.backoffUntil)}` : ""}
      </p>
      <Button size="sm" className="mt-2" aria-label={"Review " + job.name} onClick={onReview}>
        Review schedule
      </Button>
    </li>
  );
}

export function WorkScheduleRecordDetails({ selected }: { selected: CronJobRecordResponse }) {
  return (
    <>
      <dl className="grid gap-2 text-sm">
        <div>
          <dt className="text-fg-muted">Schedule</dt>
          <dd className="break-all text-fg">
            {scheduleCadence(selected.schedule)} · <span className="font-mono">{selected.schedule}</span>
          </dd>
        </div>
        <div>
          <dt className="text-fg-muted">Next run</dt>
          <dd className="text-fg">{selected.enabled ? formattedTime(selected.nextRunAt) : "Paused"}</dd>
        </div>
        <div>
          <dt className="text-fg-muted">Last run</dt>
          <dd className="text-fg">{formattedTime(selected.lastRunAt)}</dd>
        </div>
        {selected.lastRunEvidenceEnvelopeId ? (
          <div>
            <dt className="text-fg-muted">Last run evidence</dt>
            <dd className="break-all font-mono text-fg">{selected.lastRunEvidenceEnvelopeId}</dd>
          </div>
        ) : null}
      </dl>
      {selected.lastRunStatus === "failed" ? (
        <p role="alert" className="text-sm text-status-failed">
          Last scheduled run failed. {selected.lastRunOutput || "The Gateway did not report a failure reason."}
        </p>
      ) : null}
      <p className="text-sm text-fg-secondary">
        Gateway-wide · Action: {humanizeToken(selected.action)}. Destination: {selected.workdir || "Not reported"}.{" "}
        {scheduleTimezoneSummary(selected.schedule)} Displayed dates use your browser timezone.
      </p>
    </>
  );
}

export function WorkScheduleActionButtons({
  enabled,
  disabled,
  onReview,
}: {
  enabled: boolean;
  disabled: boolean;
  onReview: (action: ScheduleAction) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={disabled} onClick={() => onReview("run")}>
        Run now
      </Button>
      <Button size="sm" disabled={disabled} onClick={() => onReview(enabled ? "pause" : "resume")}>
        {enabled ? "Pause" : "Resume"}
      </Button>
      <Button size="sm" variant="danger" disabled={disabled} onClick={() => onReview("cancel")}>
        Delete schedule…
      </Button>
    </div>
  );
}
