import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createCronJob,
  deleteCronJob,
  fetchCronReviewQueue,
  fetchCronRunDiff,
  fetchCronJob,
  fetchCronJobs,
  fetchSettings,
  pauseCronJob,
  retryCronReviewQueueItem,
  runCronJobNow,
  startCronJob,
  updateCronJob,
  type CronJobsResponse,
} from "../api/client";
import { ActionButton } from "../components/ActionButton";
import { CardSkeleton } from "../components/CardSkeleton";
import { FieldHelp } from "../components/FieldHelp";
import { PageGuideCard } from "../components/PageGuideCard";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { StatusChip } from "../components/StatusChip";
import { GCSelect, GCSwitch, Textarea } from "../components/ui";
import { pageCopy } from "../content/copy";
import { useRefreshSubscription } from "../hooks/useRefreshSubscription";

type CronAction = "task" | "improvement" | "backup" | "memory_flush" | "cost_report" | "update_review";
export type ScheduleFrequency = "hourly" | "daily" | "weekly";

export interface CronScheduleDraft {
  frequency: ScheduleFrequency;
  intervalHours: number;
  hour: number;
  minute: number;
  weekdays: number[];
  timeZone: string;
  endDate: string;
}

const DEFAULT_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles";

const DEFAULT_SCHEDULE_DRAFT: CronScheduleDraft = {
  frequency: "daily",
  intervalHours: 6,
  hour: 2,
  minute: 0,
  weekdays: [1],
  timeZone: DEFAULT_TIME_ZONE,
  endDate: "",
};

const ACTION_LABELS: Record<CronAction, string> = {
  task: "Creates an Observe task",
  improvement: "Runs the improvement replay",
  backup: "Creates a backup snapshot",
  memory_flush: "Flushes stale memory data",
  cost_report: "Writes the cost report",
  update_review: "Runs the update review",
};

const WEEKDAY_OPTIONS = [
  { value: 0, short: "Sun", label: "Sunday" },
  { value: 1, short: "Mon", label: "Monday" },
  { value: 2, short: "Tue", label: "Tuesday" },
  { value: 3, short: "Wed", label: "Wednesday" },
  { value: 4, short: "Thu", label: "Thursday" },
  { value: 5, short: "Fri", label: "Friday" },
  { value: 6, short: "Sat", label: "Saturday" },
] as const;

const INTERVAL_OPTIONS = [
  { value: "1", label: "Every hour" },
  { value: "2", label: "Every 2 hours" },
  { value: "3", label: "Every 3 hours" },
  { value: "4", label: "Every 4 hours" },
  { value: "6", label: "Every 6 hours" },
  { value: "8", label: "Every 8 hours" },
  { value: "12", label: "Every 12 hours" },
] as const;

