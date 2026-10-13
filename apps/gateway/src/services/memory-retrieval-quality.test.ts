import { describe, expect, it } from "vitest";
import type { MemoryCitation, MemoryRetrievalBenchmarkLabel } from "@goatcitadel/contracts";
import { calculateLabeledRetrievalRelevance, indexRetrievalBenchmarkLabels } from "./memory-retrieval-quality.js";

const source = (sourceRef: string) => ({ sourceType: "memory_item" as const, sourceRef });
const citation = (sourceRef: string): MemoryCitation => ({
  ...source(sourceRef),
  candidateId: sourceRef,
  score: 1,
  snippet: "unrelated words",
});

describe("labeled memory retrieval relevance", () => {
  it("scores exact unique source identities and ordering independently of lexical overlap", () => {
    const label: MemoryRetrievalBenchmarkLabel = {
      prompt: "launch checklist",
      relevantSources: [source("correct"), source("missing")],
      forbiddenSources: [source("revoked")],
    };
    expect(
      calculateLabeledRetrievalRelevance(
        [citation("irrelevant"), citation("correct"), citation("correct"), citation("revoked")],
        label,
      ),
    ).toEqual({
      retrievedSourceCount: 3,
      relevantSourceCount: 2,
      matchedRelevantCount: 1,
      precision: 1 / 3,
      recall: 0.5,
      reciprocalRank: 0.5,
      forbiddenSourceCount: 1,
    });
    expect(
      calculateLabeledRetrievalRelevance([{ ...citation("correct"), sourceType: "file" }], label).matchedRelevantCount,
    ).toBe(0);
  });

  it("measures no-result abstention and false injection without rewarding missing positive results", () => {
    const none: MemoryRetrievalBenchmarkLabel = { prompt: "unrelated", relevantSources: [], expectNoResults: true };
    expect(calculateLabeledRetrievalRelevance([], none)).toMatchObject({
      precision: 1,
      recall: 1,
      reciprocalRank: 1,
      abstentionCorrect: true,
    });
    expect(calculateLabeledRetrievalRelevance([citation("noise")], none)).toMatchObject({
      precision: 0,
      recall: 0,
      reciprocalRank: 0,
      abstentionCorrect: false,
    });
    expect(
      calculateLabeledRetrievalRelevance([], { prompt: "known", relevantSources: [source("needed")] }),
    ).toMatchObject({ precision: 0, recall: 0, reciprocalRank: 0 });
  });

  it("rejects duplicate, unmatched, contradictory and oversized labels before retrieval", () => {
    const label: MemoryRetrievalBenchmarkLabel = { prompt: "question", relevantSources: [source("correct")] };
    expect(indexRetrievalBenchmarkLabels(["question"], [label]).get("question")).toBe(label);
    for (const labels of [
      [label, label],
      [{ ...label, prompt: "other" }],
      [{ ...label, expectNoResults: true }],
      [{ ...label, forbiddenSources: [source("correct")] }],
      [{ ...label, relevantSources: [source("x".repeat(1025))] }],
    ]) {
      expect(() => indexRetrievalBenchmarkLabels(["question"], labels)).toThrow(/benchmark/);
    }
  });
});
