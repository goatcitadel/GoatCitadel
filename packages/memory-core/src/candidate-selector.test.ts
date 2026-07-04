import { describe, expect, it } from "vitest";
import {
  estimateDistillerEvidenceTokens,
  resolveMemoryEvidenceTokenBudget,
  selectMemoryCandidatesForDistillation,
} from "./candidate-selector.js";
import type { RankedMemoryCandidate } from "./types.js";

function candidate(
  candidateId: string,
  text: string,
  overrides: Partial<RankedMemoryCandidate> = {},
): RankedMemoryCandidate {
  return {
    candidateId,
    sourceType: "memory_item",
    sourceRef: candidateId,
    text,
    rankScore: 1,
    rankSignals: {
      lexicalScore: 1,
      semanticHintScore: 0,
      recencyScore: 0,
      diversityScore: 0,
      totalScore: 1,
    },
    ...overrides,
  };
}

describe("selectMemoryCandidatesForDistillation", () => {
  it("clamps the evidence token budget from max context tokens", () => {
    expect(resolveMemoryEvidenceTokenBudget(100)).toBe(2_000);
    expect(resolveMemoryEvidenceTokenBudget(2_000)).toBe(6_000);
    expect(resolveMemoryEvidenceTokenBudget(4_000)).toBe(7_000);
    expect(resolveMemoryEvidenceTokenBudget(Number.NaN)).toBe(2_000);
  });

  it("preserves rank order while dropping candidates that exceed the evidence budget", () => {
    const candidates = [
      candidate("m:rank-1", "alpha ".repeat(650)),
      candidate("m:rank-2", "beta ".repeat(650)),
      candidate("m:rank-3", "gamma ".repeat(650)),
      candidate("m:rank-4", "delta ".repeat(650)),
    ];

    const result = selectMemoryCandidatesForDistillation({ candidates, maxContextTokens: 100 });
    const selectedIds = result.candidates.map((item) => item.candidateId);

    expect(selectedIds.length).toBeGreaterThan(0);
    expect(selectedIds.length).toBeLessThan(candidates.length);
    expect(selectedIds).toEqual(candidates.slice(0, selectedIds.length).map((item) => item.candidateId));
    expect(result.assembly).toMatchObject({
      availableCandidateCount: candidates.length,
      selectedCandidateCount: selectedIds.length,
      droppedCandidateCount: candidates.length - selectedIds.length,
      evidenceTokenBudget: 2_000,
    });
  });

  it("truncates an oversized top candidate instead of replacing it with lower-ranked candidates", () => {
    const candidates = [
      candidate("m:oversized-top", "alpha ".repeat(3_000)),
      candidate("m:smaller-second", "beta ".repeat(12)),
    ];

    const result = selectMemoryCandidatesForDistillation({ candidates, maxContextTokens: 100 });

    expect(result.candidates.map((item) => item.candidateId)).toEqual(["m:oversized-top"]);
    expect(result.candidates[0]?.text).toContain("[truncated]");
    expect(result.assembly.selectedTokenEstimate).toBeLessThanOrEqual(result.assembly.evidenceTokenBudget);
    expect(result.assembly).toMatchObject({
      availableCandidateCount: 2,
      selectedCandidateCount: 1,
      droppedCandidateCount: 1,
    });
  });

  it("accounts for token costs using the exact distiller evidence format", () => {
    const candidates = [
      candidate("m:first", "release gate evidence ".repeat(50)),
      candidate("m:second", "operator approval context ".repeat(50)),
    ];

    const result = selectMemoryCandidatesForDistillation({ candidates, maxContextTokens: 200 });

    expect(result.assembly.availableTokenEstimate).toBe(estimateDistillerEvidenceTokens(candidates));
    expect(result.assembly.selectedTokenEstimate).toBe(estimateDistillerEvidenceTokens(result.candidates));
  });
});
