import { Dialog } from "../../ui/Dialog";
import { Button } from "../../ui/Button";
import {
  CHECKING_FOR_CHANGES,
  type useDirectoryLifecycle,
} from "../../../features/native-routes/settings/use-directory-lifecycle";
import { directoryRecordId } from "../../../features/native-routes/settings/directory-lifecycle-binding";

export function DirectoryLifecycleReview({ lifecycle }: { lifecycle: ReturnType<typeof useDirectoryLifecycle> }) {
  const review = lifecycle.review;
  const action = review?.action === "archive" ? "Archive" : "Restore";
  const kind = review?.kind === "citadel" ? "Citadel" : "workspace";
  return (
    <Dialog
      open={Boolean(review)}
      onOpenChange={(open) => {
        if (!open) lifecycle.cancel();
      }}
      title={`${action} ${kind}?`}
      description="Review the exact saved record and revision before changing its lifecycle."
    >
      {review ? (
        <div className="space-y-3 text-sm text-fg-secondary">
          <dl className="cockpit-definition-grid grid gap-x-3 gap-y-2">
            <dt>Name</dt>
            <dd className="break-words text-fg">{review.record.name}</dd>
            <dt>Record ID</dt>
            <dd className="break-all font-mono">{directoryRecordId(review)}</dd>
            <dt>Revision</dt>
            <dd className="break-all font-mono">{review.record.revision}</dd>
            {review.kind === "workspace" ? (
              <>
                <dt>Citadel</dt>
                <dd className="break-all font-mono">{review.scope}</dd>
              </>
            ) : null}
            <dt>Change</dt>
            <dd>
              {review.record.lifecycleStatus} → {review.action === "archive" ? "archived" : "active"}
            </dd>
          </dl>
          <p>
            {review.action === "archive"
              ? "The record stays in the archived directory. Stored work is retained; any retained edit draft for this record will be discarded after the Gateway confirms the change."
              : "Restore the record to the active directory. Your active Citadel and workspace selection will stay as saved."}
          </p>
          {lifecycle.pending ? <p role="status">Waiting for the Gateway lifecycle owner…</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant={review.action === "archive" ? "danger" : "primary"}
              disabled={lifecycle.pending || !lifecycle.available}
              onClick={() => void lifecycle.confirm()}
            >
              Confirm {review.action} {kind}
            </Button>
            <Button disabled={lifecycle.pending} onClick={lifecycle.cancel}>
              Cancel
            </Button>
            {lifecycle.checking && !lifecycle.pending ? (
              <span role="status" className="self-center text-xs text-fg-muted">
                {CHECKING_FOR_CHANGES}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
