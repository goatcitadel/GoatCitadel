import { plural } from "@goatcitadel/mission-control-shared/content/format";
import type { ScheduleAction } from "../../../features/native-routes/ops/schedule-operation";
import type { CronJobRecordResponse } from "@goatcitadel/mission-control-shared/api/types";
import { Button } from "../../ui/Button";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { TimeText } from "../../ui/TimeText";
import { scheduleCadence, scheduleTimezoneSummary } from "./schedule-cadence";
import { presentScheduleAction, presentScheduleReason } from "./work-vocabulary";

/** A Gateway-reported schedule time, or a plain gap when the Gateway sent none. */
export function ScheduleTime({ value }: { value: string | undefined }) {
  return value ? <TimeText value={value} /> : <>Not reported by the Gateway</>;
}

const FAILED_FALLBACK = "The last run failed.";

/** Parses the Gateway-authored last run output; absent or malformed output yields undefined. */
function readLastRunOutput(job: CronJobRecordResponse): Record<string, unknown> | undefined {
  if (!job.lastRunOutput) return undefined;
  try {
    const parsed: unknown = JSON.parse(job.lastRunOutput);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function looksLikeJson(value: string): boolean {
  return /^\s*[[{"]/u.test(value);
}

export function lastRunOutcomeLabel(job: CronJobRecordResponse): string {
  if (job.lastRunStatus === "failed") return "Failed";
  if (job.lastRunStatus === "skipped") return "Skipped (no work done)";
  if (job.lastRunStatus === "ok") {
    return readLastRunOutput(job)?.result === "partial" ? "Partially completed" : "Succeeded";
  }
  return "Not reported";
}

export function lastRunSkipReason(job: CronJobRecordResponse): string | undefined {
  if (job.lastRunStatus !== "skipped") return undefined;
  return readNonEmptyString(readLastRunOutput(job)?.skipReason);
}

/** Present when a cleanly settled run stopped before finishing all of its work. */
export function lastRunPartial(job: CronJobRecordResponse): { reason?: string } | undefined {
  if (job.lastRunStatus !== "ok") return undefined;
  const output = readLastRunOutput(job);
  return output?.result === "partial" ? { reason: readNonEmptyString(output.partialReason) } : undefined;
}

/**
 * A human reason for a failed last run: the output's error or message field, plain text output as written, or a
 * plain fallback. The raw output belongs in technical details, never in the alert itself.
 */
export function lastRunFailureReason(job: CronJobRecordResponse): string {
  const output = readLastRunOutput(job);
  if (output) {
    const error = output.error;
    const nested = typeof error === "object" && error !== null ? (error as Record<string, unknown>).message : undefined;
    return (
      readNonEmptyString(error) ??
      readNonEmptyString(nested) ??
      readNonEmptyString(output.message) ??
      readNonEmptyString(output.failureMessage) ??
      readNonEmptyString(output.reason) ??
      FAILED_FALLBACK
    );
  }
  const text = readNonEmptyString(job.lastRunOutput);
  return text && !looksLikeJson(text) ? text : FAILED_FALLBACK;
}

/** The page notice; a run request links to its run page when the Gateway names one. */
export function WorkScheduleNotice({ message, runHref }: { message: string; runHref?: string }) {
  return (
    <p role="status" className="rounded-md border border-line bg-raised p-3 text-sm text-fg-secondary">
      {message}
      {runHref ? (
        <>
          {" "}
          <NativeOwnerLink href={runHref} scope={runHref} className="font-medium text-accent">
            Open run
          </NativeOwnerLink>
        </>
      ) : null}
    </p>
  );
}

export function WorkScheduleListItem({
  job,
  selected = false,
  onReview,
}: {
  job: CronJobRecordResponse;
  /** The schedule shown in the detail pane: marked in words and by a stronger border, never by colour alone. */
  selected?: boolean;
  onReview: () => void;
}) {
  return (
    <li
      aria-current={selected ? "true" : undefined}
      className="rounded-lg border border-line bg-raised p-4 aria-[current=true]:border-accent"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-fg">{job.name}</h2>
          <p className="mt-1 text-xs text-fg-muted">{presentScheduleAction(job.action)}</p>
        </div>
        <span className="rounded-full border border-line px-2 py-0.5 text-xs text-fg-secondary">
          {job.enabled ? "Enabled" : "Paused"}
        </span>
      </div>
      <p className="mt-2 text-sm text-fg-secondary">
        <span title={job.schedule}>{scheduleCadence(job.schedule)}</span> · {scheduleTimezoneSummary(job.schedule)}
        <br />
        Next run: {job.enabled ? <ScheduleTime value={job.nextRunAt} /> : "Paused"}
      </p>
      <p className="mt-2 text-sm text-fg-secondary">
        Last outcome: {lastRunOutcomeLabel(job)}
        {job.failureCount ? ` · ${plural(job.failureCount, "recorded failure")}` : ""}
        {job.backoffUntil ? (
          <>
            {" · Backoff until "}
            <ScheduleTime value={job.backoffUntil} />
          </>
        ) : null}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" aria-label={"Review schedule: " + job.name} onClick={onReview}>
          Review schedule
        </Button>
        {selected ? <span className="text-xs font-medium text-fg-secondary">Shown in detail</span> : null}
      </div>
    </li>
  );
}

export function WorkScheduleRecordDetails({ selected }: { selected: CronJobRecordResponse }) {
  const skipReason = lastRunSkipReason(selected);
  const partial = lastRunPartial(selected);
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
          <dd className="text-fg">{selected.enabled ? <ScheduleTime value={selected.nextRunAt} /> : "Paused"}</dd>
        </div>
        <div>
          <dt className="text-fg-muted">Last run</dt>
          <dd className="text-fg">
            <ScheduleTime value={selected.lastRunAt} />
          </dd>
        </div>
        {selected.lastRunEvidenceEnvelopeId ? (
          <div>
            <dt className="text-fg-muted">Last run evidence</dt>
            <dd className="text-fg">Signed evidence recorded</dd>
          </div>
        ) : null}
      </dl>
      {selected.lastRunStatus === "failed" ? (
        <p role="alert" className="text-sm text-status-failed">
          Last scheduled run failed. {lastRunFailureReason(selected)}
        </p>
      ) : null}
      {selected.lastRunStatus === "skipped" ? (
        <p className="text-sm text-status-waiting">
          Last run was skipped and did no work.{" "}
          {skipReason ? `Reason: ${presentScheduleReason(skipReason)}.` : "The Gateway did not report a skip reason."}
        </p>
      ) : null}
      {partial ? (
        <p className="text-sm text-status-waiting">
          Last run stopped before finishing all of its work; the work it did is kept.{" "}
          {partial.reason
            ? `Reason: ${presentScheduleReason(partial.reason)}.`
            : "The Gateway did not report why it stopped."}
        </p>
      ) : null}
      <p className="text-sm text-fg-secondary">
        Gateway-wide · Action: {presentScheduleAction(selected.action)}. Destination:{" "}
        {selected.workdir || "Not reported"}. {scheduleTimezoneSummary(selected.schedule)} Displayed dates use your
        browser timezone.
      </p>
      {selected.lastRunOutput || selected.lastRunEvidenceEnvelopeId ? (
        <TechnicalDetails label="Last run technical details">
          <dl className="grid gap-2 font-mono text-xs">
            {selected.lastRunEvidenceEnvelopeId ? (
              <div>
                <dt>Evidence envelope</dt>
                <dd className="break-all">{selected.lastRunEvidenceEnvelopeId}</dd>
              </div>
            ) : null}
            {selected.lastRunOutput ? (
              <div>
                <dt>Last run output</dt>
                <dd className="whitespace-pre-wrap break-all">{selected.lastRunOutput}</dd>
              </div>
            ) : null}
          </dl>
        </TechnicalDetails>
      ) : null}
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
