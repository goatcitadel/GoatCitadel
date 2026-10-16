const DEFAULT_MAX_LINE_BYTES = 256 * 1024;

export interface StreamReadOptions {
  maxLineBytes?: number;
  signal?: AbortSignal;
  /**
   * Called for every chunk read from the body, including SSE comment keepalives and
   * blank lines that never surface as a line or event. Stream adapters use it as a liveness touch.
   */
  onActivity?: () => void;
}

export interface ServerSentEvent {
  event?: string;
  data: string;
  id?: string;
}

/**
 * Splits a byte stream into UTF-8 lines (LF or CRLF terminated). The final
 * unterminated line is flushed at end of stream. Throws if a single line grows
 * beyond maxLineBytes so a misbehaving server cannot exhaust memory.
 */
export async function* readStreamLines(
  body: ReadableStream<Uint8Array>,
  options: StreamReadOptions = {},
): AsyncGenerator<string> {
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const signal = options.signal;
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal?.aborted) {
    onAbort();
    throw abortError();
  }
  signal?.addEventListener("abort", onAbort, { once: true });
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal?.aborted) {
        throw abortError();
      }
      if (done) {
        pending += decoder.decode();
        break;
      }
      options.onActivity?.();
      pending += decoder.decode(value, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        assertLineWithinLimit(line, maxLineBytes);
        yield line.endsWith("\r") ? line.slice(0, -1) : line;
        newline = pending.indexOf("\n");
      }
      assertLineWithinLimit(pending, maxLineBytes);
    }
    if (pending.length > 0) {
      assertLineWithinLimit(pending, maxLineBytes);
      yield pending.endsWith("\r") ? pending.slice(0, -1) : pending;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Groups SSE lines into events; comment lines and data-less events are dropped. */
export async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  options: StreamReadOptions = {},
): AsyncGenerator<ServerSentEvent> {
  let eventName: string | undefined;
  let id: string | undefined;
  let data: string[] = [];
  for await (const line of readStreamLines(body, options)) {
    if (line === "") {
      if (data.length > 0) {
        yield {
          ...(eventName !== undefined ? { event: eventName } : {}),
          data: data.join("\n"),
          ...(id !== undefined ? { id } : {}),
        };
      }
      eventName = undefined;
      id = undefined;
      data = [];
      continue;
    }
    if (line.startsWith(":")) {
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "data") {
      data.push(value);
    } else if (field === "event") {
      eventName = value;
    } else if (field === "id") {
      id = value;
    }
  }
}

function assertLineWithinLimit(line: string, maxLineBytes: number): void {
  // UTF-8 never needs more than 3 bytes per UTF-16 unit, so only measure when it could matter.
  if (line.length * 3 > maxLineBytes && new TextEncoder().encode(line).byteLength > maxLineBytes) {
    throw new Error(`Stream line exceeds the ${maxLineBytes}-byte limit.`);
  }
}

function abortError(): Error {
  const error = new Error("Stream read aborted.");
  error.name = "AbortError";
  return error;
}
