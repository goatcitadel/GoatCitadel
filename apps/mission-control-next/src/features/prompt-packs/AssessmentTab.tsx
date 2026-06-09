import type { PromptPackLatestAssessmentRecordV2 } from "@goatcitadel/contracts";
import { formatWeightedScore } from "@goatcitadel/mission-control-shared/pages/prompt-lab/prompt-lab-helpers";
import { EmptyState } from "../native-routes/primitives";
import {
  formatPromptPackAttribution,
  getPromptPackScoreDimensionLabels,
  readPromptPackScoreDimension,
} from "./PromptPacksWorkbenchPage.helpers";

export interface AssessmentTabProps {
  selectedAssessment: PromptPackLatestAssessmentRecordV2 | undefined;
}

export function AssessmentTab({ selectedAssessment }: AssessmentTabProps) {
  const selectedAutoScore = selectedAssessment?.autoScore;
  const selectedLegacyScore = selectedAssessment?.legacyScore;
  const selectedHumanReview = selectedAssessment?.humanReview;
  return (
    <div className="mc-pp-tab-grid mc-pp-tab-grid-single">
      <section className="mc-pp-surface">
        <div className="mc-pp-section-heading">
          <div>
            <h5>Assessment summary</h5>
            <p>Auto score, effective verdict, and protocol state for the latest run.</p>
          </div>
        </div>
        <div className="mc-pp-assessment-grid">
          <article className="mc-pp-metric-card">
            <span>Auto score</span>
            <strong>{selectedAutoScore ? formatWeightedScore(selectedAutoScore.weightedScore) : "Unavailable"}</strong>
            <p>
              {selectedAutoScore
                ? `${(selectedAutoScore.scoringSchemaVersion ?? "v2").toUpperCase()} ${selectedAutoScore.autoVerdict} • judge ${selectedAutoScore.judgeStatus}`
                : selectedLegacyScore
                  ? `Legacy score ${selectedLegacyScore.totalScore}/10`
                  : "No scoring evidence yet"}
            </p>
          </article>
          <article className="mc-pp-metric-card">
            <span>Effective verdict</span>
            <strong>{selectedAssessment?.effectiveVerdict ?? "Unscored"}</strong>
            <p>
              {selectedHumanReview?.overrideVerdict
                ? `Human override ${selectedHumanReview.overrideVerdict}`
                : "No manual override"}
            </p>
          </article>
          <article className="mc-pp-metric-card">
            <span>Protocol</span>
            <strong>{selectedAutoScore ? (selectedAutoScore.protocol.protocolPass ? "Pass" : "Fail") : "n/a"}</strong>
            <p>
              {selectedAutoScore
                ? `State ${selectedAssessment?.scoreState ?? selectedAutoScore.scoreState}`
                : "Protocol evidence arrives with auto-score"}
            </p>
          </article>
          <article className="mc-pp-metric-card">
            <span>Attribution</span>
            <strong>
              {selectedAutoScore?.scoringSchemaVersion === "v3"
                ? formatPromptPackAttribution(selectedAutoScore.attribution.primary)
                : "n/a"}
            </strong>
            <p>
              {selectedAutoScore?.scoringSchemaVersion === "v3"
                ? `${selectedAutoScore.attribution.confidence} confidence`
                : "Available with v3 scoring"}
            </p>
          </article>
        </div>
        {selectedHumanReview?.notes?.trim() ? (
          <p className="mc-pp-note">Latest human notes: {selectedHumanReview.notes.trim()}</p>
        ) : null}
        {selectedAutoScore ? (
          <>
            {selectedAutoScore.hardFailReasons.length > 0 ? (
              <p className="mc-pp-note danger">Hard-fail reasons: {selectedAutoScore.hardFailReasons.join(", ")}</p>
            ) : null}
            {selectedAutoScore.reviewReasons.length > 0 ? (
              <p className="mc-pp-note">Review reasons: {selectedAutoScore.reviewReasons.join(", ")}</p>
            ) : null}
            {selectedAutoScore.degradedReasons.length > 0 ? (
              <p className="mc-pp-note">Degraded reasons: {selectedAutoScore.degradedReasons.join(", ")}</p>
            ) : null}
            {selectedAutoScore.scoringSchemaVersion === "v3" &&
            selectedAutoScore.attribution.primary !== "not_applicable" ? (
              <p className="mc-pp-note">
                Failure attribution: {formatPromptPackAttribution(selectedAutoScore.attribution.primary)}
                {selectedAutoScore.attribution.evidence.length > 0
                  ? ` • ${selectedAutoScore.attribution.evidence.join("; ")}`
                  : ""}
              </p>
            ) : null}
            <details className="mc-pp-evidence-details" open>
              <summary>Score evidence</summary>
              <div className="mc-pp-table-wrap">
                <table className="mc-pp-table">
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
              </div>
            </details>
          </>
        ) : (
          <EmptyState size="compact" title="No auto-score evidence is available yet for this test." />
        )}
      </section>
    </div>
  );
}
