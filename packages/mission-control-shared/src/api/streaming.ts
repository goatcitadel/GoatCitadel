import type { ChatStreamChunk } from "@goatcitadel/contracts";

import { MAX_SSE_BUFFER_CHARS, MAX_SSE_EVENT_PREVIEW_CHARS } from "./http-internal";

export async function consumeSseResponse(
  body: ReadableStream<Uint8Array>,
  onChunk: (chunk: ChatStreamChunk) => void,
  signal?: AbortSignal,
): Promise<void> {
  let streamError: string | null = null;
  for await (const dataText of iterateSsePayloads(body, signal)) {
    const parsed = parseSseJson<ChatStreamChunk>(dataText);
    onChunk(parsed);
    if (parsed.type === "error") {
      streamError = parsed.error || "Streaming request failed.";
    }
  }
  if (streamError) {
    throw new Error(streamError);
  }
}

export async function* iterateSsePayloads(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) {
        throw createAbortError();
      }
      const { value, done } = await reader.read();
      if (done) {
        buffer = appendSseBuffer(buffer, decoder.decode());
        break;
      }
      buffer = appendSseBuffer(buffer, decoder.decode(value, { stream: true }));
      while (true) {
        const separatorIndex = buffer.indexOf("\n\n");
        if (separatorIndex < 0) {
          break;
        }
        const rawEvent = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const dataText = extractSseDataText(rawEvent);
        if (dataText) {
          yield dataText;
        }
      }
    }
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (buffer.trim()) {
    throw new Error(`SSE stream ended with incomplete event data: ${previewSseText(buffer)}`);
  }
}

export function parseSseJson<T>(dataText: string): T {
  try {
    return JSON.parse(dataText) as T;
  } catch {
    throw new Error(`Malformed SSE event payload: ${previewSseText(dataText)}`);
  }
}

function appendSseBuffer(buffer: string, chunk: string): string {
  if (!chunk) {
    return buffer;
  }
  const next = buffer + chunk;
  if (next.length > MAX_SSE_BUFFER_CHARS) {
    throw new Error("Streaming response exceeded the SSE buffer limit before a complete event was received.");
  }
  return next;
}

function extractSseDataText(rawEvent: string): string | null {
  const dataLines = rawEvent
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  if (dataLines.length === 0) {
    return null;
  }
  return dataLines.join("\n");
}

function previewSseText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "(empty)";
  }
  if (trimmed.length <= MAX_SSE_EVENT_PREVIEW_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_SSE_EVENT_PREVIEW_CHARS)}...`;
}

function createAbortError(): Error {
  try {
    return new DOMException("The operation was aborted.", "AbortError");
  } catch {
    const error = new Error("The operation was aborted.");
    error.name = "AbortError";
    return error;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : typeof error === "object" &&
        error !== null &&
        "name" in error &&
        (error as { name?: string }).name === "AbortError";
}
