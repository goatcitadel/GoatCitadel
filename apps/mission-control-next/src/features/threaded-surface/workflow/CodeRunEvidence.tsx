import type { useCodeRunLedger } from "./useCodeRunLedger";
import type { useCodeRunArtifacts } from "./useCodeRunArtifacts";

import { WorkbenchMonacoEditor } from "@goatcitadel/mission-control-shared/components/WorkbenchMonacoEditor";
import {
  CODE_MODE_ARTIFACT_KINDS,
  codeModeArtifactLanguage,
  isCodeModeArtifactAvailable,
  codeModeComparisonRows,
} from "./code-workbench-evidence";

import { shortId, formatArtifactPath, formatRunTimestamp, formatShortHash } from "./format";

export function CodeRunEvidence({
  ledger,
  artifacts,
}: {
  ledger: ReturnType<typeof useCodeRunLedger>;
  artifacts: ReturnType<typeof useCodeRunArtifacts>;
}) {
  const { selectedRunDetail, comparisonCandidates } = ledger;
  const {
    capabilityProfile,
    capabilitySnapshotLoading,
    capabilitySnapshotError,
    selectedArtifactKind,
    setSelectedArtifactKind,
    artifactPreview,
    artifactPreviewLoading,
    artifactPreviewError,
    compareBaselineRunId,
    setCompareBaselineRunId,
    runComparison,
    runComparisonLoading,
    runComparisonError,
  } = artifacts;
  if (!selectedRunDetail) return null;
  return (
    <>
      <section className="mc-next-workbench-output-preview">
        <div className="mc-next-panel-list-head">
          <strong>Capability profile</strong>
          <span>{capabilitySnapshotLoading ? "loading" : capabilityProfile ? "frozen" : "missing"}</span>
        </div>
        {capabilitySnapshotError ? (
          <div className="mc-next-panel-banner warning">Capability snapshot unavailable: {capabilitySnapshotError}</div>
        ) : null}
        {capabilityProfile ? (
          <ul className="mc-next-context-list">
            <li>
              <strong>Snapshot</strong>
              <p>{capabilityProfile.snapshotId}</p>
            </li>
            <li>
              <strong>Captured</strong>
              <p>{formatRunTimestamp(capabilityProfile.createdAt)}</p>
            </li>
            <li>
              <strong>Inspectable</strong>
              <p>{capabilityProfile.inspectableCount}</p>
            </li>
            <li>
              <strong>Callable</strong>
              <p>{capabilityProfile.callableCount}</p>
            </li>
            <li>
              <strong>Callable tools</strong>
              <p>{capabilityProfile.callableToolCount}</p>
            </li>
            <li>
              <strong>Callable skills</strong>
              <p>{capabilityProfile.callableSkillCount}</p>
            </li>
            <li>
              <strong>Inspect only</strong>
              <p>{capabilityProfile.inspectableOnlyCount}</p>
            </li>
            <li>
              <strong>Review warnings</strong>
              <p>{capabilityProfile.reviewWarningCount}</p>
            </li>
          </ul>
        ) : capabilitySnapshotLoading ? (
          <p className="mc-next-workbench-empty">Loading frozen capability catalog...</p>
        ) : (
          <p className="mc-next-workbench-empty">This run has not loaded frozen capability profile evidence.</p>
        )}
      </section>
      <section className="mc-next-workbench-output-preview">
        <div className="mc-next-panel-list-head">
          <strong>Artifact inspect</strong>
          <span>
            {artifactPreviewLoading
              ? "verifying"
              : artifactPreview?.sha256
                ? formatShortHash(artifactPreview.sha256)
                : "idle"}
          </span>
        </div>
        <div className="mc-next-workbench-action-row">
          {CODE_MODE_ARTIFACT_KINDS.map((item) => (
            <button
              key={item.kind}
              type="button"
              className={`mc-next-panel-button${selectedArtifactKind === item.kind ? " active" : ""}`}
              onClick={() => setSelectedArtifactKind(item.kind)}
              disabled={!isCodeModeArtifactAvailable(selectedRunDetail, item.kind)}
              title={
                isCodeModeArtifactAvailable(selectedRunDetail, item.kind)
                  ? undefined
                  : `${item.label} artifact is not recorded for this run.`
              }
            >
              {item.label}
            </button>
          ))}
        </div>
        {artifactPreviewError ? <div className="mc-next-panel-banner warning">{artifactPreviewError}</div> : null}
        {artifactPreview ? (
          <>
            <p className="mc-next-workbench-empty">
              {formatArtifactPath(artifactPreview.artifact)}
              {artifactPreview.truncated ? " · truncated" : ""}
            </p>
            <WorkbenchMonacoEditor
              value={artifactPreview.content}
              language={codeModeArtifactLanguage(selectedRunDetail, artifactPreview.artifactKind)}
              readOnly
              height={260}
            />
          </>
        ) : null}
      </section>
      {comparisonCandidates.length ? (
        <section className="mc-next-workbench-output-preview">
          <div className="mc-next-panel-list-head">
            <strong>Run comparison</strong>
            <label className="mc-next-code-source-field">
              <span>Baseline</span>
              <select value={compareBaselineRunId} onChange={(event) => setCompareBaselineRunId(event.target.value)}>
                {comparisonCandidates.map((run) => (
                  <option key={run.runId} value={run.runId}>
                    {shortId(run.runId)} · {run.status ?? "recorded"}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {runComparisonLoading ? <p className="mc-next-workbench-empty">Comparing run evidence...</p> : null}
          {runComparisonError ? <div className="mc-next-panel-banner warning">{runComparisonError}</div> : null}
          {runComparison ? (
            <ul className="mc-next-context-list">
              {codeModeComparisonRows(runComparison).map((row) => (
                <li key={row.label}>
                  <strong>{row.label}</strong>
                  <p>{row.matched ? "same" : "changed"}</p>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      {selectedRunDetail.stdoutPreview ? (
        <div className="mc-next-workbench-output-preview">
          <strong>Stdout preview{selectedRunDetail.stdoutTruncated ? " (truncated)" : ""}</strong>
          <WorkbenchMonacoEditor value={selectedRunDetail.stdoutPreview} language="text" readOnly height={120} />
        </div>
      ) : null}
      {selectedRunDetail.stderrPreview ? (
        <div className="mc-next-workbench-output-preview">
          <strong>Stderr preview{selectedRunDetail.stderrTruncated ? " (truncated)" : ""}</strong>
          <WorkbenchMonacoEditor value={selectedRunDetail.stderrPreview} language="text" readOnly height={120} />
        </div>
      ) : null}
      {selectedRunDetail.result ? (
        <WorkbenchMonacoEditor
          value={JSON.stringify(selectedRunDetail.result, null, 2)}
          language="json"
          readOnly
          height={180}
        />
      ) : null}
      {selectedRunDetail.errorCode ? (
        <div className="mc-next-panel-banner warning">
          {selectedRunDetail.errorCode}
          {selectedRunDetail.errorDetails ? ` · ${JSON.stringify(selectedRunDetail.errorDetails)}` : ""}
        </div>
      ) : null}
      {selectedRunDetail.error ? <div className="mc-next-panel-banner warning">{selectedRunDetail.error}</div> : null}
    </>
  );
}
