import { type MouseEvent, type ReactNode } from "react";
import { useShellHandoff } from "../../app/use-shell-handoff";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useDraftLeaveDialogState } from "../../features/native-routes/library/DraftLeaveDialog";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

/** Explicit owner handoff keeps the document's drafts and mutation admission stores. */
export function ClassicOwnerLink({
  href,
  scope,
  label,
  openingLabel,
  errorLabel,
  className,
  children,
  inboxOwner,
}: {
  href: string;
  scope: string;
  label: string;
  openingLabel?: string;
  errorLabel?: string;
  className?: string;
  children?: ReactNode;
  inboxOwner?: boolean;
}) {
  const installation = getGatewayApiBaseUrl();
  const handoff = useShellHandoff([installation, scope, href]);
  const dialog = useDraftLeaveDialogState(handoff.dialogProps);
  const opening = handoff.opening;

  function request(event: MouseEvent<HTMLAnchorElement>) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    handoff.request("classic", { href });
  }

  return (
    <>
      <a
        href={href}
        data-inbox-owner={inboxOwner ? "" : undefined}
        onClick={request}
        aria-disabled={opening || undefined}
        aria-label={opening ? (openingLabel ?? "Opening owner view…") : label}
        className={className ?? "inline-block text-sm text-accent hover:underline"}
      >
        {opening ? (openingLabel ?? "Opening owner view…") : (children ?? label)}
      </a>
      {handoff.error ? (
        <span role="alert" className="block text-sm text-status-failed">
          {errorLabel ?? "The owner view could not open. Your current drafts are still available."}
        </span>
      ) : null}
      <Dialog
        open={handoff.dialogProps.open}
        title="Unsaved changes"
        description={dialog.description}
        onOpenChange={(open) => {
          if (!open && !dialog.saving) handoff.dialogProps.onCancel();
        }}
      >
        {dialog.error ? (
          <p role="alert" className="text-sm text-status-failed">
            {dialog.error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {dialog.canSave ? (
            <Button disabled={dialog.saving} onClick={() => void dialog.saveAndContinue()}>
              Save and continue
            </Button>
          ) : null}
          {dialog.canKeep ? (
            <Button disabled={dialog.saving} onClick={handoff.dialogProps.onContinue}>
              Keep draft and close
            </Button>
          ) : null}
          <Button variant="danger" disabled={dialog.saving} onClick={dialog.discard}>
            Discard changes
          </Button>
          <Button disabled={dialog.saving} onClick={handoff.dialogProps.onCancel}>
            Cancel
          </Button>
        </div>
      </Dialog>
    </>
  );
}
