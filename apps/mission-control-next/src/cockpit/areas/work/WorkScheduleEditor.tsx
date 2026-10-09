import { useState } from "react";
import { UnattributedDraftRecovery } from "./UnattributedDraftRecovery";
import type { CronJobRecordResponse } from "@goatcitadel/mission-control-shared/api/types";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { useScheduleOperations } from "../../../features/native-routes/ops/use-schedule-operations";
import { sameScheduleReview } from "../../../features/native-routes/ops/schedule-operation";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { Dialog } from "../../ui/Dialog";
import { ScheduleAdvancedFields, scheduleSettingsInput } from "./ScheduleAdvancedFields";
import { CRON_ACTION_OPTIONS } from "../../../features/native-routes/ops/runtime-schedule-model";
import { scheduleTimezoneSummary } from "./schedule-cadence";
import { ScheduleTiming } from "./ScheduleTiming";

export function WorkScheduleEditor({
  job,
  available,
  onSaved,
}: {
  job: CronJobRecordResponse;
  available: boolean;
  onSaved: () => void;
}) {
  const fromJob = (record: CronJobRecordResponse) => ({
    base: record,
    name: record.name,
    schedule: record.schedule,
    description: record.description ?? "",
    action: record.action,
    endAt: record.endAt ?? "",
    workdir: record.workdir ?? "",
    contextFrom: record.contextFrom ?? "",
    actionConfig: record.actionConfig ? JSON.stringify(record.actionConfig, null, 2) : "",
  });
  const empty = fromJob(job);
  const editor = useSessionDraft(
    `schedule-edit:${getGatewayApiBaseUrl()}:${job.jobId}`,
    empty,
    job.revision,
    { label: "Schedule settings" },
  );
  const draft = editor.value;
  const [review, setReview] = useState<{ value: typeof draft; expires: number } | null>(null);
  const [notice, setNotice] = useState("");
  const operations = useScheduleOperations(JSON.stringify([job.jobId, draft, review]));
  const locked = operations.locked(job.jobId);
  const attempt = operations.attempt(job.jobId);
  const feedback = notice || operations.message || attempt?.message;
  const feedbackFailed = Boolean(notice || operations.message || attempt?.phase === "uncertain");
  const stale = !sameScheduleReview(draft.base, job);
  async function save() {
    if (!review || !available || stale || Date.now() > review.expires) {
      setReview(null);
      setNotice(
        "Review expired or current schedule access changed. Your draft remains available; review it again before saving.",
      );
      return;
    }
    let settings: ReturnType<typeof scheduleSettingsInput>;
    try {
      settings = scheduleSettingsInput(
        review.value,
        review.value.action,
        review.value.base.action === review.value.action
          ? review.value.base.actionConfig
          : undefined,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Invalid advanced settings.");
      return;
    }
    const receipt = await operations.execute({
      kind: "edit",
      job: review.value.base,
      input: {
        ...settings,
        name: review.value.name.trim(),
        schedule: review.value.schedule.trim(),
        description: review.value.description,
        action: review.value.action,
        endAt: settings.endAt ?? null,
        workdir: settings.workdir ?? null,
        contextFrom: settings.contextFrom ?? null,
        actionConfig: settings.actionConfig ?? null,
      },
    });
    if (receipt?.kind === "edit") {
      editor.acceptSaved(fromJob(receipt.job), receipt.job.revision, review.value);
      setReview(null);
      onSaved();
    }
  }
  return (
    <section aria-label="Edit schedule" className="grid gap-3 rounded-md border border-line p-3">
      <h3 className="font-medium text-fg">Edit schedule</h3>
      <UnattributedDraftRecovery editor={editor} />
      <p className="text-sm text-fg-secondary">
        Gateway-wide configuration. Changing timing affects future runs; it does not prove any run
        executed.
      </p>
      <Field label="Schedule name">
        {(props) => (
          <input
            {...props}
            className="w-full rounded-md border border-line bg-sunken p-2 text-fg"
            value={draft.name}
            disabled={locked}
            onChange={(event) => {
              operations.invalidate();
              setReview(null);
              editor.setValue((current) => ({ ...current, name: event.target.value }));
            }}
          />
        )}
      </Field>
      <ScheduleTiming
        value={draft.schedule}
        disabled={locked}
        onChange={(schedule) => {
          operations.invalidate();
          setReview(null);
          editor.setValue((current) => ({ ...current, schedule }));
        }}
      />
      <Field label="Scheduled action">
        {(props) => (
          <select
            {...props}
            value={draft.action}
            disabled={locked}
            onChange={(event) => {
              operations.invalidate();
              setReview(null);
              editor.setValue((current) => ({
                ...current,
                action: event.target.value as CronJobRecordResponse["action"],
              }));
            }}
            className="rounded-md border border-line bg-sunken p-2"
          >
            {[...new Set([job.action, ...CRON_ACTION_OPTIONS])].map((action) => (
              <option key={action} value={action}>
                {action}
              </option>
            ))}
          </select>
        )}
      </Field>
      <ScheduleAdvancedFields
        value={draft}
        locked={locked}
        onChange={(key, value) => {
          operations.invalidate();
          setReview(null);
          editor.setValue((current) => ({ ...current, [key]: value }));
        }}
      />
      {stale ? (
        <p role="alert">
          This schedule changed. Your draft is preserved. Review the latest settings and explicitly
          rebase your draft before saving.
        </p>
      ) : null}
      {stale ? (
        <Button
          disabled={locked || !available}
          onClick={() => {
            operations.invalidate();
            editor.setValue((current) => ({ ...current, base: job }));
          }}
        >
          Use current revision with my draft
        </Button>
      ) : null}
      {!review && feedback ? <p role={feedbackFailed ? "alert" : "status"}>{feedback}</p> : null}
      <Button
        disabled={!available || stale || locked || !draft.name.trim() || !draft.schedule.trim()}
        onClick={() => { setNotice(""); setReview({ value: structuredClone(draft), expires: Date.now() + 60_000 }); }}
      >
        Review schedule changes
      </Button>
      <Dialog
        open={Boolean(review)}
        onOpenChange={(open) => {
          if (!open) {
            operations.invalidate();
            setReview(null);
          }
        }}
        title="Save schedule changes?"
        description="The Gateway will check the current revision before saving this configuration."
      >
        {review ? (
          <div className="grid gap-3 text-sm">
            {feedback ? <p role={feedbackFailed ? "alert" : "status"}>{feedback}</p> : null}
            <p>
              Gateway-wide · {review.value.name} · {review.value.schedule}
            </p>
            <p>
              Action: {review.value.action}. Destination: {review.value.workdir || "Not specified"}.
              Context: {review.value.contextFrom || "Not specified"}. End:{" "}
              {review.value.endAt || "No end date"}. {scheduleTimezoneSummary(review.value.schedule)}
              Displayed dates use your browser timezone. Review expires after one minute.
            </p>
            <p className="break-words">
              Description: {review.value.description || "None"}. Action configuration:{" "}
              {review.value.actionConfig || "None"}
            </p>
            <Button
              variant="primary"
              disabled={!available || locked || stale}
              onClick={() => void save()}
            >
              Save schedule changes
            </Button>
            <Button
              disabled={locked}
              onClick={() => {
                operations.invalidate();
                setReview(null);
              }}
            >
              Keep editing
            </Button>
          </div>
        ) : null}
      </Dialog>
    </section>
  );
}
