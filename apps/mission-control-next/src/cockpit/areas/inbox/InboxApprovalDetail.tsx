import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { ApprovalShellExplanations } from "./ApprovalShellExplanations";
import { ApprovalCodeOutcome } from "./ApprovalCodeOutcome";
import { ApprovalAuditRecovery } from "./ApprovalAuditRecovery";
import { readSpecialistEvidence, specialistEvidenceMatches } from "./specialist-approval-evidence";
import { SpecialistApprovalReview } from "./SpecialistApprovalReview";
import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { ApprovalSettlement } from "./ApprovalSettlement";
import { RiskBadge } from "../../ui/RiskBadge";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { OperatorInboxItem } from "@goatcitadel/contracts";
import { fetchApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { buildApprovalEvidenceModel } from "@goatcitadel/mission-control-shared/content/approval-helpers";
import { presentApprovalStatus } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { CHECKING_FOR_CHANGES, lastVersionNote, recordAnswered, recordView } from "../../data/record-view";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import { approvalExpiryLabel, approvalExplanationLine } from "./approval-preview";
import { InboxApprovalActions } from "./InboxApprovalActions";
import { queryKeys } from "../../data/query-keys";
import { nullWhenMissing } from "./inbox-record-read";

export function InboxApprovalDetail({
  item,
  workspaceId,
  focusAction,
  ownerChecking = false,
}: {
  item: OperatorInboxItem;
  workspaceId: string;
  focusAction?: "approve" | "deny";
  ownerChecking?: boolean;
}) {
  const access = useProjectAccess(workspaceId);
  const [decisionNotice, setDecisionNotice] = useState("");
  const noticeRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (decisionNotice) noticeRef.current?.focus(); }, [decisionNotice]);
  const queryClient = useQueryClient();
  const approvalId = item.source.approvalId;
  // The same key as Chat's blocker card, so moving between them is a cache hit (IN-11).
  const queryKey = ["approvals", "record", workspaceId, approvalId, access.identity];
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => nullWhenMissing(fetchApproval(approvalId!, { workspaceId, signal })),
    enabled: Boolean(approvalId),
    staleTime: 0,
  });
  // Re-read the owner after a decision or stale review; the settled receipt remains reachable
  // through LinkedApproval after the pending projection removes this selection.
  const rereadSettled = (notice: string) => {
    setDecisionNotice(notice);
    void queryClient.resetQueries({ queryKey, exact: true });
    void queryClient.invalidateQueries({ queryKey: queryKeys.inbox(workspaceId) });
    const runId = query.data?.linkage?.durableRunId;
    if (runId) void queryClient.invalidateQueries({ queryKey: queryKeys.runTrace(runId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.durableRunHistory(workspaceId) });
  };
  const view = recordView(query);
  const checking = ownerChecking || view.phase === "checking";
  const lastVersion = lastVersionNote(view);
  // Pending decisions and settled follow-on evidence are separate native views of the owner record.
  const approval = view.record?.status === "pending" ? view.record : undefined;
  const settled = view.record && view.record.status !== "pending" ? view.record : undefined;
  const evidence = approval ? buildApprovalEvidenceModel(approval.preview) : null;
  // A decided record stays evidence: its request is shown read-only, never with decision controls.
  const settledEvidence = settled ? buildApprovalEvidenceModel(settled.preview) : null;
  const specialist = Boolean(approval && ["code_mode.run", "remote_worker.native_runtime"].includes(approval.kind));
  const specialistQuery = useQuery({
    queryKey: ["approvals", "specialist", access.identity, approval],
    queryFn: () => readSpecialistEvidence(approval!), enabled: specialist, retry: false, staleTime: 0,
  });
  const specialistEvidence = approval && !specialistQuery.isError && specialistQuery.data && specialistEvidenceMatches(approval, specialistQuery.data) ? specialistQuery.data : undefined;

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
        <p ref={noticeRef} tabIndex={-1} role="status" className="text-fg-secondary">
          {decisionNotice}
        </p>
      ) : null}
      {view.record ? <ApprovalAuditRecovery approval={view.record} workspaceId={workspaceId} checking={checking || query.isError} /> : null}
      {view.record?.kind === "change_plan_effect" && ["llama_cpp_setup", "llama_cpp_configuration"].includes(String(view.record.payload.targetResourceId)) && view.record.linkage?.workspaceId === workspaceId && !query.isError ? <NativeOwnerLink href="/settings/models#local-ai" scope={access.identity}>Return to llama.cpp setup</NativeOwnerLink> : null}
      {settled?.kind === "code_mode.run" ? <ApprovalCodeOutcome approval={settled} workspaceId={workspaceId} /> : null}
      {settled ? <ApprovalSettlement approval={settled} workspaceId={workspaceId} /> : null}
      {settled ? (
        <section aria-label="Decided request" className="space-y-2 rounded-md border border-line bg-sunken p-3">
          <div className="flex flex-wrap gap-2">
            <RiskBadge risk={settled.riskLevel} />
            <StatusBadge status={presentApprovalStatus(settled.status)} />
          </div>
          {settledEvidence?.commands.length ? (
            <ul className="space-y-1">
              {settledEvidence.commands.map((command) => (
                <li key={command}>
                  <code className="break-all font-mono text-xs text-fg">{command}</code>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      {recordAnswered(view) && !approval && !settled && !decisionNotice ? (
        <p className="text-fg-muted">
          This approval is no longer waiting. Open Approvals for the current record and outcome.
        </p>
      ) : null}
      {approval ? (
        <>
          <div className="flex flex-wrap gap-2">
            <RiskBadge risk={approval.riskLevel} />
            <StatusBadge status={presentApprovalStatus(approval.status)} />
          </div>
          {approval.expiresAt ? <p className="text-fg-muted">{approvalExpiryLabel(approval.expiresAt)}</p> : null}
          <p className="text-fg-secondary">
            {approvalExplanationLine(approval.explanation?.summary, approval.explanationStatus)}
          </p>
          {approval.explanation?.riskExplanation ? (
            <p className="text-fg-secondary">{approval.explanation.riskExplanation}</p>
          ) : null}
          {approval.explanationError ? <p role="alert">Approval summary unavailable: {approval.explanationError}</p> : null}
          {approval.explanation?.saferAlternative ? (
            <p className="text-fg-secondary">Safer option: {approval.explanation.saferAlternative}</p>
          ) : null}
          {evidence ? (
            <section aria-label="Action preview" className="space-y-2 rounded-md border border-line bg-sunken p-3">
              <h4 className="font-medium text-fg">Action preview</h4>
              {evidence.targets.length ? (
                <ul className="list-disc space-y-1 pl-5 text-fg-secondary">
                  {evidence.targets.map((target) => (
                    <li className="break-all" key={target}>{target}</li>
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
              {evidence.commands.length ? <ApprovalShellExplanations commands={evidence.commands} explanations={approval.shellExplanations} /> : null}
              {evidence.supporting.length ? (
                <ul className="list-disc space-y-1 pl-5 text-fg-secondary">
                  {evidence.supporting.map((support) => (
                    <li className="break-all" key={support}>{support}</li>
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
          {specialist ? <><Button disabled={specialistQuery.isFetching} onClick={() => void specialistQuery.refetch()}>Refresh specialist evidence</Button>{specialistEvidence ? <SpecialistApprovalReview approval={approval} evidence={specialistEvidence} /> : <p role="alert">{specialistQuery.error ? describeApiError(specialistQuery.error).summary : "Specialist evidence is unavailable or changed. Refresh before approving."}</p>}</> : null}
          {evidence || specialist ? (
            <InboxApprovalActions
              specialistEvidence={specialistEvidence}
              item={item}
              approval={approval}
              workspaceId={workspaceId}
              focusAction={focusAction}
              checking={checking || (specialist && specialistQuery.isFetching)}
              onResolved={rereadSettled}
              onInvalidated={(message) => rereadSettled(message ?? "The approval changed. Review the refreshed record before deciding.")}
            />
          ) : null}
          <p className="text-xs text-fg-muted">
            This is the current approval record. A decision alone does not prove its action ran.
          </p>
        </>
      ) : null}
    </section>
  );
}
