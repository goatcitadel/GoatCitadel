import {
  AlertTriangle,
  ClipboardCopy,
  Download,
  FlaskConical,
  LoaderCircle,
  RefreshCcw,
  RotateCcw,
} from "lucide-react";
import type { PromptPackExportRecord, PromptRetuneCampaignRecord } from "@goatcitadel/contracts";
import { formatDateTime } from "@goatcitadel/mission-control-shared/pages/prompt-lab/prompt-lab-helpers";
import { NativeButton } from "@next/features/native-routes/primitives";

export interface AdvancedQualityOpsPanelProps {
  retuneEnabled: boolean;
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
  retuneCampaign: PromptRetuneCampaignRecord | null;
  retuneRepeatCount: number;
  retuneHypothesis: string;
  retunePending: boolean;
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
  onSetRetuneRepeatCount: (value: number) => void;
  onSetRetuneHypothesis: (value: string) => void;
  onCreateRetuneCampaign: () => void;
  onMeasureRetuneNoise: () => void;
  onRunRetuneCandidate: () => void;
  onRefreshRetuneCampaign: () => void;
  onCancelRetuneCampaign: () => void;
  onDispositionRetunePass: (passId: string, disposition: "kept" | "rejected" | "inconclusive") => void;
}

export function AdvancedQualityOpsPanel({
  retuneEnabled,
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
  retuneCampaign,
  retuneRepeatCount,
  retuneHypothesis,
  retunePending,
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
  onSetRetuneRepeatCount,
  onSetRetuneHypothesis,
  onCreateRetuneCampaign,
  onMeasureRetuneNoise,
  onRunRetuneCandidate,
  onRefreshRetuneCampaign,
  onCancelRetuneCampaign,
  onDispositionRetunePass,
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
            aria-label="Test codes"
            rows={2}
            value={benchmarkTestCodes}
            onChange={(event) => onSetBenchmarkTestCodes(event.target.value)}
            placeholder="TEST-03, TEST-06, TEST-10"
          />
        </label>
        <label className="mc-pp-field">
          <span>Benchmark matrix</span>
          <textarea
            aria-label="Benchmark matrix"
            rows={4}
            value={benchmarkProvidersInput}
            onChange={(event) => onSetBenchmarkProvidersInput(event.target.value)}
            placeholder={"openai/gpt-5.4-mini\nmoonshot/kimi-k2.6"}
          />
        </label>
        <div className="mc-pp-inline-actions wrap">
          <NativeButton
            variant="secondary"
            onClick={onRunBenchmark}
            disabled={!selectedPackId || running || benchmarkPending}
          >
            {benchmarkPending ? <LoaderCircle size={16} className="mc-spin" /> : <FlaskConical size={16} />}
            Start benchmark
          </NativeButton>
          <NativeButton variant="secondary" onClick={onStopBenchmark} disabled={!benchmarkActive || benchmarkStopping}>
            {benchmarkStopping ? <LoaderCircle size={16} className="mc-spin" /> : <RotateCcw size={16} />}
            Stop
          </NativeButton>
          <NativeButton variant="ghost" onClick={onRefreshBenchmark} disabled={!benchmarkRunId}>
            <RefreshCcw size={16} />
            Refresh benchmark
          </NativeButton>
          <NativeButton
            variant="secondary"
            onClick={onRunRegression}
            disabled={!selectedPackId || running || regressionPending}
          >
            {regressionPending ? <LoaderCircle size={16} className="mc-spin" /> : <RotateCcw size={16} />}
            Replay regression
          </NativeButton>
          <NativeButton variant="ghost" onClick={onRefreshRegression} disabled={!regressionRunId}>
            <RefreshCcw size={16} />
            Refresh replay
          </NativeButton>
        </div>
        <div className="mc-pp-inline-actions wrap">
          <NativeButton variant="secondary" onClick={onExportReport} disabled={!selectedPackId || exporting || running}>
            {exporting ? <LoaderCircle size={16} className="mc-spin" /> : <Download size={16} />}
            Export report
          </NativeButton>
          <NativeButton variant="ghost" onClick={onCopyExportPath} disabled={!latestSavedLogPath}>
            <ClipboardCopy size={16} />
            Copy saved log path
          </NativeButton>
        </div>
        {retuneEnabled ? (
          <div className="mc-pp-reset-box">
            <div>
              <h5>Measurement-first retuning</h5>
              <p className="mc-pp-note">
                Freeze this matrix, measure A/A noise, then require candidate gains to clear the preregistered bar. No
                prompt is edited or promoted automatically.
              </p>
            </div>
            <label className="mc-pp-field">
              <span>Repetitions (2–10)</span>
              <input
                type="number"
                min={2}
                max={10}
                value={retuneRepeatCount}
                disabled={Boolean(retuneCampaign)}
                onChange={(event) => onSetRetuneRepeatCount(Math.max(2, Math.min(10, Number(event.target.value))))}
              />
            </label>
            {!retuneCampaign ? (
              <p className="mc-pp-note">
                Preflight: A/A uses {retuneRepeatCount} benchmark runs and approximately{" "}
                {retuneRepeatCount *
                  Math.max(1, benchmarkTestCodes.split(/[\s,]+/).filter(Boolean).length) *
                  Math.max(1, benchmarkProvidersInput.split(/\r?\n/).filter((line) => line.trim()).length)}{" "}
                provider/test cases. The campaign cap is {Math.max(4, retuneRepeatCount * 4)} benchmark runs; exact
                currency depends on current provider pricing and remains subject to Gateway budgets.
              </p>
            ) : null}
            {retuneCampaign ? (
              <>
                <p className="mc-pp-note">
                  <strong>{retuneCampaign.status}</strong> · {retuneCampaign.repeatCount} repeats · budget{" "}
                  {retuneCampaign.maxBenchmarkRuns} benchmark runs · {retuneCampaign.passes.length} pass(es)
                  {retuneCampaign.noiseFloor
                    ? ` · score noise ${retuneCampaign.noiseFloor.weightedScore.toFixed(2)}`
                    : ""}
                </p>
                <label className="mc-pp-field">
                  <span>Candidate hypothesis</span>
                  <input
                    value={retuneHypothesis}
                    onChange={(event) => onSetRetuneHypothesis(event.target.value)}
                    placeholder="What changed, and why should it improve the frozen benchmark?"
                  />
                </label>
                <div className="mc-pp-inline-actions wrap">
                  <NativeButton
                    variant="secondary"
                    onClick={onMeasureRetuneNoise}
                    disabled={retunePending || retuneCampaign.status !== "draft"}
                  >
                    Measure A/A noise
                  </NativeButton>
                  <NativeButton
                    variant="secondary"
                    onClick={onRunRetuneCandidate}
                    disabled={retunePending || retuneCampaign.status !== "ready" || !retuneHypothesis.trim()}
                  >
                    Run candidate
                  </NativeButton>
                  <NativeButton variant="ghost" onClick={onRefreshRetuneCampaign} disabled={retunePending}>
                    Refresh campaign
                  </NativeButton>
                  <NativeButton
                    variant="ghost"
                    onClick={onCancelRetuneCampaign}
                    disabled={retunePending || ["completed", "cancelled", "failed"].includes(retuneCampaign.status)}
                  >
                    Cancel
                  </NativeButton>
                </div>
                {retuneCampaign.passes
                  .filter((pass) => pass.kind === "candidate")
                  .map((pass) => (
                    <div className="mc-pp-note" key={pass.passId}>
                      <strong>{pass.eligibility ?? "measuring"}</strong> · {pass.hypothesis} · {pass.disposition}
                      {pass.finishedAt && pass.disposition === "pending" ? (
                        <div className="mc-pp-inline-actions wrap">
                          <NativeButton
                            variant="secondary"
                            onClick={() => onDispositionRetunePass(pass.passId, "kept")}
                            disabled={retunePending || pass.eligibility !== "eligible"}
                          >
                            Keep
                          </NativeButton>
                          <NativeButton
                            variant="ghost"
                            onClick={() => onDispositionRetunePass(pass.passId, "rejected")}
                            disabled={retunePending}
                          >
                            Reject
                          </NativeButton>
                          <NativeButton
                            variant="ghost"
                            onClick={() => onDispositionRetunePass(pass.passId, "inconclusive")}
                            disabled={retunePending}
                          >
                            Inconclusive
                          </NativeButton>
                        </div>
                      ) : null}
                    </div>
                  ))}
              </>
            ) : (
              <NativeButton
                variant="secondary"
                onClick={onCreateRetuneCampaign}
                disabled={!selectedPackId || retunePending}
              >
                {retunePending ? <LoaderCircle size={16} className="mc-spin" /> : <FlaskConical size={16} />}
                Create frozen campaign
              </NativeButton>
            )}
          </div>
        ) : null}
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
            <NativeButton variant="destructive" onClick={onArmResetConfirm} disabled={!selectedPackId || resetting}>
              <AlertTriangle size={16} />
              Reset pack
            </NativeButton>
          ) : (
            <div className="mc-pp-reset-confirm">
              <p>Reset this pack now? This clears the selected history based on the toggles above.</p>
              <div className="mc-pp-inline-actions wrap">
                <NativeButton variant="destructive" onClick={onConfirmResetPack} disabled={resetting}>
                  {resetting ? <LoaderCircle size={16} className="mc-spin" /> : <AlertTriangle size={16} />}
                  Confirm reset
                </NativeButton>
                <NativeButton variant="ghost" onClick={onCancelResetConfirm} disabled={resetting}>
                  Cancel
                </NativeButton>
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
