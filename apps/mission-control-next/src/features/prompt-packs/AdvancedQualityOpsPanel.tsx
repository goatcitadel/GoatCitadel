import {
  AlertTriangle,
  ClipboardCopy,
  Download,
  FlaskConical,
  LoaderCircle,
  RefreshCcw,
  RotateCcw,
} from "lucide-react";
import type { PromptPackExportRecord } from "@goatcitadel/contracts";
import { formatDateTime } from "@goatcitadel/mission-control-shared/pages/prompt-lab/prompt-lab-helpers";

export interface AdvancedQualityOpsPanelProps {
  benchmarkTestCodes: string;
  benchmarkProvidersInput: string;
  selectedPackId: string | null;
  running: boolean;
  benchmarkPending: boolean;
  benchmarkActive: boolean;
  benchmarkStopping: boolean;
  benchmarkRunId: string | null;
  regressionPending: boolean;
  regressionRunId: string | null;
  exporting: boolean;
  latestSavedLogPath: string;
  resetClearRuns: boolean;
  resetClearScores: boolean;
  confirmResetArmed: boolean;
  resetting: boolean;
  exportInfo: PromptPackExportRecord | null;
  onSetBenchmarkTestCodes: (value: string) => void;
  onSetBenchmarkProvidersInput: (value: string) => void;
  onRunBenchmark: () => void;
  onStopBenchmark: () => void;
  onRefreshBenchmark: () => void;
  onRunRegression: () => void;
  onRefreshRegression: () => void;
  onExportReport: () => void;
  onCopyExportPath: () => void;
  onSetResetClearRuns: (value: boolean) => void;
  onSetResetClearScores: (value: boolean) => void;
  onArmResetConfirm: () => void;
  onConfirmResetPack: () => void;
  onCancelResetConfirm: () => void;
}

