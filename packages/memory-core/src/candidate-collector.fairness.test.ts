import { expect, it } from "vitest";
import { collectMemoryCandidates } from "./candidate-collector.js";
import { rankMemoryCandidates } from "./candidate-ranker.js";

it("lets each file compete before one long file consumes the chunk budget", () => {
  const candidates = collectMemoryCandidates(
    [
      { type: "file", relativePath: "long.md", content: "Unrelated material. ".repeat(30), modifiedAt: "2026-11-18" },
      {
        type: "file",
        relativePath: "decision.md",
        content: "The amber region was selected.",
        modifiedAt: "2026-11-18",
      },
    ],
    { maxTranscriptEvents: 0, maxFileCandidates: 2, maxCharsPerCandidate: 80 },
  );
  expect(candidates).toHaveLength(2);
  expect(candidates.some((candidate) => candidate.sourceRef === "decision.md")).toBe(true);
});

it("offers a query-relevant late file chunk before unrelated earlier chunks", () => {
  const candidates = collectMemoryCandidates(
    [
      {
        type: "file",
        relativePath: "long.md",
        content: "Unrelated material. ".repeat(30) + " The heliotrope decision uses the amber region.",
        modifiedAt: "2026-11-18",
      },
    ],
    { maxTranscriptEvents: 0, maxFileCandidates: 1, maxCharsPerCandidate: 80, query: "heliotrope amber region" },
  );
  expect(candidates[0]?.text).toContain("heliotrope");
});

it("caps the merged corpus without letting one source type consume every slot", () => {
  const sources = Array.from({ length: 20 }, (_, i) => ({
    type: "memory_item" as const,
    itemId: `m${i}`,
    namespace: "notes",
    title: "Distractor",
    content: "Unrelated notes",
    updatedAt: "2026-11-18",
  }));
  const candidates = collectMemoryCandidates(
    [
      ...sources,
      { type: "file", relativePath: "answer.md", content: "Kestrel uses the amber region", modifiedAt: "2026-11-18" },
    ],
    {
      maxTranscriptEvents: 20,
      maxFileCandidates: 20,
      maxMemoryItems: 20,
      maxCharsPerCandidate: 200,
      maxCandidates: 4,
      query: "Kestrel amber region",
    },
  );
  expect(candidates).toHaveLength(4);
  expect(candidates.some((candidate) => candidate.sourceRef === "answer.md")).toBe(true);
});

it("counts worker cosine only under a real-provider ranking receipt", () => {
  const candidate = {
    candidateId: "k:1",
    sourceType: "knowledge_chunk" as const,
    sourceRef: "1",
    text: "The amber region",
    indexedSemanticScore: 1,
  };
  expect(
    rankMemoryCandidates("deployment choice", [candidate], { maxCandidates: 1, embeddingProviderIsReal: false })[0]
      ?.rankSignals.embeddingScore,
  ).toBeUndefined();
  expect(
    rankMemoryCandidates("deployment choice", [candidate], { maxCandidates: 1, embeddingProviderIsReal: true })[0]
      ?.rankSignals.embeddingScore,
  ).toBe(0.35);
});
