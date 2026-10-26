/**
 * Shared bounded SSE frame reader for provider streams. Scans only newly received text for frame
 * boundaries, enforces byte and event limits, and cancels the response body unless the stream was
 * read to its natural end (early return, consumer throw, [DONE], or a limit breach).
 */

export type SsePayload = Record<string, unknown> | "[DONE]";

export interface SsePayloadLimits {
  maxBytes: number;
  maxEvents: number;
  /** Used in limit errors, e.g. "provider stream" -> "provider stream exceeded N bytes.". */
  label: string;
  onDone?: () => void;
}

const FRAME_BOUNDARY_SOURCE = "\r?\n\r?\n";
/** Longest boundary is "\r\n\r\n"; back off enough to re-detect one split across chunks. */
const BOUNDARY_LOOKBACK = 3;

export function parseSseFramePayloads(dataLines: string[]): SsePayload[] {
  if (dataLines.length === 0) {
    return [];
  }

  const joined = dataLines.join("\n").trim();
  if (joined === "[DONE]") {
    return ["[DONE]"];
  }

  const parsedJoined = tryParseJsonRecord(joined);
  if (parsedJoined) {
    return [parsedJoined];
  }

  const parsedLines: SsePayload[] = [];
  for (const line of dataLines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === "[DONE]") {
      parsedLines.push("[DONE]");
      continue;
    }
    const parsed = tryParseJsonRecord(trimmed);
    if (parsed) {
      parsedLines.push(parsed);
    }
  }
  return parsedLines;
}

function tryParseJsonRecord(payload: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed provider chunks
  }
  return null;
}

function frameDataLines(frame: string): string[] {
  return frame
    .split(/\r?\n/g)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .filter(Boolean);
}

export async function* streamSsePayloads(
  body: ReadableStream<Uint8Array>,
  limits: SsePayloadLimits,
): AsyncGenerator<Record<string, unknown>> {
  const boundary = new RegExp(FRAME_BOUNDARY_SOURCE, "g");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let scanFrom = 0;
  let receivedBytes = 0;
  let eventCount = 0;
  let completed = false;

  function* emit(frame: string): Generator<Record<string, unknown>, boolean> {
    for (const payload of parseSseFramePayloads(frameDataLines(frame))) {
      if (payload === "[DONE]") {
        limits.onDone?.();
        return true;
      }
      eventCount += 1;
      if (eventCount > limits.maxEvents) {
        throw new Error(`${limits.label} exceeded ${limits.maxEvents} events.`);
      }
      yield payload;
    }
    return false;
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      receivedBytes += value.byteLength;
      if (receivedBytes > limits.maxBytes) {
        throw new Error(`${limits.label} exceeded ${limits.maxBytes} bytes.`);
      }
      buffer += decoder.decode(value, { stream: true });
      boundary.lastIndex = scanFrom;
      let consumed = 0;
      let match: RegExpExecArray | null;
      while ((match = boundary.exec(buffer)) !== null) {
        const frame = buffer.slice(consumed, match.index);
        consumed = match.index + match[0].length;
        if (yield* emit(frame)) {
          return;
        }
      }
      if (consumed > 0) {
        buffer = buffer.slice(consumed);
      }
      scanFrom = Math.max(0, buffer.length - BOUNDARY_LOOKBACK);
    }
    completed = true;
    buffer += decoder.decode();
    if (buffer.trim()) {
      yield* emit(buffer);
    }
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}
