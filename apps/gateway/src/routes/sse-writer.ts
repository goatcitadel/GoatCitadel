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
  if (options.eventName) {
    const wroteEvent = await writeSseChunk(raw, `event: ${options.eventName}\n`, options.signal);
    if (!wroteEvent) {
      return false;
    }
  }
  if (options.eventId !== undefined) {
    const wroteId = await writeSseChunk(raw, `id: ${options.eventId}\n`, options.signal);
    if (!wroteId) {
      return false;
    }
  }
  return writeSseChunk(raw, `data: ${JSON.stringify(payload)}\n\n`, options.signal);
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
