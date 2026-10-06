import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { OperatorInboxItem } from "@goatcitadel/contracts";
import { fetchApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { buildApprovalEvidenceModel } from "@goatcitadel/mission-control-shared/content/approval-helpers";
import { presentApprovalStatus, presentRiskLevel } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { CHECKING_FOR_CHANGES, lastVersionNote, recordAnswered, recordView } from "../../data/record-view";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import { approvalExpiryLabel, approvalExplanationLine } from "./approval-preview";
import { InboxApprovalActions } from "./InboxApprovalActions";
import { nullWhenMissing } from "./inbox-record-read";

export function InboxApprovalDetail({
  item,
  workspaceId,
  focusAction,
}: {
  item: OperatorInboxItem;
  workspaceId: string;
  focusAction?: "approve" | "deny";
}) {
  const [decisionNotice, setDecisionNotice] = useState("");
  const queryClient = useQueryClient();
  const approvalId = item.source.approvalId;
  // The same key as Chat's blocker card, so moving between them is a cache hit (IN-11).
  const queryKey = ["approvals", "record", workspaceId, approvalId];
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => nullWhenMissing(fetchApproval(approvalId!, { workspaceId, signal })),
    enabled: Boolean(approvalId),
    staleTime: 0,
  });
  // A decided or changed record is superseded. Drop it while the queue is re-read instead of keeping it
  // on screen as a background recheck would, with its old badges and a second copy of the outcome.
  const rereadSettled = (notice: string) => {
    setDecisionNotice(notice);
    void queryClient.resetQueries({ queryKey, exact: true });
  };
  const view = recordView(query);
  const checking = view.phase === "checking";
  const lastVersion = lastVersionNote(view);
  // Only a pending approval is waiting here; a decided one is reviewed in Approvals.
  const approval = view.record?.status === "pending" ? view.record : undefined;
  const evidence = approval ? buildApprovalEvidenceModel(approval.preview) : null;
  return (
    <section aria-label="Current approval" className="space-y-3 border-t border-line-subtle pt-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-display font-semibold text-fg">Current approval</h3>
        <Button
          size="sm"
          onClick={() => {
            setDecisionNotice("");
            void query.refetch();
          }}
          disabled={query.isFetching || !approvalId}
        >
          Refresh
        </Button>
      </div>
      {view.phase === "loading" ? (
        <p role="status" className="text-fg-muted">
          Loading the current approval…
        </p>
      ) : checking ? (
        <p role="status" className="text-fg-muted">
          {CHECKING_FOR_CHANGES}
        </p>
      ) : null}
      {query.isError ? (
        <p role="alert" className="text-fg-secondary">
          {describeApiError(query.error).summary}
        </p>
      ) : null}
      {lastVersion ? <p className="text-fg-muted">{lastVersion}</p> : null}
      {decisionNotice ? (
        <p role="status" className="text-fg-secondary">
          {decisionNotice}
        </p>
      ) : null}
      {recordAnswered(view) && !approval ? (
        <p className="text-fg-muted">
          This approval is no longer waiting. Open Approvals for the current record and outcome.
        </p>
      ) : null}
      {approval ? (
        <>
          <div className="flex flex-wrap gap-2">
            <StatusBadge status={presentRiskLevel(approval.riskLevel)} />
            <StatusBadge status={presentApprovalStatus(approval.status)} />
          </div>
          {approval.expiresAt ? <p className="text-fg-muted">{approvalExpiryLabel(approval.expiresAt)}</p> : null}
          <p className="text-fg-secondary">
            {approvalExplanationLine(approval.explanation?.summary, approval.explanationStatus)}
          </p>
          {approval.explanation?.riskExplanation ? (
            <p className="text-fg-secondary">{approval.explanation.riskExplanation}</p>
          ) : null}
          {approval.explanation?.saferAlternative ? (
            <p className="text-fg-secondary">Safer option: {approval.explanation.saferAlternative}</p>
          ) : null}
          {evidence ? (
            <section aria-label="Action preview" className="space-y-2 rounded-md border border-line bg-sunken p-3">
              <h4 className="font-medium text-fg">Action preview</h4>
              {evidence.targets.length ? (
                <ul className="list-disc space-y-1 pl-5 text-fg-secondary">
                  {evidence.targets.map((target) => (
                    <li key={target}>{target}</li>
                  ))}
                </ul>
              ) : null}
              {evidence.commands.length ? (
                <ul className="space-y-1">
                  {evidence.commands.map((command) => (
                    <li key={command}>
                      <code className="block overflow-x-auto rounded bg-raised p-2 font-mono text-xs text-fg">
                        {command}
                      </code>
                    </li>
                  ))}
                </ul>
              ) : null}
              {evidence.supporting.length ? (
                <ul className="list-disc space-y-1 pl-5 text-fg-secondary">
                  {evidence.supporting.map((support) => (
                    <li key={support}>{support}</li>
                  ))}
                </ul>
              ) : null}
              {evidence.changes.map((change) => (
                <details key={change.label} className="text-fg-secondary">
                  <summary className="cursor-pointer">{change.label}</summary>
                  <pre className="mt-1 overflow-x-auto rounded bg-raised p-2 text-xs">{change.content}</pre>
                </details>
              ))}
            </section>
          ) : (
            <p className="text-fg-muted">
              A structured preview is not available here. Open the full approval record before deciding.
            </p>
          )}
          {approval.rollbackNote ? <p className="text-fg-secondary">Recovery: {approval.rollbackNote}</p> : null}
          {evidence ? (
            <InboxApprovalActions
              item={item}
              approval={approval}
              workspaceId={workspaceId}
              focusAction={focusAction}
              checking={checking}
              onResolved={rereadSettled}
              onInvalidated={() => rereadSettled("The approval changed. Review the refreshed record before deciding.")}
            />
          ) : null}
          <p className="text-xs text-fg-muted">
            This is the current record for this workspace. The full decision and follow-on record remain in Approvals.
          </p>
        </>
      ) : null}
    </section>
  );
}