export function AdvancedQualityOpsPanel({
  benchmarkTestCodes,
  benchmarkProvidersInput,
  selectedPackId,
  running,
  benchmarkPending,
  benchmarkActive,
  benchmarkStopping,
  benchmarkRunId,
  regressionPending,
  regressionRunId,
  exporting,
  latestSavedLogPath,
  resetClearRuns,
  resetClearScores,
  confirmResetArmed,
  resetting,
  exportInfo,
  onSetBenchmarkTestCodes,
  onSetBenchmarkProvidersInput,
  onRunBenchmark,
  onStopBenchmark,
  onRefreshBenchmark,
  onRunRegression,
  onRefreshRegression,
  onExportReport,
  onCopyExportPath,
  onSetResetClearRuns,
  onSetResetClearScores,
  onArmResetConfirm,
  onConfirmResetPack,
  onCancelResetConfirm,
}: AdvancedQualityOpsPanelProps) {
  return (
    <details className="mc-pp-panel mc-pp-panel-collapsible">
      <summary>
        <div>
          <h4>Advanced quality ops</h4>
          <p>Benchmark, replay, export, and reset stay nearby without crowding the default view.</p>
        </div>
      </summary>
      <div className="mc-pp-advanced-grid">
        <label className="mc-pp-field">
          <span>Test codes</span>
          <textarea
            rows={2}
            value={benchmarkTestCodes}
            onChange={(event) => onSetBenchmarkTestCodes(event.target.value)}
            placeholder="TEST-03, TEST-06, TEST-10"
          />
        </label>
        <label className="mc-pp-field">
          <span>Benchmark matrix</span>
          <textarea
            rows={4}
            value={benchmarkProvidersInput}
            onChange={(event) => onSetBenchmarkProvidersInput(event.target.value)}
            placeholder={"openai/gpt-5.4-mini\nmoonshot/kimi-k2.6"}
          />
        </label>
        <div className="mc-pp-inline-actions wrap">
          <button
            type="button"
            className="mc-next-button mc-next-button-secondary"
            onClick={onRunBenchmark}
            disabled={!selectedPackId || running || benchmarkPending}
          >
            {benchmarkPending ? <LoaderCircle size={16} className="mc-spin" /> : <FlaskConical size={16} />}
            Start benchmark
          </button>
          <button
            type="button"
            className="mc-next-button mc-next-button-secondary"
            onClick={onStopBenchmark}
            disabled={!benchmarkActive || benchmarkStopping}
          >
            {benchmarkStopping ? <LoaderCircle size={16} className="mc-spin" /> : <RotateCcw size={16} />}
            Stop
          </button>
          <button
            type="button"
            className="mc-next-button mc-next-button-ghost"
            onClick={onRefreshBenchmark}
            disabled={!benchmarkRunId}
          >
            <RefreshCcw size={16} />
            Refresh benchmark
          </button>
          <button
            type="button"
            className="mc-next-button mc-next-button-secondary"
            onClick={onRunRegression}
            disabled={!selectedPackId || running || regressionPending}
          >
            {regressionPending ? <LoaderCircle size={16} className="mc-spin" /> : <RotateCcw size={16} />}
            Replay regression
          </button>
          <button
            type="button"
            className="mc-next-button mc-next-button-ghost"
            onClick={onRefreshRegression}
            disabled={!regressionRunId}
          >
            <RefreshCcw size={16} />
            Refresh replay
          </button>
        </div>
        <div className="mc-pp-inline-actions wrap">
          <button
            type="button"
            className="mc-next-button mc-next-button-secondary"
            onClick={onExportReport}
            disabled={!selectedPackId || exporting || running}
          >
            {exporting ? <LoaderCircle size={16} className="mc-spin" /> : <Download size={16} />}
            Export report
          </button>
          <button
            type="button"
            className="mc-next-button mc-next-button-ghost"
            onClick={onCopyExportPath}
            disabled={!latestSavedLogPath}
          >
            <ClipboardCopy size={16} />
            Copy saved log path
          </button>
        </div>
        <div className="mc-pp-reset-box">
          <div className="mc-pp-reset-options">
            <label className="mc-pp-toggle">
              <input
                type="checkbox"
                checked={resetClearRuns}
                onChange={(event) => onSetResetClearRuns(event.target.checked)}
              />
              <span>Clear runs</span>
            </label>
            <label className="mc-pp-toggle">
              <input
                type="checkbox"
                checked={resetClearScores}
                onChange={(event) => onSetResetClearScores(event.target.checked)}
              />
              <span>Clear scores</span>
            </label>
          </div>
          {!confirmResetArmed ? (
            <button
              type="button"
              className="mc-next-button mc-next-button-danger"
              onClick={onArmResetConfirm}
              disabled={!selectedPackId || resetting}
            >
              <AlertTriangle size={16} />
              Reset pack
            </button>
          ) : (
            <div className="mc-pp-reset-confirm">
              <p>Reset this pack now? This clears the selected history based on the toggles above.</p>
              <div className="mc-pp-inline-actions wrap">
                <button
                  type="button"
                  className="mc-next-button mc-next-button-danger"
                  onClick={onConfirmResetPack}
                  disabled={resetting}
                >
                  {resetting ? <LoaderCircle size={16} className="mc-spin" /> : <AlertTriangle size={16} />}
                  Confirm reset
                </button>
                <button
                  type="button"
                  className="mc-next-button mc-next-button-ghost"
                  onClick={onCancelResetConfirm}
                  disabled={resetting}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
        {exportInfo?.path ? (
          <p className="mc-pp-note">
            Export file: <code>{exportInfo.path}</code>
            {exportInfo.updatedAt ? ` • updated ${formatDateTime(exportInfo.updatedAt)}` : ""}
            {exportInfo.exists ? ` • ${exportInfo.sizeBytes} bytes` : " • not generated yet"}
          </p>
        ) : null}
      </div>
    </details>
  );
}
