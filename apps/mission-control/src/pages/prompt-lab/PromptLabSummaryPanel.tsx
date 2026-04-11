import type { PromptPackBenchmarkStatusRecord } from "@goatcitadel/contracts";
import { ActionButton } from "../../components/ActionButton";
import type { ActiveRunState } from "./prompt-lab-types";

interface PromptLabOverviewCard {
  label: string;
  value: string;
  detail: string;
}

interface PromptLabExportInfo {
  packId: string;
  path: string;
  exists: boolean;
  sizeBytes: number;
  updatedAt?: string;
}

interface PromptLabSummaryPanelProps {
  title: string;
  subtitle?: string;
  overviewCards: PromptLabOverviewCard[];
  activeRun: ActiveRunState | null;
  benchmarkStatus: PromptPackBenchmarkStatusRecord | null;
  isRefreshing: boolean;
  isFallbackRefreshing: boolean;
  error: string | null;
  success: string | null;
  resetClearRuns: boolean;
  resetClearScores: boolean;
  hasSelectedPack: boolean;
  running: boolean;
  resetting: boolean;
  exporting: boolean;
  importing: boolean;
  autoScoring: boolean;
  autoScoreOnRun: boolean;
  unscoredCompletedCount: number;
  exportInfo: PromptLabExportInfo | null;
  benchmarkPending: boolean;
  testOutcomeSummary: {
    runFailureCount: number;
    scoreFailureCount: number;
    needsScoreCount: number;
  };
  onResetClearRunsChange: (checked: boolean) => void;
  onResetClearScoresChange: (checked: boolean) => void;
  onCopyExportPath: () => void;
  onRunNext: () => void;
  onRunAll: () => void;
  onRunBenchmark: () => void;
  onRefreshData: () => void;
  onAutoScoreUnscored: () => void;
  onExportNow: () => void;
  onResetPack: () => void;
}

