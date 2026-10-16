import type { ApprovalRequest, MailDraftRecord } from "@goatcitadel/contracts";
import { fetchApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import { getMailDraft } from "@goatcitadel/mission-control-shared/api/personal-ops";
import { presentApprovalOutcome } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { LibraryApproval } from "./LibraryApproval";

/**
 * `replayed` marks a receipt for a request whose original response was lost; `observed` is the latest re-read of
 * the draft and `approvalStatus` the latest re-read of its approval.
 */
export type SendReceipt = {
  record: MailDraftRecord;
  replayed: boolean;
  observed?: MailDraftRecord;
  approvalStatus?: ApprovalRequest["status"];
};

/**
 * Re-reads the draft and its approval in the receipt's workspace. The approval card stays authoritative, so a failed
 * or mismatched read leaves that part of the receipt unchanged instead of hiding it.
 */
export async function readSendReceiptUpdate(
  record: MailDraftRecord,
  workspaceId: string,
): Promise<Pick<SendReceipt, "observed" | "approvalStatus">> {
  const approvalId = record.approvalId;
  const [observed, approval] = await Promise.all([
    Promise.resolve()
      .then(() => getMailDraft(record.draftId, workspaceId))
      .catch(() => undefined),
    Promise.resolve()
      .then(() => (approvalId ? fetchApproval(approvalId, { workspaceId }) : undefined))
      .catch(() => undefined),
  ]);
  return {
    ...(observed?.draftId === record.draftId ? { observed } : {}),
    ...(approvalId && approval?.approvalId === approvalId ? { approvalStatus: approval.status } : {}),
  };
}

/** The decision is recorded but the draft has no outcome yet: the send is still settling. */
function decidedPendingText(receipt: SendReceipt): string | undefined {
  const status = receipt.approvalStatus;
  if (!status || status === "pending") return undefined;
  return status === "approved"
    ? "The approval was decided; delivery is in progress. Refresh to see the outcome."
    : "The approval was decided; the draft outcome is still being recorded. Refresh to see the outcome.";
}

/** The shared label for a delivery the provider may have completed. */
const OUTCOME_UNKNOWN_LABEL = presentApprovalOutcome("unknown").label;

/**
 * An `outcome_unknown` draft may already have been delivered, so it is never described as not sent: the operator
 * checks the mailbox before sending again.
 */
function OutcomeUnknownCallout({ intro }: { intro: string }) {
  return (
    <Callout tone="warning">
      {intro}
      <span className="wrap-anywhere block font-medium">
        {OUTCOME_UNKNOWN_LABEL}: the message may have been delivered. Check the sent mailbox before sending it again.
      </span>
    </Callout>
  );
}

/** The delivery outcome the Gateway recorded on the draft, once the approval has been decided. */
function draftOutcomeText(draft: MailDraftRecord | undefined): string | undefined {
  if (!draft) return undefined;
  if (draft.status === "sent") return "Sent.";
  if (draft.status === "outcome_unknown") return OUTCOME_UNKNOWN_LABEL;
  if (draft.status === "failed" || draft.status === "send_unavailable")
    return `Not sent: ${draft.failureReason ?? "the Gateway did not record a reason."}`;
  return undefined;
}

type Props = {
  receipt: SendReceipt;
  workspaceId: string;
  onRefresh: () => Promise<unknown>;
  onDismiss: () => void;
};

export function LibraryMailSendReceipt({ receipt, workspaceId, onRefresh, onDismiss }: Props) {
  const outcome = draftOutcomeText(receipt.observed);
  const decidedPending = outcome ? undefined : decidedPendingText(receipt);
  return (
    <section className="grid min-w-0 grid-cols-1 gap-2" aria-label="Send approval receipt">
      {receipt.record.status === "approval_required" && receipt.record.approvalId ? (
        <>
          {/* The recorded outcome joins the decision callout, so a single region announces the result. */}
          {receipt.observed?.status === "sent" ? (
            <Callout>
              The approval was decided and the message was sent.
              <span className="wrap-anywhere block font-medium">{outcome}</span>
            </Callout>
          ) : receipt.observed?.status === "outcome_unknown" ? (
            <OutcomeUnknownCallout intro="The approval was decided, but the delivery outcome was not confirmed." />
          ) : receipt.observed?.status === "failed" || receipt.observed?.status === "send_unavailable" ? (
            <Callout tone="error">
              The approval was decided, but the message was not sent.
              <span className="wrap-anywhere block font-medium">{outcome}</span>
            </Callout>
          ) : decidedPending ? (
            <Callout>{decidedPending}</Callout>
          ) : (
            <Callout>
              Send approval requested. Nothing has been sent yet. Approving sends this exact message once.
            </Callout>
          )}
          <p className="wrap-anywhere text-sm">
            To {receipt.record.to.join(", ")} · {receipt.record.subject}
          </p>
          <LibraryApproval approvalId={receipt.record.approvalId} workspaceId={workspaceId} onRefresh={onRefresh} />
        </>
      ) : receipt.record.status === "outcome_unknown" ? (
        <OutcomeUnknownCallout intro="This draft was already approved, but its delivery outcome was not confirmed." />
      ) : receipt.replayed ? (
        <Callout tone="error">
          The earlier send request&apos;s outcome is unknown: a send approval may already exist, and this draft can no
          longer be sent. Nothing was sent. Check Inbox before preparing a new request.
        </Callout>
      ) : (
        <Callout tone="error">
          The Gateway cannot request an approval for this draft: it no longer holds it, or an earlier request for it
          ended without a confirmed outcome. Nothing was sent. Check Inbox, then review the send request again to
          prepare a new draft.
        </Callout>
      )}
      <Button variant="ghost" onClick={onDismiss}>
        Dismiss send receipt
      </Button>
    </section>
  );
}
