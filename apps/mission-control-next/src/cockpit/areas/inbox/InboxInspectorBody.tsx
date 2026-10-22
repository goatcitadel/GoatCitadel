import { useEffect } from "react";
import type { OperatorInboxItem } from "@goatcitadel/contracts";
import { presentRiskLevel } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { StatusBadge } from "../../ui/StatusBadge";
import { TimeText } from "../../ui/TimeText";
import { approvalExpiryLabel } from "./approval-preview";
import { inboxItemKindLabel } from "./inbox-presentation";
import { inboxUpdateVersion } from "./inbox-viewed-updates";
import { InboxApprovalDetail } from "./InboxApprovalDetail";
import { InboxCapabilityProposalDetail } from "./InboxCapabilityProposalDetail";
import { InboxChangePlanDetail } from "./InboxChangePlanDetail";
import { InboxDocumentProposalDetail } from "./InboxDocumentProposalDetail";
import { InboxImprovementProposalDetail } from "./InboxImprovementProposalDetail";
import { InboxMemoryProposalDetail } from "./InboxMemoryProposalDetail";
import { InboxOwnerLink } from "./InboxOwnerLink";
import { InboxRunRecovery } from "./InboxRunRecovery";
import { InboxSourceContext } from "./InboxSourceContext";
import { InboxUserInputDetail } from "./InboxUserInputDetail";
import { useMinuteClock } from "./use-minute-clock";

function RecordViewedUpdate({ onOpened }: { onOpened: () => void }) {
  useEffect(onOpened, [onOpened]);
  return null;
}

export function InboxInspectorBody({
  item,
  workspaceId,
  installation,
  focusAction,
  explicitDetails,
  onOpened,
  onDecision,
}: {
  item: OperatorInboxItem;
  workspaceId: string;
  installation: string;
  focusAction?: "approve" | "deny";
  explicitDetails: boolean;
  onOpened: () => void;
  /** The Inbox page announces a decision and moves focus once; see use-inbox-decision-focus (IN-07). */
  onDecision?: (message: string, settled: boolean) => void;
}) {
  const now = useMinuteClock(item.expiresAt);
  return (
    <div className="grid gap-4 text-sm">
      <div>
        <p className="text-xs font-medium text-fg-muted">
          {inboxItemKindLabel(item.kind)} · <TimeText value={item.createdAt} />
        </p>
        <p className="mt-2 text-fg-secondary">{item.summary}</p>
        {/* An approval's detail states its expiry from the current record; show it once (IN-R04). */}
        {item.expiresAt && item.kind !== "approval" ? (
          <p className="mt-2 text-fg-muted">{approvalExpiryLabel(item.expiresAt, now)}</p>
        ) : null}
      </div>
      {explicitDetails && inboxUpdateVersion(item, workspaceId) ? <RecordViewedUpdate onOpened={onOpened} /> : null}
      {/* An approval's detail shows the risk from its current record; show the projected risk only once (IN-15). */}
      {item.riskLevel && item.kind !== "approval" ? (
        <div className="w-fit">
          <StatusBadge status={presentRiskLevel(item.riskLevel)} />
        </div>
      ) : null}
      {item.kind === "approval" ? (
        <InboxApprovalDetail item={item} workspaceId={workspaceId} focusAction={focusAction} onDecision={onDecision} />
      ) : item.kind === "change_plan" ? (
        <InboxChangePlanDetail key={`${workspaceId}:${item.id}`} item={item} workspaceId={workspaceId} />
      ) : item.kind === "failed_run" || item.kind === "dead_letter" ? (
        <InboxRunRecovery item={item} workspaceId={workspaceId} />
      ) : item.kind === "memory_proposal" ? (
        <InboxMemoryProposalDetail key={`${workspaceId}:${item.id}`} item={item} workspaceId={workspaceId} />
      ) : item.kind === "improvement_proposal" ? (
        <InboxImprovementProposalDetail key={`${workspaceId}:${item.id}`} item={item} workspaceId={workspaceId} />
      ) : item.kind === "capability_proposal" ? (
        <InboxCapabilityProposalDetail key={`${workspaceId}:${item.id}`} item={item} workspaceId={workspaceId} />
      ) : item.kind === "document_proposal" ? (
        <InboxDocumentProposalDetail key={`${workspaceId}:${item.id}`} item={item} workspaceId={workspaceId} />
      ) : item.kind === "user_input" ? (
        <InboxUserInputDetail key={`${workspaceId}:${item.id}`} item={item} workspaceId={workspaceId} />
      ) : (
        <p className="text-xs text-fg-muted">This is a read-only summary. Review the current record before deciding.</p>
      )}
      {item.source.sessionId ? (
        <InboxSourceContext
          key={JSON.stringify([installation, workspaceId, item.id, item.updatedAt, item.source.sessionId])}
          item={item}
          workspaceId={workspaceId}
        />
      ) : null}
      {item.source.sessionId ? (
        <NativeOwnerLink
          scope={[workspaceId, item.id, item.source.sessionId]}
          href={`/chat?sessionId=${encodeURIComponent(item.source.sessionId)}`}
          className="text-sm font-medium text-accent hover:underline"
        >
          Open source conversation
        </NativeOwnerLink>
      ) : null}
      <InboxOwnerLink item={item} workspaceId={workspaceId} />
    </div>
  );
}
