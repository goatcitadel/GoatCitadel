import type { useCodeRunLedger } from "./useCodeRunLedger";
import type { useCodeRunArtifacts } from "./useCodeRunArtifacts";
import type { CodePanelType } from "./code-workbench-model";

import { shortId } from "./format";
import { CodeRunVerification } from "./CodeRunVerification";
import { CodeRunMetadata } from "./CodeRunMetadata";
import { CodeRunEvidence } from "./CodeRunEvidence";

export function CodeRunDetail({
  ledger,
  artifacts,
  onOpenApprovals,
}: {
  ledger: ReturnType<typeof useCodeRunLedger>;
  artifacts: ReturnType<typeof useCodeRunArtifacts>;
  onOpenApprovals: CodePanelType["props"]["onOpenApprovals"];
}) {
  const { runDetailLoading, runDetailError, selectedRunSummary, selectedRunDetail, selectedRunApprovalId } = ledger;
  return (
    <>
      {selectedRunSummary ? (
        <section className="mc-next-workbench-run-detail">
          <div className="mc-next-panel-list-head">
            <strong>Code Mode run detail</strong>
            <span>{shortId(selectedRunSummary.runId)}</span>
          </div>
          {runDetailLoading ? <p>Loading run detail...</p> : null}
          {runDetailError ? <div className="mc-next-panel-banner warning">{runDetailError}</div> : null}
          {!selectedRunDetail && selectedRunApprovalId ? (
            <ul className="mc-next-context-list">
              <li>
                <strong>Approval</strong>
                <p>{selectedRunApprovalId}</p>
                {onOpenApprovals ? (
                  <button
                    type="button"
                    className="mc-next-panel-button"
                    onClick={() => onOpenApprovals(selectedRunApprovalId)}
                  >
                    Open approval queue
                  </button>
                ) : null}
              </li>
            </ul>
          ) : null}
          {selectedRunDetail ? (
            <>
              <CodeRunVerification ledger={ledger} />
              <CodeRunMetadata ledger={ledger} onOpenApprovals={onOpenApprovals} />
              <CodeRunEvidence ledger={ledger} artifacts={artifacts} />
            </>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
