import { WorkScheduleCreateForm, type CreateScheduleAction } from "./WorkScheduleCreateForm";
import { WorkScheduleEditor } from "./WorkScheduleEditor";
import { SchedulerReviewQueue } from "./SchedulerReviewQueue";
import { useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
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
import { sameScheduleReview } from "../../../features/native-routes/ops/schedule-operation";
import type { CronJobRecordResponse } from "@goatcitadel/mission-control-shared/api/types";
import { Dialog } from "../../ui/Dialog";
import { scheduleTimezoneSummary } from "./schedule-cadence";
import { EMPTY_SCHEDULE_SETTINGS, scheduleSettingsInput } from "./ScheduleAdvancedFields";
import { queryKeys } from "../../data/query-keys";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { cockpitHref, readCockpitHistory, subscribeCockpitHistory } from "../../app/cockpit-history";
import { readCockpitLocation } from "../../app/cockpit-back-guard";
import { CockpitNavigationContext } from "../../app/cockpit-navigation-context";
import { formattedTime, WorkScheduleActionButtons, WorkScheduleListItem, WorkScheduleRecordDetails } from "./WorkScheduleSummary";

export function WorkSchedules() {
  const client = useQueryClient();
  const { activeWorkspaceId } = useUiPreferences();
  const schedules = useQuery({
    queryKey: queryKeys.schedules(),
    refetchOnMount: "always",
    queryFn: () => fetchCronJobs(),
    refetchInterval: 60_000,
  });
  const history = useSyncExternalStore(subscribeCockpitHistory, readCockpitHistory, () => "server");
  const navigation = useContext(CockpitNavigationContext);
  const routeJobId = typeof window === "undefined" ? null : new URLSearchParams(readCockpitLocation().search).get("jobId");
  const [selection, setSelection] = useState({ history, id: routeJobId });
  const selectedId = selection.history === history ? selection.id : routeJobId;
  const receiptTransition = useRef<{ href: string; fromHistory: string; workspace: string | undefined; message: string } | null>(null);
  const setSelectedId = (id: string | null, receiptMessage?: string) => {
    if (navigation) {
      const url = new URL(readCockpitLocation().href);
      if (id) url.searchParams.set("jobId", id); else url.searchParams.delete("jobId");
      if (receiptMessage) receiptTransition.current = { href: cockpitHref(url.pathname + url.search + url.hash)!, fromHistory: history, workspace: activeWorkspaceId ?? undefined, message: receiptMessage };
      navigation.navigate(url.pathname + url.search + url.hash);
    } else setSelection({ history, id });
  };
  const detail = useQuery({
    // Selection/history is the read-admission lifetime; never authorize a returned cache entry alone.
    queryKey: ["cockpit", "schedule", selectedId, history],
    staleTime: 0,
    refetchOnMount: "always",
    queryFn: ({ signal }) => fetchCronJob(selectedId!, { signal }),
    placeholderData: (previous) => previous?.jobId === selectedId ? previous : undefined,
    enabled: Boolean(selectedId),
  });
  const [pending, setPending] = useState<ScheduleAction | null>(null);
  const reviewedJob = useRef<{ job: CronJobRecordResponse; expires: number; workspace: string | undefined } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const empty = { ...EMPTY_SCHEDULE_SETTINGS, name: "", schedule: "0 9 * * *", action: "task" as CreateScheduleAction };
  const editor = useSessionDraft(scheduleCreateDraftKey(getGatewayApiBaseUrl()), empty, undefined, {
    label: "New schedule",
    active: createOpen,
  });
  const { name, schedule, action: createAction } = editor.value;
  const selected = !schedules.isError && !detail.isError && detail.data?.jobId === selectedId ? detail.data : undefined;
  const operations = useScheduleOperations(
    JSON.stringify([
      activeWorkspaceId,
      history,
      selectedId,
      selected?.revision,
      pending,
      createOpen,
      name,
      schedule,
      createAction,
      editor.value,
    ]),
    JSON.stringify([activeWorkspaceId, history, selectedId, pending, createOpen, editor.value]),
  );
  const reviewSnapshot = pending ? reviewedJob.current?.job : undefined;
  const reviewChanged = Boolean(reviewSnapshot && selected && !sameScheduleReview(reviewSnapshot, selected));
  const reviewMessage = operations.message ?? (reviewChanged ? "This schedule changed during review. Close this review and inspect its latest settings before acting." : undefined);
  const createAttempt = operations.attempt();
  const selectedAttempt = selectedId ? operations.attempt(selectedId) : undefined;
  const busy = [createAttempt, selectedAttempt].some(
    (attempt) => attempt?.phase === "checking" || attempt?.phase === "submitted",
  );
  const createUncertain = createAttempt?.phase === "uncertain";
  const actionLocked = (selectedId ? operations.locked(selectedId) : false) || detail.isFetching || !detail.isFetchedAfterMount || detail.isPlaceholderData;
  const message = operations.message ?? selectedAttempt?.message ?? createAttempt?.message ?? notice;
  useLayoutEffect(() => {
    // The operation binding includes history and invalidates old callbacks during render.
    reviewedJob.current = null;
    setPending(null);
    const receipt = receiptTransition.current;
    receiptTransition.current = null;
    const location = readCockpitLocation();
    const ownTransition = receipt && receipt.fromHistory !== history && receipt.workspace === (activeWorkspaceId ?? undefined) && receipt.href === location.pathname + location.search + location.hash;
    setNotice(ownTransition ? receipt.message : null);
  }, [history, activeWorkspaceId]);
  function reviewAction(action: ScheduleAction) {
    if (!selected || actionLocked) return;
    reviewedJob.current = { job: structuredClone(selected), expires: Date.now() + 60_000, workspace: activeWorkspaceId ?? undefined };
    operations.invalidate(); setPending(action);
  }

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
    let advanced: ReturnType<typeof scheduleSettingsInput>;
    try { advanced = scheduleSettingsInput(editor.value, createAction); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Invalid advanced settings."); return; }
    const jobId = createScheduleJobId(trimmedName);
    const submitted = editor.value;
    const receipt = await operations.execute(
      {
        kind: "create",
        input: {
          ...advanced,
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
      setSelectedId(jobId, "Schedule created. Review its current settings below.");
      setNotice("Schedule created. Review its current settings below.");
      await client.invalidateQueries({ queryKey: queryKeys.schedules() });
    }
  }

  async function applyAction(): Promise<void> {
    if (!selected || !pending) return;
    if (!reviewedJob.current || Date.now() > reviewedJob.current.expires || reviewedJob.current.workspace !== (activeWorkspaceId ?? undefined) || !sameScheduleReview(reviewedJob.current.job, selected)) {
      setPending(null); setNotice("Schedule review expired or its context changed. Review the current schedule again."); return;
    }
    setNotice(null);
    const receipt = await operations.execute({ kind: pending, job: reviewedJob.current.job });
    if (receipt) {
      if (receipt.kind === "cancel") {
        setSelectedId(null, "Schedule deleted.");
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
          advanced={editor.value}
          onAdvanced={(key, value) => { operations.invalidate(); editor.setValue(current => ({ ...current, [key]: value })); }}
          locked={operations.locked()}
          busy={busy}
          createUncertain={createUncertain}
          scope="Gateway-wide"
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
                <WorkScheduleListItem
                  key={job.jobId}
                  job={job}
                  onReview={() => {
                    operations.invalidate();
                    setSelectedId(job.jobId);
                    setPending(null);
                    setNotice(null);
                  }}
                />
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
                  {detail.isFetching ? <p role="status" className="text-sm text-fg-secondary">Checking current schedule access. Controls wait for the authorized read.</p> : null}
                  <div>
                    <h2 className="font-display text-md font-semibold text-fg">{selected.name}</h2>
                    <p className="text-xs text-fg-muted">
                      {selected.enabled ? "Enabled" : "Paused"} · {humanizeToken(selected.action)}
                    </p>
                  </div>
                  {selected.description ? <p className="text-sm text-fg-secondary">{selected.description}</p> : null}
                  <WorkScheduleRecordDetails selected={selected} />
                  <WorkScheduleEditor key={selected.jobId} job={selected} available={!actionLocked && !busy} onSaved={() => { setNotice("Schedule settings saved and independently verified. Execution has not been verified."); void refresh(); }} />
                  {actionLocked ? (
                    <p role="alert" className="text-sm text-status-failed">
                      {selectedAttempt?.message}
                    </p>
                  ) : null}
                  {pending ? (
                    <Dialog open={true} title="Review schedule action" description="Gateway-wide action. The current revision is rechecked before persistence; review expires after one minute." onOpenChange={open => { if (!open) { operations.invalidate(); setPending(null); } }}>
                      {reviewMessage || selectedAttempt?.message ? <p role={reviewMessage || selectedAttempt?.phase === "uncertain" ? "alert" : "status"} className="mb-3 text-sm text-fg-secondary">{reviewMessage ?? selectedAttempt?.message}</p> : null}
                      <p className="mb-3 text-sm text-fg-secondary">{reviewSnapshot?.name} · {reviewSnapshot?.schedule} · {humanizeToken(reviewSnapshot?.action ?? "unknown")}. Destination: {reviewSnapshot?.workdir || "Not reported"}. Next run: {formattedTime(reviewSnapshot?.nextRunAt)}. {scheduleTimezoneSummary(reviewSnapshot?.schedule ?? "")} Displayed dates use your browser timezone.</p>
                      <p className="mb-3 text-sm text-fg-secondary">{pending === "pause" ? "Pause stops future occurrences; it does not cancel a running job." : pending === "resume" ? "Resume enables future recurring occurrences." : pending === "run" ? "Run now submits the saved action configuration immediately. Gateway policy and approval gates still apply." : "Delete permanently removes the schedule and stops future occurrences."}</p>
                      <p className="text-sm text-fg">
                        {pending === "cancel"
                          ? `Delete “${reviewSnapshot?.name}”? Future runs stop and it can't be restored.`
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
      <SchedulerReviewQueue />
    </section>
  );
}
