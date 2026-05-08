import { describe, expect, it } from "vitest";
import { rankMemoryCandidates } from "./candidate-ranker.js";
import type { MemoryCandidate } from "./types.js";

describe("rankMemoryCandidates", () => {
  it("uses candidateId as a deterministic tiebreaker", () => {
    const candidates: MemoryCandidate[] = [
      {
        candidateId: "t:beta",
        sourceType: "transcript",
        sourceRef: "beta",
        text: "shared launch context",
        timestamp: "2026-05-07T12:00:00.000Z",
      },
      {
        candidateId: "t:alpha",
        sourceType: "transcript",
        sourceRef: "alpha",
        text: "shared launch context",
        timestamp: "2026-05-07T12:00:00.000Z",
      },
    ];

    const ranked = rankMemoryCandidates("launch context", candidates, {
      maxCandidates: 2,
      nowIso: "2026-05-07T12:00:00.000Z",
    });

    expect(ranked.map((candidate) => candidate.candidateId)).toEqual(["t:alpha", "t:beta"]);
  });
});
