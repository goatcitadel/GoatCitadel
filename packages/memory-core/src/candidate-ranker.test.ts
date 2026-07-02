import { describe, expect, it } from "vitest";
import { rankMemoryCandidates } from "./candidate-ranker.js";
import type { MemoryCandidate } from "./types.js";

describe("rankMemoryCandidates", () => {
  it("ranks lexical-only candidates with BM25-style signals", () => {
    const ranked = rankMemoryCandidates(
      "release verification checklist",
      [
        {
          candidateId: "m:release",
          sourceType: "memory_item",
          sourceRef: "release",
          text: "Release verification checklist requires docs check and smoke proof.",
          timestamp: "2026-05-07T12:00:00.000Z",
        },
        {
          candidateId: "m:meeting",
          sourceType: "memory_item",
          sourceRef: "meeting",
          text: "Meeting notes about design polish.",
          timestamp: "2026-05-07T12:00:00.000Z",
        },
      ],
      { maxCandidates: 2, nowIso: "2026-05-07T12:00:00.000Z" },
    );

    expect(ranked[0]?.candidateId).toBe("m:release");
    expect(ranked[0]?.rankSignals).toMatchObject({
      lexicalScore: expect.any(Number),
      lexicalBm25Score: expect.any(Number),
      recencyScore: 0.25,
      diversityScore: 0.08,
    });
    expect(ranked[0]?.rankSignals.embeddingScore).toBeUndefined();
  });

  it("uses explicit embeddings when both query and candidate vectors are present", () => {
    const ranked = rankMemoryCandidates(
      "deployment rollout validation",
      [
        {
          candidateId: "m:embedding-match",
          sourceType: "memory_item",
          sourceRef: "embedding-match",
          text: "Unrelated maintenance note.",
          embedding: [1, 0, 0],
        },
        {
          candidateId: "m:lexical-match",
          sourceType: "memory_item",
          sourceRef: "lexical-match",
          text: "Deployment notes.",
          embedding: [0, 1, 0],
        },
      ],
      {
        maxCandidates: 2,
        queryEmbedding: [1, 0, 0],
        embeddingProviderIsReal: true,
        nowIso: "2026-05-07T12:00:00.000Z",
      },
    );

    expect(ranked[0]?.candidateId).toBe("m:embedding-match");
    expect(ranked[0]?.rankSignals).toMatchObject({
      embeddingScore: 0.35,
      embeddingStatus: "used",
      embeddingDimensions: { query: 3, candidate: 3 },
      semanticVectorScore: 0.35,
    });
  });

  it("suppresses the embedding term under a pseudo provider so ranking stays lexical (P0-#3)", () => {
    const ranked = rankMemoryCandidates(
      "deployment rollout validation",
      [
        {
          candidateId: "m:vector-only",
          sourceType: "memory_item",
          sourceRef: "vector-only",
          // Unrelated lexically, but a perfect vector match to the query.
          text: "Unrelated maintenance note.",
          embedding: [1, 0, 0],
        },
        {
          candidateId: "m:lexical-only",
          sourceType: "memory_item",
          sourceRef: "lexical-only",
          text: "Deployment rollout validation notes.",
          embedding: [0, 1, 0],
        },
      ],
      // embeddingProviderIsReal omitted → pseudo default → embedding term suppressed.
      { maxCandidates: 2, queryEmbedding: [1, 0, 0], nowIso: "2026-05-07T12:00:00.000Z" },
    );

    // With the pseudo embedding gated off, the genuine lexical match wins instead
    // of the relevance-uncorrelated vector match.
    expect(ranked[0]?.candidateId).toBe("m:lexical-only");
    expect(ranked.every((candidate) => candidate.rankSignals.embeddingScore === undefined)).toBe(true);
    expect(ranked.every((candidate) => candidate.rankSignals.embeddingStatus === "missing")).toBe(true);
  });

  it("does not treat substring token matches as lexical or semantic-hint hits", () => {
    const ranked = rankMemoryCandidates(
      "mem",
      [
        {
          candidateId: "partial",
          sourceType: "memory_item",
          sourceRef: "partial",
          text: "Memory memoir memoization notes.",
          retrievalHints: ["memory memoir"],
          timestamp: "2026-05-07T12:00:00.000Z",
        },
        {
          candidateId: "exact",
          sourceType: "memory_item",
          sourceRef: "exact",
          text: "Use the mem budget for local context.",
          retrievalHints: ["mem budget"],
          timestamp: "2026-05-07T12:00:00.000Z",
        },
      ],
      { maxCandidates: 2, nowIso: "2026-05-07T12:00:00.000Z" },
    );

    expect(ranked[0]?.candidateId).toBe("exact");
    expect(ranked.find((candidate) => candidate.candidateId === "partial")?.rankSignals).toMatchObject({
      lexicalScore: 0,
      lexicalBm25Score: 0,
      semanticHintScore: 0,
    });
    expect(ranked.find((candidate) => candidate.candidateId === "exact")?.rankSignals.lexicalScore).toBeGreaterThan(0);
  });

  it("falls back cleanly when embeddings are missing or incompatible", () => {
    const ranked = rankMemoryCandidates(
      "approval evidence",
      [
        {
          candidateId: "m:missing",
          sourceType: "memory_item",
          sourceRef: "missing",
          text: "Approval evidence envelope.",
        },
        {
          candidateId: "m:wrong-dimensions",
          sourceType: "memory_item",
          sourceRef: "wrong",
          text: "Other note.",
          embedding: [1, 0],
        },
      ],
      {
        maxCandidates: 2,
        queryEmbedding: [1, 0, 0],
        embeddingProviderIsReal: true,
        nowIso: "2026-05-07T12:00:00.000Z",
      },
    );

    expect(ranked[0]?.candidateId).toBe("m:missing");
    expect(ranked.every((candidate) => candidate.rankSignals.embeddingScore === undefined)).toBe(true);
    expect(ranked.map((candidate) => candidate.rankSignals.embeddingStatus)).toEqual(["missing", "dimension_mismatch"]);
    expect(ranked[1]?.rankSignals.embeddingDimensions).toEqual({ query: 3, candidate: 2 });
  });

  it("keeps search-after-write deterministic when embedding providers fail or change dimensions", () => {
    const ranked = rankMemoryCandidates(
      "operator rollback evidence",
      [
        {
          candidateId: "m:fresh-write",
          sourceType: "memory_item",
          sourceRef: "fresh-write",
          text: "Operator rollback evidence was written after approval.",
          timestamp: "2026-05-07T12:00:00.000Z",
        },
        {
          candidateId: "m:stale-vector",
          sourceType: "memory_item",
          sourceRef: "stale-vector",
          text: "Rollback note from old embedding index.",
          timestamp: "2026-05-07T11:00:00.000Z",
          embedding: [1, 0],
        },
        {
          candidateId: "m:invalid-vector",
          sourceType: "memory_item",
          sourceRef: "invalid-vector",
          text: "Other approval note.",
          embedding: [Number.NaN, 0, 1],
        },
      ],
      {
        maxCandidates: 3,
        queryEmbedding: [1, 0, 0],
        embeddingProviderIsReal: true,
        nowIso: "2026-05-07T12:00:00.000Z",
      },
    );

    expect(ranked[0]?.candidateId).toBe("m:fresh-write");
    expect(ranked.map((candidate) => candidate.rankSignals.embeddingStatus)).toEqual([
      "missing",
      "dimension_mismatch",
      "invalid",
    ]);
    expect(ranked.every((candidate) => candidate.rankSignals.embeddingScore === undefined)).toBe(true);
  });

  it("uses recency as a transparent tie-break signal", () => {
    const ranked = rankMemoryCandidates(
      "launch",
      [
        {
          candidateId: "old",
          sourceType: "file",
          sourceRef: "old.md",
          text: "launch",
          timestamp: "2026-04-01T00:00:00.000Z",
        },
        {
          candidateId: "fresh",
          sourceType: "file",
          sourceRef: "fresh.md",
          text: "launch",
          timestamp: "2026-05-07T12:00:00.000Z",
        },
      ],
      { maxCandidates: 2, nowIso: "2026-05-07T12:00:00.000Z" },
    );

    expect(ranked.map((candidate) => candidate.candidateId)).toEqual(["fresh", "old"]);
    expect(ranked[0]?.rankSignals.recencyScore).toBe(0.25);
  });

  it("keeps source diversity visible in rank signals", () => {
    const ranked = rankMemoryCandidates(
      "operator approval",
      [
        {
          candidateId: "m:memory",
          sourceType: "memory_item",
          sourceRef: "memory",
          text: "operator approval",
        },
        {
          candidateId: "f:file",
          sourceType: "file",
          sourceRef: "file.md",
          text: "operator approval",
        },
      ],
      { maxCandidates: 2, nowIso: "2026-05-07T12:00:00.000Z" },
    );

    expect(ranked[0]?.candidateId).toBe("m:memory");
    expect(ranked[0]?.rankSignals.diversityScore).toBe(0.08);
  });

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
      rankSignals: expect.objectContaining({
        recencyScore: 0.25,
      }),
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
