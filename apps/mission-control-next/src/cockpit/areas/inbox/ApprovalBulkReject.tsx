import { useApprovalOperationAttempt, beginApprovalOperation, updateApprovalOperation, canReviewApprovalOperation } from "./approval-operation-attempts";
import { useState } from "react";
import { resolveApprovalsBulk } from "@goatcitadel/mission-control-shared/api/approvals";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
export function ApprovalBulkReject({ onResolved }: { onResolved: () => void }) {
  const access = useProjectAccess("installation-approval-rejection");
  return <BulkReject key={access.identity} onResolved={onResolved} />;
}
function BulkReject({ onResolved }: { onResolved: () => void }) {
  const access = useProjectAccess("installation-approval-rejection");
  const [review, setReview] = useState<object>(),
    [typed, setTyped] = useState(""),
    [busy, setBusy] = useState(false),
    [freshReview, setFreshReview] = useState(false);
  const attemptKey = JSON.stringify([access.presentationScope, "bulk-reject"]);
  const attempt = useApprovalOperationAttempt(attemptKey);
  const outcome = attempt?.phase === "resolved" && freshReview ? "" : attempt?.message ?? "";
  const canReview = canReviewApprovalOperation(attempt, "installation", true);
  async function reject() {
    if (review !== access.token || !access.current() || typed !== "reject all" || !canReview || outcome) return;
    const token = beginApprovalOperation(attemptKey, "installation", true);
    if (!token) return;
    setFreshReview(false);
    updateApprovalOperation(attemptKey, token, "submitted", "Bulk rejection submitted; outcome is not yet verified.");
    setBusy(true);
    try {
      const result = await resolveApprovalsBulk({
        decision: "reject",
        status: "pending",
        resolutionNote: "Bulk rejected from the approvals queue.",
      });
      updateApprovalOperation(attemptKey, token, "resolved", `Rejected ${result.resolvedCount}. Skipped ${result.skippedCount}. Failed ${result.failedCount}.`);
      if (access.current()) {
        onResolved();
      }
    } catch (cause) {
      updateApprovalOperation(attemptKey, token, "uncertain", `Bulk rejection outcome is not confirmed. A history refresh cannot settle this request. ${describeApiError(cause).summary}`);
    } finally {
      if (access.current()) setBusy(false);
    }
  }
  return (
    <>
      <Button
        variant="danger"
        onClick={() => {
          setFreshReview(attempt?.phase === "resolved");
          setReview(access.token);
          setTyped("");
        }}
      >
        Review installation-wide rejection
      </Button>
      <Dialog
        open={review === access.token}
        onOpenChange={(open) => {
          if (!open && !busy) setReview(undefined);
        }}
        title="Reject all pending approvals"
        description="This existing Gateway operation applies across the installation, including other workspaces. It rejects every pending request visible to the authorized operator."
      >
        <div className="grid gap-3">
          <p>
            Pending requests may change while this review is open. Rejection withholds authorization; it does not undo
            completed work.
          </p>
          <label>
            Type reject all to confirm
            <input
              className="block w-full rounded-md border border-line bg-raised p-2"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          </label>
          {outcome ? <p role="status">{outcome}</p> : null}
          <Button
            variant="danger"
            disabled={busy || Boolean(outcome) || typed !== "reject all"}
            onClick={() => void reject()}
          >
            Confirm installation-wide rejection
          </Button>
          <Button disabled={busy} onClick={() => setReview(undefined)}>
            Cancel
          </Button>
        </div>
      </Dialog>
    </>
  );
}
