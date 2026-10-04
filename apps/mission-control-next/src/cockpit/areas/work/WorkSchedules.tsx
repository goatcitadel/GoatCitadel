import { WorkScheduleCreateForm, type CreateScheduleAction } from "./WorkScheduleCreateForm";
import { useState, type FormEvent } from "react";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { scheduleCreateDraftKey } from "../../../features/native-routes/ops/work-form-drafts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { fetchCronJob, fetchCronJobs } from "@goatcitadel/mission-control-shared/api/cron";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { createScheduleJobId } from "../../../features/native-routes/ops/schedule-id";
import { useScheduleOperations } from "../../../features/native-routes/ops/use-schedule-operations";
import type { ScheduleAction } from "../../../features/native-routes/ops/schedule-operation";
import { queryKeys } from "../../data/query-keys";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";

function formattedTime(iso: string | undefined): string {
  if (!iso) return "Not reported by the Gateway";
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed)
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(parsed)
    : "Time unavailable";
}

export function WorkSchedules() {
  const client = useQueryClient();
  const { activeWorkspaceId } = useUiPreferences();
  const schedules = useQuery({
    queryKey: queryKeys.schedules(),
    queryFn: () => fetchCronJobs(),
    refetchInterval: 60_000,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detail = useQuery({
    queryKey: ["cockpit", "schedule", selectedId],
    queryFn: () => fetchCronJob(selectedId!),
    enabled: Boolean(selectedId),
  });
  const [pending, setPending] = useState<ScheduleAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const empty = { name: "", schedule: "0 9 * * *", action: "task" as CreateScheduleAction };
  const editor = useSessionDraft(scheduleCreateDraftKey(getGatewayApiBaseUrl()), empty, undefined, {
    label: "New schedule",
    active: createOpen,
  });
  const { name, schedule, action: createAction } = editor.value;
  const selected = !schedules.isError && !detail.isError && detail.data?.jobId === selectedId ? detail.data : undefined;
  const operations = useScheduleOperations(
    JSON.stringify([
      activeWorkspaceId,
      selectedId,
      selected?.revision,
      pending,
      createOpen,
      name,
      schedule,
      createAction,
    ]),
  );
  const createAttempt = operations.attempt();
  const selectedAttempt = selectedId ? operations.attempt(selectedId) : undefined;
  const busy = [createAttempt, selectedAttempt].some(
    (attempt) => attempt?.phase === "checking" || attempt?.phase === "submitted",
  );
  const createUncertain = createAttempt?.phase === "uncertain";
  const actionLocked = selectedId ? operations.locked(selectedId) : false;
  const message = operations.message ?? selectedAttempt?.message ?? createAttempt?.message ?? notice;

  async function refresh(): Promise<void> {
    operations.invalidate();
    setPending(null);
    await schedules.refetch();
    if (selectedId) await detail.refetch();
  }

  async function create(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (operations.locked()) return;
    const trimmedName = name.trim();
    const trimmedSchedule = schedule.trim();
    if (!trimmedName || !trimmedSchedule) {
      setNotice("Name and schedule are required.");
      return;
    }
    setNotice(null);
    const jobId = createScheduleJobId(trimmedName);
    const submitted = editor.value;
    const receipt = await operations.execute(
      {
        kind: "create",
        input: {
          jobId,
          name: trimmedName,
          schedule: trimmedSchedule,
          action: createAction,
          enabled: true,
        },
      },
      (recorded) => {
        if (recorded.kind === "create") editor.acceptSaved(empty, undefined, submitted);
      },
    );
    if (receipt?.kind === "create") {
      setCreateOpen(false);
      setSelectedId(jobId);
      setNotice("Schedule created. Review its current settings below.");
      await client.invalidateQueries({ queryKey: queryKeys.schedules() });
    }
  }

  async function applyAction(): Promise<void> {
    if (!selected || !pending) return;
    setNotice(null);
    const receipt = await operations.execute({ kind: pending, job: selected });
    if (receipt) {
      if (receipt.kind === "cancel") {
        setSelectedId(null);
        setNotice("Schedule deleted.");
      } else if (receipt.kind === "run") {
        setNotice(`Run request acknowledged as ${receipt.run.runId}. Check Work for its outcome.`);
      } else {
        setNotice(receipt.kind === "pause" ? "Schedule paused." : "Schedule resumed.");
      }
      setPending(null);
      await client.invalidateQueries({ queryKey: queryKeys.schedules() });
      await client.invalidateQueries({ queryKey: ["cockpit", "schedule", selected.jobId] });
    }
  }

  return (
    <section className="mx-auto flex max-w-5xl flex-col gap-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-fg">Schedules</h1>
          <p className="text-sm text-fg-secondary">Gateway-wide recurring jobs and their next run.</p>
          <p className="mt-1 text-xs text-fg-muted">Schedules apply across workspaces.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={schedules.isFetching || busy} onClick={() => void refresh()}>
            <RefreshCw aria-hidden="true" className="size-4" /> Refresh
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              operations.invalidate();
              setCreateOpen(true);
              setNotice(null);
            }}
          >
            New schedule
          </Button>
        </div>
      </header>
      {message ? (
        <p role="status" className="rounded-md border border-line bg-raised p-3 text-sm text-fg-secondary">
          {message}
        </p>
      ) : null}
      {createOpen ? (
        <WorkScheduleCreateForm
          name={name}
          schedule={schedule}
          createAction={createAction}
          locked={operations.locked()}
          busy={busy}
          createUncertain={createUncertain}
          scope={activeWorkspaceId ?? "default"}
          onName={(value) => {
            operations.invalidate();
            editor.setValue((current) => ({ ...current, name: value }));
          }}
          onSchedule={(value) => {
            operations.invalidate();
            editor.setValue((current) => ({ ...current, schedule: value }));
          }}
          onAction={(value) => {
            operations.invalidate();
            editor.setValue((current) => ({ ...current, action: value }));
          }}
          onSubmit={(event) => void create(event)}
          onClose={() => {
            operations.invalidate();
            setCreateOpen(false);
          }}
        />
      ) : null}
      {schedules.isLoading ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading schedules…
        </p>
      ) : null}
      {schedules.isError ? (
        <EmptyState
          title="Schedules unavailable"
          description={describeApiError(schedules.error).summary}
          action={<Button onClick={() => void refresh()}>Try again</Button>}
        />
      ) : null}
      {schedules.data && !schedules.isError ? (
        schedules.data.items.length ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <ul className="grid content-start gap-2">
              {schedules.data.items.map((job) => (
                <li key={job.jobId} className="rounded-lg border border-line bg-raised p-4">
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
                    Next run: {job.enabled ? formattedTime(job.nextRunAt) : "Paused"}
                  </p>
                  <Button
                    size="sm"
                    className="mt-2"
                    aria-label={"Review " + job.name}
                    onClick={() => {
                      operations.invalidate();
                      setSelectedId(job.jobId);
                      setPending(null);
                      setNotice(null);
                    }}
                  >
                    Review schedule
                  </Button>
                </li>
              ))}
            </ul>
            <div aria-label="Schedule detail" className="min-w-0">
              {!selectedId ? (
                <EmptyState
                  title="Select a schedule"
                  description="Review its current Gateway record before taking action."
                />
              ) : null}
              {selectedId && detail.isLoading ? (
                <p role="status" className="text-sm text-fg-muted">
                  Loading schedule…
                </p>
              ) : null}
              {selectedId && detail.isError ? (
                <EmptyState
                  title="Schedule unavailable"
                  description={describeApiError(detail.error).summary}
                  action={<Button onClick={() => void detail.refetch()}>Try again</Button>}
                />
              ) : null}
              {selected ? (
                <div className="grid gap-3 rounded-lg border border-line bg-raised p-4">
                  <div>
                    <h2 className="font-display text-md font-semibold text-fg">{selected.name}</h2>
                    <p className="text-xs text-fg-muted">
                      {selected.enabled ? "Enabled" : "Paused"} · {humanizeToken(selected.action)}
                    </p>
                  </div>
                  {selected.description ? <p className="text-sm text-fg-secondary">{selected.description}</p> : null}
                  <dl className="grid gap-2 text-sm">
                    <div>
                      <dt className="text-fg-muted">Schedule</dt>
                      <dd className="break-all font-mono text-fg">{selected.schedule}</dd>
                    </div>
                    <div>
                      <dt className="text-fg-muted">Next run</dt>
                      <dd className="text-fg">{selected.enabled ? formattedTime(selected.nextRunAt) : "Paused"}</dd>
                    </div>
                    <div>
                      <dt className="text-fg-muted">Last run</dt>
                      <dd className="text-fg">{formattedTime(selected.lastRunAt)}</dd>
                    </div>
                  </dl>
                  {actionLocked ? (
                    <p role="alert" className="text-sm text-status-failed">
                      {selectedAttempt?.message}
                    </p>
                  ) : null}
                  {pending && selectedAttempt?.phase !== "uncertain" ? (
                    <div className="grid gap-2 rounded-md border border-line-strong bg-sunken p-3">
                      <p className="text-sm text-fg">
                        {pending === "cancel"
                          ? `Delete “${selected.name}”? Future runs stop and it can't be restored.`
                          : `${pending === "run" ? "Run now" : pending === "pause" ? "Pause" : "Resume"} this schedule? The Gateway will recheck its current record before the request.`}
                      </p>
                      {pending === "run" ? (
                        <p className="text-xs text-fg-muted">
                          Run now has no atomic configuration revision check. Acknowledgement confirms a request;
                          inspect the recorded run for execution results.
                        </p>
                      ) : null}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant={pending === "cancel" ? "danger" : "primary"}
                          disabled={busy || actionLocked}
                          onClick={() => void applyAction()}
                        >
                          {pending === "cancel" ? "Delete schedule" : `Confirm ${pending}`}
                        </Button>
                        {pending === "cancel" && selected.enabled ? (
                          <Button
                            disabled={busy || actionLocked}
                            onClick={() => {
                              operations.invalidate();
                              setPending("pause");
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
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={busy || actionLocked}
                        onClick={() => {
                          operations.invalidate();
                          setPending("run");
                        }}
                      >
                        Run now
                      </Button>
                      <Button
                        size="sm"
                        disabled={busy || actionLocked}
                        onClick={() => {
                          operations.invalidate();
                          setPending(selected.enabled ? "pause" : "resume");
                        }}
                      >
                        {selected.enabled ? "Pause" : "Resume"}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={busy || actionLocked}
                        onClick={() => {
                          operations.invalidate();
                          setPending("cancel");
                        }}
                      >
                        Delete schedule…
                      </Button>
                    </div>
                  )}
                  <ClassicOwnerLink
                    href="/ops/schedules?shell=classic"
                    scope={activeWorkspaceId ?? "default"}
                    label="Open full schedule controls in Ops"
                  />
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <EmptyState
            title="No schedules returned"
            description="The Gateway has no recurring jobs in its current schedule list."
          />
        )
      ) : null}
    </section>
  );
}
