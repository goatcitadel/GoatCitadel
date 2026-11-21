import type { MemoryRetrievalMatchSignals, TranscriptEvent } from "@goatcitadel/contracts";

export interface MemoryTranscriptSource {
  type: "transcript";
  events: TranscriptEvent[];
}

export interface MemoryFileSource {
  type: "file";
  relativePath: string;
  content: string;
  modifiedAt: string;
}

export interface MemoryItemSource {
  type: "memory_item";
  itemId: string;
  namespace: string;
  title: string;
  content: string;
  updatedAt: string;
  pinned?: boolean;
  retrievalHints?: string[];
  embedding?: number[];
  sourceHash?: string;
  indexedSemanticScore?: number;
}

export interface MemoryLearningSource {
  type: "memory_learning";
  learningId: string;
  title: string;
  content: string;
  updatedAt: string;
  sourceHash: string;
  retrievalHints?: string[];
}

export interface MemoryKnowledgeSource {
  type: "knowledge_chunk";
  chunkId: string;
  title: string;
  content: string;
  updatedAt: string;
  sourceHash: string;
  indexedSemanticScore?: number;
}

export type MemorySourceInput = MemoryTranscriptSource | MemoryFileSource | MemoryItemSource | MemoryLearningSource | MemoryKnowledgeSource;

export interface MemoryCandidate {
  candidateId: string;
  sourceType: "transcript" | "file" | "memory_item" | "memory_learning" | "knowledge_chunk";
  sourceRef: string;
  sourceHash?: string;
  text: string;
  timestamp?: string;
  retrievalHints?: string[];
  embedding?: number[];
  indexedSemanticScore?: number;
}

export interface RankedMemoryCandidate extends MemoryCandidate {
  rankScore: number;
  rankSignals: MemoryRetrievalMatchSignals;
}

export interface DistillationPayload {
  summary: string;
  facts: Array<{ text: string; citationIds: string[] }>;
  risks: string[];
  openQuestions: string[];
  saferNextSteps: string[];
}
