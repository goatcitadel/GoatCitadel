import { RiskBadge } from "../../ui/RiskBadge";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { useQuery } from "@tanstack/react-query";
import { fetchApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { useState } from "react";
import { ApprovalDecisionBar } from "../inbox/ApprovalDecisionBar";
import { ApprovalSettlement } from "../inbox/ApprovalSettlement";
import { approvalExpiryLabel } from "../inbox/approval-preview";
import { nullWhenMissing } from "../inbox/inbox-record-read";
import { ChatPendingQuestion } from "./ChatPendingQuestion";

type Blockers = Pick<
  MissionThreadedActiveSessionSurfaceProps,
  | "pendingApproval"
  | "pendingUserInput"
  | "selectedSessionId"
  | "approvalPending"
  | "userInputPending"
  | "onApprovePending"
  | "onDenyPending"
  | "onSubmitUserInput"
  | "onRefreshThread"
>;

export function ChatBlockers({ props }: { props: Blockers }) {
  const { activeWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const pendingApproval = props.pendingApproval;
  const approvalId = pendingApproval?.approvalId;
  const [receipt, setReceipt] = useState<{ scope: string; message: string }>();
  const noticeScope = JSON.stringify([workspaceId, props.selectedSessionId, approvalId]);
  const notice = receipt?.scope === noticeScope ? receipt.message : "";
  const recordQuery = useQuery({
    // The same key as the Inbox approval detail, so moving between them is a cache hit (IN-11).
    queryKey: ["approvals", "record", workspaceId, approvalId],
    queryFn: ({ signal }) => nullWhenMissing(fetchApproval(approvalId!, { workspaceId, signal })),
    // Every risk RiskApprovalAction reviews needs the persisted evidence; only safe and caution are one-click.
    enabled: Boolean(approvalId),
    staleTime: 0,
  });
  const reviewedApproval = recordQuery.data?.approvalId === approvalId ? recordQuery.data : undefined;
  // Retained stream signals can omit risk metadata. Hydrate only from the
  // matching pending canonical record; unavailable/settled records stay closed.
  const approval =
    pendingApproval &&
    !pendingApproval.riskLevel &&
    reviewedApproval?.approvalId === pendingApproval.approvalId &&
    reviewedApproval.status === "pending"
      ? {
          ...pendingApproval,
          kind: reviewedApproval.kind,
          riskLevel: reviewedApproval.riskLevel,
          expiresAt: reviewedApproval.expiresAt,
        }
      : pendingApproval;
  const input = props.pendingUserInput;
  const expiry = approvalExpiryLabel(approval?.expiresAt);
  const chatHref = props.selectedSessionId
    ? `/chat?sessionId=${encodeURIComponent(props.selectedSessionId)}&shell=classic`
    : "/chat?shell=classic";
  return (
    <>
      {approval ? (
        <section
          aria-label="Pending approval"
          className="mt-3 rounded-md border border-status-waiting bg-raised p-3 text-sm"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="font-display font-semibold text-fg">Approval needed</h3>
              <p className="mt-1 text-fg-secondary">
                {approval.toolName || (approval.kind ? humanizeToken(approval.kind) : "Action request")}
              </p>
            </div>
            {approval.riskLevel ? <RiskBadge risk={approval.riskLevel} /> : null}
          </div>
          {approval.reason ? <p className="mt-2 text-fg-secondary">{approval.reason}</p> : null}
          {approval.affectedResources?.length ? (
            <p className="mt-2 text-xs text-fg-secondary">Touches: {approval.affectedResources.join(", ")}</p>
          ) : null}
          {approval.codePreview ? (
            <details className="mt-2 text-xs text-fg-secondary">
              <summary>Code preview</summary>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-sunken p-2">
                {approval.codePreview}
              </pre>
            </details>
          ) : null}
          {expiry ? <p className="mt-2 text-xs text-fg-muted">{expiry}</p> : null}
          {notice ? <p role="status">{notice}</p> : null}
          {reviewedApproval?.status === "pending" ? (
            <ApprovalDecisionBar
              approval={reviewedApproval}
              workspaceId={workspaceId}
              sessionId={props.selectedSessionId ?? undefined}
              checking={recordQuery.isFetching || recordQuery.isError || props.approvalPending}
              onResolved={(message) => {
                setReceipt({ scope: noticeScope, message });
                void recordQuery.refetch();
                props.onRefreshThread();
              }}
              onInvalidated={() => { void recordQuery.refetch(); props.onRefreshThread(); }}
            />
          ) : (
            <p role="status">
              {reviewedApproval
                ? "Decision recorded. Check follow-on work below."
                : recordQuery.isPending
                  ? "Checking the current approval…"
                  : "Current approval unavailable. Open the persisted record before deciding."}
            </p>
          )}
          {reviewedApproval && reviewedApproval.status !== "pending" ? (
            <ApprovalSettlement approval={reviewedApproval} workspaceId={workspaceId} />
          ) : null}
          <ClassicOwnerLink
            href={`/ops/approvals?approvalId=${encodeURIComponent(approval.approvalId)}&shell=classic`}
            scope={JSON.stringify([props.selectedSessionId, approval.approvalId])}
            className="mt-2 inline-block font-medium text-accent hover:underline"
            label="Inspect persisted approval"
          />
        </section>
      ) : null}
      {input ? (
        <>
          <ChatPendingQuestion
            key={input.promptId}
            prompt={input}
            pending={props.userInputPending}
            onSubmit={props.onSubmitUserInput}
          />
          <ClassicOwnerLink
            href={chatHref}
            scope={JSON.stringify([props.selectedSessionId, input.promptId])}
            className="mt-2 inline-block text-xs font-medium text-accent hover:underline"
            label="Open this question in the classic view"
          />
        </>
      ) : null}
    </>
  );
}
