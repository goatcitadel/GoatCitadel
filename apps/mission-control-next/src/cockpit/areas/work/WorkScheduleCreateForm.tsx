import { useId, type FormEvent } from "react";
import { SCHEDULE_ACTION_LABELS } from "./work-vocabulary";
import { Button } from "../../ui/Button";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { ScheduleAdvancedFields, type ScheduleSettingsDraft } from "./ScheduleAdvancedFields";
import { ScheduleTiming } from "./ScheduleTiming";
const CREATE_ACTIONS = [
  "task",
  "improvement",
  "backup",
  "memory_flush",
  "cost_report",
  "update_review",
  "watchdog",
] as const;
export type CreateScheduleAction = (typeof CREATE_ACTIONS)[number];
/** One plain line per action; built-in maintenance reuses the matching built-in job. */
const CREATE_ACTION_DESCRIPTIONS: Readonly<Record<CreateScheduleAction, string>> = {
  task: "Adds a task to the task list each time it runs. It does not start a run.",
  improvement: "Runs the built-in improvement review.",
  backup: "Runs the built-in backup.",
  memory_flush: "Runs the built-in memory flush.",
  cost_report: "Runs the built-in cost report.",
  update_review: "Runs the built-in update review.",
  watchdog: "Runs a health check. Choose the check under Advanced job settings.",
};
export function WorkScheduleCreateForm({
  name,
  schedule,
  createAction,
  locked,
  busy,
  createUncertain,
  scope,
  recoveryHref,
  onName,
  onSchedule,
  onAction,
  onSubmit,
  onClose,
  advanced,
  onAdvanced,
}: {
  name: string;
  schedule: string;
  createAction: CreateScheduleAction;
  locked: boolean;
  busy: boolean;
  createUncertain: boolean;
  scope: string;
  recoveryHref: string;
  onName: (value: string) => void;
  onSchedule: (value: string) => void;
  onAction: (value: CreateScheduleAction) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
  advanced: ScheduleSettingsDraft;
  onAdvanced: (key: keyof ScheduleSettingsDraft, value: string) => void;
}) {
  const actionDescriptionId = useId();
  return (
    <form
      aria-label="New schedule"
      onSubmit={onSubmit}
      className="grid gap-3 rounded-lg border border-line bg-raised p-4"
    >
      <h2 className="text-base font-semibold text-fg">New schedule</h2>
      <label className="grid gap-1 text-sm text-fg-secondary">
        Name
        <input
          required
          maxLength={100}
          value={name}
          disabled={locked}
          onChange={(event) => {
            onName(event.target.value);
          }}
          className="rounded-md border border-line-control bg-canvas p-2 text-fg"
        />
      </label>
      <ScheduleTiming value={schedule} disabled={locked} onChange={onSchedule} />
      <label className="grid gap-1 text-sm text-fg-secondary">
        Action
        <select
          value={createAction}
          disabled={locked}
          aria-describedby={actionDescriptionId}
          onChange={(event) => {
            onAction(event.target.value as CreateScheduleAction);
          }}
          className="rounded-md border border-line-control bg-canvas p-2 text-fg"
        >
          {CREATE_ACTIONS.map((action) => (
            <option key={action} value={action}>
              {SCHEDULE_ACTION_LABELS[action]}
            </option>
          ))}
        </select>
      </label>
      <p id={actionDescriptionId} className="text-xs text-fg-secondary">
        {CREATE_ACTION_DESCRIPTIONS[createAction]}
        {createAction === "task" || createAction === "watchdog"
          ? ""
          : " It may skip a run, for example while that built-in job is turned off; the last outcome says why."}
      </p>
      <p className="text-xs text-fg-muted">
        Applies across workspaces. Times run in UTC unless the expression ends with a timezone name (for example 0 9 * *
        * America/New_York); check the next run after saving. Creating a schedule does not run it.
      </p>
      <ScheduleAdvancedFields value={advanced} locked={locked} onChange={onAdvanced} />
      {createUncertain ? (
        <NativeOwnerLink href={recoveryHref} scope={scope}>
          Inspect current schedules
        </NativeOwnerLink>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={busy || locked || !schedule.trim()}>
          Create schedule
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            onClose();
          }}
        >
          Close
        </Button>
      </div>
    </form>
  );
}