export function CronPage() {
  const [data, setData] = useState<CronJobsResponse | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedJobDetail, setSelectedJobDetail] = useState<{
    jobId: string;
    name: string;
    action: CronAction;
    description?: string;
    schedule: string;
    enabled: boolean;
    endAt?: string;
    lastRunAt?: string;
    nextRunAt?: string;
    updatedAt?: string;
  } | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [jobIdInput, setJobIdInput] = useState("");
  const [jobIdDirty, setJobIdDirty] = useState(false);
  const [actionInput, setActionInput] = useState<CronAction>("task");
  const [descriptionInput, setDescriptionInput] = useState("");
  const [scheduleDraft, setScheduleDraft] = useState<CronScheduleDraft>(DEFAULT_SCHEDULE_DRAFT);
  const [enabledInput, setEnabledInput] = useState(true);
  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isFallbackRefreshing, setIsFallbackRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewQueueEnabled, setReviewQueueEnabled] = useState(true);
  const [reviewQueueError, setReviewQueueError] = useState<string | null>(null);
  const [reviewQueue, setReviewQueue] = useState<
    Array<{
      itemId: string;
      jobId: string;
      runId: string;
      severity: "low" | "medium" | "high" | "critical";
      status: "open" | "resolved" | "retrying" | "ignored";
      createdAt: string;
      updatedAt: string;
    }>
  >([]);
  const [selectedRunDiff, setSelectedRunDiff] = useState<{ runId: string; diff: Record<string, unknown> } | null>(null);
  const reviewQueueEnabledRef = useRef(reviewQueueEnabled);

  useEffect(() => {
    reviewQueueEnabledRef.current = reviewQueueEnabled;
  }, [reviewQueueEnabled]);

  const load = useCallback(async (options?: { background?: boolean }) => {
    const background = options?.background ?? false;
    if (background) {
      setIsRefreshing(true);
    } else {
      setIsInitialLoading(true);
    }
    try {
      const settingsPromise = background
        ? Promise.resolve<Awaited<ReturnType<typeof fetchSettings>> | null>(null)
        : fetchSettings();
      const [response, settings] = await Promise.all([fetchCronJobs(), settingsPromise]);
      const nextReviewQueueEnabled = settings?.features.cronReviewQueueV1Enabled ?? reviewQueueEnabledRef.current;
      if (settings) {
        setReviewQueueEnabled(nextReviewQueueEnabled);
      }
      if (nextReviewQueueEnabled) {
        try {
          const review = await fetchCronReviewQueue(100);
          setReviewQueue(review.items);
          setReviewQueueError(null);
        } catch (reviewErr) {
          setReviewQueue([]);
          setReviewQueueError((reviewErr as Error).message);
        }
      } else {
        setReviewQueue([]);
        setReviewQueueError(null);
        setSelectedRunDiff(null);
      }
      setData(response);
      setSelectedJobId((current) => current ?? response.items[0]?.jobId ?? null);
    } finally {
      if (background) {
        setIsRefreshing(false);
      } else {
        setIsInitialLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load({ background: false })
      .then(() => {
        if (!cancelled) {
          setError(null);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  useRefreshSubscription(
    "system",
    async () => {
      await load({ background: true });
    },
    {
      enabled: !isInitialLoading,
      coalesceMs: 1200,
      staleMs: 20000,
      pollIntervalMs: 15000,
      onFallbackStateChange: setIsFallbackRefreshing,
    },
  );

  useEffect(() => {
    if (!selectedJobId) {
      setSelectedJobDetail(null);
      return;
    }
    void fetchCronJob(selectedJobId)
      .then((job) => {
        setSelectedJobDetail(job);
      })
      .catch((err: Error) => {
        setError(err.message);
      });
  }, [selectedJobId]);

  const selectedJob = useMemo(
    () => data?.items.find((item) => item.jobId === selectedJobId) ?? null,
    [data?.items, selectedJobId],
  );

  const generatedSchedule = useMemo(() => buildScheduleExpression(scheduleDraft), [scheduleDraft]);
  const isBusy = busyJobId !== null;

  const resetForm = useCallback(() => {
    setEditingJobId(null);
    setNameInput("");
    setJobIdInput("");
    setJobIdDirty(false);
    setActionInput("task");
    setDescriptionInput("");
    setScheduleDraft(DEFAULT_SCHEDULE_DRAFT);
    setEnabledInput(true);
  }, []);

  const handleEdit = useCallback(
    (jobId: string) => {
      const job = data?.items.find((item) => item.jobId === jobId);
      if (!job) {
        return;
      }
      setEditingJobId(jobId);
      setNameInput(job.name);
      setJobIdInput(job.jobId);
      setJobIdDirty(true);
      setActionInput(job.action);
      setDescriptionInput(job.description ?? "");
      setScheduleDraft(parseScheduleExpression(job.schedule, job.endAt));
      setEnabledInput(job.enabled);
      setStatus(`Editing ${job.jobId}`);
      setError(null);
    },
    [data?.items],
  );

  const handleNameChange = useCallback(
    (value: string) => {
      setNameInput(value);
      if (!editingJobId && !jobIdDirty) {
        setJobIdInput(slugifyJobId(value));
      }
    },
    [editingJobId, jobIdDirty],
  );

  const handleCreateOrUpdate = useCallback(async () => {
    const normalizedName = nameInput.trim();
    const normalizedJobId = jobIdInput.trim();
    const normalizedDescription = descriptionInput.trim();
    if (!normalizedName) {
      setError("Job name is required.");
      return;
    }
    if (!editingJobId && !normalizedJobId) {
      setError("Job ID is required.");
      return;
    }
    if (actionInput === "task" && !normalizedDescription) {
      setError("Add what this scheduled job should do.");
      return;
    }
    if (scheduleDraft.frequency === "weekly" && scheduleDraft.weekdays.length === 0) {
      setError("Pick at least one day for a weekly schedule.");
      return;
    }
    if (!scheduleDraft.timeZone.trim()) {
      setError("Time zone is required.");
      return;
    }

    const normalizedSchedule = buildScheduleExpression(scheduleDraft);
    const endAt = scheduleDraft.endDate ? endDateToIso(scheduleDraft.endDate) : undefined;

    setBusyJobId(editingJobId ?? "__create__");
    try {
      if (editingJobId) {
        await updateCronJob(editingJobId, {
          name: normalizedName,
          action: actionInput,
          description: normalizedDescription || undefined,
          schedule: normalizedSchedule,
          enabled: enabledInput,
          endAt: endAt ?? null,
        });
        setStatus(`Updated ${editingJobId}`);
      } else {
        await createCronJob({
          jobId: normalizedJobId,
          name: normalizedName,
          action: actionInput,
          description: normalizedDescription || undefined,
          schedule: normalizedSchedule,
          enabled: enabledInput,
          endAt,
        });
        setStatus(`Created ${normalizedJobId}`);
      }
      await load();
      setSelectedJobId(editingJobId ?? normalizedJobId);
      resetForm();
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyJobId(null);
    }
  }, [
    actionInput,
    descriptionInput,
    editingJobId,
    enabledInput,
    jobIdInput,
    load,
    nameInput,
    resetForm,
    scheduleDraft,
  ]);

  const handleToggle = useCallback(
    async (jobId: string, enabled: boolean) => {
      setBusyJobId(jobId);
      try {
        if (enabled) {
          await pauseCronJob(jobId);
          setStatus(`Paused ${jobId}`);
        } else {
          await startCronJob(jobId);
          setStatus(`Started ${jobId}`);
        }
        await load();
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusyJobId(null);
      }
    },
    [load],
  );

  const handleRunNow = useCallback(
    async (jobId: string) => {
      setBusyJobId(jobId);
      try {
        await runCronJobNow(jobId);
        setStatus(`Ran ${jobId} manually`);
        await load();
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusyJobId(null);
      }
    },
    [load],
  );

  const handleDelete = useCallback(
    async (jobId: string) => {
      const confirmed = window.confirm(`Delete cron job ${jobId}?`);
      if (!confirmed) {
        return;
      }
      setBusyJobId(jobId);
      try {
        await deleteCronJob(jobId);
        setStatus(`Deleted ${jobId}`);
        if (selectedJobId === jobId) {
          setSelectedJobId(null);
          setSelectedJobDetail(null);
        }
        if (editingJobId === jobId) {
          resetForm();
        }
        await load();
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusyJobId(null);
      }
    },
    [editingJobId, load, resetForm, selectedJobId],
  );

  const handleRefresh = useCallback(async () => {
    setBusyJobId("__refresh__");
    try {
      await load();
      setStatus("Refreshed jobs");
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyJobId(null);
    }
  }, [load]);

  const handleRetryReviewItem = useCallback(
    async (itemId: string) => {
      setBusyJobId(itemId);
      try {
        const updated = await retryCronReviewQueueItem(itemId);
        setStatus(`Retried queue item ${updated.itemId.slice(0, 8)}`);
        await load({ background: true });
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusyJobId(null);
      }
    },
    [load],
  );

  const handleOpenDiff = useCallback(async (runId: string) => {
    setBusyJobId(runId);
    try {
      const diff = await fetchCronRunDiff(runId);
      setSelectedRunDiff({ runId, diff: diff.diff });
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyJobId(null);
    }
  }, []);

  if (error && !data) {
    return <p className="error">{error}</p>;
  }
  if (isInitialLoading || !data) {
    return (
      <section className="workflow-page">
        <PageHeader
          eyebrow="Automation"
          title={pageCopy.cron.title}
          subtitle={pageCopy.cron.subtitle}
          hint="Schedule repeatable work, inspect job health, and resolve review-queue items when automated runs need operator attention."
        />
        <CardSkeleton lines={8} />
      </section>
    );
  }

  return (
    <section className="workflow-page">
      <PageHeader
        eyebrow="Automation"
        title={pageCopy.cron.title}
        subtitle={pageCopy.cron.subtitle}
        hint="Use scheduled jobs to create repeatable operational work, then handle notable outputs through the review queue."
        actions={
          <div className="workflow-summary-strip">
            <StatusChip tone="muted">{data.items.length} jobs</StatusChip>
            <StatusChip tone={!reviewQueueEnabled ? "muted" : reviewQueue.length > 0 ? "warning" : "success"}>
              {reviewQueueEnabled ? `${reviewQueue.length} review items` : "Review queue off"}
            </StatusChip>
            {selectedJob ? (
              <StatusChip tone={selectedJob.enabled ? "success" : "muted"}>
                {ACTION_LABELS[selectedJob.action]}
              </StatusChip>
            ) : null}
          </div>
        }
      />
      <PageGuideCard
        pageId="cron"
        what={pageCopy.cron.guide?.what ?? ""}
        when={pageCopy.cron.guide?.when ?? ""}
        actions={pageCopy.cron.guide?.actions ?? []}
      />
      <div className="workflow-status-stack">
        {isRefreshing ? <p className="status-banner">Refreshing cron jobs...</p> : null}
        {isFallbackRefreshing ? (
          <p className="status-banner warning">Live updates degraded, checking periodically.</p>
        ) : null}
        {error ? <p className="error">{error}</p> : null}
        {status ? <p className="status-banner">{status}</p> : null}
        <FieldHelp>
          Custom jobs create Observe tasks on schedule. Built-in jobs keep their existing runtime behavior, but you can
          still control timing and notes here.
        </FieldHelp>
      </div>

      <div className="split-grid">
        <Panel
          title={editingJobId ? `Edit Job: ${editingJobId}` : "Create Job"}
          subtitle="Define what should happen first, then set how often and when it should run."
        >
          <div className="controls-row">
            <label htmlFor="cronJobName">Name</label>
            <input
              id="cronJobName"
              value={nameInput}
              onChange={(event) => handleNameChange(event.target.value)}
              disabled={isBusy}
              placeholder="Weekly release checklist"
            />
          </div>
          <div className="controls-row">
            <label htmlFor="cronJobId">Job ID</label>
            <input
              id="cronJobId"
              value={jobIdInput}
              onChange={(event) => {
                setJobIdDirty(true);
                setJobIdInput(event.target.value);
              }}
              disabled={Boolean(editingJobId) || isBusy}
              placeholder="weekly-release-checklist"
            />
          </div>
          {editingJobId ? (
            <FieldHelp>Job IDs stay fixed after creation so schedule history and references do not drift.</FieldHelp>
          ) : (
            <FieldHelp>We auto-fill the ID from the name, but you can edit it before saving.</FieldHelp>
          )}

          <div className="controls-row">
            <label htmlFor="cronJobAction">What happens</label>
            <input id="cronJobAction" value={ACTION_LABELS[actionInput]} disabled readOnly />
          </div>
          <div className="controls-row">
            <label htmlFor="cronJobDescription">Instructions</label>
            <Textarea
              id="cronJobDescription"
              value={descriptionInput}
              onChange={(event) => setDescriptionInput(event.target.value)}
              disabled={isBusy}
              placeholder={
                actionInput === "task"
                  ? "Create a task to review deployment health, check the release notes, and confirm the incident queue is clear."
                  : "Optional operator notes for this built-in job."
              }
              className="min-h-24"
            />
          </div>

          <div className="cron-schedule-builder">
            <div className="controls-row">
              <label htmlFor="cronFrequency">Runs</label>
              <GCSelect
                id="cronFrequency"
                value={scheduleDraft.frequency}
                onChange={(value) =>
                  setScheduleDraft((current) => ({
                    ...current,
                    frequency: value as ScheduleFrequency,
                    weekdays: value === "weekly" ? current.weekdays : DEFAULT_SCHEDULE_DRAFT.weekdays,
                  }))
                }
                options={[
                  { value: "hourly", label: "Every few hours" },
                  { value: "daily", label: "Every day" },
                  { value: "weekly", label: "Specific days" },
                ]}
                disabled={isBusy}
              />
              {scheduleDraft.frequency === "hourly" ? (
                <label>
                  Interval
                  <GCSelect
                    value={String(scheduleDraft.intervalHours)}
                    onChange={(value) =>
                      setScheduleDraft((current) => ({
                        ...current,
                        intervalHours: clampNumber(value, 1, 23, current.intervalHours),
                      }))
                    }
                    options={INTERVAL_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                    disabled={isBusy}
                  />
                </label>
              ) : (
                <label>
                  Time
                  <input
                    type="time"
                    value={toTimeInputValue(scheduleDraft.hour, scheduleDraft.minute)}
                    disabled={isBusy}
                    onChange={(event) => {
                      const [rawHour = "", rawMinute = ""] = event.target.value.split(":");
                      const nextHour = Number.parseInt(rawHour, 10);
                      const nextMinute = Number.parseInt(rawMinute, 10);
                      if (!Number.isFinite(nextHour) || !Number.isFinite(nextMinute)) {
                        return;
                      }
                      setScheduleDraft((current) => ({ ...current, hour: nextHour, minute: nextMinute }));
                    }}
                  />
                </label>
              )}
              {scheduleDraft.frequency === "hourly" ? (
                <label>
                  Minute
                  <input
                    type="number"
                    min={0}
                    max={59}
                    value={scheduleDraft.minute}
                    disabled={isBusy}
                    onChange={(event) =>
                      setScheduleDraft((current) => ({
                        ...current,
                        minute: clampNumber(event.target.value, 0, 59, current.minute),
                      }))
                    }
                  />
                </label>
              ) : null}
              <label>
                Time zone
                <input
                  value={scheduleDraft.timeZone}
                  disabled={isBusy}
                  onChange={(event) => setScheduleDraft((current) => ({ ...current, timeZone: event.target.value }))}
                  placeholder="America/Los_Angeles"
                />
              </label>
            </div>

            {scheduleDraft.frequency === "weekly" ? (
              <div className="cron-weekday-grid">
                {WEEKDAY_OPTIONS.map((option) => {
                  const checked = scheduleDraft.weekdays.includes(option.value);
                  return (
                    <label key={option.value} className="cron-weekday-option">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={isBusy}
                        onChange={() =>
                          setScheduleDraft((current) => ({
                            ...current,
                            weekdays: checked
                              ? current.weekdays.filter((weekday) => weekday !== option.value)
                              : [...current.weekdays, option.value].sort((left, right) => left - right),
                          }))
                        }
                      />
                      <span>{option.short}</span>
                    </label>
                  );
                })}
              </div>
            ) : null}

            <div className="controls-row">
              <label>
                Runs until
                <input
                  type="date"
                  value={scheduleDraft.endDate}
                  disabled={isBusy}
                  onChange={(event) => setScheduleDraft((current) => ({ ...current, endDate: event.target.value }))}
                />
              </label>
              <FieldHelp>Leave blank to keep running. End dates stop future scheduled runs automatically.</FieldHelp>
            </div>
            <FieldHelp>
              {describeScheduleExpression(generatedSchedule, scheduleDraft.endDate)}
              <br />
              Generated schedule: <code>{generatedSchedule}</code>
            </FieldHelp>
          </div>

          {editingJobId && actionInput !== "task" ? (
            <FieldHelp>
              This is a built-in automation. You can adjust timing and notes here, but the underlying behavior is fixed
              by the runtime.
            </FieldHelp>
          ) : null}

          <div className="controls-row">
            <GCSwitch
              id="cronJobEnabled"
              checked={enabledInput}
              onCheckedChange={setEnabledInput}
              disabled={isBusy}
              label="Enabled"
            />
          </div>
          <div className="actions-row">
            <ActionButton
              label={editingJobId ? "Save Changes" : "Create Job"}
              onClick={handleCreateOrUpdate}
              disabled={isBusy}
            />
            <ActionButton label="Clear" onClick={resetForm} disabled={isBusy} />
          </div>
        </Panel>

        <Panel title="Job Details" subtitle="Current status for the selected job.">
          {!selectedJobDetail ? (
            <p>Select a job to view details.</p>
          ) : (
            <dl className="cron-job-details">
              <dt>Name</dt>
              <dd>{selectedJobDetail.name}</dd>
              <dt>Job ID</dt>
              <dd>{selectedJobDetail.jobId}</dd>
              <dt>What happens</dt>
              <dd>{ACTION_LABELS[selectedJobDetail.action]}</dd>
              <dt>Instructions</dt>
              <dd>{selectedJobDetail.description?.trim() || "-"}</dd>
              <dt>Schedule</dt>
              <dd>{describeScheduleExpression(selectedJobDetail.schedule, selectedJobDetail.endAt)}</dd>
              <dt>Raw schedule</dt>
              <dd>
                <code>{selectedJobDetail.schedule}</code>
              </dd>
              <dt>Enabled</dt>
              <dd>{selectedJobDetail.enabled ? "yes" : "no"}</dd>
              <dt>Runs until</dt>
              <dd>{selectedJobDetail.endAt ? new Date(selectedJobDetail.endAt).toLocaleString() : "No end date"}</dd>
              <dt>Last Run</dt>
              <dd>{selectedJobDetail.lastRunAt ? new Date(selectedJobDetail.lastRunAt).toLocaleString() : "-"}</dd>
              <dt>Next Run</dt>
              <dd>{selectedJobDetail.nextRunAt ? new Date(selectedJobDetail.nextRunAt).toLocaleString() : "-"}</dd>
              <dt>Updated</dt>
              <dd>{selectedJobDetail.updatedAt ? new Date(selectedJobDetail.updatedAt).toLocaleString() : "-"}</dd>
            </dl>
          )}
        </Panel>
      </div>

      <Panel
        title="Cron Jobs"
        subtitle="Current job catalog with edit, pause/start, run-now, and delete actions."
        actions={<ActionButton label="Refresh" onClick={handleRefresh} disabled={isBusy} />}
      >
        <table className="gc-data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Job ID</th>
              <th>What happens</th>
              <th>Schedule</th>
              <th>Enabled</th>
              <th>Last Run</th>
              <th>Next Run</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((job) => (
              <tr
                key={job.jobId}
                className={selectedJob?.jobId === job.jobId ? "row-selected" : ""}
                onClick={() => setSelectedJobId(job.jobId)}
              >
                <td>{job.name}</td>
                <td>
                  <code>{job.jobId}</code>
                </td>
                <td>{ACTION_LABELS[job.action]}</td>
                <td>{describeScheduleExpression(job.schedule, job.endAt)}</td>
                <td>{job.enabled ? "yes" : "no"}</td>
                <td>{job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : "-"}</td>
                <td>{job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "-"}</td>
                <td className="cron-actions">
                  <ActionButton label="Edit" onClick={() => handleEdit(job.jobId)} disabled={isBusy} />
                  <ActionButton
                    label={job.enabled ? "Pause" : "Start"}
                    onClick={() => handleToggle(job.jobId, job.enabled)}
                    disabled={busyJobId === job.jobId}
                  />
                  <ActionButton
                    label="Run"
                    onClick={() => handleRunNow(job.jobId)}
                    disabled={busyJobId === job.jobId}
                  />
                  <ActionButton
                    label="Delete"
                    danger
                    onClick={() => handleDelete(job.jobId)}
                    disabled={busyJobId === job.jobId}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel
        title="Review Queue"
        subtitle="Flagged or notable cron outputs that need operator review, diff check, or retry."
      >
        {!reviewQueueEnabled ? (
          <p className="office-subtitle">
            Review queue is disabled right now. Scheduled jobs still appear above and can be run or edited normally.
          </p>
        ) : reviewQueueError ? (
          <p className="error">{reviewQueueError}</p>
        ) : reviewQueue.length === 0 ? (
          <p className="office-subtitle">No review items recorded yet.</p>
        ) : (
          <table className="gc-data-table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Run</th>
                <th>Severity</th>
                <th>Status</th>
                <th>Updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {reviewQueue.map((item) => (
                <tr key={item.itemId}>
                  <td>{item.jobId}</td>
                  <td>
                    <code>{item.runId.slice(0, 8)}</code>
                  </td>
                  <td>{item.severity}</td>
                  <td>{item.status}</td>
                  <td>{new Date(item.updatedAt).toLocaleString()}</td>
                  <td className="cron-actions">
                    <ActionButton
                      label="Diff"
                      disabled={busyJobId === item.runId}
                      onClick={() => void handleOpenDiff(item.runId)}
                    />
                    <ActionButton
                      label="Retry"
                      disabled={busyJobId === item.itemId}
                      onClick={() => void handleRetryReviewItem(item.itemId)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {selectedRunDiff ? (
          <details open>
            <summary>Run diff: {selectedRunDiff.runId}</summary>
            <pre>{JSON.stringify(selectedRunDiff.diff, null, 2)}</pre>
          </details>
        ) : null}
      </Panel>
    </section>
  );
}

export function slugifyJobId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function parseScheduleExpression(schedule: string, endAt?: string): CronScheduleDraft {
  const parts = schedule.trim().split(/\s+/).filter(Boolean);
  const minute = clampNumber(parts[0] ?? "0", 0, 59, DEFAULT_SCHEDULE_DRAFT.minute);
  const hourToken = parts[1] ?? "2";
  const weekdayToken = parts[4] ?? "*";
  const timeZone = parts.slice(5).join(" ") || DEFAULT_TIME_ZONE;
  const draft: CronScheduleDraft = {
    ...DEFAULT_SCHEDULE_DRAFT,
    minute,
    timeZone,
    endDate: endAt ? toDateInputValue(endAt) : "",
  };

  if (hourToken === "*") {
    return {
      ...draft,
      frequency: "hourly",
      intervalHours: 1,
    };
  }
  if (/^\*\/\d+$/.test(hourToken)) {
    return {
      ...draft,
      frequency: "hourly",
      intervalHours: clampNumber(hourToken.slice(2), 1, 23, DEFAULT_SCHEDULE_DRAFT.intervalHours),
    };
  }

  draft.hour = clampNumber(hourToken, 0, 23, DEFAULT_SCHEDULE_DRAFT.hour);
  if (weekdayToken !== "*") {
    return {
      ...draft,
      frequency: "weekly",
      weekdays: weekdayToken
        .split(",")
        .map((token) => clampNumber(token, 0, 6, 1))
        .sort((left, right) => left - right),
    };
  }

  return {
    ...draft,
    frequency: "daily",
  };
}

export function buildScheduleExpression(draft: CronScheduleDraft): string {
  const timeZone = draft.timeZone.trim() || DEFAULT_TIME_ZONE;
  if (draft.frequency === "hourly") {
    const hourToken = draft.intervalHours <= 1 ? "*" : `*/${draft.intervalHours}`;
    return `${draft.minute} ${hourToken} * * * ${timeZone}`;
  }
  if (draft.frequency === "weekly") {
    const weekdays = draft.weekdays.length > 0 ? draft.weekdays.join(",") : "1";
    return `${draft.minute} ${draft.hour} * * ${weekdays} ${timeZone}`;
  }
  return `${draft.minute} ${draft.hour} * * * ${timeZone}`;
}

export function describeScheduleExpression(schedule: string, endDate?: string): string {
  const draft = parseScheduleExpression(schedule, endDate);
  const timeText =
    draft.frequency === "hourly"
      ? `at ${String(draft.minute).padStart(2, "0")} past the hour`
      : `at ${String(draft.hour).padStart(2, "0")}:${String(draft.minute).padStart(2, "0")}`;

  const summary =
    draft.frequency === "hourly"
      ? draft.intervalHours <= 1
        ? `Every hour ${timeText}`
        : `Every ${draft.intervalHours} hours ${timeText}`
      : draft.frequency === "weekly"
        ? `${draft.weekdays
            .map((weekday) => WEEKDAY_OPTIONS.find((option) => option.value === weekday)?.label)
            .filter(Boolean)
            .join(", ")} ${timeText}`
        : `Every day ${timeText}`;

  if (draft.endDate) {
    return `${summary} (${draft.timeZone}) until ${draft.endDate}`;
  }
  return `${summary} (${draft.timeZone})`;
}

export function toTimeInputValue(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function clampNumber(rawValue: string, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

export function endDateToIso(value: string): string {
  return new Date(`${value}T23:59:59`).toISOString();
}

export function toDateInputValue(value: string): string {
  const parsed = new Date(value);
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
