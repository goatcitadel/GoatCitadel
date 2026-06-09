import { AlertTriangle, CheckCircle2, LoaderCircle, Sparkles } from "lucide-react";
import type { PromptPackRunRecord } from "@goatcitadel/contracts";
import { formatWeightedScore } from "@goatcitadel/mission-control-shared/pages/prompt-lab/prompt-lab-helpers";
import type { ScoreDraft } from "@goatcitadel/mission-control-shared/pages/prompt-lab/prompt-lab-types";
import { DIMENSION_ROWS } from "./PromptPacksWorkbenchPage.helpers";

export interface ReviewTabProps {
  v2UiEnabled: boolean;
  scoreDraft: ScoreDraft;
  draftWeightedScore: number | null;
  draftVerdict: string;
  completedDraftDimensions: number;
  selectedRun: PromptPackRunRecord | undefined;
  savingScore: boolean;
  autoScoring: boolean;
  onSetScoreDraft: (updater: (current: ScoreDraft) => ScoreDraft) => void;
  onSubmitScore: () => void;
  onAutoScoreSelected: () => void;
}

export function ReviewTab({
  v2UiEnabled,
  scoreDraft,
  draftWeightedScore,
  draftVerdict,
  completedDraftDimensions,
  selectedRun,
  savingScore,
  autoScoring,
  onSetScoreDraft,
  onSubmitScore,
  onAutoScoreSelected,
}: ReviewTabProps) {
  return (
    <div className="mc-pp-tab-grid mc-pp-tab-grid-single">
      <section className="mc-pp-surface">
        <div className="mc-pp-section-heading">
          <div>
            <h5>Manual review</h5>
            <p>Layer human judgment on top of the existing evidence only when it adds signal.</p>
          </div>
        </div>
        {!v2UiEnabled ? (
          <div className="mc-pp-alert warning">
            <AlertTriangle size={16} />
            <span>Prompt Pack Scoring V2 UI is disabled in this build.</span>
          </div>
        ) : null}
        <div className="mc-pp-assessment-grid">
          <article className="mc-pp-metric-card">
            <span>Draft score</span>
            <strong>{draftWeightedScore === null ? "Incomplete" : formatWeightedScore(draftWeightedScore)}</strong>
            <p>{completedDraftDimensions}/5 dimensions set</p>
          </article>
          <article className="mc-pp-metric-card">
            <span>Draft verdict</span>
            <strong>{draftVerdict}</strong>
            <p>{scoreDraft.overrideVerdict ? `Override ${scoreDraft.overrideVerdict}` : "No override selected"}</p>
          </article>
        </div>
        <div className="mc-pp-review-grid">
          {DIMENSION_ROWS.map((dimension) => (
            <div key={dimension.key} className="mc-pp-review-row">
              <div>
                <strong>{dimension.label}</strong>
                <p>Weight {dimension.weight}%</p>
              </div>
              <div className="mc-pp-score-row">
                <button
                  type="button"
                  className={`mc-pp-score-button${scoreDraft[dimension.key] === null ? " active" : ""}`}
                  disabled={!v2UiEnabled}
                  onClick={() => onSetScoreDraft((current) => ({ ...current, [dimension.key]: null }))}
                >
                  --
                </button>
                {[0, 1, 2, 3, 4].map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={`mc-pp-score-button${scoreDraft[dimension.key] === value ? " active" : ""}`}
                    disabled={!v2UiEnabled}
                    onClick={() => onSetScoreDraft((current) => ({ ...current, [dimension.key]: value }))}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="mc-pp-review-controls">
          <label className="mc-pp-field">
            <span>Override verdict</span>
            <select
              value={scoreDraft.overrideVerdict || "none"}
              disabled={!v2UiEnabled}
              onChange={(event) =>
                onSetScoreDraft((current) => ({
                  ...current,
                  overrideVerdict:
                    event.target.value === "none" ? "" : (event.target.value as "pass" | "fail" | "review"),
                }))
              }
            >
              <option value="none">No override</option>
              <option value="pass">Pass</option>
              <option value="review">Review</option>
              <option value="fail">Fail</option>
            </select>
          </label>
          <label className="mc-pp-field">
            <span>Notes</span>
            <textarea
              rows={4}
              placeholder="Optional notes..."
              disabled={!v2UiEnabled}
              value={scoreDraft.notes}
              onChange={(event) =>
                onSetScoreDraft((current) => ({
                  ...current,
                  notes: event.target.value,
                }))
              }
            />
          </label>
        </div>
        <div className="mc-pp-inline-actions wrap">
          <button
            type="button"
            className="mc-next-button mc-next-button-secondary"
            disabled={!v2UiEnabled}
            onClick={() =>
              onSetScoreDraft((current) => ({
                ...current,
                taskSuccess: 3,
                honesty: 3,
                executionQuality: 3,
                robustness: 3,
                usability: 3,
              }))
            }
          >
            Fill pass defaults
          </button>
          <button
            type="button"
            className="mc-next-button"
            disabled={!v2UiEnabled || savingScore || !selectedRun}
            onClick={onSubmitScore}
          >
            {savingScore ? <LoaderCircle size={16} className="mc-spin" /> : <CheckCircle2 size={16} />}
            Save review
          </button>
          <button
            type="button"
            className="mc-next-button mc-next-button-secondary"
            disabled={!v2UiEnabled || autoScoring || !selectedRun || selectedRun.status !== "completed"}
            onClick={onAutoScoreSelected}
          >
            {autoScoring ? <LoaderCircle size={16} className="mc-spin" /> : <Sparkles size={16} />}
            Auto score this run
          </button>
        </div>
        {selectedRun?.status === "failed" ? (
          <div className="mc-pp-alert warning">
            <AlertTriangle size={16} />
            <span>Latest run failed. Rerun the test and inspect trace or tool grants before scoring.</span>
          </div>
        ) : null}
      </section>
    </div>
  );
}
