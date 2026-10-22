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
import {
  presentApprovalOutcome,
  presentApprovalStatus,
} from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { CHECKING_FOR_CHANGES, lastVersionNote, recordAnswered, recordView } from "../../data/record-view";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import { approvalExpiryLabel, approvalExplanationLine, splitApprovalSupport } from "./approval-preview";
import { InboxApprovalActions } from "./InboxApprovalActions";
import { queryKeys } from "../../data/query-keys";
import { nullWhenMissing } from "./inbox-record-read";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { hasExpired, useMinuteClock } from "./use-minute-clock";

export function InboxApprovalDetail({
  item,
  workspaceId,
  focusAction,
  ownerChecking = false,
  onDecision,
}: {
  item: OperatorInboxItem;
  workspaceId: string;
  focusAction?: "approve" | "deny";
  ownerChecking?: boolean;
  /**
   * Inside the Inbox page, the page announces the decision and moves focus once (IN-07). Without it (a linked
   * approval), focus moves to the notice here instead, so its text is read.
   */
  onDecision?: (message: string, settled: boolean) => void;
}) {
  const access = useProjectAccess(workspaceId);
  const [decisionNotice, setDecisionNotice] = useState("");
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const pageOwnsFocus = Boolean(onDecision);
  useEffect(() => {
    if (decisionNotice && !pageOwnsFocus) noticeRef.current?.focus();
  }, [decisionNotice, pageOwnsFocus]);
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
  const rereadSettled = (notice: string, settled: boolean) => {
    setDecisionNotice(notice);
    onDecision?.(notice, settled);
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
    queryFn: () => readSpecialistEvidence(approval!),
    enabled: specialist,
    retry: false,
    staleTime: 0,
  });
  const specialistEvidence =
    approval &&
    !specialistQuery.isError &&
    specialistQuery.data &&
    specialistEvidenceMatches(approval, specialistQuery.data)
      ? specialistQuery.data
      : undefined;
  // Still reading: say so, and raise an alert only once the read has failed or returned something else (IN-16).
  const specialistChecking = !specialistQuery.isError && (specialistQuery.isPending || specialistQuery.isFetching);
  const support = splitApprovalSupport(evidence?.supporting ?? []);
  // One failure line, and only when no explanation loaded (IN-L01).
  const explanationLoaded = Boolean(approval?.explanation?.summary?.trim());
  const explanationFailed =
    !explanationLoaded && (Boolean(approval?.explanationError) || approval?.explanationStatus === "failed");
  const now = useMinuteClock(approval?.expiresAt);
  const expired = hasExpired(approval?.expiresAt, now);

  return (
    <section aria-label="Current approval" className="space-y-3 border-t border-line-subtle pt-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold text-fg">Current approval</h3>
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
        // Not a live region: the page announcer (or focus, for a linked approval) reads it once.
        <p ref={noticeRef} tabIndex={-1} data-inbox-decision-notice className="text-fg-secondary">
          {decisionNotice}
        </p>
      ) : null}
      {view.record ? (
        <ApprovalAuditRecovery approval={view.record} workspaceId={workspaceId} checking={checking || query.isError} />
      ) : null}
      {view.record?.kind === "change_plan_effect" &&
      ["llama_cpp_setup", "llama_cpp_configuration"].includes(String(view.record.payload.targetResourceId)) &&
      view.record.linkage?.workspaceId === workspaceId &&
      !query.isError ? (
        <NativeOwnerLink href="/settings/models#local-ai" scope={access.identity}>
          Return to llama.cpp setup
        </NativeOwnerLink>
      ) : null}
      {settled?.kind === "code_mode.run" ? <ApprovalCodeOutcome approval={settled} workspaceId={workspaceId} /> : null}
      {settled ? <ApprovalSettlement approval={settled} workspaceId={workspaceId} /> : null}
      {settled ? (
        <section aria-label="Decided request" className="space-y-2 border-t border-line-subtle pt-3">
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
          This approval is no longer waiting. Its record is not available in this workspace.
        </p>
      ) : null}
      {approval ? (
        <>
          <div className="flex flex-wrap gap-2">
            <RiskBadge risk={approval.riskLevel} />
            <StatusBadge
              status={expired ? presentApprovalOutcome("expired") : presentApprovalStatus(approval.status)}
            />
          </div>
          {approval.expiresAt ? <p className="text-fg-muted">{approvalExpiryLabel(approval.expiresAt, now)}</p> : null}
          {explanationFailed ? (
            <p role="alert">Approval summary unavailable. Review the action preview before deciding.</p>
          ) : (
            <p className="text-fg-secondary">
              {approvalExplanationLine(approval.explanation?.summary, approval.explanationStatus)}
            </p>
          )}
          {approval.explanation?.riskExplanation ? (
            <p className="text-fg-secondary">{approval.explanation.riskExplanation}</p>
          ) : null}
          {approval.explanationError ? (
            <TechnicalDetails>
              <p>{approval.explanationError}</p>
            </TechnicalDetails>
          ) : null}
          {approval.explanation?.saferAlternative ? (
            <p className="text-fg-secondary">Safer option: {approval.explanation.saferAlternative}</p>
          ) : null}
          {evidence ? (
            <section aria-label="Action preview" className="space-y-2 border-t border-line-subtle pt-3">
              <h4 className="font-medium text-fg">Action preview</h4>
              {evidence.targets.length ? (
                <ul className="list-disc space-y-1 pl-5 text-fg-secondary">
                  {evidence.targets.map((target) => (
                    <li className="wrap-anywhere" key={target}>
                      {target}
                    </li>
                  ))}
                </ul>
              ) : null}
              {evidence.commands.length ? (
                <ul className="space-y-1">
                  {evidence.commands.map((command) => (
                    <li key={command}>
                      <code className="block overflow-x-auto rounded-md bg-sunken p-2 font-mono text-xs text-fg">
                        {command}
                      </code>
                    </li>
                  ))}
                </ul>
              ) : null}
              {evidence.commands.length ? (
                <ApprovalShellExplanations commands={evidence.commands} explanations={approval.shellExplanations} />
              ) : null}
              {support.visible.length ? (
                <ul className="list-disc space-y-1 pl-5 text-fg-secondary">
                  {support.visible.map((line) => (
                    <li className="wrap-anywhere" key={line}>
                      {line}
                    </li>
                  ))}
                </ul>
              ) : null}
              {support.technical.length ? (
                <TechnicalDetails label="Recorded request details">
                  {support.technical.map((line) => (
                    <p key={line} className="break-all font-mono text-xs">
                      {line}
                    </p>
                  ))}
                </TechnicalDetails>
              ) : null}
              {evidence.changes.map((change) => (
                <details key={change.label} className="text-fg-secondary">
                  <summary className="cursor-pointer">{change.label}</summary>
                  <pre className="mt-1 overflow-x-auto rounded-md bg-sunken p-2 text-xs">{change.content}</pre>
                </details>
              ))}
            </section>
          ) : (
            <p className="text-fg-muted">
              A structured preview is not available, so this approval can&apos;t be decided here.
            </p>
          )}
          {approval.rollbackNote ? <p className="text-fg-secondary">Recovery: {approval.rollbackNote}</p> : null}
          {specialist ? (
            <>
              <Button disabled={specialistQuery.isFetching} onClick={() => void specialistQuery.refetch()}>
                Check again
              </Button>
              {specialistEvidence ? (
                <SpecialistApprovalReview approval={approval} evidence={specialistEvidence} />
              ) : (
                <p role={specialistChecking ? "status" : "alert"} className={specialistChecking ? "text-fg-muted" : ""}>
                  {specialistChecking
                    ? "Checking the specialist review…"
                    : specialistQuery.error
                      ? describeApiError(specialistQuery.error).summary
                      : "The specialist review is unavailable or changed. Check again before approving."}
                </p>
              )}
            </>
          ) : null}
          {evidence || specialist ? (
            <InboxApprovalActions
              // This detail states the expiry above, so the decision summary leaves it out.
              expiryShownNearby
              specialistEvidence={specialistEvidence}
              item={item}
              approval={approval}
              workspaceId={workspaceId}
              focusAction={focusAction}
              checking={checking || (specialist && specialistQuery.isFetching)}
              onResolved={(message) => rereadSettled(message, true)}
              onInvalidated={(message) =>
                rereadSettled(message ?? "The approval changed. Review the refreshed record before deciding.", false)
              }
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}
