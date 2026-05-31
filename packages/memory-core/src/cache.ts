import { createHash } from "node:crypto";
import type { MemoryContextScope, MemoryRelationScope } from "@goatcitadel/contracts";
import type { RankedMemoryCandidate } from "./types.js";

export interface CacheKeyInput {
  scope: MemoryContextScope;
  prompt: string;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  phaseId?: string;
  relationScope?: MemoryRelationScope;
  maxContextTokens: number;
  candidates: RankedMemoryCandidate[];
  queryEmbedding?: number[];
}

export function hashText(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function buildQueryHash(prompt: string, queryEmbedding?: number[]): string {
  const normalizedPrompt = prompt.trim().toLowerCase();
  const embeddingFingerprint = normalizeEmbeddingFingerprint(queryEmbedding);
  return hashText(embeddingFingerprint ? `${normalizedPrompt}|embedding:${embeddingFingerprint}` : normalizedPrompt);
}

export function buildSourcesHash(candidates: RankedMemoryCandidate[]): string {
  const payload = candidates
    .map((candidate) => `${candidate.candidateId}|${candidate.timestamp ?? ""}|${candidate.rankScore.toFixed(5)}`)
    .join("\n");
  return hashText(payload);
}

export function buildCacheKey(input: CacheKeyInput): string {
  const basis = [
    input.scope,
    input.sessionId ?? "",
    input.taskId ?? "",
    input.runId ?? "",
    input.phaseId ?? "",
    input.relationScope ?? "",
    String(input.maxContextTokens),
    buildQueryHash(input.prompt, input.queryEmbedding),
    buildSourcesHash(input.candidates),
  ].join("|");
  return hashText(basis);
}

function normalizeEmbeddingFingerprint(queryEmbedding?: number[]): string | undefined {
  if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
    return undefined;
  }
  const values = queryEmbedding.filter((value) => Number.isFinite(value));
  if (values.length !== queryEmbedding.length) {
    return undefined;
  }
  return hashText(values.map((value) => value.toFixed(6)).join(","));
}
