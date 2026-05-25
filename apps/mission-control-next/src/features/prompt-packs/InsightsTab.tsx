import type { PromptPackBenchmarkStatusRecord, PromptPackReportRecord } from "@goatcitadel/contracts";
import type {
  fetchPromptPackReplayRegressionStatus,
  fetchPromptPackTrends,
} from "@goatcitadel/mission-control-shared/api/client";
import { formatPromptPackExecutionStyle, type PromptPackTestOutcomeSummary } from "./PromptPacksWorkbenchPage.helpers";

type TrendSeries = Awaited<ReturnType<typeof fetchPromptPackTrends>>["items"];
type RegressionStatus = Awaited<ReturnType<typeof fetchPromptPackReplayRegressionStatus>> | null;

export interface InsightsTabProps {
  report: {
    runs: unknown;
    latestAssessments: unknown;
    summary: PromptPackReportRecord["summary"];
  } | null;
  testOutcomeSummary: PromptPackTestOutcomeSummary;
  passThreshold: number;
  trendSeries: TrendSeries;
  benchmarkStatus: PromptPackBenchmarkStatusRecord | null;
  regressionStatus: RegressionStatus;
}

export function InsightsTab({
  report,
  testOutcomeSummary,
  passThreshold,
  trendSeries,
  benchmarkStatus,
  regressionStatus,
}: InsightsTabProps) {
  return (
    <div className="mc-pp-tab-grid">
      <section className="mc-pp-surface">
        <div className="mc-pp-section-heading">
          <div>
            <h5>Pack insights</h5>
            <p>Quality snapshot, benchmark posture, replay status, and trend alerts.</p>
          </div>
        </div>
        <div className="mc-pp-insight-metrics">
          <article className="mc-pp-metric-card">
            <span>Total tests</span>
            <strong>{report?.summary.totalTests ?? 0}</strong>
            <p>{report?.summary.completedRuns ?? 0} completed runs</p>
          </article>
          <article className="mc-pp-metric-card">
            <span>Passing</span>
            <strong>{testOutcomeSummary.passingCount}</strong>
            <p>{testOutcomeSummary.reviewCount} in review</p>
          </article>
          <article className="mc-pp-metric-card">
            <span>Average weighted</span>
            <strong>{report ? `${report.summary.averageWeightedScore.toFixed(1)}/100` : "n/a"}</strong>
            <p>Threshold {passThreshold}/100</p>
          </article>
          <article className="mc-pp-metric-card">
            <span>Effective pass rate</span>
            <strong>{report ? `${(report.summary.effectivePassRate * 100).toFixed(1)}%` : "n/a"}</strong>
            <p>
              {report?.summary.reviewRate
                ? `${(report.summary.reviewRate * 100).toFixed(1)}% review rate`
                : "No review rate yet"}
            </p>
          </article>
        </div>
        {trendSeries.length > 0 ? (
          <div className="mc-pp-trend-row">
            {trendSeries.map((series) => (
              <span key={series.capability} className={`mc-pp-chip trend${series.breached ? " breached" : ""}`}>
                {series.capability}:{" "}
                {series.points.length > 0 ? series.points[series.points.length - 1]?.value.toFixed(2) : "n/a"}
              </span>
            ))}
          </div>
        ) : null}
        {benchmarkStatus ? (
          <details className="mc-pp-evidence-details" open>
            <summary>Latest benchmark</summary>
            <p className="mc-pp-note">
              Execution style: {formatPromptPackExecutionStyle(benchmarkStatus.run.executionStyle)}
            </p>
            <div className="mc-pp-table-wrap">
              <table className="mc-pp-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Pass rate</th>
                    <th>Review rate</th>
                    <th>Avg</th>
                    <th>Failures</th>
                  </tr>
                </thead>
                <tbody>
                  {benchmarkStatus.modelSummaries.slice(0, 10).map((summary) => (
                    <tr key={`${summary.providerId}/${summary.model}`}>
                      <td>
                        {summary.providerId}/{summary.model}
                      </td>
                      <td>{(summary.passRate * 100).toFixed(1)}%</td>
                      <td>{(summary.reviewRate * 100).toFixed(1)}%</td>
                      <td>{summary.averageWeightedScore.toFixed(1)}</td>
                      <td>{summary.runFailures}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ) : null}
        {regressionStatus ? (
          <details className="mc-pp-evidence-details" open>
            <summary>Latest replay regression</summary>
            <div className="mc-pp-table-wrap">
              <table className="mc-pp-table">
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
                  {regressionStatus.results.slice(0, 12).map((item) => (
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
            </div>
          </details>
        ) : null}
      </section>
    </div>
  );
}
