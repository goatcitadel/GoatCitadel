import type { OperatorInboxItem, TraceMemoryCandidateRecord } from "@goatcitadel/contracts";

/** The reviewed candidate must still be the exact proposed owner record. */
export function canResolveInboxMemoryProposal(
  item: OperatorInboxItem,
  reviewed: TraceMemoryCandidateRecord,
  current: TraceMemoryCandidateRecord | undefined,
  workspaceId: string,
): boolean {
  return item.kind === "memory_proposal"
    && item.source.workspaceId === workspaceId
    && item.source.proposalId === reviewed.candidateId
    && reviewed.workspaceId === workspaceId
    && reviewed.status === "proposed"
    && current?.candidateId === reviewed.candidateId
    && current.workspaceId === workspaceId
    && current.status === "proposed"
    && JSON.stringify(current) === JSON.stringify(reviewed);
}
