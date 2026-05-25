import { AlertTriangle, FlaskConical, LoaderCircle, RotateCcw } from "lucide-react";
import type { PromptPackBenchmarkStatusRecord } from "@goatcitadel/contracts";
import type { ActiveRunState } from "@goatcitadel/mission-control-shared/pages/prompt-lab/prompt-lab-types";
import type { fetchPromptPackReplayRegressionStatus } from "@goatcitadel/mission-control-shared/api/client";

export interface PromptPacksStatusRowProps {
  activeRun: ActiveRunState | null;
  benchmarkStatus: PromptPackBenchmarkStatusRecord | null;
  regressionStatus: Awaited<ReturnType<typeof fetchPromptPackReplayRegressionStatus>> | null;
  isFallbackRefreshing: boolean;
}

export function PromptPacksStatusRow({
  activeRun,
  benchmarkStatus,
  regressionStatus,
  isFallbackRefreshing,
}: PromptPacksStatusRowProps) {
  if (!activeRun && !benchmarkStatus && !regressionStatus && !isFallbackRefreshing) {
    return null;
  }
  return (
    <section className="mc-pp-status-row" aria-label="Prompt pack status">
      {activeRun ? (
        <div className="mc-pp-status-pill">
          <LoaderCircle size={14} className="mc-spin" />
          <span>
            Running {activeRun.testCode ?? "prompt-pack flow"} in {activeRun.mode} mode
          </span>
        </div>
      ) : null}
      {benchmarkStatus ? (
        <div className="mc-pp-status-pill">
          <FlaskConical size={14} />
          <span>
            Benchmark {benchmarkStatus.run.status} {benchmarkStatus.progress.completedItems}/
            {benchmarkStatus.progress.totalItems}
          </span>
        </div>
      ) : null}
      {regressionStatus ? (
        <div className="mc-pp-status-pill">
          <RotateCcw size={14} />
          <span>Replay regression {regressionStatus.run.status}</span>
        </div>
      ) : null}
      {isFallbackRefreshing ? (
        <div className="mc-pp-status-pill">
          <AlertTriangle size={14} />
          <span>Live updates degraded, polling periodically.</span>
        </div>
      ) : null}
    </section>
  );
}
