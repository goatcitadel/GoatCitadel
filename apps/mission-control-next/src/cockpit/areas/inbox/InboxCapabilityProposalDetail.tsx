import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CapabilityProposalDetailRecord, OperatorInboxItem, OperatorInboxResponse } from "@goatcitadel/contracts";
import { fetchCapabilityProposal } from "@goatcitadel/mission-control-shared/api/capabilities";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { fetchOperatorInbox } from "@goatcitadel/mission-control-shared/api/operator-inbox";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { Button } from "../../ui/Button";
import {
  CHECKING_FOR_CHANGES,
  keepRecordForSameItem,
  lastVersionNote,
  recordAnswered,
  recordView,
} from "../../data/record-view";
import { useCachedInboxItem } from "../../data/use-operator-inbox";
import { inboxMatchesWorkspace } from "./inbox-presentation";

const ACTIVE_STATUSES = new Set(["proposed", "validating", "pending_approval"]);

export function currentCapabilityProposal(
  item: OperatorInboxItem,
  projection: OperatorInboxResponse,
  detail: CapabilityProposalDetailRecord,
  workspaceId: string,
): CapabilityProposalDetailRecord | null {
  const proposal = detail.proposal;
  if (
    !inboxMatchesWorkspace(projection, workspaceId) ||
    item.kind !== "capability_proposal" ||
    item.group !== "proposals" ||
    item.source.workspaceId !== workspaceId ||
    !item.source.proposalId ||
    item.id !== `capability_proposal:${item.source.proposalId}` ||
    proposal.proposalId !== item.source.proposalId ||
    proposal.payload.workspaceId !== workspaceId ||
    !ACTIVE_STATUSES.has(proposal.status) ||
    proposal.createdAt !== item.createdAt ||
    proposal.updatedAt !== item.updatedAt ||
    !projection.items.some(
      (record) =>
        record.id === item.id &&
        record.kind === item.kind &&
        record.group === item.group &&
        record.source.workspaceId === workspaceId &&
        record.source.proposalId === item.source.proposalId &&
        record.updatedAt === item.updatedAt,
    )
  )
    return null;
  return detail;
}

/** The proposal, still in this workspace's Inbox; the cached Inbox is used when given, else read once. */
async function readCurrentProposal(
  item: OperatorInboxItem,
  workspaceId: string,
  cached?: OperatorInboxResponse,
): Promise<CapabilityProposalDetailRecord | null> {
  if (item.kind !== "capability_proposal" || item.source.workspaceId !== workspaceId || !item.source.proposalId)
    return null;
  const projection = cached ?? (await fetchOperatorInbox(workspaceId));
  if (!inboxMatchesWorkspace(projection, workspaceId) || !projection.items.some((record) => record.id === item.id))
    return null;
  const detail = await fetchCapabilityProposal(item.source.proposalId);
  return currentCapabilityProposal(item, projection, detail, workspaceId);
}

export function InboxCapabilityProposalDetail({ item, workspaceId }: { item: OperatorInboxItem; workspaceId: string }) {
  const { activeWorkspaceId } = useUiPreferences();
  const scopeRef = useRef(activeWorkspaceId ?? "default");
  scopeRef.current = activeWorkspaceId ?? "default";
  const cached = useCachedInboxItem(workspaceId, item.id);
  const queryKey = ["capability", "inbox-proposal", workspaceId, item.id, cached.fingerprint];
  const query = useQuery({
    queryKey,
    queryFn: () => readCurrentProposal(item, workspaceId, cached.projection),
    placeholderData: keepRecordForSameItem(queryKey),
    enabled: Boolean(item.source.proposalId) && item.source.workspaceId === workspaceId && Boolean(cached.projection),
    staleTime: 0,
  });
  const scopeChanged = scopeRef.current !== workspaceId;
  const view = recordView(query);
  const lastVersion = lastVersionNote(view);
  const current = scopeChanged ? null : view.record;
  const proposal = current?.proposal;

  return (
    <section aria-label="Current capability proposal" className="space-y-3 border-t border-line-subtle pt-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-display font-semibold text-fg">Current capability proposal</h3>
        <Button size="sm" disabled={query.isFetching || !item.source.proposalId} onClick={() => void query.refetch()}>
          Refresh
        </Button>
      </div>
      {scopeChanged ? (
        <p role="alert" className="text-fg-secondary">
          The selected workspace changed. Open this item again in the current Inbox.
        </p>
      ) : null}
      {view.phase === "loading" ? (
        <p role="status" className="text-fg-muted">
          Loading the current proposal…
        </p>
      ) : view.phase === "checking" ? (
        <p role="status" className="text-fg-muted">
          {CHECKING_FOR_CHANGES}
        </p>
      ) : null}
      {query.isError ? (
        <p role="alert" className="text-status-failed">
          {describeApiError(query.error).summary}
        </p>
      ) : null}
      {lastVersion ? <p className="text-fg-muted">{lastVersion}</p> : null}
      {recordAnswered(view) && !proposal && !scopeChanged ? (
        <p className="text-fg-muted">
          This proposal is no longer in the selected workspace Inbox. Open Library for its current status.
        </p>
      ) : null}
      {proposal ? (
        <div className="space-y-2 text-fg-secondary">
          <p className="text-xs text-fg-muted">
            {humanizeToken(proposal.proposalKind)} proposal · {humanizeToken(proposal.status)}
          </p>
          {proposal.candidateId ? (
            <p>
              A candidate is linked to this proposal. Review its current version and lifecycle in Library before
              requesting promotion.
            </p>
          ) : null}
          <p className="text-xs text-fg-muted">
            {current.events.length} recorded {current.events.length === 1 ? "event" : "events"}. Proposal review here
            does not activate a capability.
          </p>
          <p className="text-xs text-fg-muted">
            Decisions for this proposal are unavailable in Inbox. Candidate promotion uses the governed Library flow.
          </p>
        </div>
      ) : null}
    </section>
  );
}
