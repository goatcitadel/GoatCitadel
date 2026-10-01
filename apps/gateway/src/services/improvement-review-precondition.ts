import { ConflictError, type ImprovementCandidateDecisionReceipt, type ImprovementCandidateRecord,
  type ImprovementCandidateRevisionRecord, type ImprovementCandidateReviewPrecondition,
  type ImprovementEvaluationRecord } from "@goatcitadel/contracts";

export class ImprovementCandidateDecisionPostCommitError extends Error {
  public readonly mutationCommitted = true;

  constructor(public readonly canonicalResult: ImprovementCandidateDecisionReceipt, cause: unknown) {
    super("The candidate decision was saved, but its review or audit delivery failed. Refresh its current state before taking another action.", { cause });
    this.name = "ImprovementCandidateDecisionPostCommitError";
  }
}

export function hasPassingCurrentImprovementEvaluation(
  candidate: ImprovementCandidateRecord,
  revision: ImprovementCandidateRevisionRecord | undefined,
  evaluation: ImprovementEvaluationRecord | undefined,
): boolean {
  return Boolean(revision && evaluation && evaluation.status === "passed"
    && candidate.currentRevisionId === evaluation.revisionId && revision.revisionId === evaluation.revisionId
    && revision.candidateId === candidate.candidateId && evaluation.candidateId === candidate.candidateId
    && revision.changeHash === evaluation.changeHash);
}

/** Call only while holding the candidate lifecycle transaction lock. */
export function assertImprovementReviewPrecondition(
  expected: ImprovementCandidateReviewPrecondition | undefined,
  candidate: ImprovementCandidateRecord,
  revision: ImprovementCandidateRevisionRecord | undefined,
): void {
  if (!expected) return;
  if (expected.workspaceId !== candidate.workspaceId || expected.expectedStatus !== candidate.status
    || expected.expectedRevisionId !== (candidate.currentRevisionId ?? null)
    || expected.expectedRevisionId !== (revision?.revisionId ?? null)
    || expected.expectedChangeHash !== (revision?.changeHash ?? null)
    || (revision && revision.candidateId !== candidate.candidateId)) {
    throw new ConflictError({ code: "WRITE_CONFLICT", message: "The improvement candidate changed after review. Refresh its workspace, status, and revision before deciding." });
  }
}
