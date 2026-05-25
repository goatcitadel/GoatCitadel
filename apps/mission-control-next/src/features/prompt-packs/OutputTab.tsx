import type { PromptPackExecutionStyle, PromptPackRunRecord } from "@goatcitadel/contracts";
import {
  formatPromptPackProviderModel,
  resolvePromptPackRunModelUsage,
} from "@goatcitadel/mission-control-shared/pages/prompt-lab/prompt-lab-helpers";
import { EmptyState } from "../native-routes/primitives";
import { formatPromptPackExecutionStyle } from "./PromptPacksWorkbenchPage.helpers";

type ResolvedPromptPackRunModelUsage = ReturnType<typeof resolvePromptPackRunModelUsage>;

export interface OutputTabProps {
  selectedRun: PromptPackRunRecord | undefined;
  selectedRunModelUsage: ResolvedPromptPackRunModelUsage;
  executionStyle: PromptPackExecutionStyle;
}

export function OutputTab({ selectedRun, selectedRunModelUsage, executionStyle }: OutputTabProps) {
  return (
    <div className="mc-pp-tab-grid">
      <section className="mc-pp-surface">
        <div className="mc-pp-section-heading">
          <div>
            <h5>Assistant output</h5>
            <p>The latest completion tied to this test run.</p>
          </div>
        </div>
        {selectedRun?.responseText ? (
          <pre>{selectedRun.responseText}</pre>
        ) : (
          <EmptyState size="compact" title="No output available for the latest run." />
        )}
      </section>
      <section className="mc-pp-surface">
        <div className="mc-pp-section-heading">
          <div>
            <h5>Run evidence</h5>
            <p>Requested vs actual model, tools, citations, and fallback behavior.</p>
          </div>
        </div>
        <div className="mc-pp-evidence-stack">
          <div className="mc-pp-evidence-line">
            <span>Requested</span>
            <strong>
              {formatPromptPackProviderModel(
                selectedRunModelUsage.requestedProviderId,
                selectedRunModelUsage.requestedModel,
              )}
            </strong>
          </div>
          <div className="mc-pp-evidence-line">
            <span>Actual</span>
            <strong>
              {formatPromptPackProviderModel(selectedRunModelUsage.actualProviderId, selectedRunModelUsage.actualModel)}
            </strong>
          </div>
          <div className="mc-pp-evidence-line">
            <span>Fallback</span>
            <strong>
              {selectedRunModelUsage.fallbackUsed
                ? formatPromptPackProviderModel(
                    selectedRunModelUsage.fallbackProviderId,
                    selectedRunModelUsage.fallbackModel,
                  )
                : "Not used"}
            </strong>
          </div>
          <div className="mc-pp-evidence-line">
            <span>Execution style</span>
            <strong>{formatPromptPackExecutionStyle(selectedRun?.executionStyle ?? executionStyle)}</strong>
          </div>
          <div className="mc-pp-evidence-line">
            <span>Tool runs</span>
            <strong>{selectedRun?.trace ? selectedRun.trace.toolRuns.length : 0}</strong>
          </div>
          <div className="mc-pp-evidence-line">
            <span>Citations</span>
            <strong>{selectedRun?.citations?.length ?? 0}</strong>
          </div>
          {selectedRun?.status === "failed" && selectedRun.error ? (
            <p className="mc-pp-note danger">{selectedRun.error}</p>
          ) : null}
          {selectedRunModelUsage.fallbackReason ? (
            <p className="mc-pp-note">Fallback reason: {selectedRunModelUsage.fallbackReason}</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
