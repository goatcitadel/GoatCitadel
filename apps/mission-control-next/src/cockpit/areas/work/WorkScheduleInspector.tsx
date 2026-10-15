import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { WorkScheduleActionButtons, WorkScheduleRecordDetails, formattedTime } from "./WorkScheduleSummary";
import { WorkScheduleEditor } from "./WorkScheduleEditor";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { scheduleTimezoneSummary } from "./schedule-cadence";
import type { Dispatch, SetStateAction } from "react";
import type { CronJobRecordResponse } from "@goatcitadel/mission-control-shared/api/types";
import type { ScheduleAction } from "../../../features/native-routes/ops/schedule-operation";
import type { useScheduleOperations } from "../../../features/native-routes/ops/use-schedule-operations";

interface WorkScheduleInspectorProps {
  selected: CronJobRecordResponse;
  detail: { isFetching: boolean };
  actionLocked: boolean;
  busy: boolean;
  selectedAttempt: ReturnType<ReturnType<typeof useScheduleOperations>["attempt"]>;
  setNotice: Dispatch<SetStateAction<string | null>>;
  refresh: () => Promise<void>;
  pending: ScheduleAction | null;
  operations: Pick<ReturnType<typeof useScheduleOperations>, "invalidate">;
  setPending: Dispatch<SetStateAction<ScheduleAction | null>>;
  reviewMessage: string | undefined;
  reviewSnapshot: CronJobRecordResponse | undefined;
  reviewChanged: boolean;
  applyAction: () => Promise<void>;
  reviewAction: (action: ScheduleAction) => void;
  selectedRecoveryHref: string;
  activeWorkspaceId: string | null | undefined;
}

/** Presentation only. Selection, admission, expiry, receipts and unknown locks stay in WorkSchedules. */
export function WorkScheduleInspector({
  selected,
  detail,
  actionLocked,
  busy,
  selectedAttempt,
  setNotice,
  refresh,
  pending,
  operations,
  setPending,
  reviewMessage,
  reviewSnapshot,
  reviewChanged,
  applyAction,
  reviewAction,
  selectedRecoveryHref,
  activeWorkspaceId,
}: WorkScheduleInspectorProps) {
  return (
    <div className="grid gap-3 rounded-lg border border-line bg-raised p-4">
      {detail.isFetching ? (
        <p role="status" className="text-sm text-fg-secondary">
          Checking current schedule access. Controls wait for the authorized read.
        </p>
      ) : null}
      <div>
        <h2 className="font-display text-md font-semibold text-fg">{selected.name}</h2>
        <p className="text-xs text-fg-muted">
          {selected.enabled ? "Enabled" : "Paused"} · {humanizeToken(selected.action)}
        </p>
      </div>
      {selected.description ? <p className="text-sm text-fg-secondary">{selected.description}</p> : null}
      <WorkScheduleRecordDetails selected={selected} />
      <WorkScheduleEditor
        key={selected.jobId}
        job={selected}
        available={!actionLocked && !busy}
        onSaved={() => {
          setNotice("Schedule settings saved and independently verified. Execution has not been verified.");
          void refresh();
        }}
      />
      {actionLocked ? (
        <p role="alert" className="text-sm text-status-failed">
          {selectedAttempt?.message}
        </p>
      ) : null}
      {pending ? (
        <Dialog
          open={true}
          title="Review schedule action"
          description="Gateway-wide action. The current revision is rechecked before persistence; review expires after one minute."
          onOpenChange={(open) => {
            if (!open) {
              operations.invalidate();
              setPending(null);
            }
          }}
        >
          {reviewMessage || selectedAttempt?.message ? (
            <p
              role={reviewMessage || selectedAttempt?.phase === "uncertain" ? "alert" : "status"}
              className="mb-3 text-sm text-fg-secondary"
            >
              {reviewMessage ?? selectedAttempt?.message}
            </p>
          ) : null}
          <p className="mb-3 text-sm text-fg-secondary">
            {reviewSnapshot?.name}
            {" · "}
            {reviewSnapshot?.schedule}
            {" · "}
            {humanizeToken(reviewSnapshot?.action ?? "unknown")}
            {". Destination: "}
            {reviewSnapshot?.workdir || "Not reported"}
            {". Next run: "}
            {formattedTime(reviewSnapshot?.nextRunAt)}
            {". "}
            {scheduleTimezoneSummary(reviewSnapshot?.schedule ?? "")}
            {" Displayed dates use your browser timezone."}
          </p>
          <p className="mb-3 text-sm text-fg-secondary">
            {pending === "pause"
              ? "Pause stops future occurrences; it does not cancel a running job."
              : pending === "resume"
                ? "Resume enables future recurring occurrences."
                : pending === "run"
                  ? "Run now submits the saved action configuration immediately. Gateway policy and approval gates still apply."
                  : "Delete permanently removes the schedule and stops future occurrences."}
          </p>
          <p className="text-sm text-fg">
            {pending === "cancel"
              ? `Delete “${reviewSnapshot?.name}”? Future runs stop and it can't be restored.`
              : `${pending === "run" ? "Run now" : pending === "pause" ? "Pause" : "Resume"} this schedule? The Gateway will recheck its current record before the request.`}
          </p>
          {pending === "run" ? (
            <p className="text-xs text-fg-muted">
              Run now has no atomic configuration revision check. Acknowledgement confirms a request; inspect the
              recorded run for execution results.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant={pending === "cancel" ? "danger" : "primary"}
              disabled={busy || actionLocked || reviewChanged}
              onClick={() => void applyAction()}
            >
              {pending === "cancel" ? "Delete schedule" : `Confirm ${pending}`}
            </Button>
            {pending === "cancel" && reviewSnapshot?.enabled ? (
              <Button
                disabled={busy || actionLocked || reviewChanged}
                onClick={() => {
                  operations.invalidate();
                  reviewAction("pause");
                }}
              >
                Pause instead
              </Button>
            ) : null}
            <Button
              disabled={busy}
              onClick={() => {
                operations.invalidate();
                setPending(null);
              }}
            >
              Keep schedule
            </Button>
          </div>
        </Dialog>
      ) : (
        <WorkScheduleActionButtons
          enabled={selected.enabled}
          disabled={busy || actionLocked}
          onReview={(action) => {
            operations.invalidate();
            reviewAction(action);
          }}
        />
      )}
      <NativeOwnerLink href={selectedRecoveryHref} scope={[activeWorkspaceId ?? "default", selected.jobId]}>
        Inspect current schedule record
      </NativeOwnerLink>
    </div>
  );
}
