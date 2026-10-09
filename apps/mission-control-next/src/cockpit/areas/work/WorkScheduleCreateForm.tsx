import type { FormEvent } from "react";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { Button } from "../../ui/Button";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
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
export function WorkScheduleCreateForm({
  name,
  schedule,
  createAction,
  locked,
  busy,
  createUncertain,
  scope,
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
  onName: (value: string) => void;
  onSchedule: (value: string) => void;
  onAction: (value: CreateScheduleAction) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
  advanced: ScheduleSettingsDraft;
  onAdvanced: (key: keyof ScheduleSettingsDraft, value: string) => void;
}) {
  return (
    <form
      aria-label="New schedule"
      onSubmit={onSubmit}
      className="grid gap-3 rounded-lg border border-line bg-raised p-4"
    >
      <h2 className="font-display text-md font-semibold text-fg">New schedule</h2>
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
          className="rounded-md border border-line bg-canvas p-2 text-fg"
        />
      </label>
      <ScheduleTiming value={schedule} disabled={locked} onChange={onSchedule} />
      <label className="grid gap-1 text-sm text-fg-secondary">
        Action
        <select
          value={createAction}
          disabled={locked}
          onChange={(event) => {
            onAction(event.target.value as CreateScheduleAction);
          }}
          className="rounded-md border border-line bg-canvas p-2 text-fg"
        >
          {CREATE_ACTIONS.map((action) => (
            <option key={action} value={action}>
              {humanizeToken(action)}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-fg-muted">Gateway-wide schedule. The Gateway validates timing and owns future runs. Times run in UTC unless the expression ends with a timezone name (for example 0 9 * * * America/New_York); verify the next-run receipt. Creation does not prove a scheduled job executed.</p>
      <ScheduleAdvancedFields value={advanced} locked={locked} onChange={onAdvanced} />
      {createUncertain ? (
        <ClassicOwnerLink href="/ops/schedules?shell=classic" scope={scope} label="Review in Ops before retrying" />
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
