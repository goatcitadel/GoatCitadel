import type { MailDraftRecord } from "@goatcitadel/contracts";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { LibraryApproval } from "./LibraryApproval";

/** `replayed` marks a receipt for a request whose original response was lost; `observed` is the latest re-read of the draft. */
export type SendReceipt = { record: MailDraftRecord; replayed: boolean; observed?: MailDraftRecord };

/** The delivery outcome the Gateway recorded on the draft, once the approval has been decided. */
function draftOutcomeText(draft: MailDraftRecord | undefined): string | undefined {
  if (!draft) return undefined;
  if (draft.status === "sent") return "Sent.";
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
  return (
    <section className="grid min-w-0 grid-cols-1 gap-2" aria-label="Send approval receipt">
      {receipt.record.status === "approval_required" && receipt.record.approvalId ? (
        <>
          <Callout>
            Send approval requested. Nothing has been sent yet. Approving sends this exact message once.
          </Callout>
          {outcome ? (
            <p role="status" className="wrap-anywhere text-sm font-medium">
              {outcome}
            </p>
          ) : null}
          <p className="wrap-anywhere text-sm">
            To {receipt.record.to.join(", ")} · {receipt.record.subject}
          </p>
          <LibraryApproval approvalId={receipt.record.approvalId} workspaceId={workspaceId} onRefresh={onRefresh} />
        </>
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
