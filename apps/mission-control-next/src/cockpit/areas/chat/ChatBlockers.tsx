import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { useQuery } from "@tanstack/react-query";
import { fetchApprovals } from "@goatcitadel/mission-control-shared/api/client";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { humanizeToken, presentRiskLevel } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { StatusBadge } from "../../ui/StatusBadge";
import { Button } from "../../ui/Button";
import { approvalExpiryLabel } from "../inbox/approval-preview";
import { ChatPendingQuestion } from "./ChatPendingQuestion";
import { RiskApprovalAction } from "./RiskApprovalAction";

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
>;

export function ChatBlockers({ props }: { props: Blockers }) {
  const { activeWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const pendingApproval = props.pendingApproval;
  const reviewedApproval = useQuery({
    queryKey: ["approvals", "cockpit-chat-danger", workspaceId, pendingApproval?.approvalId],
    queryFn: () => fetchApprovals({ status: "pending", workspaceId, limit: 200 }),
    enabled: Boolean(
      pendingApproval &&
      (!pendingApproval.riskLevel || pendingApproval.riskLevel === "danger" || pendingApproval.riskLevel === "nuclear"),
    ),
    staleTime: 0,
  }).data?.items.find((record) => record.approvalId === pendingApproval?.approvalId);
  // Retained stream signals can omit risk metadata. Hydrate only from the
  // matching pending canonical record; unavailable/settled records stay closed.
  const approval =
    pendingApproval && !pendingApproval.riskLevel && reviewedApproval?.status === "pending"
      ? {
          ...pendingApproval,
          kind: reviewedApproval.kind,
          riskLevel: reviewedApproval.riskLevel,
          expiresAt: reviewedApproval.expiresAt,
        }
      : pendingApproval;
  const input = props.pendingUserInput;
  const expiry = approvalExpiryLabel(approval?.expiresAt);
  const approvalReviewKey = JSON.stringify([
    props.selectedSessionId,
    approval?.approvalId,
    approval?.kind,
    approval?.riskLevel,
    approval?.toolName,
    approval?.reason,
    approval?.expiresAt,
    approval?.codeHash,
    approval?.wrapperManifestHash,
    approval?.capabilitySnapshotId,
    approval?.inspectPath,
    approval?.requestedOutputIntent,
    approval?.saveCandidateOnSuccess,
    approval?.remainingCount,
    approval?.affectedResources,
    approval?.codePreview,
  ]);
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
            {approval.riskLevel ? <StatusBadge status={presentRiskLevel(approval.riskLevel)} /> : null}
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
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <RiskApprovalAction
              key={approvalReviewKey}
              approval={approval}
              reviewedApproval={reviewedApproval}
              pending={props.approvalPending}
              onApprove={() => props.onApprovePending("once")}
            />
            <Button variant="secondary" size="sm" disabled={props.approvalPending} onClick={props.onDenyPending}>
              Deny
            </Button>
          </div>
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
