import {
  useApprovalOperationAttempt,
  beginApprovalOperation,
  updateApprovalOperation,
  canReviewApprovalOperation,
} from "./approval-operation-attempts";
import { useState } from "react";
import { resolveApprovalsBulk } from "@goatcitadel/mission-control-shared/api/approvals";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { useWorkspaceNameLookup } from "../../data/use-workspace-name";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { TypedConfirmation, typedConfirmationMatches } from "../../ui/TypedConfirmation";
import { describeInstallationScope, useInstallationPendingApprovals } from "./installation-pending-approvals";

const CONFIRMATION = "reject all";

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
  const pending = useInstallationPendingApprovals();
  const nameOf = useWorkspaceNameLookup(useUiPreferences().activeCitadelId);
  // The scope is only known once a fresh read settles; a stale, failed or empty read keeps confirm unavailable.
  const scope =
    pending.data && !pending.isFetching && !pending.isError ? describeInstallationScope(pending.data, nameOf) : null;
  const scopeReady = Boolean(scope && scope.count > 0);
  const attemptKey = JSON.stringify([access.presentationScope, "bulk-reject"]);
  const attempt = useApprovalOperationAttempt(attemptKey);
  const outcome = attempt?.phase === "resolved" && freshReview ? "" : (attempt?.message ?? "");
  const canReview = canReviewApprovalOperation(attempt, "installation", true);
  async function reject() {
    if (
      review !== access.token ||
      !access.current() ||
      !typedConfirmationMatches(typed, CONFIRMATION) ||
      !scopeReady ||
      !canReview ||
      outcome
    )
      return;
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
      updateApprovalOperation(
        attemptKey,
        token,
        "resolved",
        `Rejected ${result.resolvedCount}. Skipped ${result.skippedCount}. Failed ${result.failedCount}.`,
      );
      if (access.current()) {
        onResolved();
      }
    } catch (cause) {
      updateApprovalOperation(
        attemptKey,
        token,
        "uncertain",
        `Bulk rejection outcome is not confirmed. A history refresh cannot settle this request. ${describeApiError(cause).summary}`,
      );
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
          void pending.refetch();
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
        description="This applies across the whole installation, including other workspaces. It rejects every pending request you are allowed to see."
      >
        <div className="grid gap-3">
          {pending.isFetching ? (
            <p role="status">Checking how many requests are pending…</p>
          ) : pending.isError ? (
            <p role="alert">
              The scope couldn't be checked, so rejection stays unavailable. {describeApiError(pending.error).summary}
            </p>
          ) : scope ? (
            <div role="status" className="grid gap-1">
              <p className="font-medium text-fg">{scope.summary}</p>
              {scope.workspaces ? <p className="text-sm text-fg-secondary">{scope.workspaces}</p> : null}
              {scope.unnamedWorkspaceIds.length ? (
                <TechnicalDetails label="Unnamed workspace IDs">
                  <p className="break-all font-mono text-xs">{scope.unnamedWorkspaceIds.join(", ")}</p>
                </TechnicalDetails>
              ) : null}
            </div>
          ) : null}
          <p>
            Pending requests may change while this review is open. Rejection withholds authorization; it does not undo
            completed work.
          </p>
          <TypedConfirmation
            phrase={CONFIRMATION}
            value={typed}
            onChange={setTyped}
            disabled={busy}
            consequence="Confirm installation-wide rejection"
          />
          {outcome ? <p role="status">{outcome}</p> : null}
          <Button
            variant="danger"
            disabled={busy || Boolean(outcome) || !scopeReady || !typedConfirmationMatches(typed, CONFIRMATION)}
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
