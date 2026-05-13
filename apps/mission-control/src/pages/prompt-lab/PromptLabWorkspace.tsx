import type { Dispatch, SetStateAction } from "react";
import type {
  PromptPackAutoScoreRecord,
  PromptPackLatestAssessmentRecordV2,
  PromptPackRunRecord,
  PromptPackTestRecord,
  PromptPackScoringSchemaVersion,
} from "@goatcitadel/contracts";
import { ActionButton } from "../../components/ActionButton";
import { GCSelect } from "../../components/ui";
import {
  classifyTestResultCategory,
  formatDateTime,
  formatPromptPackProviderModel,
  formatResultCategory,
  formatRunStatus,
  formatWeightedScore,
  normalizePromptPlaceholderKey,
  resultCategoryClass,
  statusChipClass,
  type TestResultFilter,
} from "./prompt-lab-helpers";
import type { ActiveRunState, ScoreDraft } from "./prompt-lab-types";

interface SelectedRunModelUsage {
  requestedProviderId?: string;
  requestedModel?: string;
  actualProviderId?: string;
  actualModel?: string;
  actualApiStyle?: string;
  fallbackUsed: boolean;
  fallbackProviderId?: string;
  fallbackModel?: string;
  fallbackReason?: string;
}

interface PromptLabWorkspaceProps {
  v2UiEnabled: boolean;
  tests: PromptPackTestRecord[];
  filteredTests: PromptPackTestRecord[];
  testResultFilter: TestResultFilter;
  onTestResultFilterChange: (filter: TestResultFilter) => void;
  testOutcomeSummary: {
    approvalPausedCount: number;
    runFailureCount: number;
    scoreFailureCount: number;
    reviewCount: number;
    needsScoreCount: number;
    notRunCount: number;
    passingCount: number;
  };
  latestRunByTest: Map<string, PromptPackRunRecord>;
  latestAssessmentByTest: Map<string, PromptPackLatestAssessmentRecordV2>;
  selectedTestId: string | null;
  onSelectedTestIdChange: (testId: string) => void;
  activeRun: ActiveRunState | null;
  running: boolean;
  runOne: (test: PromptPackTestRecord, mode?: ActiveRunState["mode"]) => Promise<void>;
  selectedTest: PromptPackTestRecord | null;
  selectedPlaceholders: string[];
  placeholderValues: Record<string, string>;
  onPlaceholderValuesChange: Dispatch<SetStateAction<Record<string, string>>>;
  selectedMissingPlaceholders: string[];
  selectedRun?: PromptPackRunRecord;
  selectedRunModelUsage: SelectedRunModelUsage;
  selectedAssessment?: PromptPackLatestAssessmentRecordV2;
  scoreDraft: ScoreDraft;
  onScoreDraftChange: Dispatch<SetStateAction<ScoreDraft>>;
  savingScore: boolean;
  submitScore: () => Promise<void>;
  autoScoring: boolean;
  autoScoreSelected: () => Promise<void>;
}

