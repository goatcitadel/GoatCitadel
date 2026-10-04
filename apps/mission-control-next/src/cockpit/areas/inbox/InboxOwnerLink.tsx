import type { OperatorInboxItem } from "@goatcitadel/contracts";
import { ArrowUpRight } from "lucide-react";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";

export function InboxOwnerLink({ item, workspaceId }: { item: OperatorInboxItem; workspaceId: string }) {
  const { navigate } = useCockpitRoute();
  const area =
    item.kind === "approval"
      ? "Approvals"
      : item.source.sessionId
        ? "Chat"
        : item.kind === "memory_proposal" ||
            item.kind === "document_proposal" ||
            item.kind === "capability_proposal" ||
            item.kind === "improvement_proposal"
          ? "Library"
          : "Ops";
  const className = "inline-flex min-h-9 items-center gap-1 text-sm font-medium text-accent hover:underline";
  // The projection supplies relative owner destinations; it does not grant actions.
  if (!item.href.startsWith("/") || item.href.startsWith("//")) return null;
  const destination = new URL(item.href, "http://cockpit.invalid");
  if (destination.origin !== "http://cockpit.invalid") return null;
  const classic = destination.searchParams.get("shell") === "classic";
  // Ops and Approvals exist only in the classic shell, so a classic destination says so.
  const label = classic ? `Open in classic ${area}` : `Open in ${area}`;
  const content = (
    <>
      {label}
      <ArrowUpRight aria-hidden="true" className="size-4" />
    </>
  );
  return classic ? (
    <ClassicOwnerLink
      href={item.href}
      scope={JSON.stringify([workspaceId, item.id])}
      label={label}
      inboxOwner
      className={className}
    >
      {content}
    </ClassicOwnerLink>
  ) : (
    <a
      href={item.href}
      data-inbox-owner
      className={className}
      onClick={(event) => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate(item.href);
      }}
    >
      {content}
    </a>
  );
}
