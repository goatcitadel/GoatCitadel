import type { ToolGroupId } from "@goatcitadel/contracts";
import { settingsChangeIsConfirmed } from "../../../features/native-routes/settings/use-settings-change";
import { toolGroupItemHref } from "../capabilities/tools/tool-links";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
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

/**
 * The one announced region for this control: the latest Change Plan receipt and the latest save notice.
 * Actions sit outside it so a status change never re-reads buttons.
 */
export function WriteAccessOutcomeStatus({
  control,
}: {
  control: Pick<FilesystemWriteAccess, "change" | "notice" | "uncertain" | "busy" | "reconcile">;
}) {
  const { change, notice, uncertain, busy, reconcile } = control;
  const pending = change.change;
  const confirmed = settingsChangeIsConfirmed(pending);
  const failed = notice?.tone === "failed" || Boolean(pending?.error);
  return (
    <div className="mt-3 space-y-2 text-sm text-fg-secondary">
      <div role={failed ? "alert" : "status"} className="space-y-1">
        {pending ? (
          <p>
            <strong className="text-fg">{presentChangeStatusLabel(pending.receipt.status)}</strong> · {pending.message}
          </p>
        ) : null}
        {pending?.error ? <p className="text-status-failed">{pending.error}</p> : null}
        {pending?.blocking ? <p>Other filesystem access changes wait until GoatCitadel confirms this one.</p> : null}
        {notice ? (
          <p
            className={
              notice.tone === "failed"
                ? "text-status-failed"
                : notice.tone === "waiting"
                  ? "text-status-waiting"
                  : "text-status-done"
            }
          >
            {notice.message}
          </p>
        ) : null}
      </div>
      {pending ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void change.refresh()}>
            Refresh change status
          </Button>
          {pending.receipt.requiredAction?.kind === "approval" && !confirmed ? (
            <SettingsApprovalOwnerAction
              plan={pending.plan}
              receipt={pending.receipt}
              owner="filesystem-write-access"
              workspaceId="default"
              viewIdentity={pending.receipt.planId}
              label="Review approval"
            />
          ) : null}
        </div>
      ) : null}
      {pending && !confirmed ? <ApprovedSettingsContinuation plan={pending.plan} onSettled={change.refresh} /> : null}
      {uncertain ? (
        <div className="space-y-2">
          <p>Changes stay locked until you re-read the current settings and check that they match what you expect.</p>
          <Button size="sm" disabled={busy} onClick={() => void reconcile()}>
            Re-read settings and unlock
          </Button>
        </div>
      ) : null}
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
        <p className="mb-3 text-sm text-status-failed">
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

/**
 * One line at the top of the Files tools' access settings when the group is switched off in Capabilities › Tools.
 * Those tool settings still save, but nothing reads them until the group is back on, so the page says so rather than
 * implying the AI can use them. It belongs to the tool list only: write roots and the outside-root mode also govern
 * document, slide and browser outputs, which belong to other groups.
 */
export function FilesToolsOffNote({
  switchedOffToolGroups,
}: {
  switchedOffToolGroups: readonly ToolGroupId[] | undefined;
}) {
  if (!switchedOffToolGroups?.includes("files")) return null;
  return (
    <p className="mt-2 text-sm text-status-waiting">
      The Files tools are switched off in{" "}
      <NativeOwnerLink scope="files" href={toolGroupItemHref("files")}>
        Capabilities › Tools
      </NativeOwnerLink>
      , so these settings have no effect until they're back on.
    </p>
  );
}