export function PromptLabWorkspace(props: PromptLabWorkspaceProps) {
  const {
    v2UiEnabled,
    tests,
    filteredTests,
    testResultFilter,
    onTestResultFilterChange,
    testOutcomeSummary,
    latestRunByTest,
    latestAssessmentByTest,
    selectedTestId,
    onSelectedTestIdChange,
    activeRun,
    running,
    runOne,
    selectedTest,
    selectedPlaceholders,
    placeholderValues,
    onPlaceholderValuesChange,
    selectedMissingPlaceholders,
    selectedRun,
    selectedRunModelUsage,
    selectedAssessment,
    scoreDraft,
    onScoreDraftChange,
    savingScore,
    submitScore,
    autoScoring,
    autoScoreSelected,
  } = props;
  const selectedAutoScore = selectedAssessment?.autoScore;
  const selectedLegacyScore = selectedAssessment?.legacyScore;
  const selectedHumanReview = selectedAssessment?.humanReview;
  const selectedCategory = classifyTestResultCategory(selectedRun, selectedAssessment);
  const completedDraftDimensions = DIMENSION_ROWS.filter(({ key }) => scoreDraft[key] !== null).length;
  const draftWeightedScore = computeDraftWeightedScore(scoreDraft);
  const draftVerdict = computeDraftVerdict(scoreDraft, scoreDraft.overrideVerdict);

  return (
    <div className="prompt-lab-workspace">
      <article className="card prompt-lab-surface prompt-lab-tests prompt-lab-rail">
        <div className="prompt-lab-tests-header">
          <div>
            <h3>Tests</h3>
            <p className="office-subtitle">
              {filteredTests.length} of {tests.length} visible
            </p>
          </div>
          <label className="chat-v11-select prompt-lab-mobile-filter">
            View
            <GCSelect
              value={testResultFilter}
              onChange={(value) => onTestResultFilterChange(value as TestResultFilter)}
              options={FILTER_OPTIONS.map((option) => ({
                value: option.value,
                label: `${option.label} (${option.count(testOutcomeSummary, tests.length)})`,
              }))}
            />
          </label>
        </div>

        <div className="prompt-lab-filter-chips" role="tablist" aria-label="Test result filters">
          {FILTER_OPTIONS.map((option) => {
            const count = option.count(testOutcomeSummary, tests.length);
            const active = testResultFilter === option.value;
            return (
              <button
                key={option.value}
                type="button"
                className={["gc-button", "prompt-lab-filter-chip", active ? "prompt-lab-filter-chip-active" : ""]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => onTestResultFilterChange(option.value)}
              >
                {option.label}
                <span>{count}</span>
              </button>
            );
          })}
        </div>

        <ul className="prompt-lab-test-list">
          {filteredTests.map((test) => {
            const run = latestRunByTest.get(test.testId);
            const assessment = latestAssessmentByTest.get(test.testId);
            const score = assessment?.autoScore;
            const categoryWithThreshold = classifyTestResultCategory(run, assessment);
            const selected = selectedTestId === test.testId;
            return (
              <li key={test.testId} className={selected ? "prompt-lab-test-row selected" : "prompt-lab-test-row"}>
                <div className="prompt-lab-test-row-main">
                  <button
                    type="button"
                    className="prompt-lab-test-select"
                    onClick={() => onSelectedTestIdChange(test.testId)}
                  >
                    <span
                      className={`prompt-lab-status-dot ${resultCategoryClass(categoryWithThreshold)}`}
                      aria-hidden="true"
                    />
                    <div className="prompt-lab-test-copy">
                      <div className="prompt-lab-test-heading">
                        <span className="prompt-lab-test-code">{test.code}</span>
                        <span className={`prompt-lab-chip ${statusChipClass(run?.status)}`}>
                          {formatRunStatus(run?.status)}
                        </span>
                      </div>
                      <strong>{test.title}</strong>
                      <div className="prompt-lab-test-meta">
                        <span
                          className={`prompt-lab-chip ${score || assessment?.legacyScore ? "score-ready" : "score-missing"}`}
                        >
                          {score
                            ? `${formatWeightedScore(score.weightedScore)} • ${assessment?.effectiveVerdict ?? score.autoVerdict}`
                            : assessment?.legacyScore
                              ? `Legacy ${assessment.legacyScore.totalScore}/10 • ${formatLegacyVerdict(assessment.legacyScore.totalScore)}`
                              : "Needs score"}
                        </span>
                        <span className={`prompt-lab-chip ${resultCategoryClass(categoryWithThreshold)}`}>
                          {formatResultCategory(categoryWithThreshold)}
                        </span>
                      </div>
                    </div>
                  </button>
                  <ActionButton
                    label="Run"
                    pending={activeRun?.testId === test.testId}
                    disabled={running && activeRun?.testId !== test.testId}
                    onClick={() => void runOne(test, "single")}
                    className="prompt-lab-row-run"
                  />
                </div>
              </li>
            );
          })}
        </ul>
        {filteredTests.length === 0 ? <p className="office-subtitle">No tests match this filter.</p> : null}
      </article>

      <article className="card prompt-lab-surface prompt-lab-detail prompt-lab-detail-surface">
        {selectedTest ? (
          <>
            <div className="prompt-lab-detail-header">
              <div>
                <div className="prompt-lab-test-heading">
                  <span className="prompt-lab-test-code">{selectedTest.code}</span>
                  <span className={`prompt-lab-chip ${statusChipClass(selectedRun?.status)}`}>
                    {formatRunStatus(selectedRun?.status)}
                  </span>
                  <span className={`prompt-lab-chip ${resultCategoryClass(selectedCategory)}`}>
                    {formatResultCategory(selectedCategory)}
                  </span>
                </div>
                <h3>{selectedTest.title}</h3>
                <p className="office-subtitle">
                  Latest run is evaluated with the V2 evidence model first. Manual review layers on top when you need
                  judgment or override control.
                </p>
              </div>
              <ActionButton
                label="Run selected test"
                pending={activeRun?.testId === selectedTest.testId}
                disabled={running && activeRun?.testId !== selectedTest.testId}
                onClick={() => void runOne(selectedTest, "single")}
              />
            </div>

            <div className="prompt-lab-detail-grid">
              <section className="prompt-lab-panel prompt-lab-panel-prompt">
                <div className="prompt-lab-panel-heading">
                  <h4>Prompt</h4>
                  <span className="office-subtitle">Source prompt used for the active test.</span>
                </div>
                <pre>{selectedTest.prompt}</pre>
              </section>

              <section className="prompt-lab-panel prompt-lab-panel-run">
                <div className="prompt-lab-panel-heading">
                  <h4>Run summary</h4>
                  <span className="office-subtitle">
                    Requested vs actual model, fallback routing, and output integrity.
                  </span>
                </div>
                {selectedRun ? (
                  <div className="prompt-lab-run-summary">
                    <div className="prompt-lab-run-grid">
                      <div>
                        <span className="prompt-lab-overview-label">Run state</span>
                        <strong>{formatRunStatus(selectedRun.status)}</strong>
                        <p className="office-subtitle">
                          {selectedRun.runId ? `run ${selectedRun.runId}` : "No run id recorded"}
                        </p>
                      </div>
                      <div>
                        <span className="prompt-lab-overview-label">Requested model</span>
                        <strong>
                          {formatPromptPackProviderModel(
                            selectedRunModelUsage.requestedProviderId,
                            selectedRunModelUsage.requestedModel,
                          )}
                        </strong>
                        <p className="office-subtitle">
                          {selectedRun.startedAt
                            ? `started ${formatDateTime(selectedRun.startedAt)}`
                            : "No start time recorded"}
                        </p>
                      </div>
                      <div>
                        <span className="prompt-lab-overview-label">Actual model used</span>
                        <strong>
                          {formatPromptPackProviderModel(
                            selectedRunModelUsage.actualProviderId,
                            selectedRunModelUsage.actualModel,
                          )}
                        </strong>
                        <p className="office-subtitle">
                          {selectedRun.finishedAt
                            ? `finished ${formatDateTime(selectedRun.finishedAt)}`
                            : "Run still in progress"}
                        </p>
                      </div>
                      <div>
                        <span className="prompt-lab-overview-label">Fallback</span>
                        <strong>
                          {selectedRunModelUsage.fallbackUsed
                            ? formatPromptPackProviderModel(
                                selectedRunModelUsage.fallbackProviderId,
                                selectedRunModelUsage.fallbackModel,
                              )
                            : "Not used"}
                        </strong>
                        <p className="office-subtitle">
                          {selectedRunModelUsage.fallbackReason
                            ? `Fallback reason: ${selectedRunModelUsage.fallbackReason}`
                            : "No fallback reason recorded"}
                        </p>
                      </div>
                    </div>
                    <p className="office-subtitle">
                      Requested model:{" "}
                      {formatPromptPackProviderModel(
                        selectedRunModelUsage.requestedProviderId,
                        selectedRunModelUsage.requestedModel,
                      )}{" "}
                      • Actual model used:{" "}
                      {formatPromptPackProviderModel(
                        selectedRunModelUsage.actualProviderId,
                        selectedRunModelUsage.actualModel,
                      )}
                      {selectedRunModelUsage.fallbackUsed
                        ? ` • fallback: ${formatPromptPackProviderModel(
                            selectedRunModelUsage.fallbackProviderId,
                            selectedRunModelUsage.fallbackModel,
                          )}`
                        : ""}
                    </p>
                    {selectedRunModelUsage.actualApiStyle ? (
                      <p className="office-subtitle">Actual upstream API: {selectedRunModelUsage.actualApiStyle}</p>
                    ) : null}
                    {selectedRun.trace ? (
                      <p className="office-subtitle">Tools used: {selectedRun.trace.toolRuns.length}</p>
                    ) : null}
                    {selectedRun.citations && selectedRun.citations.length > 0 ? (
                      <p className="office-subtitle">Citations captured: {selectedRun.citations.length}</p>
                    ) : null}
                    {selectedRun.integrity ? (
                      <p className="office-subtitle">
                        Integrity: {selectedRun.integrity.validationStatus}
                        {selectedRun.integrity.completionStatus
                          ? ` • completion ${selectedRun.integrity.completionStatus}`
                          : ""}
                        {selectedRun.integrity.outputTokenCount !== undefined
                          ? ` • ${selectedRun.integrity.outputTokenCount} output tokens`
                          : ""}
                      </p>
                    ) : null}
                    {selectedRun.status === "failed" && selectedRun.error ? (
                      <p className="error">{selectedRun.error}</p>
                    ) : null}
                  </div>
                ) : (
                  <p className="office-subtitle">No run yet for this test.</p>
                )}
              </section>
            </div>
            {selectedPlaceholders.length > 0 ? (
              <section className="status-banner warning prompt-lab-placeholder-banner">
                <p className="prompt-lab-placeholder-copy">
                  This test has placeholder tokens. Fill them before running.
                </p>
                <div className="prompt-lab-placeholder-fields">
                  {selectedPlaceholders.map((placeholder) => {
                    const key = normalizePromptPlaceholderKey(placeholder);
                    return (
                      <label key={placeholder} className="prompt-lab-field">
                        {placeholder}
                        <input
                          value={placeholderValues[key] ?? ""}
                          onChange={(event) => {
                            const value = event.target.value;
                            onPlaceholderValuesChange((current) => ({
                              ...current,
                              [key]: value,
                            }));
                          }}
                          placeholder={`Value for ${placeholder}`}
                        />
                      </label>
                    );
                  })}
                </div>
                {selectedMissingPlaceholders.length > 0 ? (
                  <p className="prompt-lab-placeholder-note">Missing: {selectedMissingPlaceholders.join(", ")}</p>
                ) : (
                  <p className="prompt-lab-placeholder-note">All placeholders set for this test.</p>
                )}
              </section>
            ) : null}

            <div className="prompt-lab-detail-grid">
              <section className="prompt-lab-panel">
                <div className="prompt-lab-panel-heading">
                  <h4>Assistant output</h4>
                  <span className="office-subtitle">The latest completion tied to this test run.</span>
                </div>
                {selectedRun?.responseText ? (
                  <pre>{selectedRun.responseText}</pre>
                ) : (
                  <p className="office-subtitle">No output available for the latest run.</p>
                )}
              </section>

              <section className="prompt-lab-panel">
                <div className="prompt-lab-panel-heading">
                  <h4>Assessment</h4>
                  <span className="office-subtitle">
                    Effective verdict precedence: human override, then effective verdict, then auto verdict.
                  </span>
                </div>
                <div className="prompt-lab-evidence-grid">
                  <article className="prompt-lab-evidence-card">
                    <span className="prompt-lab-overview-label">Auto score</span>
                    <strong>
                      {selectedAutoScore ? formatWeightedScore(selectedAutoScore.weightedScore) : "Unavailable"}
                    </strong>
                    <p className="office-subtitle">
                      {selectedAutoScore
                        ? `auto verdict ${selectedAutoScore.autoVerdict} • judge ${selectedAutoScore.judgeStatus}`
                        : selectedLegacyScore
                          ? `Legacy v1 score ${selectedLegacyScore.totalScore}/10 • ${formatLegacyVerdict(selectedLegacyScore.totalScore)}`
                          : "No scoring evidence yet"}
                    </p>
                  </article>
                  <article className="prompt-lab-evidence-card">
                    <span className="prompt-lab-overview-label">Effective verdict</span>
                    <strong>
                      {selectedAssessment?.effectiveVerdict ?? selectedAutoScore?.autoVerdict ?? "Unscored"}
                    </strong>
                    <p className="office-subtitle">
                      {selectedHumanReview?.overrideVerdict
                        ? `Human override ${selectedHumanReview.overrideVerdict}`
                        : "No human override on the latest assessment"}
                    </p>
                  </article>
                  <article className="prompt-lab-evidence-card">
                    <span className="prompt-lab-overview-label">Protocol</span>
                    <strong>
                      {selectedAutoScore ? (selectedAutoScore.protocol.protocolPass ? "pass" : "fail") : "n/a"}
                    </strong>
                    <p className="office-subtitle">
                      {selectedAutoScore
                        ? `state ${selectedAssessment?.scoreState ?? selectedAutoScore.scoreState}`
                        : "Protocol evidence arrives with V2 auto-score"}
                    </p>
                  </article>
                </div>
                {selectedHumanReview?.notes?.trim() ? (
                  <p className="office-subtitle">Latest human notes: {selectedHumanReview.notes.trim()}</p>
                ) : null}
                {selectedAutoScore ? (
                  <>
                    <div className="prompt-lab-reason-list">
                      {selectedAutoScore.hardFailReasons.length > 0 ? (
                        <p className="office-subtitle">
                          Hard-fail reasons: {selectedAutoScore.hardFailReasons.join(", ")}
                        </p>
                      ) : null}
                      {selectedAutoScore.reviewReasons.length > 0 ? (
                        <p className="office-subtitle">Review reasons: {selectedAutoScore.reviewReasons.join(", ")}</p>
                      ) : null}
                      {selectedAutoScore.degradedReasons.length > 0 ? (
                        <p className="office-subtitle">
                          Degraded reasons: {selectedAutoScore.degradedReasons.join(", ")}
                        </p>
                      ) : null}
                    </div>
                    <details className="prompt-lab-breakdown" open>
                      <summary>Score evidence</summary>
                      <table className="prompt-lab-breakdown-table gc-data-table">
                        <thead>
                          <tr>
                            <th>Dimension</th>
                            <th>Rule</th>
                            <th>Judge</th>
                            <th>Final</th>
                            <th>Diff</th>
                          </tr>
                        </thead>
                        <tbody>
                          {getPromptPackScoreDimensionLabels(selectedAutoScore.scoringSchemaVersion ?? "v2").map(
                            ([dimension, label]) => (
                              <tr key={dimension}>
                                <td>{label}</td>
                                <td>{readPromptPackScoreDimension(selectedAutoScore.ruleScores, dimension)}</td>
                                <td>{readPromptPackScoreDimension(selectedAutoScore.judgeScores, dimension)}</td>
                                <td>{readPromptPackScoreDimension(selectedAutoScore.finalScores, dimension)}</td>
                                <td>{readPromptPackScoreDimension(selectedAutoScore.disagreement, dimension)}</td>
                              </tr>
                            ),
                          )}
                        </tbody>
                      </table>
                    </details>
                  </>
                ) : null}
              </section>
            </div>

            {!v2UiEnabled ? (
              <div className="status-banner warning">
                Prompt Pack Scoring V2 UI is disabled for this build via <code>VITE_PROMPT_PACK_V2_UI_ENABLED</code>.
              </div>
            ) : null}

            <section className="prompt-lab-panel prompt-lab-panel-review">
              <div className="prompt-lab-panel-heading">
                <h4>Manual review</h4>
                <span className="office-subtitle">
                  Manual edits remain a human review layer on top of the existing V2 evidence model.
                </span>
              </div>

              <div className="prompt-lab-review-summary">
                <article className="prompt-lab-evidence-card">
                  <span className="prompt-lab-overview-label">Draft score</span>
                  <strong>
                    {draftWeightedScore === null ? "Incomplete" : formatWeightedScore(draftWeightedScore)}
                  </strong>
                  <p className="office-subtitle">{completedDraftDimensions}/5 dimensions set</p>
                </article>
                <article className="prompt-lab-evidence-card">
                  <span className="prompt-lab-overview-label">Draft verdict</span>
                  <strong>{draftVerdict}</strong>
                  <p className="office-subtitle">
                    {scoreDraft.overrideVerdict
                      ? `Override active: ${scoreDraft.overrideVerdict}`
                      : "No override selected"}
                  </p>
                </article>
              </div>

              <div className="prompt-lab-dimension-stack">
                {DIMENSION_ROWS.map((dimension) => (
                  <div key={dimension.key} className="prompt-lab-dimension-row">
                    <div className="prompt-lab-dimension-copy">
                      <strong>{dimension.label}</strong>
                      <span className="office-subtitle">Weight {dimension.weight}%</span>
                    </div>
                    <div className="prompt-lab-score-buttons">
                      <button
                        type="button"
                        className={[
                          "gc-button",
                          "prompt-lab-score-button",
                          scoreDraft[dimension.key] === null ? "active" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        disabled={!v2UiEnabled}
                        onClick={() => onScoreDraftChange((current) => ({ ...current, [dimension.key]: null }))}
                      >
                        --
                      </button>
                      {[0, 1, 2, 3, 4].map((value) => (
                        <button
                          key={value}
                          type="button"
                          className={[
                            "gc-button",
                            "prompt-lab-score-button",
                            scoreDraft[dimension.key] === value ? "active" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          disabled={!v2UiEnabled}
                          onClick={() => onScoreDraftChange((current) => ({ ...current, [dimension.key]: value }))}
                        >
                          {value}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div className="prompt-lab-review-controls">
                <label className="chat-v11-select">
                  Override verdict
                  <GCSelect
                    value={scoreDraft.overrideVerdict || "none"}
                    disabled={!v2UiEnabled}
                    onChange={(value) =>
                      onScoreDraftChange((current) => ({
                        ...current,
                        overrideVerdict: value === "none" ? "" : (value as "pass" | "fail" | "review"),
                      }))
                    }
                    options={[
                      { value: "none", label: "No override" },
                      { value: "pass", label: "Pass" },
                      { value: "review", label: "Review" },
                      { value: "fail", label: "Fail" },
                    ]}
                  />
                </label>
                <textarea
                  rows={3}
                  placeholder="Optional notes..."
                  disabled={!v2UiEnabled}
                  value={scoreDraft.notes}
                  onChange={(event) => onScoreDraftChange((current) => ({ ...current, notes: event.target.value }))}
                />
              </div>

              <div className="prompt-lab-actions">
                <ActionButton
                  label="Fill pass defaults"
                  disabled={!v2UiEnabled}
                  onClick={() =>
                    onScoreDraftChange((current) => ({
                      ...current,
                      taskSuccess: 3,
                      honesty: 3,
                      executionQuality: 3,
                      robustness: 3,
                      usability: 3,
                    }))
                  }
                />
                <ActionButton
                  label="Save review"
                  pending={savingScore}
                  disabled={!v2UiEnabled}
                  onClick={() => void submitScore()}
                />
                <ActionButton
                  label="Auto score this run"
                  pending={autoScoring}
                  disabled={!v2UiEnabled || !selectedRun || selectedRun.status !== "completed"}
                  onClick={() => void autoScoreSelected()}
                />
              </div>
              {selectedRun?.status === "failed" ? (
                <div className="status-banner warning">
                  Latest run failed. Try running again with web mode `quick`, then review trace and tool grants before
                  scoring.
                </div>
              ) : null}
            </section>
          </>
        ) : (
          <div className="prompt-lab-empty-state">
            <h3>Select a test</h3>
            <p className="office-subtitle">
              Pick a test from the rail to inspect prompt content, run output, and review controls.
            </p>
          </div>
        )}
      </article>
    </div>
  );
}

const PROMPT_PACK_V2_DIMENSION_LABELS = [
  ["taskSuccess", "Task success"],
  ["honesty", "Honesty"],
  ["executionQuality", "Execution quality"],
  ["robustness", "Robustness"],
  ["usability", "Usability"],
] as const;

const PROMPT_PACK_V3_DIMENSION_LABELS = [
  ["taskSuccess", "Task success"],
  ["truthfulness", "Truthfulness"],
  ["evidenceGrounding", "Evidence grounding"],
  ["formatAdherence", "Format adherence"],
  ["operatorUsefulness", "Operator usefulness"],
  ["toolUseQuality", "Tool use quality"],
  ["orchestrationQuality", "Orchestration quality"],
  ["efficiency", "Efficiency"],
  ["recoveryQuality", "Recovery quality"],
] as const;

function getPromptPackScoreDimensionLabels(schemaVersion: PromptPackScoringSchemaVersion) {
  return schemaVersion === "v3" ? PROMPT_PACK_V3_DIMENSION_LABELS : PROMPT_PACK_V2_DIMENSION_LABELS;
}

function readPromptPackScoreDimension(
  scores: PromptPackAutoScoreRecord["finalScores"] | PromptPackAutoScoreRecord["ruleScores"] | undefined,
  dimension: string,
): string | number {
  if (!scores) {
    return "-";
  }
  const value = (scores as Record<string, number | undefined>)[dimension];
  return value ?? "-";
}

const DIMENSION_ROWS: Array<{
  key: keyof Pick<ScoreDraft, "taskSuccess" | "honesty" | "executionQuality" | "robustness" | "usability">;
  label: string;
  weight: number;
}> = [
  { key: "taskSuccess", label: "Task success", weight: 25 },
  { key: "honesty", label: "Honesty", weight: 20 },
  { key: "executionQuality", label: "Execution quality", weight: 20 },
  { key: "robustness", label: "Robustness", weight: 20 },
  { key: "usability", label: "Usability", weight: 15 },
];

const FILTER_OPTIONS: Array<{
  value: TestResultFilter;
  label: string;
  count: (summary: PromptLabWorkspaceProps["testOutcomeSummary"], totalTests: number) => number;
}> = [
  { value: "all", label: "All", count: (_summary, total) => total },
  { value: "approval_paused", label: "Paused", count: (summary) => summary.approvalPausedCount },
  { value: "run_failed", label: "Run failed", count: (summary) => summary.runFailureCount },
  { value: "score_failed", label: "Score failed", count: (summary) => summary.scoreFailureCount },
  { value: "review", label: "Review", count: (summary) => summary.reviewCount },
  { value: "needs_score", label: "Needs score", count: (summary) => summary.needsScoreCount },
  { value: "not_run", label: "Not run", count: (summary) => summary.notRunCount },
  { value: "passing", label: "Passing", count: (summary) => summary.passingCount },
];

function formatLegacyVerdict(totalScore: number): "pass" | "fail" {
  return totalScore >= 7 ? "pass" : "fail";
}

function computeDraftWeightedScore(scoreDraft: ScoreDraft): number | null {
  if (DIMENSION_ROWS.some((dimension) => scoreDraft[dimension.key] === null)) {
    return null;
  }
  const total = DIMENSION_ROWS.reduce(
    (sum, dimension) => sum + Number(scoreDraft[dimension.key]) * dimension.weight,
    0,
  );
  return total / 4;
}

function computeDraftVerdict(
  scoreDraft: ScoreDraft,
  overrideVerdict: ScoreDraft["overrideVerdict"],
): "pass" | "review" | "fail" | "incomplete" {
  if (overrideVerdict) {
    return overrideVerdict;
  }
  const weighted = computeDraftWeightedScore(scoreDraft);
  if (weighted === null) {
    return "incomplete";
  }
  if (weighted >= 75) {
    return "pass";
  }
  if (weighted >= 60) {
    return "review";
  }
  return "fail";
}
