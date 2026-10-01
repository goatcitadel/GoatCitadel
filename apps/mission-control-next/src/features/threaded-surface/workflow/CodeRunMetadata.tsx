import type { useCodeRunLedger } from "./useCodeRunLedger";

import type { CodePanelType } from "./code-workbench-model";

import {
  formatArtifactPath,
  formatRunPermissionProfile,
  formatOriginSurface,
  formatRunTimestamp,
  formatSandboxPosture,
  formatExecutionBackend,
  formatShortHash,
} from "./format";

export function CodeRunMetadata({
  ledger,
  onOpenApprovals,
}: {
  ledger: ReturnType<typeof useCodeRunLedger>;
  onOpenApprovals: CodePanelType["props"]["onOpenApprovals"];
}) {
  const { selectedRunDetail, selectedRunApprovalId } = ledger;
  if (!selectedRunDetail) return null;
  return (
    <>
      <ul className="mc-next-context-list">
        <li>
          <strong>Status</strong>
          <p>{selectedRunDetail.status}</p>
        </li>
        <li>
          <strong>Approval</strong>
          <p>{selectedRunApprovalId ?? "not linked"}</p>
          {selectedRunApprovalId && onOpenApprovals ? (
            <button
              type="button"
              className="mc-next-panel-button"
              onClick={() => onOpenApprovals(selectedRunApprovalId)}
            >
              Open approval queue
            </button>
          ) : null}
        </li>
        <li>
          <strong>Permission profile</strong>
          <p>{formatRunPermissionProfile(selectedRunDetail)}</p>
        </li>
        <li>
          <strong>Local Operator Override</strong>
          <p>{selectedRunDetail.localOperatorOverrideId ?? "not recorded"}</p>
        </li>
        <li>
          <strong>Surface</strong>
          <p>{formatOriginSurface(selectedRunDetail.originSurface)}</p>
        </li>
        <li>
          <strong>Created</strong>
          <p>{formatRunTimestamp(selectedRunDetail.createdAt)}</p>
        </li>
        <li>
          <strong>Started</strong>
          <p>{formatRunTimestamp(selectedRunDetail.startedAt)}</p>
        </li>
        <li>
          <strong>Finished</strong>
          <p>{formatRunTimestamp(selectedRunDetail.finishedAt)}</p>
        </li>
        <li>
          <strong>Sandbox posture</strong>
          <p>{formatSandboxPosture(selectedRunDetail.sandbox)}</p>
        </li>
        <li>
          <strong>Execution backend</strong>
          <p>{formatExecutionBackend(selectedRunDetail.executionBackend)}</p>
        </li>
        <li>
          <strong>Source hash</strong>
          <p>{formatShortHash(selectedRunDetail.codeHash)}</p>
        </li>
        <li>
          <strong>Input hash</strong>
          <p>{formatShortHash(selectedRunDetail.codeModeInputHash)}</p>
        </li>
        <li>
          <strong>Wrapper hash</strong>
          <p>{formatShortHash(selectedRunDetail.wrapperManifestHash)}</p>
        </li>
        <li>
          <strong>Policy hash</strong>
          <p>{formatShortHash(selectedRunDetail.policySnapshotHash)}</p>
        </li>
        <li>
          <strong>Source artifact</strong>
          <p>{formatArtifactPath(selectedRunDetail.codeArtifact)}</p>
        </li>
        <li>
          <strong>Wrapper artifact</strong>
          <p>{formatArtifactPath(selectedRunDetail.wrapperManifestArtifact)}</p>
        </li>
        <li>
          <strong>Policy artifact</strong>
          <p>{formatArtifactPath(selectedRunDetail.policySnapshotArtifact)}</p>
        </li>
        <li>
          <strong>Stdout artifact</strong>
          <p>{formatArtifactPath(selectedRunDetail.stdoutArtifact)}</p>
        </li>
        <li>
          <strong>Stderr artifact</strong>
          <p>{formatArtifactPath(selectedRunDetail.stderrArtifact)}</p>
        </li>
      </ul>
    </>
  );
}
