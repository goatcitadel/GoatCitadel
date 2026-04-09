import type {
  PromptPackBenchmarkStatusRecord,
  PromptPackRunRecord,
  PromptPackScoreRecord,
} from "@goatcitadel/contracts";
import { formatDateTime } from "./prompt-lab-helpers";

interface PromptLabReportPanelProps {
  report: {
    runs: PromptPackRunRecord[];
    scores: PromptPackScoreRecord[];
    summary: {
      totalTests: number;
      completedRuns: number;
      failedRuns: number;
      durableRuns?: number;
      approvalPausedRuns?: number;
      backgroundedRuns?: number;
      passThreshold: number;
      averageTotalScore: number;
      passRate: number;
      failingCodes: string[];
    };
  };
  testOutcomeSummary: {
    runFailureCount: number;
    scoreFailureCount: number;
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

  return (
    <article className="card prompt-lab-surface prompt-lab-summary">
      <h3>Report</h3>
      <p>Total tests: {report.summary.totalTests}</p>
      <p>Executed runs: {report.summary.completedRuns}</p>
      <p>Failed runs: {report.summary.failedRuns}</p>
      <p>Scored runs: {report.scores.length}</p>
      <p>Run failures (execution/runtime): {testOutcomeSummary.runFailureCount}</p>
      <p>Score failures (completed but below threshold): {testOutcomeSummary.scoreFailureCount}</p>
      <p>Runs waiting for score: {testOutcomeSummary.needsScoreCount}</p>
      <p>Durable-backed latest runs: {report.summary.durableRuns ?? 0}</p>
      <p>Approval-paused latest runs: {report.summary.approvalPausedRuns ?? 0}</p>
      <p>Backgrounded latest runs: {report.summary.backgroundedRuns ?? 0}</p>
      <p>Passing tests: {testOutcomeSummary.passingCount}</p>
      <p>Average score: {report.summary.averageTotalScore.toFixed(2)}/10</p>
      <p>
        Pass rate: {(report.summary.passRate * 100).toFixed(1)}% (threshold {passThreshold}/10)
      </p>
      <p>Failing tests: {report.summary.failingCodes.length > 0 ? report.summary.failingCodes.join(", ") : "none"}</p>
      <p className="office-subtitle">
        Run failures indicate execution/runtime blockers. Score failures indicate model quality gaps on completed runs.
      </p>
      {benchmarkStatus ? (
        <section>
          <h4>Latest benchmark</h4>
          <p>
            Run: <code>{benchmarkStatus.run.benchmarkRunId}</code> • {benchmarkStatus.run.status} (
            {benchmarkStatus.progress.completedItems}/{benchmarkStatus.progress.totalItems})
          </p>
          {benchmarkStatus.modelSummaries.length > 0 ? (
            <table className="prompt-lab-benchmark-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Pass rate</th>
                  <th>Avg score</th>
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
                    <td>{summary.averageTotalScore.toFixed(2)}</td>
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
            <table className="prompt-lab-benchmark-table">
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
