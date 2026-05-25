import { LoaderCircle, Play } from "lucide-react";
import type {
  PromptPackLatestAssessmentRecordV2,
  PromptPackRunRecord,
  PromptPackTestRecord,
} from "@goatcitadel/contracts";
import {
  classifyTestResultCategory,
  formatResultCategory,
  formatRunStatus,
  formatWeightedScore,
  type TestResultFilter,
} from "@goatcitadel/mission-control-shared/pages/prompt-lab/prompt-lab-helpers";
import type { ActiveRunState } from "@goatcitadel/mission-control-shared/pages/prompt-lab/prompt-lab-types";
import { EmptyState } from "../native-routes/primitives";
import {
  FILTER_OPTIONS,
  resultCategoryClass,
  statusChipClass,
  type PromptPackTestOutcomeSummary,
} from "./PromptPacksWorkbenchPage.helpers";

export interface PromptPackTestsColumnProps {
  selectedPackName?: string;
  testsLength: number;
  filteredTests: PromptPackTestRecord[];
  testResultFilter: TestResultFilter;
  testOutcomeSummary: PromptPackTestOutcomeSummary;
  latestRunByTest: Map<string, PromptPackRunRecord>;
  latestAssessmentByTest: Map<string, PromptPackLatestAssessmentRecordV2>;
  selectedTestId: string | null;
  activeRun: ActiveRunState | null;
  running: boolean;
  onSetTestResultFilter: (filter: TestResultFilter) => void;
  onSelectTest: (testId: string) => void;
  onRunOne: (test: PromptPackTestRecord) => void;
}

export function PromptPackTestsColumn({
  selectedPackName,
  testsLength,
  filteredTests,
  testResultFilter,
  testOutcomeSummary,
  latestRunByTest,
  latestAssessmentByTest,
  selectedTestId,
  activeRun,
  running,
  onSetTestResultFilter,
  onSelectTest,
  onRunOne,
}: PromptPackTestsColumnProps) {
  return (
    <section className="mc-pp-tests-column">
      <div className="mc-pp-section-heading">
        <div>
          <h4>Tests</h4>
          <p>
            {filteredTests.length} visible of {testsLength}
            {selectedPackName ? ` in ${selectedPackName}` : ""}
          </p>
        </div>
      </div>
      <div className="mc-pp-filter-row" role="tablist" aria-label="Prompt pack test filters">
        {FILTER_OPTIONS.map((option) => {
          const count = option.count(testOutcomeSummary, testsLength);
          const active = testResultFilter === option.value;
          return (
            <button
              key={option.value}
              type="button"
              className={`mc-pp-filter-chip${active ? " active" : ""}`}
              onClick={() => onSetTestResultFilter(option.value)}
            >
              <span>{option.label}</span>
              <strong>{count}</strong>
            </button>
          );
        })}
      </div>
      <div className="mc-pp-test-list" role="list" aria-label="Prompt pack tests">
        {filteredTests.map((test) => {
          const run = latestRunByTest.get(test.testId);
          const assessment = latestAssessmentByTest.get(test.testId);
          const category = classifyTestResultCategory(run, assessment);
          const score = assessment?.autoScore;
          const selected = selectedTestId === test.testId;
          return (
            <article
              key={test.testId}
              className={`mc-pp-test-row${selected ? " active" : ""}`}
              data-category={category}
            >
              <div
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                className="mc-pp-test-select"
                onClick={() => onSelectTest(test.testId)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelectTest(test.testId);
                  }
                }}
              >
                <span className="mc-pp-test-select-content">
                  <span className={`mc-pp-status-dot ${resultCategoryClass(category)}`} aria-hidden="true" />
                  <span className="mc-pp-test-copy">
                    <span className="mc-pp-test-headline">
                      <span className="mc-pp-test-code">{test.code}</span>
                      <span className={`mc-pp-chip ${statusChipClass(run?.status)}`}>
                        {formatRunStatus(run?.status)}
                      </span>
                    </span>
                    <strong>{test.title}</strong>
                    <span className="mc-pp-test-meta">
                      <span
                        className={`mc-pp-chip ${score || assessment?.legacyScore ? "score-ready" : "score-missing"}`}
                      >
                        {score
                          ? `${formatWeightedScore(score.weightedScore)} • ${assessment?.effectiveVerdict ?? score.autoVerdict}`
                          : assessment?.legacyScore
                            ? `Legacy ${assessment.legacyScore.totalScore}/10`
                            : "Needs score"}
                      </span>
                      {formatResultCategory(category) !== formatRunStatus(run?.status) ? (
                        <span className={`mc-pp-chip ${resultCategoryClass(category)}`}>
                          {formatResultCategory(category)}
                        </span>
                      ) : null}
                      {test.diagnosticMetadata?.capabilityTargets.slice(0, 2).map((target) => (
                        <span key={target} className="mc-pp-chip diagnostic">
                          {target}
                        </span>
                      ))}
                    </span>
                  </span>
                </span>
              </div>
              <button
                type="button"
                className="mc-next-button mc-next-button-secondary mc-pp-run-button"
                onClick={() => onRunOne(test)}
                disabled={running && activeRun?.testId !== test.testId}
              >
                {activeRun?.testId === test.testId ? (
                  <LoaderCircle size={15} className="mc-spin" />
                ) : (
                  <Play size={15} />
                )}
                Run
              </button>
            </article>
          );
        })}
        {filteredTests.length === 0 ? <EmptyState size="compact" title="No tests match this filter." /> : null}
      </div>
    </section>
  );
}
