import { ClipboardCopy, LoaderCircle, Play } from "lucide-react";
import type {
  PromptPackExecutionStyle,
  PromptPackLatestAssessmentRecordV2,
  PromptPackRunRecord,
  PromptPackTestRecord,
} from "@goatcitadel/contracts";
import {
  formatDateTime,
  formatPromptPackProviderModel,
  formatResultCategory,
  formatRunStatus,
  resolvePromptPackRunModelUsage,
  type TestResultFilter,
} from "@goatcitadel/mission-control-shared/pages/prompt-lab/prompt-lab-helpers";
import type { ActiveRunState } from "@goatcitadel/mission-control-shared/pages/prompt-lab/prompt-lab-types";
import { NativeButton } from "@next/features/native-routes/primitives";
import {
  formatPromptPackExecutionStyle,
  resultCategoryClass,
  statusChipClass,
} from "./PromptPacksWorkbenchPage.helpers";

type ResolvedPromptPackRunModelUsage = ReturnType<typeof resolvePromptPackRunModelUsage>;

export interface PromptPackDetailHeaderProps {
  selectedTest: PromptPackTestRecord;
  selectedRun: PromptPackRunRecord | undefined;
  selectedAssessment: PromptPackLatestAssessmentRecordV2 | undefined;
  selectedCategory: Exclude<TestResultFilter, "all">;
  selectedRunModelUsage: ResolvedPromptPackRunModelUsage;
  selectedRunLink: string | null;
  hasNavigate: boolean;
  activeRun: ActiveRunState | null;
  running: boolean;
  executionStyle: PromptPackExecutionStyle;
  onRunSelected: () => void;
  onOpenSelectedRun: () => void;
  onCopySelectedRunLink: () => void;
}

export function PromptPackDetailHeader({
  selectedTest,
  selectedRun,
  selectedAssessment,
  selectedCategory,
  selectedRunModelUsage,
  selectedRunLink,
  hasNavigate,
  activeRun,
  running,
  executionStyle,
  onRunSelected,
  onOpenSelectedRun,
  onCopySelectedRunLink,
}: PromptPackDetailHeaderProps) {
  const selectedAutoScore = selectedAssessment?.autoScore;
  const selectedHumanReview = selectedAssessment?.humanReview;
  return (
    <>
      <header className="mc-pp-detail-head">
        <div className="mc-pp-detail-copy">
          <div className="mc-pp-test-headline">
            <span className="mc-pp-test-code">{selectedTest.code}</span>
            <span className={`mc-pp-chip ${statusChipClass(selectedRun?.status)}`}>
              {formatRunStatus(selectedRun?.status)}
            </span>
            {formatResultCategory(selectedCategory) !== formatRunStatus(selectedRun?.status) ? (
              <span className={`mc-pp-chip ${resultCategoryClass(selectedCategory)}`}>
                {formatResultCategory(selectedCategory)}
              </span>
            ) : null}
          </div>
          <h4>{selectedTest.title}</h4>
        </div>
        <NativeButton
          onClick={onRunSelected}
          disabled={running && activeRun?.testId !== selectedTest.testId}
        >
          {activeRun?.testId === selectedTest.testId ? (
            <LoaderCircle size={16} className="mc-spin" />
          ) : (
            <Play size={16} />
          )}
          Run selected
        </NativeButton>
      </header>

      {selectedRunLink ? (
        <div className="mc-pp-detail-actions">
          {hasNavigate ? (
            <NativeButton variant="secondary" onClick={onOpenSelectedRun}>
              Open run thread
            </NativeButton>
          ) : null}
          <NativeButton variant="secondary" onClick={onCopySelectedRunLink}>
            <ClipboardCopy size={15} />
            Copy run link
          </NativeButton>
        </div>
      ) : null}

      <div className="mc-pp-detail-summary">
        <div className="mc-pp-detail-card">
          <span>Run state</span>
          <strong>{formatRunStatus(selectedRun?.status)}</strong>
          <p>{selectedRun?.startedAt ? `Started ${formatDateTime(selectedRun.startedAt)}` : "No run yet"}</p>
        </div>
        <div className="mc-pp-detail-card">
          <span>Requested lane</span>
          <strong>
            {formatPromptPackProviderModel(
              selectedRunModelUsage.requestedProviderId,
              selectedRunModelUsage.requestedModel,
            )}
          </strong>
          <p>
            {selectedRun?.finishedAt ? `Finished ${formatDateTime(selectedRun.finishedAt)}` : "Waiting for run output"}
          </p>
        </div>
        <div className="mc-pp-detail-card">
          <span>Execution style</span>
          <strong>{formatPromptPackExecutionStyle(selectedRun?.executionStyle ?? executionStyle)}</strong>
          <p>{selectedRun?.executionStyle ? "Captured on latest run" : "Next run setting"}</p>
        </div>
        <div className="mc-pp-detail-card">
          <span>Effective verdict</span>
          <strong>{selectedAssessment?.effectiveVerdict ?? selectedAutoScore?.autoVerdict ?? "Unscored"}</strong>
          <p>
            {selectedHumanReview?.overrideVerdict
              ? `Human override: ${selectedHumanReview.overrideVerdict}`
              : "No human override on the latest assessment"}
          </p>
        </div>
        <div className="mc-pp-detail-card">
          <span>Output integrity</span>
          <strong>{selectedRun?.integrity?.validationStatus ?? "n/a"}</strong>
          <p>
            {selectedRun?.integrity?.outputTokenCount !== undefined
              ? `${selectedRun.integrity.outputTokenCount} output tokens`
              : "No integrity data yet"}
          </p>
        </div>
      </div>
    </>
  );
}
