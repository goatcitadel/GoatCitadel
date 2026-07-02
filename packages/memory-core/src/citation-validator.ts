import type { MemoryCitation } from "@goatcitadel/contracts";
import type { MemoryCandidate } from "./types.js";

export function validateCitations(
  citations: MemoryCitation[],
  candidates: MemoryCandidate[],
): { valid: boolean; invalidIds: string[] } {
  const allowed = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const invalidIds: string[] = [];
  for (const citation of citations) {
    const candidate = allowed.get(citation.candidateId);
    if (!candidate) {
      invalidIds.push(citation.candidateId);
      continue;
    }
    if (
      citation.sourceType !== candidate.sourceType ||
      citation.sourceRef !== candidate.sourceRef ||
      !Number.isFinite(citation.score) ||
      citation.score < 0 ||
      citation.score > 1
    ) {
      invalidIds.push(citation.candidateId);
    }
  }
  return {
    valid: invalidIds.length === 0,
    invalidIds,
  };
}
