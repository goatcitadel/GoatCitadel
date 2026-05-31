import type { TranscriptEvent } from "@goatcitadel/contracts";

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
}

export type MemorySourceInput = MemoryTranscriptSource | MemoryFileSource | MemoryItemSource;

export interface MemoryCandidate {
  candidateId: string;
  sourceType: "transcript" | "file" | "memory_item";
  sourceRef: string;
  text: string;
  timestamp?: string;
}

export interface RankedMemoryCandidate extends MemoryCandidate {
  rankScore: number;
}

export interface DistillationPayload {
  summary: string;
  facts: Array<{ text: string; citationIds: string[] }>;
  risks: string[];
  openQuestions: string[];
  saferNextSteps: string[];
}
