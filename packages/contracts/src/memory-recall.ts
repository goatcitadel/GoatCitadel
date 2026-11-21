import type { MemoryEmbeddingProfile } from "./memory.js";

export type MemoryRecallSourceType = "memory_item" | "memory_learning" | "knowledge_chunk";

export interface RecallHit {
  sourceType: MemoryRecallSourceType;
  sourceRef: string;
  sourceHash: string;
  workspaceId: string;
  title: string;
  snippet: string;
  updatedAt: string;
  namespace?: string;
  docId?: string;
  documentSourceRef?: string;
  trustLevel?: "trusted_operator" | "trusted_workspace" | "mixed_untrusted" | "untrusted_external";
  lexicalScore: number;
  semanticScore?: number;
}

/** Derived-index coverage is separate from source trust and permission. */
export interface RecallCoverage {
  generation: number;
  lexicalStatus: "ready" | "building" | "unavailable";
  semanticStatus: "ready" | "building" | "unavailable" | "profile_incompatible" | "over_capacity";
  embeddingProfileId?: string;
  indexedCount: number;
  unindexedCount: number;
  ineligibleCount?: number;
  semanticIndexedCount?: number;
  semanticUnindexedCount?: number;
  reason?: string;
}

export interface MemoryCorpusSearchRequest {
  workspaceId: string;
  sessionId: string;
  query: string;
  sourceTypes?: MemoryRecallSourceType[];
  limit?: number;
  namespace?: string;
  queryEmbedding?: { values: number[]; profile: MemoryEmbeddingProfile };
}

export interface MemoryCorpusSearchResult {
  hits: RecallHit[];
  coverage: RecallCoverage;
}
