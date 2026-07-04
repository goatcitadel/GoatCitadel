import type { MemoryContextAssemblyReport } from "@goatcitadel/contracts";
import { buildDistillerEvidence } from "./distiller.js";
import { estimateTokensFromText } from "./token-estimator.js";
import type { RankedMemoryCandidate } from "./types.js";

export interface SelectMemoryCandidatesInput {
  candidates: RankedMemoryCandidate[];
  maxContextTokens: number;
}

export interface SelectMemoryCandidatesResult {
  candidates: RankedMemoryCandidate[];
  assembly: MemoryContextAssemblyReport;
}

export function selectMemoryCandidatesForDistillation(
  input: SelectMemoryCandidatesInput,
): SelectMemoryCandidatesResult {
  const evidenceTokenBudget = resolveMemoryEvidenceTokenBudget(input.maxContextTokens);
  const availableTokenEstimate = estimateDistillerEvidenceTokens(input.candidates);
  const selected: RankedMemoryCandidate[] = [];
  const firstCandidate = input.candidates[0];
  const firstCandidateExceedsBudget =
    firstCandidate !== undefined && estimateDistillerEvidenceTokens([firstCandidate]) > evidenceTokenBudget;

  if (firstCandidateExceedsBudget && firstCandidate) {
    selected.push(truncateCandidateToEvidenceBudget(firstCandidate, evidenceTokenBudget));
  }

  for (const candidate of input.candidates.slice(firstCandidateExceedsBudget ? 1 : 0)) {
    const next = [...selected, candidate];
    if (estimateDistillerEvidenceTokens(next) <= evidenceTokenBudget) {
      selected.push(candidate);
    }
  }

  if (selected.length === 0 && firstCandidate) {
    selected.push(truncateCandidateToEvidenceBudget(input.candidates[0]!, evidenceTokenBudget));
  }

  const selectedTokenEstimate = estimateDistillerEvidenceTokens(selected);
  return {
    candidates: selected,
    assembly: {
      availableCandidateCount: input.candidates.length,
      selectedCandidateCount: selected.length,
      droppedCandidateCount: Math.max(0, input.candidates.length - selected.length),
      availableTokenEstimate,
      selectedTokenEstimate,
      evidenceTokenBudget,
    },
  };
}

export function resolveMemoryEvidenceTokenBudget(maxContextTokens: number): number {
  const normalized = Number.isFinite(maxContextTokens) ? Math.max(0, Math.floor(maxContextTokens)) : 0;
  return Math.min(7_000, Math.max(2_000, normalized * 3));
}

export function estimateDistillerEvidenceTokens(candidates: RankedMemoryCandidate[]): number {
  return estimateTokensFromText(buildDistillerEvidence(candidates));
}

function truncateCandidateToEvidenceBudget(
  candidate: RankedMemoryCandidate,
  evidenceTokenBudget: number,
): RankedMemoryCandidate {
  let low = 0;
  let high = candidate.text.length;
  let bestText = "";
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const text = truncateEvidenceText(candidate.text, mid);
    const estimate = estimateDistillerEvidenceTokens([{ ...candidate, text }]);
    if (estimate <= evidenceTokenBudget) {
      bestText = text;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return {
    ...candidate,
    text: bestText || truncateEvidenceText(candidate.text, 0),
  };
}

function truncateEvidenceText(input: string, maxChars: number): string {
  const suffix = "\n...[truncated]";
  if (input.length <= maxChars) {
    return input;
  }
  if (maxChars <= 0) {
    return suffix.trimStart();
  }
  const bodyBudget = Math.max(0, maxChars - suffix.length);
  const body = input.slice(0, bodyBudget).trimEnd();
  return body ? `${body}${suffix}` : suffix.trimStart();
}
