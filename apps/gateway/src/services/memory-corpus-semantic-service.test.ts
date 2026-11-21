import { expect, it, vi } from "vitest";
import type { MemoryCorpusSearchRequest, MemoryCorpusSearchResult } from "@goatcitadel/contracts";
import { MemoryCorpusSemanticService } from "./memory-corpus-semantic-service.js";

it.each(["memory_item", "knowledge_chunk"] as const)(
  "warms in bounded pages, merges a semantic-only eligible %s, and fails closed on generation changes",
  async (sourceType) => {
    const profile = {
      profileId: "fixture",
      provider: "remote",
      modelId: "fixture",
      version: "1",
      dimensions: 2,
      status: "active",
      source: "request",
    } as const;
    let generation = 1;
    const hit = {
      sourceType,
      sourceRef: "semantic-only",
      sourceHash: "a".repeat(64),
      workspaceId: "A",
      title: "Launch",
      snippet: "Use the amber region",
      updatedAt: "2026-11-18",
      lexicalScore: 0,
    };
    const storage = {
      readGeneration: vi.fn(async () => generation),
      listVectorPage: vi.fn(async () => ({
        entries: [
          {
            sourceType,
            sourceRef: hit.sourceRef,
            vector: [8, 0],
            metadata: { provider: profile.provider, modelId: profile.modelId, version: profile.version, dimensions: 2 },
          },
        ],
        hasMore: false,
      })),
      getEligibleSources: vi.fn(async () => [hit]),
    };
    const service = new MemoryCorpusSemanticService({ repository: storage as never });
    const input: MemoryCorpusSearchRequest = {
      workspaceId: "A",
      sessionId: "private",
      query: "deployment choice",
      sourceTypes: [sourceType],
      limit: 40,
      queryEmbedding: { values: [1, 0], profile },
    };
    const lexical: MemoryCorpusSearchResult = {
      hits: [],
      coverage: {
        generation: 1,
        lexicalStatus: "ready",
        semanticStatus: "unavailable",
        indexedCount: 1,
        unindexedCount: 0,
      },
    };
    try {
      await service.prepare(input, 1);
      const result = await service.augment(input, lexical);
      expect(result.hits[0]).toMatchObject({ sourceRef: hit.sourceRef, semanticScore: 1 });
      expect(result.coverage.semanticStatus).toBe("ready");
      expect(storage.listVectorPage).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "A", sessionId: "private", limit: 200 }),
      );
      generation = 2;
      const changed = await service.augment(input, lexical);
      expect(changed.hits).toEqual([]);
      expect(changed.coverage.semanticStatus).toBe("building");
      expect(
        (
          await service.augment(
            { ...input, queryEmbedding: { values: [1, 0], profile: { ...profile, provider: "pseudo" } } },
            lexical,
          )
        ).coverage.semanticStatus,
      ).toBe("profile_incompatible");
    } finally {
      await service.close();
    }
  },
);
