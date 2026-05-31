import type { MemoryCandidate, MemorySourceInput } from "./types.js";

export interface CandidateCollectorOptions {
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
        text,
        timestamp: source.updatedAt,
        retrievalHints: source.retrievalHints,
      });
      memoryItemCount += 1;
      continue;
    }

    if (fileCount >= maxFileCandidates) {
      continue;
    }

    const chunks = splitIntoChunks(source.content, maxCharsPerCandidate);
    for (let index = 0; index < chunks.length; index += 1) {
      if (fileCount >= maxFileCandidates) {
        break;
      }
      const chunk = chunks[index]!;
      out.push({
        candidateId: `f:${source.relativePath}#${index}`,
        sourceType: "file",
        sourceRef: source.relativePath,
        text: chunk,
        timestamp: source.modifiedAt,
      });
      fileCount += 1;
    }
  }

  return out;
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
  return `${input.slice(0, Math.max(0, maxChars - 16))}\n...[truncated]`;
}
