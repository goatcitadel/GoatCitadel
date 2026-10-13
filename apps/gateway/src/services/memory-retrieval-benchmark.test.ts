import { describe, expect, it, vi } from "vitest";
import type {
  MemoryContextComposeRequest,
  MemoryContextCompositionDiagnostics,
  MemoryContextPack,
  MemoryCitation,
} from "@goatcitadel/contracts";
import { MemoryLifecycleService } from "./memory-lifecycle-service.js";

const source = (sourceRef: string) => ({ sourceType: "memory_item" as const, sourceRef });
function harness() {
  const compose = vi.fn(
    async (
      input: MemoryContextComposeRequest,
      _lineage: unknown,
      observe: (diagnostics: Readonly<MemoryContextCompositionDiagnostics>) => void,
    ): Promise<MemoryContextPack> => {
      observe({
        outcome: input.prompt === "failure" ? "failed" : "completed",
        embeddingCacheStatus: "refresh",
        contextCacheStatus: "refresh",
        embeddingProviderIsReal: false,
        timings: {
          totalMs: 7,
          accessMs: 1,
          embeddingMs: 1,
          sourceReadMs: 2,
          rankingMs: 1,
          contextCacheMs: 0,
          distillationMs: 2,
        },
      });
      if (input.prompt === "failure") throw new Error("fixture retrieval failed");
      const citations: MemoryCitation[] =
        input.prompt === "unrelated"
          ? []
          : ["correct", "irrelevant"].map((id) => ({ ...source(id), candidateId: id, score: 1 }));
      return {
        contextId: "fixture",
        scope: "chat",
        queryHash: "q",
        sourcesHash: "s",
        contextText: "Text sharing no query words",
        citations,
        quality: { status: "fallback" },
        originalTokenEstimate: 100,
        distilledTokenEstimate: 40,
        createdAt: "2026-10-11T00:00:00.000Z",
        expiresAt: "2026-10-12T00:00:00.000Z",
      };
    },
  );
  const service = new MemoryLifecycleService({
    context: { compose } as never,
    learned: {} as never,
    maintenance: {} as never,
    admin: {
      gatewaySql: {},
      memoryItemEnumeration: {},
      requireFeatureEnabled: vi.fn(),
      tryParseJson: vi.fn(),
      publishRealtime: vi.fn(),
    } as never,
    resolveLearnedMemoryPolicy: vi.fn(),
    readTranscriptOrEmpty: vi.fn(),
  });
  return { service, compose };
}

describe("native memory benchmark ground truth", () => {
  it("returns separate relevance and stage metrics without allowing labels to influence retrieval", async () => {
    const { service, compose } = harness();
    const result = await service.runRetrievalBenchmark({
      prompts: ["known", "unrelated"],
      workspace: "workspace-one",
      labels: [
        { prompt: "known", relevantSources: [source("correct")], forbiddenSources: [source("irrelevant")] },
        { prompt: "unrelated", relevantSources: [], expectNoResults: true },
      ],
    });
    expect(result.relevanceSummary).toMatchObject({
      evaluatedItemCount: 2,
      avgPrecision: 0.75,
      avgRecall: 1,
      meanReciprocalRank: 1,
      forbiddenSourceCount: 1,
      noResultCaseCount: 1,
      correctAbstentions: 1,
    });
    expect(result.items[0]?.overlapScore).toBe(0);
    expect(result.items[0]?.composition?.timings).toMatchObject({ totalMs: 7, sourceReadMs: 2 });
    expect(result.items[0]?.composition?.embeddingProviderIsReal).toBe(false);
    for (const [input] of compose.mock.calls) {
      expect(input).toMatchObject({ workspaceId: "workspace-one", forceRefresh: true });
      expect(input).not.toHaveProperty("labels");
    }
  });

  it("does not claim relevance for unlabelled or failed runs but retains failure stage evidence", async () => {
    const { service } = harness();
    const result = await service.runRetrievalBenchmark({
      prompts: ["known", "failure"],
      labels: [{ prompt: "failure", relevantSources: [source("correct")] }],
    });
    expect(result.relevanceSummary).toBeUndefined();
    expect(result.items[0]?.relevance).toBeUndefined();
    expect(result.items[1]).toMatchObject({
      status: "failed",
      composition: { outcome: "failed", timings: { totalMs: 7 } },
    });
    expect(result.semanticCoverageNote).toContain("unlabelled runs do not establish relevance quality");
  });

  it("validates labels before calling any retrieval or provider owner", async () => {
    const { service, compose } = harness();
    await expect(
      service.runRetrievalBenchmark({ prompts: ["known"], labels: [{ prompt: "other", relevantSources: [] }] }),
    ).rejects.toThrow(/uniquely match/);
    expect(compose).not.toHaveBeenCalled();
  });
});