export function PromptLabSummaryPanel({
  title,
  subtitle,
  overviewCards,
  activeRun,
  benchmarkStatus,
  isRefreshing,
  isFallbackRefreshing,
  error,
  success,
  resetClearRuns,
  resetClearScores,
  hasSelectedPack,
  running,
  resetting,
  exporting,
  importing,
  autoScoring,
  autoScoreOnRun,
  unscoredCompletedCount,
  exportInfo,
  benchmarkPending,
  testOutcomeSummary,
  onResetClearRunsChange,
  onResetClearScoresChange,
  onCopyExportPath,
  onRunNext,
  onRunAll,
  onRunBenchmark,
  onRefreshData,
  onAutoScoreUnscored,
  onExportNow,
  onResetPack,
}: PromptLabSummaryPanelProps) {
  return (
    <div className="prompt-lab-shell-card">
      <header className="prompt-lab-hero">
        <div className="prompt-lab-hero-copy">
          <p className="prompt-lab-kicker">Evaluation Console</p>
          <h2>{title}</h2>
          <p className="prompt-lab-intro">{subtitle}</p>
          <p className="office-subtitle">
            Re-running a test creates a fresh run. Historical scores stay attached to older runs until you review the
            new output.
          </p>
        </div>

        <div className="prompt-lab-hero-actions">
          <div className="prompt-lab-actions prompt-lab-action-cluster">
            <span className="prompt-lab-action-label">Run lane</span>
            <div className="prompt-lab-actions">
              <ActionButton
                label="Run next test"
                pending={activeRun?.mode === "next"}
                disabled={running && activeRun?.mode !== "next"}
                onClick={onRunNext}
              />
              <ActionButton
                label="Run all"
                pending={activeRun?.mode === "all"}
                disabled={running && activeRun?.mode !== "all"}
                onClick={onRunAll}
              />
              <ActionButton
                label="Run benchmark"
                pending={benchmarkPending}
                disabled={!hasSelectedPack || running || importing}
                onClick={onRunBenchmark}
              />
              <ActionButton label="Refresh data" pending={isRefreshing} onClick={onRefreshData} />
            </div>
          </div>

          <div className="prompt-lab-actions prompt-lab-action-cluster">
            <span className="prompt-lab-action-label">Pack ops</span>
            <div className="prompt-lab-actions">
              <ActionButton
                label="Auto score unscored"
                pending={autoScoring}
                disabled={!hasSelectedPack || unscoredCompletedCount === 0 || running}
                onClick={onAutoScoreUnscored}
              />
              <ActionButton
                label="Export now"
                pending={exporting}
                disabled={!hasSelectedPack || running || resetting}
                onClick={onExportNow}
              />
              <ActionButton
                label="Reset pack"
                pending={resetting}
                disabled={!hasSelectedPack || running || exporting || importing || autoScoring}
                onClick={onResetPack}
              />
            </div>
          </div>
        </div>
      </header>

      <section className="prompt-lab-overview" aria-label="Prompt Lab summary">
        {overviewCards.map((card) => (
          <article key={card.label} className="prompt-lab-overview-card">
            <span className="prompt-lab-overview-label">{card.label}</span>
            <strong>{card.value}</strong>
            <p>{card.detail}</p>
          </article>
        ))}
      </section>

      {error ? <p className="error">{error}</p> : null}
      {success ? <p className="status-banner">{success}</p> : null}

      <section className="prompt-lab-status-stack">
        <div className="prompt-lab-status-grid">
          {activeRun ? (
            <div className="status-banner">
              Run in progress: {activeRun.testCode ?? "prompt-pack run"} ({activeRun.mode})
            </div>
          ) : null}
          {benchmarkStatus ? (
            <div className="status-banner">
              Benchmark {benchmarkStatus.run.benchmarkRunId}: {benchmarkStatus.run.status} (
              {benchmarkStatus.progress.completedItems}/{benchmarkStatus.progress.totalItems})
            </div>
          ) : null}
          {isRefreshing ? (
            <div className="status-banner">Refreshing prompt-pack results in the background...</div>
          ) : null}
          {isFallbackRefreshing ? (
            <div className="status-banner warning">Live updates degraded, checking periodically.</div>
          ) : null}
          <div className="status-banner warning">
            {autoScoreOnRun
              ? "Auto-score is ON (model + rule checks). You can still edit any score manually."
              : "Run status only confirms execution. Pass rate updates after scoring."}
            {unscoredCompletedCount > 0 ? ` ${unscoredCompletedCount} run(s) still need scoring.` : ""}
          </div>
          <div className="status-banner">
            Run failures: <strong>{testOutcomeSummary.runFailureCount}</strong> | Score failures:{" "}
            <strong>{testOutcomeSummary.scoreFailureCount}</strong> | Needs score:{" "}
            <strong>{testOutcomeSummary.needsScoreCount}</strong>
          </div>
        </div>

        <div className="prompt-lab-ops-row">
          <div className="status-banner prompt-lab-reset-banner">
            <span className="prompt-lab-inline-label">Reset options</span>
            <label>
              <input
                type="checkbox"
                checked={resetClearRuns}
                onChange={(event) => onResetClearRunsChange(event.target.checked)}
                disabled={running || resetting || exporting || importing || autoScoring}
              />{" "}
              Clear runs
            </label>
            <label>
              <input
                type="checkbox"
                checked={resetClearScores}
                onChange={(event) => onResetClearScoresChange(event.target.checked)}
                disabled={running || resetting || exporting || importing || autoScoring}
              />{" "}
              Clear scores
            </label>
          </div>

          {exportInfo?.path ? (
            <div className="status-banner prompt-lab-export-banner">
              <div>
                Export file: <code>{exportInfo.path}</code>
                {exportInfo.updatedAt ? ` (updated ${new Date(exportInfo.updatedAt).toLocaleTimeString()})` : ""}
                {exportInfo.exists ? ` • ${exportInfo.sizeBytes} bytes` : " • not generated yet"}
              </div>
              <button type="button" onClick={onCopyExportPath} className="gc-button">
                Copy path
              </button>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
