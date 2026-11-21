import type { MemoryCandidate, MemorySourceInput } from "./types.js";

export interface CandidateCollectorOptions {
  maxCandidates?: number;
  query?: string;
  maxTranscriptEvents: number;
  maxFileCandidates: number;
  maxMemoryItems?: number;
  maxCharsPerCandidate: number;
}

export function collectMemoryCandidates(
  sources: MemorySourceInput[],
  options: CandidateCollectorOptions,
): MemoryCandidate[] {
  const out: MemoryCandidate[] = [];
  const maxTranscriptEvents = Math.max(0, Math.floor(options.maxTranscriptEvents));
  const maxFileCandidates = Math.max(0, Math.floor(options.maxFileCandidates));
  const maxMemoryItems = Math.max(0, Math.floor(options.maxMemoryItems ?? 24));
  const maxCharsPerCandidate = Math.max(1, Math.floor(options.maxCharsPerCandidate));
  let fileCount = 0;
  let memoryItemCount = 0;
  let learningCount = 0;
  const fileGroups: MemoryCandidate[][] = [];
  const queryTokens = [
    ...new Set(
      (
        options.query
          ?.normalize("NFKC")
          .toLowerCase()
          .match(/[\p{L}\p{N}]+/gu) ?? []
      ).slice(0, 32),
    ),
  ];

  for (const source of sources) {
    if (source.type === "transcript") {
      if (maxTranscriptEvents === 0) {
        continue;
      }
      const recent = source.events.slice(-maxTranscriptEvents);
      for (const event of recent) {
        const content = extractTranscriptText(event.payload);
        if (!content) {
          continue;
        }
        out.push({
          candidateId: `t:${event.eventId}`,
          sourceType: "transcript",
          sourceRef: event.eventId,
          text: trimCandidate(content, maxCharsPerCandidate),
          timestamp: event.timestamp,
        });
      }
      continue;
    }

    if (source.type === "memory_item") {
      if (memoryItemCount >= maxMemoryItems) {
        continue;
      }
      const text = trimCandidate(
        [`${source.title} (${source.namespace})`, source.pinned ? "Pinned memory" : "", source.content]
          .filter(Boolean)
          .join("\n"),
        maxCharsPerCandidate,
      );
      if (!text) {
        continue;
      }
      out.push({
        candidateId: `m:${source.itemId}`,
        sourceType: "memory_item",
        sourceRef: source.itemId,
        sourceHash: source.sourceHash,
        indexedSemanticScore: source.indexedSemanticScore,
        text,
        timestamp: source.updatedAt,
        retrievalHints: source.retrievalHints,
        embedding: source.embedding,
      });
      memoryItemCount += 1;
      continue;
    }

    if (source.type === "memory_learning" || source.type === "knowledge_chunk") {
      if (learningCount >= maxMemoryItems) continue;
      const text = trimCandidate([source.title, source.content].join("\n"), maxCharsPerCandidate);
      if (!text.trim() || !source.sourceHash) continue;
      out.push({
        candidateId: source.type === "memory_learning" ? `l:${source.learningId}` : `k:${source.chunkId}`,
        sourceType: source.type,
        sourceRef: source.type === "memory_learning" ? source.learningId : source.chunkId,
        sourceHash: source.sourceHash,
        indexedSemanticScore: source.type === "knowledge_chunk" ? source.indexedSemanticScore : undefined,
        text,
        timestamp: source.updatedAt,
        retrievalHints: source.type === "memory_learning" ? source.retrievalHints : undefined,
      });
      learningCount += 1;
      continue;
    }

    const chunks = splitIntoChunks(source.content, maxCharsPerCandidate);
    const group: Array<MemoryCandidate & { matchCount: number }> = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!;
      const normalizedChunk = chunk.normalize("NFKC").toLowerCase();
      group.push({
        candidateId: `f:${source.relativePath}#${index}`,
        sourceType: "file",
        sourceRef: source.relativePath,
        text: chunk,
        timestamp: source.modifiedAt,
        matchCount: queryTokens.filter((token) => normalizedChunk.includes(token)).length,
      });
    }
    group.sort((left, right) => right.matchCount - left.matchCount);
    fileGroups.push(group.map(({ matchCount: _matchCount, ...candidate }) => candidate));
  }
  for (
    let offset = 0;
    fileCount < maxFileCandidates && fileGroups.some((group) => offset < group.length);
    offset += 1
  ) {
    for (const group of fileGroups) {
      if (fileCount >= maxFileCandidates) break;
      if (group[offset]) {
        out.push(group[offset]!);
        fileCount += 1;
      }
    }
  }

  const maximum = options.maxCandidates === undefined ? out.length : Math.max(0,Math.floor(options.maxCandidates));
  if (out.length <= maximum) return out;
  const groups = new Map<string,Array<{candidate:MemoryCandidate;matches:number}>>();
  for (const candidate of out) {
    const text = candidate.text.normalize("NFKC").toLowerCase();
    const group = groups.get(candidate.sourceType) ?? [];
    group.push({candidate,matches:queryTokens.filter(token => text.includes(token)).length});
    groups.set(candidate.sourceType,group);
  }
  for (const group of groups.values()) group.sort((a,b) => b.matches-a.matches);
  const selected:MemoryCandidate[] = [];
  for(let offset=0;selected.length<maximum && [...groups.values()].some(group => offset<group.length);offset++) {
    for(const group of groups.values()) {
      if (selected.length === maximum) break;
      if (group[offset]) selected.push(group[offset]!.candidate);
    }
  }
  return selected;
}

function extractTranscriptText(payload: Record<string, unknown>): string | undefined {
  const message = payload.message;
  if (typeof message === "string" && message.trim()) {
    return message.trim();
  }

  const content = payload.content;
  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }

  if (typeof payload === "object") {
    const serialized = JSON.stringify(payload);
    if (serialized && serialized !== "{}") {
      return serialized;
    }
  }
  return undefined;
}

function splitIntoChunks(input: string, maxChars: number): string[] {
  const normalized = input.trim();
  if (!normalized) {
    return [];
  }
  if (normalized.length <= maxChars) {
    return [normalized];
  }

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    const next = normalized.slice(cursor, cursor + maxChars).trim();
    if (next) {
      chunks.push(next);
    }
    cursor += maxChars;
  }
  return chunks;
}

function trimCandidate(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  const suffix = "\n...[truncated]";
  if (maxChars <= suffix.length) {
    return input.slice(0, maxChars);
  }
  return `${input.slice(0, Math.max(0, maxChars - 16))}${suffix}`;
}
