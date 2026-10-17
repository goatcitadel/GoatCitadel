import { RiskBadge } from "../../ui/RiskBadge";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { useQuery } from "@tanstack/react-query";
import { fetchApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { useEffect, useRef, useState } from "react";
import { ChatApprovalRenderer } from "./ChatApprovalRenderer";
import { approvalExpiryLabel } from "../inbox/approval-preview";
import { nullWhenMissing } from "../inbox/inbox-record-read";
import { ChatPendingQuestion } from "./ChatPendingQuestion";
import { presentApprovalAction } from "./chat-vocabulary";
import { TechnicalDetails } from "../../ui/TechnicalDetails";

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
> &
  Partial<Pick<MissionThreadedActiveSessionSurfaceProps, "composerRef">>;

export function ChatBlockers({ props }: { props: Blockers }) {
  const { activeWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const { search, hash } = useCockpitRoute();
  const pendingApproval = props.pendingApproval;
  const approvalId = pendingApproval?.approvalId;
  const [receipt, setReceipt] = useState<{ scope: string; message: string }>();
  const noticeScope = JSON.stringify([workspaceId, props.selectedSessionId, approvalId]);
  const notice = receipt?.scope === noticeScope ? receipt.message : "";
  // CH-18: a decision replaces its buttons. If focus was inside and fell to <body>, move it once to the
  // settlement message, or to the composer when the whole card is gone.
  const focusWithin = useRef(false);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const composerRef = props.composerRef;
  useEffect(() => {
    if (!focusWithin.current) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    focusWithin.current = false;
    const composer = composerRef?.current;
    if (noticeRef.current) noticeRef.current.focus({ preventScroll: true });
    else if (composer && !composer.disabled) composer.focus({ preventScroll: true });
  });
  const recordQuery = useQuery({
    // The same key as the Inbox approval detail, so moving between them is a cache hit (IN-11).
    queryKey: ["approvals", "record", workspaceId, approvalId],
    queryFn: ({ signal }) => nullWhenMissing(fetchApproval(approvalId!, { workspaceId, signal })),
    // Every risk RiskApprovalAction reviews needs the persisted evidence; only safe and caution are one-click.
    enabled: Boolean(approvalId),
    staleTime: 0,
  });
  // CH-02: a failed read is an error, not "checking"; a missing record is its own state. Both offer a way forward.
  const recordFailed = recordQuery.isError && !recordQuery.data;
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
  function continuationHref(destination: "/chat" | "/inbox", selectedApprovalId?: string) {
    const parameters = new URLSearchParams(search);
    parameters.set("workspaceId", workspaceId);
    if (props.selectedSessionId) parameters.set("sessionId", props.selectedSessionId);
    else parameters.delete("sessionId");
    if (selectedApprovalId) parameters.set("approvalId", selectedApprovalId);
    else parameters.delete("approvalId");
    parameters.delete("shell");
    parameters.delete("shellScope");
    return `${destination}?${parameters}${hash}`;
  }
  return (
    <div
      onFocusCapture={() => {
        focusWithin.current = true;
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) focusWithin.current = false;
      }}
    >
      {approval ? (
        <section
          aria-label="Pending approval"
          className="mt-3 rounded-md border border-status-waiting bg-raised p-3 text-sm"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="font-semibold text-fg">Approval needed</h3>
              <p className="mt-1 text-fg-secondary">{presentApprovalAction(approval.toolName, approval.kind)}</p>
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
          {approval.toolName || approval.kind ? (
            <TechnicalDetails label="Action technical details">
              <p className="font-mono text-xs wrap-anywhere">
                {[approval.toolName && `Tool: ${approval.toolName}`, approval.kind && `Kind: ${approval.kind}`]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </TechnicalDetails>
          ) : null}
          {notice ? (
            <p ref={noticeRef} role="status" tabIndex={-1} className="outline-none">
              {notice}
            </p>
          ) : null}
          <ChatApprovalRenderer
            approvalId={approval.approvalId}
            approval={reviewedApproval}
            workspaceId={workspaceId}
            sessionId={props.selectedSessionId ?? undefined}
            recordPending={recordQuery.isPending && !recordQuery.isError}
            recovery={{
              failed: recordFailed,
              retrying: recordQuery.isFetching,
              onRetry: () => void recordQuery.refetch(),
              onDeny: props.onDenyPending,
              denying: props.approvalPending,
            }}
            checking={recordQuery.isFetching || props.approvalPending}
            onResolved={(message) => {
              setReceipt({ scope: noticeScope, message });
              void recordQuery.refetch();
              props.onRefreshThread();
            }}
            onInvalidated={() => {
              void recordQuery.refetch();
              props.onRefreshThread();
            }}
          />
          <NativeOwnerLink
            href={continuationHref("/inbox", approval.approvalId)}
            scope={noticeScope}
            className="mt-2 inline-block font-medium text-accent hover:underline"
          >
            Inspect persisted approval
          </NativeOwnerLink>
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
          <NativeOwnerLink
            href={continuationHref("/chat")}
            scope={JSON.stringify([workspaceId, props.selectedSessionId, input.promptId])}
            className="mt-2 inline-block text-xs font-medium text-accent hover:underline"
          >
            Open this conversation in Chat
          </NativeOwnerLink>
        </>
      ) : null}
    </div>
  );
}
