import type { OperatorInboxItem } from "@goatcitadel/contracts";
import {
  presentApprovalOutcome,
  presentRiskLevel,
} from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import { TimeText } from "../../ui/TimeText";
import { approvalExpiryLabel } from "./approval-preview";
import { inboxItemKindLabel, inboxItemTitle } from "./inbox-presentation";
import { InboxOwnerLink } from "./InboxOwnerLink";
import { canDecideInRow, InboxRowDecision } from "./InboxRowDecision";
import { InboxSourceContext } from "./InboxSourceContext";
import { hasExpired, useMinuteClock } from "./use-minute-clock";

export function InboxItemCard({
  item,
  workspaceId,
  selected,
  contextOpen,
  onDetails,
  onToggleContext,
  onDecision,
}: {
  item: OperatorInboxItem;
  workspaceId: string;
  selected: boolean;
  contextOpen: boolean;
  onDetails: () => void;
  onToggleContext: () => void;
  /** Reports an in-row decision to the page, which announces it and moves focus once. */
  onDecision?: (message: string, settled: boolean) => void;
}) {
  const now = useMinuteClock(item.expiresAt);
  const expired = hasExpired(item.expiresAt, now);
  const dangerous = item.kind === "approval" && (item.riskLevel === "danger" || item.riskLevel === "nuclear");
  return (
    <article
      data-selected={selected}
      aria-current={selected ? "true" : undefined}
      className="border-b border-line-subtle py-4 data-[selected=true]:border-l-2 data-[selected=true]:border-l-accent data-[selected=true]:pl-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-fg-muted">
            {inboxItemKindLabel(item.kind)} · <TimeText value={item.createdAt} />
            {selected ? <span className="font-semibold text-fg"> · Selected</span> : null}
          </p>
          <h3 className="mt-1 text-md font-semibold text-fg">{inboxItemTitle(item)}</h3>
          <p className="mt-1 text-sm text-fg-secondary">{item.summary}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {expired ? <StatusBadge status={presentApprovalOutcome("expired")} /> : null}
          {item.riskLevel ? <StatusBadge status={presentRiskLevel(item.riskLevel)} /> : null}
        </div>
      </div>
      {item.expiresAt || item.group === "needs_decision" ? (
        <p className="mt-2 text-xs text-fg-muted">
          {approvalExpiryLabel(item.expiresAt, now) ?? "No expiry time was given."}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button size="sm" data-inbox-detail onClick={onDetails}>
          {dangerous ? "Review" : "Details"}
        </Button>
        {onDecision && canDecideInRow(item) ? (
          <InboxRowDecision item={item} workspaceId={workspaceId} onDecision={onDecision} />
        ) : null}
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
