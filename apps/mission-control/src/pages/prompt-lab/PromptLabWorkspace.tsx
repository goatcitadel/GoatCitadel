import type { Dispatch, SetStateAction } from "react";
import type { PromptPackRunRecord, PromptPackScoreRecord, PromptPackTestRecord } from "@goatcitadel/contracts";
import { ActionButton } from "../../components/ActionButton";
import { GCSelect } from "../../components/ui";
import {
  classifyTestResultCategory,
  formatDateTime,
  formatPromptPackProviderModel,
  formatResultCategory,
  formatRunStatus,
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
  tests: PromptPackTestRecord[];
  filteredTests: PromptPackTestRecord[];
  testResultFilter: TestResultFilter;
  onTestResultFilterChange: (filter: TestResultFilter) => void;
  testOutcomeSummary: {
    approvalPausedCount: number;
    runFailureCount: number;
    scoreFailureCount: number;
    needsScoreCount: number;
    notRunCount: number;
    passingCount: number;
  };
  latestRunByTest: Map<string, PromptPackRunRecord>;
  latestScoreByTest: Map<string, PromptPackScoreRecord>;
  passThreshold: number;
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
  scoreDraft: ScoreDraft;
  onScoreDraftChange: Dispatch<SetStateAction<ScoreDraft>>;
  savingScore: boolean;
  submitScore: () => Promise<void>;
  autoScoring: boolean;
  autoScoreSelected: () => Promise<void>;
}

export function PromptLabWorkspace(props: PromptLabWorkspaceProps) {
  const {
    tests,
    filteredTests,
    testResultFilter,
    onTestResultFilterChange,
    testOutcomeSummary,
    latestRunByTest,
    latestScoreByTest,
    passThreshold,
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
    scoreDraft,
    onScoreDraftChange,
    savingScore,
    submitScore,
    autoScoring,
    autoScoreSelected,
  } = props;

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
            const score = latestScoreByTest.get(test.testId);
            const categoryWithThreshold = classifyTestResultCategory(run, score, passThreshold);
            return (
              <li key={test.testId}>
                <button
                  type="button"
                  className={selectedTestId === test.testId ? "active" : ""}
                  onClick={() => onSelectedTestIdChange(test.testId)}
                >
                  {test.code} - {test.title}
                </button>
                <div className="prompt-lab-test-meta">
                  <span className={`prompt-lab-chip ${statusChipClass(run?.status)}`}>
                    {formatRunStatus(run?.status)}
                  </span>
                  <span className={`prompt-lab-chip ${score ? "score-ready" : "score-missing"}`}>
                    {score ? `${score.totalScore}/10` : "Needs score"}
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
          </section>
        ) : (
          <p className="office-subtitle">No run yet for this test.</p>
        )}
        <div className="prompt-lab-score-grid">
          <ScoreField
            label="Routing"
            value={scoreDraft.routingScore}
            onChange={(value) => onScoreDraftChange((current) => ({ ...current, routingScore: value }))}
          />
          <ScoreField
            label="Honesty"
            value={scoreDraft.honestyScore}
            onChange={(value) => onScoreDraftChange((current) => ({ ...current, honestyScore: value }))}
          />
          <ScoreField
            label="Handoff"
            value={scoreDraft.handoffScore}
            onChange={(value) => onScoreDraftChange((current) => ({ ...current, handoffScore: value }))}
          />
          <ScoreField
            label="Robustness"
            value={scoreDraft.robustnessScore}
            onChange={(value) => onScoreDraftChange((current) => ({ ...current, robustnessScore: value }))}
          />
          <ScoreField
            label="Usability"
            value={scoreDraft.usabilityScore}
            onChange={(value) => onScoreDraftChange((current) => ({ ...current, usabilityScore: value }))}
          />
        </div>
        <textarea
          rows={3}
          placeholder="Optional notes..."
          value={scoreDraft.notes}
          onChange={(event) => onScoreDraftChange((current) => ({ ...current, notes: event.target.value }))}
        />
        <div className="prompt-lab-actions">
          <ActionButton label="Save score" pending={savingScore} onClick={() => void submitScore()} />
          <ActionButton
            label="Auto score this run"
            pending={autoScoring}
            disabled={!selectedRun || selectedRun.status !== "completed"}
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

function ScoreField(props: { label: string; value: 0 | 1 | 2; onChange: (value: 0 | 1 | 2) => void }) {
  return (
    <label className="chat-v11-select">
      {props.label}
      <GCSelect
        value={String(props.value)}
        onChange={(value) => props.onChange(Number(value) as 0 | 1 | 2)}
        options={[
          { value: "0", label: "0" },
          { value: "1", label: "1" },
          { value: "2", label: "2" },
        ]}
      />
    </label>
  );
}
