import { useCallback, useEffect, useMemo, useState } from "react";
import {
  approveImprovementAutoTune,
  draftReplayOverride,
  executeReplayOverride,
  fetchReplayDiff,
  fetchImprovementReplayRun,
  fetchImprovementReplayRuns,
  fetchImprovementReports,
  revertImprovementAutoTune,
  runImprovementReplay,
} from "../api/client";
import { ActionButton } from "../components/ActionButton";
import { FieldHelp } from "../components/FieldHelp";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { PageGuideCard } from "../components/PageGuideCard";
import { StatusChip } from "../components/StatusChip";
import { GCSelect } from "../components/ui";
import { pageCopy } from "../content/copy";
import { useRefreshSubscription } from "../hooks/useRefreshSubscription";

export function ImprovementPage({ workspaceId: _workspaceId }: { workspaceId?: string }) {
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isFallbackRefreshing, setIsFallbackRefreshing] = useState(false);
  const [runningReplay, setRunningReplay] = useState(false);
  const [pendingTuneId, setPendingTuneId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [lastRunEvent, setLastRunEvent] = useState<string | null>(null);
  const [lastRunUpdateAt, setLastRunUpdateAt] = useState<string | null>(null);
  const [reports, setReports] = useState<Awaited<ReturnType<typeof fetchImprovementReports>>["items"]>([]);
  const [replayRuns, setReplayRuns] = useState<Awaited<ReturnType<typeof fetchImprovementReplayRuns>>["items"]>([]);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<Awaited<ReturnType<typeof fetchImprovementReplayRun>> | null>(null);
  const [overrideStepKey, setOverrideStepKey] = useState("");
  const [overrideKind, setOverrideKind] = useState<"tool_output" | "prompt_patch" | "policy_decision">("tool_output");
  const [overrideJson, setOverrideJson] = useState('{"note":"override"}');
  const [overrideBusy, setOverrideBusy] = useState<null | "draft" | "execute">(null);
  const [replayDiff, setReplayDiff] = useState<Awaited<ReturnType<typeof fetchReplayDiff>> | null>(null);

  const load = useCallback(
    async (options?: { background?: boolean }) => {
      const background = options?.background ?? false;
      if (background) {
        setIsRefreshing(true);
      } else {
        setIsInitialLoading(true);
      }
      try {
        const [reportResponse, runResponse] = await Promise.all([
          fetchImprovementReports(60),
          fetchImprovementReplayRuns(80),
        ]);
        setReports(reportResponse.items);
        setReplayRuns(runResponse.items);
        const nextReportId =
          selectedReportId && reportResponse.items.some((item) => item.reportId === selectedReportId)
            ? selectedReportId
            : (reportResponse.items[0]?.reportId ?? null);
        setSelectedReportId(nextReportId);
        const preferredRunId = nextReportId
          ? reportResponse.items.find((item) => item.reportId === nextReportId)?.runId
          : undefined;
        const nextRunId =
          selectedRunId && runResponse.items.some((item) => item.runId === selectedRunId)
            ? selectedRunId
            : (preferredRunId ?? runResponse.items[0]?.runId ?? null);
        setSelectedRunId(nextRunId);
        if (nextRunId) {
          setRunDetail(await fetchImprovementReplayRun(nextRunId));
        } else {
          setRunDetail(null);
        }
        setLastRunUpdateAt(new Date().toISOString());
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        if (background) {
          setIsRefreshing(false);
        } else {
          setIsInitialLoading(false);
        }
      }
    },
    [selectedReportId, selectedRunId],
  );

  useEffect(() => {
    void load({ background: false });
  }, [load]);

  const refreshSelectedRunDetail = useCallback(
    async (runId: string, options?: { refreshListsOnTerminal?: boolean; isCancelled?: () => boolean }) => {
      try {
        const detail = await fetchImprovementReplayRun(runId);
        if (options?.isCancelled?.()) {
          return;
        }
        setRunDetail(detail);
        setReplayRuns((current) => upsertReplayRun(current, detail.run));
        if (detail.run.reportId) {
          setSelectedReportId((prev) => prev ?? detail.run.reportId ?? null);
        }
        setLastRunEvent(`Run ${detail.run.runId.slice(0, 8)} is ${detail.run.status}.`);
        setLastRunUpdateAt(new Date().toISOString());
        if (
          options?.refreshListsOnTerminal !== false &&
          detail.run.status !== "running" &&
          detail.run.status !== "queued"
        ) {
          await load({ background: true });
        }
      } catch {
        // keep last known state when background detail refresh fails
      }
    },
    [load],
  );

  const reportDetail = useMemo(
    () => reports.find((item) => item.reportId === selectedReportId) ?? null,
    [reports, selectedReportId],
  );
  const activeRunStatus = useMemo(() => {
    if (!selectedRunId) {
      return null;
    }
    if (runDetail?.run.runId === selectedRunId) {
      return runDetail.run.status;
    }
    return replayRuns.find((run) => run.runId === selectedRunId)?.status ?? null;
  }, [replayRuns, runDetail, selectedRunId]);

  useRefreshSubscription(
    "improvement",
    async () => {
      if (selectedRunId && (activeRunStatus === "running" || activeRunStatus === "queued")) {
        await refreshSelectedRunDetail(selectedRunId, { refreshListsOnTerminal: true });
        return;
      }
      await load({ background: true });
    },
    {
      enabled: !isInitialLoading,
      coalesceMs: 1200,
      staleMs: 20000,
      pollIntervalMs: selectedRunId && (activeRunStatus === "running" || activeRunStatus === "queued") ? 2000 : 15000,
      onFallbackStateChange: setIsFallbackRefreshing,
    },
  );

  useEffect(() => {
    if (!selectedRunId) {
      setRunDetail(null);
      return;
    }
    let cancelled = false;
    void refreshSelectedRunDetail(selectedRunId, {
      refreshListsOnTerminal: false,
      isCancelled: () => cancelled,
    }).then(() => {
      if (cancelled) {
        return;
      }
    });
    return () => {
      cancelled = true;
    };
  }, [refreshSelectedRunDetail, selectedRunId]);

  const latestSummary = reportDetail?.summary;
  const topItems = useMemo(() => (runDetail?.items ?? []).slice(0, 8), [runDetail?.items]);

  const handleRunNow = useCallback(async () => {
    setRunningReplay(true);
    setError(null);
    setSuccess(null);
    try {
      const replay = await runImprovementReplay({ sampleSize: 500 });
      setReplayRuns((current) => upsertReplayRun(current, replay.run));
      setRunDetail((current) => {
        if (current?.run.runId === replay.run.runId) {
          return {
            ...current,
            run: replay.run,
          };
        }
        return {
          run: replay.run,
          items: [],
          findings: [],
          autoTunes: [],
        };
      });
      if (replay.run.status === "running") {
        setSuccess(`Replay run ${replay.run.runId.slice(0, 8)} started. Results will appear when it finishes.`);
      } else {
        setSuccess(`Replay run ${replay.run.runId.slice(0, 8)} completed.`);
      }
      setLastRunEvent(`Run ${replay.run.runId.slice(0, 8)} started (${replay.run.status}).`);
      setLastRunUpdateAt(new Date().toISOString());
      setSelectedRunId(replay.run.runId);
      await load({ background: true });
      if (replay.report) {
        setSelectedReportId(replay.report.reportId);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunningReplay(false);
    }
  }, [load]);

  const parseOverridePayload = useCallback((): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(overrideJson) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Override payload must be a JSON object.");
      }
      return parsed;
    } catch (err) {
      setError((err as Error).message);
      return null;
    }
  }, [overrideJson]);

  const handleDraftReplay = useCallback(async () => {
    if (!selectedRunId) {
      setError("Select a replay run first.");
      return;
    }
    if (!overrideStepKey.trim()) {
      setError("Step key is required for replay override.");
      return;
    }
    const payload = parseOverridePayload();
    if (!payload) {
      return;
    }
    setOverrideBusy("draft");
    setError(null);
    setSuccess(null);
    try {
      const draft = await draftReplayOverride(selectedRunId, {
        overrides: [
          {
            stepKey: overrideStepKey.trim(),
            overrideKind,
            override: payload,
          },
        ],
      });
      setSuccess(`Replay draft ${draft.replayRunId.slice(0, 8)} created (${draft.status}).`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setOverrideBusy(null);
    }
  }, [overrideKind, overrideStepKey, parseOverridePayload, selectedRunId]);

  const handleExecuteReplay = useCallback(async () => {
    if (!selectedRunId) {
      setError("Select a replay run first.");
      return;
    }
    if (!overrideStepKey.trim()) {
      setError("Step key is required for replay override.");
      return;
    }
    const payload = parseOverridePayload();
    if (!payload) {
      return;
    }
    setOverrideBusy("execute");
    setError(null);
    setSuccess(null);
    try {
      const replay = await executeReplayOverride(selectedRunId, {
        overrides: [
          {
            stepKey: overrideStepKey.trim(),
            overrideKind,
            override: payload,
          },
        ],
      });
      const diff = await fetchReplayDiff(replay.replayRunId);
      setReplayDiff(diff);
      setSuccess(`Replay override executed (${replay.replayRunId.slice(0, 8)}).`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setOverrideBusy(null);
    }
  }, [overrideKind, overrideStepKey, parseOverridePayload, selectedRunId]);

  const handleApproveTune = useCallback(
    async (tuneId: string) => {
      setPendingTuneId(tuneId);
      setError(null);
      setSuccess(null);
      try {
        await approveImprovementAutoTune(tuneId);
        setSuccess("Auto-tune approved and applied.");
        await load({ background: true });
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setPendingTuneId(null);
      }
    },
    [load],
  );

  const handleRevertTune = useCallback(
    async (tuneId: string) => {
      setPendingTuneId(tuneId);
      setError(null);
      setSuccess(null);
      try {
        await revertImprovementAutoTune(tuneId);
        setSuccess("Auto-tune reverted.");
        await load({ background: true });
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setPendingTuneId(null);
      }
    },
    [load],
  );

  if (isInitialLoading) {
    return <p>Loading improvement reports...</p>;
  }

  return (
    <section className="workflow-page improvement-page">
      <PageHeader
        eyebrow="Quality"
        title={pageCopy.improvement.title}
        subtitle={pageCopy.improvement.subtitle}
        hint="Use replay runs, weekly scorecards, and low-risk recommendations to inspect what the system got wrong and decide what to tune next."
        actions={
          <div className="workflow-summary-strip">
            <StatusChip tone="muted">{reports.length} weekly reports</StatusChip>
            <StatusChip tone={selectedRunId ? "success" : "muted"}>{replayRuns.length} replay runs</StatusChip>
            {activeRunStatus ? (
              <StatusChip
                tone={
                  activeRunStatus === "completed" ? "success" : activeRunStatus === "failed" ? "critical" : "warning"
                }
              >
                {activeRunStatus}
              </StatusChip>
            ) : null}
            <ActionButton
              label="Run Replay Now"
              pendingLabel="Running Replay..."
              onClick={handleRunNow}
              pending={runningReplay}
            />
          </div>
        }
      />

      <PageGuideCard
        pageId="improvement"
        what={pageCopy.improvement.guide?.what ?? ""}
        when={pageCopy.improvement.guide?.when ?? ""}
        actions={pageCopy.improvement.guide?.actions ?? []}
      />

      <div className="workflow-status-stack">
        {error ? <p className="error">{error}</p> : null}
        {success ? <p className="status-banner">{success}</p> : null}
        {isRefreshing ? <p className="status-banner">Refreshing improvement reports...</p> : null}
        {isFallbackRefreshing ? (
          <p className="status-banner warning">Live updates degraded, checking periodically.</p>
        ) : null}
        {lastRunEvent ? (
          <p className="office-subtitle">
            {lastRunEvent}
            {lastRunUpdateAt ? ` Last update: ${new Date(lastRunUpdateAt).toLocaleTimeString()}.` : ""}
          </p>
        ) : null}
        <FieldHelp>
          Weekly reports explain what regressed, replay runs let you inspect specifics, and replay overrides let you
          test a change without mutating the baseline run immediately.
        </FieldHelp>
      </div>

      <Panel
        title="Replay Override + Diff"
        subtitle="Draft or execute a step-level override to compare outcomes against the original run."
      >
        <div className="controls-row">
          <label htmlFor="overrideStepKey">Step key</label>
          <input
            id="overrideStepKey"
            value={overrideStepKey}
            onChange={(event) => setOverrideStepKey(event.target.value)}
            placeholder="tool:memory.search"
          />
          <label htmlFor="overrideKind">Override type</label>
          <GCSelect
            id="overrideKind"
            value={overrideKind}
            onChange={(value) => setOverrideKind(value as "tool_output" | "prompt_patch" | "policy_decision")}
            options={[
              { value: "tool_output", label: "tool_output" },
              { value: "prompt_patch", label: "prompt_patch" },
              { value: "policy_decision", label: "policy_decision" },
            ]}
          />
        </div>
        <label htmlFor="overrideJson">Override payload (JSON object)</label>
        <textarea
          id="overrideJson"
          rows={4}
          value={overrideJson}
          onChange={(event) => setOverrideJson(event.target.value)}
          placeholder='{"replacement":"value"}'
        />
        <div className="prompt-lab-actions">
          <ActionButton
            label="Draft replay"
            pending={overrideBusy === "draft"}
            disabled={!selectedRunId}
            onClick={() => void handleDraftReplay()}
          />
          <ActionButton
            label="Execute replay"
            pending={overrideBusy === "execute"}
            disabled={!selectedRunId}
            onClick={() => void handleExecuteReplay()}
          />
        </div>
        {replayDiff ? (
          <details open>
            <summary>Latest replay diff ({replayDiff.replayRunId.slice(0, 8)})</summary>
            <p className="office-subtitle">
              latencyΔ {replayDiff.summary.latencyDeltaMs} ms | inTokΔ {replayDiff.summary.inputTokensDelta} | outTokΔ{" "}
              {replayDiff.summary.outputTokensDelta} | costΔ ${replayDiff.summary.costUsdDelta.toFixed(4)}
            </p>
            <p className="office-subtitle">Error changed: {replayDiff.summary.errorChanged ? "yes" : "no"}</p>
          </details>
        ) : null}
      </Panel>

      <Panel title="Recent Replay Runs" subtitle="Latest replay activity, scored volume, and likely-wrong hotspots.">
        <ul className="improvement-simple-list">
          {replayRuns.map((run) => (
            <li key={run.runId}>
              <button
                type="button"
                className={["gc-button", (selectedRunId === run.runId ? "active" : "")].filter(Boolean).join(" ")}
                onClick={() => setSelectedRunId(run.runId)}
              >
                {new Date(run.startedAt).toLocaleString()}
              </button>
              <div className="prompt-lab-test-meta">
                <span className={`prompt-lab-chip run-${run.status}`}>{run.status}</span>
                <span>
                  {run.totalScored}/{run.totalCandidates} scored
                </span>
                <span>{run.likelyWrongCount} likely wrong</span>
              </div>
              {run.error ? <div className="table-subtext">{run.error}</div> : null}
            </li>
          ))}
        </ul>
        {replayRuns.length === 0 ? <p>No replay runs yet.</p> : null}
      </Panel>

      <div className="prompt-lab-grid">
        <Panel
          className="prompt-lab-tests"
          title="Weekly Reports"
          subtitle="Recent report cards generated from sampled decisions and replay analysis."
        >
          <ul>
            {reports.map((report) => (
              <li key={report.reportId}>
                <button
                  type="button"
                  className={["gc-button", (selectedReportId === report.reportId ? "active" : "")].filter(Boolean).join(" ")}
                  onClick={() => {
                    setSelectedReportId(report.reportId);
                    setSelectedRunId(report.runId);
                  }}
                >
                  {new Date(report.weekEnd).toLocaleDateString()} ({report.summary.sampledDecisions} sampled)
                </button>
                <div className="prompt-lab-test-meta">
                  <span className="prompt-lab-chip run-completed">{report.summary.likelyWrongCount} likely wrong</span>
                  <span>{new Date(report.createdAt).toLocaleString()}</span>
                </div>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel
          className="prompt-lab-detail"
          title="Weekly Scorecard"
          subtitle="Summarized quality movement, cluster themes, and week-over-week changes."
        >
          {!reportDetail ? (
            <p>
              {runDetail?.run.status === "running"
                ? "Replay is still running. A weekly report appears after scoring and clustering complete."
                : "No report selected yet."}
            </p>
          ) : (
            <>
              <div className="improvement-score-grid">
                <div>
                  <strong>Sampled</strong>
                  <p>{latestSummary?.sampledDecisions ?? 0}</p>
                </div>
                <div>
                  <strong>Likely wrong</strong>
                  <p>{latestSummary?.likelyWrongCount ?? 0}</p>
                </div>
                <div>
                  <strong>Wrongness rate</strong>
                  <p>{((latestSummary?.wrongnessRate ?? 0) * 100).toFixed(1)}%</p>
                </div>
                <div>
                  <strong>Duplicates filtered</strong>
                  <p>{latestSummary?.duplicateSuppressedCount ?? 0}</p>
                </div>
                <div>
                  <strong>Improved</strong>
                  <p>{latestSummary?.improvedCount ?? 0}</p>
                </div>
                <div>
                  <strong>Regressed</strong>
                  <p>{latestSummary?.regressedCount ?? 0}</p>
                </div>
              </div>

              <h4>Top clusters</h4>
              <ul className="improvement-simple-list">
                {(latestSummary?.topCauseClasses ?? []).map((entry) => (
                  <li key={`${entry.causeClass}:${entry.count}`}>
                    <strong>{entry.causeClass}</strong> - {entry.count}
                  </li>
                ))}
              </ul>

              <h4>Week-over-week</h4>
              <details open>
                <summary>What changed</summary>
                <div className="improvement-compare-grid">
                  <div>
                    <strong>Improved</strong>
                    <ul className="improvement-simple-list">
                      {(reportDetail.weekOverWeek.improved.length > 0
                        ? reportDetail.weekOverWeek.improved
                        : ["none"]
                      ).map((line) => (
                        <li key={`imp-${line}`}>{line}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <strong>Regressed</strong>
                    <ul className="improvement-simple-list">
                      {(reportDetail.weekOverWeek.regressed.length > 0
                        ? reportDetail.weekOverWeek.regressed
                        : ["none"]
                      ).map((line) => (
                        <li key={`reg-${line}`}>{line}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </details>
            </>
          )}
        </Panel>
      </div>

      <div className="split-grid">
        <Panel title="Applied Low-Risk Auto-Tunes" subtitle="Changes already applied from safe queued recommendations.">
          <div className="stack-md">
            {(reportDetail?.appliedAutoTunes ?? []).map((tune) => (
              <div key={tune.tuneId} className="prompt-lab-run-summary">
                <p>
                  <strong>{tune.tuneClass}</strong> - {tune.description}
                </p>
                <p>
                  Status: {tune.status} | Risk: {tune.riskLevel}
                </p>
                <div className="actions">
                  <ActionButton
                    label="Revert"
                    pendingLabel="Reverting..."
                    onClick={() => handleRevertTune(tune.tuneId)}
                    pending={pendingTuneId === tune.tuneId}
                  />
                </div>
              </div>
            ))}
            {(reportDetail?.appliedAutoTunes.length ?? 0) === 0 ? <p>No applied tunes in this report.</p> : null}
          </div>
        </Panel>

        <Panel title="Queued Recommendations" subtitle="Suggestions ready for operator review or explicit approval.">
          <div className="stack-md">
            {(reportDetail?.queuedRecommendations ?? []).map((tune) => (
              <div key={tune.tuneId} className="prompt-lab-run-summary">
                <p>
                  <strong>{tune.tuneClass}</strong> - {tune.description}
                </p>
                <p>
                  Status: {tune.status} | Risk: {tune.riskLevel}
                </p>
                <div className="actions">
                  <ActionButton
                    label="Approve"
                    pendingLabel="Applying..."
                    onClick={() => handleApproveTune(tune.tuneId)}
                    pending={pendingTuneId === tune.tuneId}
                    disabled={tune.riskLevel !== "low"}
                  />
                </div>
              </div>
            ))}
            {(reportDetail?.queuedRecommendations.length ?? 0) === 0 ? (
              <p>No queued recommendations in this report.</p>
            ) : null}
          </div>
        </Panel>
      </div>

      <Panel
        title="Top Wrong Decisions (Current Run)"
        subtitle="Highest-confidence issues from the currently selected replay run."
      >
        {runDetail ? (
          <>
            <p className="office-subtitle">
              Status: {runDetail.run.status} | Scored {runDetail.run.totalScored}/{runDetail.run.totalCandidates}
              {runDetail.run.finishedAt ? ` | Finished ${new Date(runDetail.run.finishedAt).toLocaleString()}` : ""}
            </p>
            {runDetail.run.error ? <p className="error">{runDetail.run.error}</p> : null}
            <ul className="improvement-simple-list">
              {topItems.map((item) => (
                <li key={item.itemId}>
                  <strong>{item.causeClass}</strong> - {Math.round(item.wrongnessProbability * 100)}% wrongness
                  <div className="table-subtext">
                    {item.summary ?? `${item.decisionType} ${item.turnId ?? item.toolRunId ?? ""}`}
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>No run data available.</p>
        )}
      </Panel>
    </section>
  );
}

function upsertReplayRun<T extends { runId: string; startedAt: string }>(current: T[], next: T): T[] {
  const index = current.findIndex((item) => item.runId === next.runId);
  if (index === -1) {
    return [next, ...current].sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
  }
  const copy = [...current];
  copy[index] = next;
  return copy.sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
}
