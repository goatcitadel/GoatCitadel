import { settingsChangeIsConfirmed } from "../../../features/native-routes/settings/use-settings-change";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { ApprovedSettingsContinuation } from "./ApprovedSettingsContinuation";
import { SettingsApprovalOwnerAction } from "./SettingsApprovalOwnerAction";
import { presentChangeStatusLabel } from "./settings-vocabulary";
import type { FilesystemWriteAccess } from "./use-filesystem-write-access";

/** A pending review of one filesystem write-access change, bound to the settings version it was opened at. */
export interface WriteAccessReview {
  title: string;
  description: string;
  confirmLabel: string;
  danger: boolean;
  revision: number;
  run: () => Promise<void>;
}

/** The Change Plan receipt for the latest save, with its approval link and approved-change continuation. */
export function WriteAccessChangeStatus({ change }: { change: FilesystemWriteAccess["change"] }) {
  if (!change.change) return null;
  const confirmed = settingsChangeIsConfirmed(change.change);
  return (
    <div className="mt-3 rounded-md border border-line bg-raised p-3 text-sm text-fg-secondary">
      <p role="status">
        <strong className="text-fg">{presentChangeStatusLabel(change.change.receipt.status)}</strong> ·{" "}
        {change.change.message}
      </p>
      {change.change.error ? (
        <p role="alert" className="mt-1 text-status-failed">
          {change.change.error}
        </p>
      ) : null}
      {change.change.blocking ? (
        <p className="mt-1">Other filesystem access changes wait until the gateway confirms this one.</p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void change.refresh()}>
          Refresh change status
        </Button>
        {change.change.receipt.requiredAction?.kind === "approval" && !confirmed ? (
          <SettingsApprovalOwnerAction
            plan={change.change.plan}
            receipt={change.change.receipt}
            owner="filesystem-write-access"
            workspaceId="default"
            viewIdentity={change.change.receipt.planId}
            label="Review approval"
          />
        ) : null}
      </div>
      {!confirmed ? <ApprovedSettingsContinuation plan={change.change.plan} onSettled={change.refresh} /> : null}
    </div>
  );
}

export function WriteAccessReviewDialog({
  review,
  current,
  busy,
  onClose,
}: {
  review: WriteAccessReview | null;
  /** False once the settings version moved past the one the review was opened at. */
  current: boolean;
  busy: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={Boolean(review)}
      title={review?.title ?? "Review change"}
      description={review?.description}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      {review && !current ? (
        <p role="alert" className="mb-3 text-sm text-status-failed">
          Filesystem access changed after this review opened. Close it and review the current settings.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant={review?.danger ? "danger" : "primary"}
          loading={busy}
          disabled={!current}
          onClick={() => {
            onClose();
            if (review) void review.run();
          }}
        >
          {review?.confirmLabel ?? "Confirm"}
        </Button>
        <Button disabled={busy} onClick={onClose}>
          Keep current setting
        </Button>
      </div>
    </Dialog>
  );
}

/** Folders the config file owns, shown read-only. */
export function ConfiguredFolders({ title, paths }: { title: string; paths: readonly string[] }) {
  return (
    <div className="min-w-0">
      <p className="text-sm font-medium text-fg">{title}</p>
      {paths.length ? (
        <ul className="mt-1 space-y-0.5">
          {paths.map((path) => (
            <li key={path} className="break-all font-mono text-xs text-fg-secondary">
              {path}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-fg-muted">None configured.</p>
      )}
    </div>
  );
}
