import type { useCodeRunLedger } from "./useCodeRunLedger";

import { StatusChip } from "../../native-routes/primitives";

import {
  CODE_MODE_VERIFICATION_COMMANDS,
  codeModeVerificationTone,
  codeModeVerificationCopy,
} from "./code-workbench-evidence";
import type { CodeModeVerificationCommandName } from "@goatcitadel/contracts";
import { formatRunTimestamp, formatShortHash } from "./format";

export function CodeRunVerification({ ledger }: { ledger: ReturnType<typeof useCodeRunLedger> }) {
  const {
    verificationCommandName,
    setVerificationCommandName,
    verificationEvidence,
    verificationEvidenceLoading,
    verificationActionBusy,
    verificationError,
    selectedRunDetail,
    selectedRunVerificationStatus,
    selectedRunVerificationEvidence,
    selectedRunArtifactIntegrity,
    runNamedCodeModeVerification,
  } = ledger;
  if (!selectedRunDetail) return null;
  return (
    <>
      <section className="mc-next-workbench-output-preview" aria-label="Code Mode verification truth">
        <div className="mc-next-panel-list-head">
          <strong>Execution and verification truth</strong>
          <span>{verificationEvidence.length} durable proof events</span>
        </div>
        <div className="mc-next-workbench-action-row">
          <StatusChip tone={selectedRunDetail.status === "completed" ? "success" : "warning"}>
            Execution: {selectedRunDetail.status}
          </StatusChip>
          <StatusChip
            tone={verificationEvidenceLoading ? "muted" : codeModeVerificationTone(selectedRunVerificationStatus)}
          >
            Verification: {verificationEvidenceLoading ? "checking" : selectedRunVerificationStatus}
          </StatusChip>
          {selectedRunArtifactIntegrity ? (
            <StatusChip tone={selectedRunArtifactIntegrity.tone}>
              Artifact integrity: {selectedRunArtifactIntegrity.label}
            </StatusChip>
          ) : null}
        </div>
        <p className="mc-next-workbench-empty">
          {verificationEvidenceLoading
            ? "Checking the append-only proof ledger before displaying a semantic verification claim."
            : codeModeVerificationCopy(selectedRunVerificationStatus, selectedRunVerificationEvidence)}
        </p>
        {selectedRunArtifactIntegrity ? (
          <p className="mc-next-workbench-empty">{selectedRunArtifactIntegrity.detail}</p>
        ) : null}
        <div className="mc-next-workbench-action-row">
          <label className="mc-next-code-source-field">
            <span>Guarded named proof</span>
            <select
              aria-label="Guarded Code Mode verification command"
              value={verificationCommandName}
              onChange={(event) => setVerificationCommandName(event.target.value as CodeModeVerificationCommandName)}
              disabled={verificationActionBusy}
            >
              {CODE_MODE_VERIFICATION_COMMANDS.map((command) => (
                <option key={command.name} value={command.name}>
                  {command.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="mc-next-panel-button"
            onClick={() => void runNamedCodeModeVerification()}
            disabled={
              selectedRunDetail.status !== "completed" || !selectedRunDetail.sessionId || verificationActionBusy
            }
            title={
              selectedRunDetail.status !== "completed"
                ? "Named proof is available only after successful execution."
                : !selectedRunDetail.sessionId
                  ? "This run is not linked to a Chat workbench session."
                  : undefined
            }
          >
            {verificationActionBusy ? "Running named proof..." : "Run named proof"}
          </button>
        </div>
        <p className="mc-next-workbench-empty">
          The Gateway maps this selection to a fixed server-owned command in the linked Chat workbench. No arbitrary
          command text is accepted, and this does not establish hostile-code sandboxing.
        </p>
        {verificationError ? <div className="mc-next-panel-banner warning">{verificationError}</div> : null}
        {selectedRunVerificationEvidence ? (
          <ul className="mc-next-context-list">
            <li>
              <strong>Latest proof event</strong>
              <p>
                {selectedRunVerificationEvidence.commandLabel} · {selectedRunVerificationEvidence.scope}
                scope · {selectedRunVerificationEvidence.commandStatus}
                {typeof selectedRunVerificationEvidence.exitCode === "number"
                  ? ` · exit ${selectedRunVerificationEvidence.exitCode}`
                  : ""}
              </p>
            </li>
            <li>
              <strong>Proof subject</strong>
              <p>{formatShortHash(selectedRunVerificationEvidence.subject.subjectHash)}</p>
            </li>
            <li>
              <strong>Recorded</strong>
              <p>{formatRunTimestamp(selectedRunVerificationEvidence.createdAt)}</p>
            </li>
          </ul>
        ) : null}
      </section>
    </>
  );
}
