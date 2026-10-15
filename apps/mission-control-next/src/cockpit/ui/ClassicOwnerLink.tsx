import { type MouseEvent, type ReactNode } from "react";
import { useShellHandoff } from "../../app/use-shell-handoff";
import { buildClassicOwnerUrl } from "../../app/classic-owner-url";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { UnsavedChangesDialog } from "./UnsavedChangesDialog";

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
  const ownerHref = buildClassicOwnerUrl(href);
  const handoff = useShellHandoff([installation, scope, ownerHref]);
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
    handoff.request("classic", { href: ownerHref });
  }

  return (
    <>
      <a
        href={ownerHref}
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
      <UnsavedChangesDialog {...handoff.dialogProps} />
    </>
  );
}
