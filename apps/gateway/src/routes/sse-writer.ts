type SseWritable = {
  write(chunk: string): boolean;
  once(event: "drain" | "close" | "error", listener: (...args: unknown[]) => void): unknown;
  off?(event: "drain" | "close" | "error", listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: "drain" | "close" | "error", listener: (...args: unknown[]) => void): unknown;
  destroyed?: boolean;
  writableEnded?: boolean;
};

export interface WriteSsePayloadOptions {
  eventId?: string | number;
  eventName?: string;
  signal?: AbortSignal;
}

export async function writeSseChunk(raw: SseWritable, chunk: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted || raw.destroyed || raw.writableEnded) {
    return false;
  }
  const accepted = raw.write(chunk);
  if (accepted) {
    return true;
  }
  await waitForDrain(raw, signal);
  return !(signal?.aborted || raw.destroyed || raw.writableEnded);
}

export async function writeSsePayload(
  raw: SseWritable,
  payload: unknown,
  options: WriteSsePayloadOptions = {},
): Promise<boolean> {
  // One write per event: the event, id and data lines go out as a single chunk
  // so a busy stream does one socket write (and at most one drain) per event.
  const eventLine = options.eventName ? `event: ${options.eventName}\n` : "";
  const idLine = options.eventId !== undefined ? `id: ${options.eventId}\n` : "";
  return writeSseChunk(raw, `${eventLine}${idLine}data: ${JSON.stringify(payload)}\n\n`, options.signal);
}

function waitForDrain(raw: SseWritable, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("sse_write_aborted"));
  }
  return new Promise((resolve, reject) => {
    const detach = () => {
      raw.off?.("drain", onDrain);
      raw.off?.("close", onClose);
      raw.off?.("error", onError);
      raw.removeListener?.("drain", onDrain);
      raw.removeListener?.("close", onClose);
      raw.removeListener?.("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onDrain = () => {
      detach();
      resolve();
    };
    const onClose = () => {
      detach();
      resolve();
    };
    const onError = (error: unknown) => {
      detach();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onAbort = () => {
      detach();
      reject(signal?.reason instanceof Error ? signal.reason : new Error("sse_write_aborted"));
    };
    raw.once("drain", onDrain);
    raw.once("close", onClose);
    raw.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
