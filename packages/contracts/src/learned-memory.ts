export type LearnedMemoryItemType = "preference" | "goal" | "constraint" | "fact" | "project_context";

export interface LearnedMemoryItemRecord {
  itemId: string;
  sessionId: string;
  itemType: LearnedMemoryItemType;
  content: string;
  confidence: number;
  status: "active" | "superseded" | "conflict" | "disabled" | "dropped";
  supersededByItemId?: string;
  redacted: boolean;
  createdAt: string;
  updatedAt: string;
  claim?: MemoryClaim;
  sourceHash?: string;
}

export interface LearnedMemoryConflictRecord {
  conflictId: string;
  sessionId: string;
  itemType: LearnedMemoryItemType;
  existingItemId?: string;
  incomingItemId?: string;
  incomingContent: string;
  status: "open" | "resolved" | "ignored";
  resolutionNote?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface LearnedMemoryUpdateInput {
  status?: "active" | "superseded" | "conflict" | "disabled";
  content?: string;
  confidence?: number;
  resolutionNote?: string;
}
import type { MemoryClaim } from "./memory-claims.js";
