import { RiskBadge } from "../../ui/RiskBadge";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { useQuery } from "@tanstack/react-query";
import { fetchApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { useEffect, useRef, useState } from "react";
import { AttachmentImage } from "../../ui/AttachmentImage";
import { ChatApprovalRenderer } from "./ChatApprovalRenderer";
import { approvalExpiryLabel } from "../inbox/approval-preview";
import { nullWhenMissing } from "../inbox/inbox-record-read";
import { ChatPendingQuestion } from "./ChatPendingQuestion";
import { presentApprovalAction } from "./chat-vocabulary";
import { presentApprovalStatus } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { Button } from "../../ui/Button";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { readSpecialistEvidence, specialistEvidenceMatches } from "../inbox/specialist-approval-evidence";

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

function errandScreenshotAttachmentId(preview: Record<string, unknown> | undefined): string | undefined {
  const id = preview?.screenshotAttachmentId;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

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
  // A code_mode.request approval belongs to the Code Mode card in the reply, which asks once with its own wording.
  const ownedByCodeModeCard =
    approval?.kind === "code_mode.request" ||
    approval?.toolName === "code_mode.request" ||
    reviewedApproval?.kind === "code_mode.request";
  // A Code Mode run approval is approved only against the exact code and target it reads back (as the Inbox does).
  const specialistTarget =
    reviewedApproval?.status === "pending" && reviewedApproval.kind === "code_mode.run" ? reviewedApproval : undefined;
  const specialistQuery = useQuery({
    queryKey: ["approvals", "specialist", workspaceId, specialistTarget],
    queryFn: () => readSpecialistEvidence(specialistTarget!),
    enabled: Boolean(specialistTarget),
    retry: false,
    staleTime: 0,
  });
  const specialistEvidence =
    specialistTarget &&
    !specialistQuery.isError &&
    specialistQuery.data &&
    specialistEvidenceMatches(specialistTarget, specialistQuery.data)
      ? specialistQuery.data
      : undefined;
  // Until the evidence matches, Approve stays disabled: say why, as the Inbox detail does, and offer a fresh read.
  const specialistChecking = !specialistQuery.isError && (specialistQuery.isPending || specialistQuery.isFetching);
  // A browser errand step shows the picture of the page the errand is about to act on, above the decision.
  const errandScreenshotId =
    reviewedApproval?.kind === "browser.errand.action" || approval?.kind === "browser.errand.action"
      ? errandScreenshotAttachmentId(reviewedApproval?.preview)
      : undefined;
  const input = props.pendingUserInput;
  // The persisted record outranks the retained prompt: once it is decided, the card reports the decision
  // instead of asking for one while Chat waits for the queue to clear it.
  const decided = reviewedApproval && reviewedApproval.status !== "pending" ? reviewedApproval : undefined;
  const expiry = decided ? null : approvalExpiryLabel(approval?.expiresAt);
  function continuationHref(destination: "/inbox", selectedApprovalId?: string) {
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
      {approval && !ownedByCodeModeCard ? (
        <section
          aria-label={decided ? "Decided approval" : "Pending approval"}
          className={`mt-3 rounded-md border bg-raised p-3 text-sm ${decided ? "border-line-subtle" : "border-status-waiting"}`}
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="font-semibold text-fg">
                {decided ? `Approval decided: ${presentApprovalStatus(decided.status).label}` : "Approval needed"}
              </h3>
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
          {specialistTarget && !specialistEvidence ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <p role={specialistChecking ? "status" : "alert"} className={specialistChecking ? "text-fg-muted" : ""}>
                {specialistChecking
                  ? "Checking the specialist review…"
                  : specialistQuery.error
                    ? describeApiError(specialistQuery.error).summary
                    : "The specialist review is unavailable or changed. Check again before approving."}
              </p>
              {specialistChecking ? null : (
                // A read that failed after an earlier answer stays failed while it is read again, so the button
                // waits for that read, as in the Inbox detail.
                <Button
                  type="button"
                  size="sm"
                  disabled={specialistQuery.isFetching}
                  onClick={() => void specialistQuery.refetch()}
                >
                  Check again
                </Button>
              )}
            </div>
          ) : null}
          {errandScreenshotId ? (
            <AttachmentImage
              attachmentId={errandScreenshotId}
              alt="The page the browser errand is about to act on"
              className="mt-2 max-h-72 w-auto max-w-full rounded-md border border-line bg-sunken"
            />
          ) : null}
          <ChatApprovalRenderer
            approvalId={approval.approvalId}
            approval={reviewedApproval}
            workspaceId={workspaceId}
            sessionId={props.selectedSessionId ?? undefined}
            specialistEvidence={specialistEvidence}
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
            onFollowOnChange={props.onRefreshThread}
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
      {/* CH-N06: blockers only render inside the Chat transcript, so no "open in Chat" link. */}
      {input ? (
        <ChatPendingQuestion
          key={input.promptId}
          prompt={input}
          pending={props.userInputPending}
          onSubmit={props.onSubmitUserInput}
        />
      ) : null}
    </div>
  );
}
