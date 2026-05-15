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

  it("clamps future timestamps into the freshest recency band", () => {
    const ranked = rankMemoryCandidates(
      "launch",
      [
        {
          candidateId: "future",
          sourceType: "file",
          sourceRef: "future.md",
          text: "launch",
          timestamp: "2026-05-07T13:00:00.000Z",
        },
        {
          candidateId: "old",
          sourceType: "file",
          sourceRef: "old.md",
          text: "launch",
          timestamp: "2026-04-01T00:00:00.000Z",
        },
      ],
      { maxCandidates: 2, nowIso: "2026-05-07T12:00:00.000Z" },
    );

    expect(ranked[0]).toMatchObject({
      candidateId: "future",
      rankScore: 1.25,
    });
  });

  it("uses the current clock when no reference timestamp is supplied", () => {
    const ranked = rankMemoryCandidates(
      "launch",
      [
        {
          candidateId: "current-clock",
          sourceType: "file",
          sourceRef: "current.md",
          text: "launch",
          timestamp: new Date().toISOString(),
        },
      ],
      { maxCandidates: 1 },
    );

    expect(ranked[0]?.candidateId).toBe("current-clock");
  });
});
