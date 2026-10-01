import type { DocumentPatchProposalRecord, OperatorInboxItem, OperatorInboxResponse } from "@goatcitadel/contracts";
import { inboxMatchesWorkspace } from "./inbox-presentation";

const MAX_INBOX_REVIEW_CHARS = 64_000;

export function hasCurrentInboxDocumentProposalItem(
  item: OperatorInboxItem,
  projection: OperatorInboxResponse,
  workspaceId: string,
): boolean {
  const proposalId = item.source.proposalId;
  if (item.kind !== "document_proposal" || item.group !== "proposals" || !proposalId
    || item.id !== `document_proposal:${proposalId}` || item.source.workspaceId !== workspaceId
    || projection.authority !== "derived_projection" || !inboxMatchesWorkspace(projection, workspaceId)) return false;
  const currentItem = projection.items.find((entry) => entry.id === item.id);
  return Boolean(currentItem && JSON.stringify(currentItem) === JSON.stringify(item));
}

export function currentInboxDocumentProposal(
  item: OperatorInboxItem,
  projection: OperatorInboxResponse,
  proposal: DocumentPatchProposalRecord,
  workspaceId: string,
): DocumentPatchProposalRecord | undefined {
  if (!hasCurrentInboxDocumentProposalItem(item, projection, workspaceId)
    || proposal.proposalId !== item.source.proposalId || proposal.workspaceId !== workspaceId
    || proposal.state !== "pending" || proposal.sessionId !== item.source.sessionId
    || proposal.turnId !== item.source.turnId || proposal.createdAt !== item.createdAt
    || proposal.updatedAt !== item.updatedAt
    || item.title !== `Review ${proposal.targetKind === "personal_note" ? "note" : "artifact"} edit`) return undefined;
  return proposal;
}

export function canReviewInboxDocumentProposal(proposal: DocumentPatchProposalRecord | undefined): boolean {
  return Boolean(proposal && proposal.state === "pending" && proposal.derivedDiff
    && proposal.derivedDiff !== "No changes." && proposal.proposedContent
    && proposal.derivedDiff.length <= MAX_INBOX_REVIEW_CHARS
    && proposal.proposedContent.length <= MAX_INBOX_REVIEW_CHARS);
}
