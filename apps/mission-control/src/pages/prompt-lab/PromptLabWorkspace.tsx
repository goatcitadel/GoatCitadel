import type { Dispatch, SetStateAction } from "react";
import type {
  PromptPackLatestAssessmentRecordV2,
  PromptPackRunRecord,
  PromptPackTestRecord,
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

  return (
    <div className="prompt-lab-grid">
      <article className="card prompt-lab-surface prompt-lab-tests">
        <div className="prompt-lab-tests-header">
          <h3>Tests</h3>
          <label className="chat-v11-select">
            View
            <GCSelect
              value={testResultFilter}
              onChange={(value) => onTestResultFilterChange(value as TestResultFilter)}
              options={[
                { value: "all", label: `All (${tests.length})` },
                { value: "approval_paused", label: `Approval paused (${testOutcomeSummary.approvalPausedCount})` },
                { value: "run_failed", label: `Run failures (${testOutcomeSummary.runFailureCount})` },
                { value: "score_failed", label: `Score failures (${testOutcomeSummary.scoreFailureCount})` },
                { value: "review", label: `Review (${testOutcomeSummary.reviewCount})` },
                { value: "needs_score", label: `Needs score (${testOutcomeSummary.needsScoreCount})` },
                { value: "not_run", label: `Not run (${testOutcomeSummary.notRunCount})` },
                { value: "passing", label: `Passing (${testOutcomeSummary.passingCount})` },
              ]}
            />
          </label>
        </div>
        <ul>
          {filteredTests.map((test) => {
            const run = latestRunByTest.get(test.testId);
            const assessment = latestAssessmentByTest.get(test.testId);
            const score = assessment?.autoScore;
            const categoryWithThreshold = classifyTestResultCategory(run, assessment);
            return (
              <li key={test.testId}>
                <button
                  type="button"
                  className={["gc-button", (selectedTestId === test.testId ? "active" : "")].filter(Boolean).join(" ")}
                  onClick={() => onSelectedTestIdChange(test.testId)}
                >
                  {test.code} - {test.title}
                </button>
                <div className="prompt-lab-test-meta">
                  <span className={`prompt-lab-chip ${statusChipClass(run?.status)}`}>
                    {formatRunStatus(run?.status)}
                  </span>
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
                <ActionButton
                  label="Run"
                  pending={activeRun?.testId === test.testId}
                  disabled={running && activeRun?.testId !== test.testId}
                  onClick={() => void runOne(test, "single")}
                />
              </li>
            );
          })}
        </ul>
        {filteredTests.length === 0 ? <p className="office-subtitle">No tests match this filter.</p> : null}
      </article>

      <article className="card prompt-lab-surface prompt-lab-detail">
        <h3>{selectedTest ? `${selectedTest.code} - ${selectedTest.title}` : "Select a test"}</h3>
        {selectedTest ? (
          <pre>{selectedTest.prompt}</pre>
        ) : (
          <p className="office-subtitle">Pick a test to inspect prompt content and score it.</p>
        )}
        {selectedTest && selectedPlaceholders.length > 0 ? (
          <section className="status-banner warning prompt-lab-placeholder-banner">
            <p className="prompt-lab-placeholder-copy">This test has placeholder tokens. Fill them before running.</p>
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
        {selectedRun ? (
          <section className="prompt-lab-run-summary">
            <p>
              Latest run: <strong>{formatRunStatus(selectedRun.status)}</strong>
              {selectedRun.runId ? ` • run ${selectedRun.runId}` : ""}
              {selectedRun.startedAt ? ` • started ${formatDateTime(selectedRun.startedAt)}` : ""}
              {selectedRun.finishedAt ? ` • finished ${formatDateTime(selectedRun.finishedAt)}` : ""}
            </p>
            <p className="office-subtitle">
              Requested model:{" "}
              {formatPromptPackProviderModel(
                selectedRunModelUsage.requestedProviderId,
                selectedRunModelUsage.requestedModel,
              )}
              {" • "}
              Actual model used:{" "}
              {formatPromptPackProviderModel(selectedRunModelUsage.actualProviderId, selectedRunModelUsage.actualModel)}
              {selectedRunModelUsage.actualApiStyle ? ` • upstream API: ${selectedRunModelUsage.actualApiStyle}` : ""}
              {selectedRunModelUsage.fallbackUsed
                ? ` • fallback: ${formatPromptPackProviderModel(selectedRunModelUsage.fallbackProviderId, selectedRunModelUsage.fallbackModel)}`
                : ""}
            </p>
            {selectedRunModelUsage.fallbackReason ? (
              <p className="office-subtitle">Fallback reason: {selectedRunModelUsage.fallbackReason}</p>
            ) : null}
            {selectedAutoScore ? (
              <p className="office-subtitle">
                Auto score: {formatWeightedScore(selectedAutoScore.weightedScore)} • auto verdict{" "}
                {selectedAutoScore.autoVerdict} • effective verdict{" "}
                {selectedAssessment.effectiveVerdict ?? selectedAutoScore.autoVerdict} • judge{" "}
                {selectedAutoScore.judgeStatus} • protocol {selectedAutoScore.protocol.protocolPass ? "pass" : "fail"} •
                state {selectedAssessment.scoreState}
              </p>
            ) : null}
            {!selectedAutoScore && selectedLegacyScore ? (
              <p className="office-subtitle">
                Legacy v1 score: {selectedLegacyScore.totalScore}/10 •{" "}
                {formatLegacyVerdict(selectedLegacyScore.totalScore)} • read-only history
              </p>
            ) : null}
            {selectedHumanReview?.overrideVerdict ? (
              <p className="office-subtitle">
                Latest human override: {selectedHumanReview.overrideVerdict}
                {selectedHumanReview.notes?.trim() ? ` • ${selectedHumanReview.notes.trim()}` : ""}
              </p>
            ) : null}
            {selectedRun.status === "failed" && selectedRun.error ? <p className="error">{selectedRun.error}</p> : null}
            {selectedRun.responseText ? (
              <details>
                <summary>Assistant output</summary>
                <pre>{selectedRun.responseText}</pre>
              </details>
            ) : null}
            {selectedRun.trace ? (
              <p className="office-subtitle">Tools used: {selectedRun.trace.toolRuns.length}</p>
            ) : null}
            {selectedRun.citations && selectedRun.citations.length > 0 ? (
              <p className="office-subtitle">Citations captured: {selectedRun.citations.length}</p>
            ) : null}
            {selectedAutoScore ? (
              <details className="prompt-lab-breakdown">
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
                    {PROMPT_PACK_V2_DIMENSION_LABELS.map(([dimension, label]) => (
                      <tr key={dimension}>
                        <td>{label}</td>
                        <td>{selectedAutoScore.ruleScores[dimension] ?? "-"}</td>
                        <td>{selectedAutoScore.judgeScores?.[dimension] ?? "-"}</td>
                        <td>{selectedAutoScore.finalScores[dimension] ?? "-"}</td>
                        <td>{selectedAutoScore.disagreement[dimension] ?? "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {selectedAutoScore.hardFailReasons.length > 0 ? (
                  <p className="office-subtitle">Hard-fail reasons: {selectedAutoScore.hardFailReasons.join(", ")}</p>
                ) : null}
                {selectedAutoScore.reviewReasons.length > 0 ? (
                  <p className="office-subtitle">Review reasons: {selectedAutoScore.reviewReasons.join(", ")}</p>
                ) : null}
                {selectedAutoScore.degradedReasons.length > 0 ? (
                  <p className="office-subtitle">Degraded reasons: {selectedAutoScore.degradedReasons.join(", ")}</p>
                ) : null}
              </details>
            ) : null}
          </section>
        ) : (
          <p className="office-subtitle">No run yet for this test.</p>
        )}
        {!v2UiEnabled ? (
          <div className="status-banner warning">
            Prompt Pack Scoring V2 UI is disabled for this build via <code>VITE_PROMPT_PACK_V2_UI_ENABLED</code>.
          </div>
        ) : null}
        <div className="prompt-lab-score-grid">
          <ScoreField
            label="Task success"
            value={scoreDraft.taskSuccess}
            disabled={!v2UiEnabled}
            onChange={(value) => onScoreDraftChange((current) => ({ ...current, taskSuccess: value }))}
          />
          <ScoreField
            label="Honesty"
            value={scoreDraft.honesty}
            disabled={!v2UiEnabled}
            onChange={(value) => onScoreDraftChange((current) => ({ ...current, honesty: value }))}
          />
          <ScoreField
            label="Execution quality"
            value={scoreDraft.executionQuality}
            disabled={!v2UiEnabled}
            onChange={(value) => onScoreDraftChange((current) => ({ ...current, executionQuality: value }))}
          />
          <ScoreField
            label="Robustness"
            value={scoreDraft.robustness}
            disabled={!v2UiEnabled}
            onChange={(value) => onScoreDraftChange((current) => ({ ...current, robustness: value }))}
          />
          <ScoreField
            label="Usability"
            value={scoreDraft.usability}
            disabled={!v2UiEnabled}
            onChange={(value) => onScoreDraftChange((current) => ({ ...current, usability: value }))}
          />
        </div>
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
      </article>
    </div>
  );
}

function ScoreField(props: {
  label: string;
  value: 0 | 1 | 2 | 3 | 4 | null;
  disabled?: boolean;
  onChange: (value: 0 | 1 | 2 | 3 | 4 | null) => void;
}) {
  return (
    <label className="chat-v11-select">
      {props.label}
      <GCSelect
        value={props.value === null ? "unset" : String(props.value)}
        disabled={props.disabled}
        onChange={(value) => props.onChange(value === "unset" ? null : (Number(value) as 0 | 1 | 2 | 3 | 4))}
        options={[
          { value: "unset", label: "Unset" },
          { value: "0", label: "0" },
          { value: "1", label: "1" },
          { value: "2", label: "2" },
          { value: "3", label: "3" },
          { value: "4", label: "4" },
        ]}
      />
    </label>
  );
}

const PROMPT_PACK_V2_DIMENSION_LABELS = [
  ["taskSuccess", "Task success"],
  ["honesty", "Honesty"],
  ["executionQuality", "Execution quality"],
  ["robustness", "Robustness"],
  ["usability", "Usability"],
] as const;

function formatLegacyVerdict(totalScore: number): "pass" | "fail" {
  return totalScore >= 7 ? "pass" : "fail";
}


