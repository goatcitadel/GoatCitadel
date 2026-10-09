import type { OperatorInboxItem } from "@goatcitadel/contracts";
import { presentRiskLevel } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import { approvalCreatedLabel, approvalExpiryLabel } from "./approval-preview";
import { inboxItemKindLabel } from "./inbox-presentation";
import { InboxOwnerLink } from "./InboxOwnerLink";
import { InboxSourceContext } from "./InboxSourceContext";

export function InboxItemCard({
  item,
  workspaceId,
  selected,
  contextOpen,
  onDetails,
  onToggleContext,
}: {
  item: OperatorInboxItem;
  workspaceId: string;
  selected: boolean;
  contextOpen: boolean;
  onDetails: () => void;
  onToggleContext: () => void;
}) {
  return (
    <article
      data-selected={selected}
      className="rounded-lg border border-line bg-raised p-4 data-[selected=true]:border-accent"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-fg-muted">
            {inboxItemKindLabel(item.kind)} · {approvalCreatedLabel(item.createdAt)}
          </p>
          <h3 className="mt-1 font-display text-md font-semibold text-fg">{item.title}</h3>
          <p className="mt-1 text-sm text-fg-secondary">{item.summary}</p>
        </div>
        {item.riskLevel ? <StatusBadge status={presentRiskLevel(item.riskLevel)} /> : null}
      </div>
      {item.expiresAt || item.group === "needs_decision" ? (
        <p className="mt-2 text-xs text-fg-muted">
          {approvalExpiryLabel(item.expiresAt) ?? "Expiry not provided; review the current decision."}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button size="sm" data-inbox-detail onClick={onDetails}>
          Details
        </Button>
        <InboxOwnerLink item={item} workspaceId={workspaceId} />
        {item.source.sessionId ? (
          <Button size="sm" aria-expanded={contextOpen} onClick={onToggleContext}>
            {contextOpen ? "Hide source context" : "Show source context"}
          </Button>
        ) : null}
      </div>
      {contextOpen ? (
        <div className="mt-3">
          <InboxSourceContext item={item} workspaceId={workspaceId} />
        </div>
      ) : null}
    </article>
  );
}
