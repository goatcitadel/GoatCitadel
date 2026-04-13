import type { PromptPackBenchmarkStatusRecord, PromptPackReportRecord } from "@goatcitadel/contracts";
import { formatDateTime } from "./prompt-lab-helpers";

interface PromptLabReportPanelProps {
  report: Pick<PromptPackReportRecord, "runs" | "summary" | "latestAssessments">;
  testOutcomeSummary: {
    runFailureCount: number;
    scoreFailureCount: number;
    reviewCount: number;
    needsScoreCount: number;
    passingCount: number;
  };
  passThreshold: number;
  benchmarkStatus: PromptPackBenchmarkStatusRecord | null;
  regressionStatus: {
    run: {
      regressionRunId: string;
      status: string;
      finishedAt?: string;
      error?: string;
    };
    results: Array<{
      resultId: string;
      testCode: string;
      capability: string;
      scoreDelta: number;
      passDelta: number;
      latencyDeltaMs: number;
    }>;
  } | null;
  trendSeries: Array<{
    capability: string;
    breached?: boolean;
    points: Array<{ value: number }>;
  }>;
}

export function PromptLabReportPanel(props: PromptLabReportPanelProps) {
  const { report, testOutcomeSummary, passThreshold, benchmarkStatus, regressionStatus, trendSeries } = props;
  const hasLegacyOnlyRows = report.latestAssessments.some(
    (assessment) => assessment.legacyScore && !assessment.autoScore,
  );
  const metrics = [
    { label: "Total tests", value: report.summary.totalTests },
    { label: "Executed runs", value: report.summary.completedRuns },
    { label: "Passing tests", value: testOutcomeSummary.passingCount },
    { label: "Review queue", value: testOutcomeSummary.reviewCount },
    { label: "Run failures", value: testOutcomeSummary.runFailureCount },
    { label: "Needs score", value: testOutcomeSummary.needsScoreCount },
    { label: "Auto-scored runs", value: report.summary.autoScoredRuns },
    { label: "Human review", value: report.summary.humanReviewedRuns },
    { label: "Judge fallbacks", value: report.summary.judgeFallbackCount },
    { label: "Judge errors", value: report.summary.judgeErrorCount },
    { label: "Average weighted", value: `${report.summary.averageWeightedScore.toFixed(1)}/100` },
    {
      label: "Effective pass rate",
      value: `${(report.summary.effectivePassRate * 100).toFixed(1)}%`,
      detail: `threshold ${passThreshold}/100`,
    },
  ];

  return (
    <article className="card prompt-lab-surface prompt-lab-summary">
      <div className="prompt-lab-section-heading">
        <h3>Report</h3>
        <span className="office-subtitle">Current pack health</span>
      </div>

      <div className="prompt-lab-report-metrics">
        {metrics.map((metric) => (
          <div key={metric.label} className="prompt-lab-report-metric">
            <span className="prompt-lab-overview-label">{metric.label}</span>
            <strong>{metric.value}</strong>
            {metric.detail ? <p className="office-subtitle">{metric.detail}</p> : null}
          </div>
        ))}
      </div>

      <div className="prompt-lab-report-notes">
        <p>Failed runs: {report.summary.failedRuns}</p>
        <p>Invalid latest runs: {report.summary.invalidLatestRuns}</p>
        <p>Degraded auto scores: {report.summary.degradedScoreCount}</p>
        <p>Fail verdicts: {testOutcomeSummary.scoreFailureCount}</p>
        <p>Review rate: {(report.summary.reviewRate * 100).toFixed(1)}%</p>
        <p>Durable-backed latest runs: {report.summary.durableRuns ?? 0}</p>
        <p>Approval-paused latest runs: {report.summary.approvalPausedRuns ?? 0}</p>
        <p>Backgrounded latest runs: {report.summary.backgroundedRuns ?? 0}</p>
        <p>Failing tests: {report.summary.failingCodes.length > 0 ? report.summary.failingCodes.join(", ") : "none"}</p>
      </div>

      <p className="office-subtitle">
        Comparison score and release verdict are now separate. Review means the run can still be useful for regression
        comparison while staying out of the automatic ship lane.
      </p>
      {hasLegacyOnlyRows ? (
        <p className="office-subtitle">Legacy v1 history is shown as read-only and is kept out of v2 trend math.</p>
      ) : null}
      {benchmarkStatus ? (
        <section>
          <h4>Latest benchmark</h4>
          <p>
            Run: <code>{benchmarkStatus.run.benchmarkRunId}</code> • {benchmarkStatus.run.status} (
            {benchmarkStatus.progress.completedItems}/{benchmarkStatus.progress.totalItems})
          </p>
          {benchmarkStatus.modelSummaries.length > 0 ? (
            <table className="prompt-lab-benchmark-table gc-data-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Pass rate</th>
                  <th>Review rate</th>
                  <th>Avg weighted</th>
                  <th>Run failures</th>
                  <th>Top signals</th>
                </tr>
              </thead>
              <tbody>
                {benchmarkStatus.modelSummaries.map((summary) => (
                  <tr key={`${summary.providerId}/${summary.model}`}>
                    <td>
                      {summary.providerId}/{summary.model}
                    </td>
                    <td>{(summary.passRate * 100).toFixed(1)}%</td>
                    <td>{(summary.reviewRate * 100).toFixed(1)}%</td>
                    <td>{summary.averageWeightedScore.toFixed(1)}/100</td>
                    <td>{summary.runFailures}</td>
                    <td>
                      {summary.topFailureSignals.length > 0
                        ? summary.topFailureSignals.map((item) => `${item.signal} (${item.count})`).join(", ")
                        : "none"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="office-subtitle">No benchmark items recorded yet.</p>
          )}
        </section>
      ) : null}
      {regressionStatus ? (
        <section>
          <h4>Latest replay regression</h4>
          <p>
            Run: <code>{regressionStatus.run.regressionRunId}</code> • {regressionStatus.run.status}
            {regressionStatus.run.finishedAt ? ` • finished ${formatDateTime(regressionStatus.run.finishedAt)}` : ""}
          </p>
          {regressionStatus.run.error ? <p className="error">{regressionStatus.run.error}</p> : null}
          {regressionStatus.results.length > 0 ? (
            <table className="prompt-lab-benchmark-table gc-data-table">
              <thead>
                <tr>
                  <th>Test</th>
                  <th>Capability</th>
                  <th>Score Δ</th>
                  <th>Pass Δ</th>
                  <th>Latency Δ</th>
                </tr>
              </thead>
              <tbody>
                {regressionStatus.results.slice(0, 30).map((item) => (
                  <tr key={item.resultId}>
                    <td>{item.testCode}</td>
                    <td>{item.capability}</td>
                    <td>{item.scoreDelta.toFixed(2)}</td>
                    <td>{item.passDelta.toFixed(2)}</td>
                    <td>{Math.round(item.latencyDeltaMs)} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="office-subtitle">No regression results recorded yet.</p>
          )}
        </section>
      ) : null}
      {trendSeries.length > 0 ? (
        <section>
          <h4>Capability trend alerts</h4>
          <div className="token-row">
            {trendSeries.map((series) => (
              <span key={series.capability} className={`token-chip${series.breached ? " token-chip-alert" : ""}`}>
                {series.capability}:{" "}
                {series.points.length > 0 ? series.points[series.points.length - 1]?.value.toFixed(2) : "n/a"}
                {series.breached ? " (threshold breached)" : ""}
              </span>
            ))}
          </div>
        </section>
      ) : null}
    </article>
  );
}


