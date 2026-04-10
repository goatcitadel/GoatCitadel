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
import { GCSwitch } from "../components/ui";
import { pageCopy } from "../content/copy";
import { useRefreshSubscription } from "../hooks/useRefreshSubscription";

const DEFAULT_SCHEDULE = "0 2 * * * America/Los_Angeles";

export function CronPage() {
  const [data, setData] = useState<CronJobsResponse | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedJobDetail, setSelectedJobDetail] = useState<{
    jobId: string;
    name: string;
    schedule: string;
    enabled: boolean;
    lastRunAt?: string;
    nextRunAt?: string;
    updatedAt?: string;
  } | null>(null);
  const [jobIdInput, setJobIdInput] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [scheduleInput, setScheduleInput] = useState(DEFAULT_SCHEDULE);
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
  const [reviewQueue, setReviewQueue] = useState<Array<{
    itemId: string;
    jobId: string;
    runId: string;
    severity: "low" | "medium" | "high" | "critical";
    status: "open" | "resolved" | "retrying" | "ignored";
    createdAt: string;
    updatedAt: string;
  }>>([]);
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
      const [response, settings] = await Promise.all([
        fetchCronJobs(),
        settingsPromise,
      ]);
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

  const isBusy = busyJobId !== null;

  const resetForm = useCallback(() => {
    setEditingJobId(null);
    setJobIdInput("");
    setNameInput("");
    setScheduleInput(DEFAULT_SCHEDULE);
    setEnabledInput(true);
  }, []);

  const handleEdit = useCallback((jobId: string) => {
    const job = data?.items.find((item) => item.jobId === jobId);
    if (!job) {
      return;
    }
    setEditingJobId(jobId);
    setJobIdInput(job.jobId);
    setNameInput(job.name);
    setScheduleInput(job.schedule);
    setEnabledInput(job.enabled);
    setStatus(`Editing ${job.jobId}`);
    setError(null);
  }, [data?.items]);

  const handleCreateOrUpdate = useCallback(async () => {
    const normalizedJobId = jobIdInput.trim();
    const normalizedName = nameInput.trim();
    const normalizedSchedule = scheduleInput.trim();
    if (!normalizedJobId || !normalizedName || !normalizedSchedule) {
      setError("Job ID, name, and schedule are required.");
      return;
    }
    setBusyJobId(editingJobId ?? "__create__");
    try {
      if (editingJobId) {
        await updateCronJob(editingJobId, {
          name: normalizedName,
          schedule: normalizedSchedule,
          enabled: enabledInput,
        });
        setStatus(`Updated ${editingJobId}`);
      } else {
        await createCronJob({
          jobId: normalizedJobId,
          name: normalizedName,
          schedule: normalizedSchedule,
          enabled: enabledInput,
        });
        setStatus(`Created ${normalizedJobId}`);
      }
      await load();
      setSelectedJobId(normalizedJobId);
      resetForm();
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyJobId(null);
    }
  }, [editingJobId, enabledInput, jobIdInput, load, nameInput, resetForm, scheduleInput]);

  const handleToggle = useCallback(async (jobId: string, enabled: boolean) => {
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
  }, [load]);

  const handleRunNow = useCallback(async (jobId: string) => {
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
  }, [load]);

  const handleDelete = useCallback(async (jobId: string) => {
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
  }, [editingJobId, load, resetForm, selectedJobId]);

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

  const handleRetryReviewItem = useCallback(async (itemId: string) => {
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
  }, [load]);

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
        hint="Use cron for scheduled operational jobs, then handle notable outputs through the review queue instead of chasing them across multiple pages."
        actions={(
          <div className="workflow-summary-strip">
            <StatusChip tone="muted">{data.items.length} jobs</StatusChip>
            <StatusChip tone={!reviewQueueEnabled ? "muted" : reviewQueue.length > 0 ? "warning" : "success"}>
              {reviewQueueEnabled ? `${reviewQueue.length} review items` : "Review queue off"}
            </StatusChip>
            {selectedJob ? <StatusChip tone={selectedJob.enabled ? "success" : "muted"}>{selectedJob.jobId}</StatusChip> : null}
          </div>
        )}
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
          Keep job definitions stable and use the review queue for human follow-up. The queue is where diffs, retries, and notable background outputs should converge.
        </FieldHelp>
      </div>

      <div className="split-grid">
        <Panel title={editingJobId ? `Edit Job: ${editingJobId}` : "Create Job"} subtitle="Define the job identity, schedule, and whether it should be enabled automatically.">
          <div className="controls-row">
            <label htmlFor="cronJobId">Job ID</label>
            <input
              id="cronJobId"
              value={jobIdInput}
              onChange={(event) => setJobIdInput(event.target.value)}
              disabled={Boolean(editingJobId) || isBusy}
              placeholder="nightly-maintenance"
            />
          </div>
          <div className="controls-row">
            <label htmlFor="cronJobName">Name</label>
            <input
              id="cronJobName"
              value={nameInput}
              onChange={(event) => setNameInput(event.target.value)}
              disabled={isBusy}
              placeholder="Nightly Maintenance"
            />
          </div>
          <div className="controls-row">
            <label htmlFor="cronJobSchedule">Schedule</label>
            <input
              id="cronJobSchedule"
              value={scheduleInput}
              onChange={(event) => setScheduleInput(event.target.value)}
              disabled={isBusy}
              placeholder={DEFAULT_SCHEDULE}
            />
          </div>
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
            <ActionButton
              label="Clear"
              onClick={resetForm}
              disabled={isBusy}
            />
          </div>
          <p className="office-subtitle">
            Supported schedule format: <code>M H * * * [Timezone]</code> or <code>M H * * DOW [Timezone]</code>.
          </p>
        </Panel>

        <Panel title="Job Details" subtitle="Current status for the selected job.">
          {!selectedJobDetail ? (
            <p>Select a job to view details.</p>
          ) : (
            <dl className="cron-job-details">
              <dt>Job ID</dt>
              <dd>{selectedJobDetail.jobId}</dd>
              <dt>Name</dt>
              <dd>{selectedJobDetail.name}</dd>
              <dt>Schedule</dt>
              <dd>{selectedJobDetail.schedule}</dd>
              <dt>Enabled</dt>
              <dd>{selectedJobDetail.enabled ? "yes" : "no"}</dd>
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
                <td><code>{job.jobId}</code></td>
                <td><code>{job.schedule}</code></td>
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

      <Panel title="Review Queue" subtitle="Flagged or notable cron outputs that need operator review, diff check, or retry.">
        {!reviewQueueEnabled ? (
          <p className="office-subtitle">
            Review queue is disabled right now. Scheduled jobs still appear above and can be run or edited normally.
          </p>
        ) : reviewQueueError ? <p className="error">{reviewQueueError}</p> : reviewQueue.length === 0 ? (
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
                  <td><code>{item.runId.slice(0, 8)}</code></td>
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

