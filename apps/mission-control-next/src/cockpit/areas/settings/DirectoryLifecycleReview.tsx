import { Dialog } from "../../ui/Dialog";
import { Button } from "../../ui/Button";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
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
      description="Review the saved record before archiving or restoring it."
    >
      {review ? (
        <div className="space-y-3 text-sm text-fg-secondary">
          <dl className="cockpit-definition-grid grid gap-x-3 gap-y-2">
            <dt>Name</dt>
            <dd className="break-words text-fg">{review.record.name}</dd>
            <dt>Change</dt>
            <dd>
              {review.record.lifecycleStatus === "active" ? "Active" : "Archived"} →{" "}
              {review.action === "archive" ? "Archived" : "Active"}
            </dd>
          </dl>
          <TechnicalDetails>
            <p className="break-all font-mono text-xs">Record {directoryRecordId(review)}</p>
            <p className="break-all font-mono text-xs">Version {review.record.revision}</p>
            {review.kind === "workspace" ? <p className="break-all font-mono text-xs">Citadel {review.scope}</p> : null}
          </TechnicalDetails>
          <p>
            {review.action === "archive"
              ? "The record stays in the archived directory. Stored work is retained; any retained edit draft for this record will be discarded after GoatCitadel confirms the change."
              : "Restore the record to the active directory. Your active Citadel and workspace selection will stay as saved."}
          </p>
          {lifecycle.pending ? <p role="status">Waiting for GoatCitadel to confirm…</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
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
