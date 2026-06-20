export interface BoundedResponseReadOptions {
  maxBytes: number;
  timeoutMs: number;
  label?: string;
}

export async function readBoundedResponseText(
  response: Response,
  options: BoundedResponseReadOptions,
): Promise<string> {
  assertResponseBodyWithinLimit(response, options);
  if (!response.body) {
    const body = await withTimeout(response.text(), options);
    if (Buffer.byteLength(body, "utf8") > options.maxBytes) {
      throw createBodyLimitError(options);
    }
    return body;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const deadlineMs = Date.now() + options.timeoutMs;
  let receivedBytes = 0;
  let body = "";
  try {
    while (true) {
      const chunk = await readBodyChunkWithDeadline(reader, deadlineMs, options);
      if (chunk.done) {
        body += decoder.decode();
        return body;
      }
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > options.maxBytes) {
        await cancelBodyReader(reader);
        throw createBodyLimitError(options);
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function assertResponseBodyWithinLimit(response: Response, options: BoundedResponseReadOptions): void {
  const contentLength = response.headers.get("content-length");
  if (!contentLength) {
    return;
  }
  const parsed = Number(contentLength);
  if (Number.isFinite(parsed) && parsed > options.maxBytes) {
    throw createBodyLimitError(options);
  }
}

async function readBodyChunkWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadlineMs: number,
  options: BoundedResponseReadOptions,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    await cancelBodyReader(reader);
    throw createBodyTimeoutError(options);
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
        timer = setTimeout(() => {
          void cancelBodyReader(reader);
          reject(createBodyTimeoutError(options));
        }, remainingMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, options: BoundedResponseReadOptions): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(createBodyTimeoutError(options)), options.timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function cancelBodyReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Best-effort cleanup only; the caller already has a terminal read outcome.
  }
}

function createBodyLimitError(options: BoundedResponseReadOptions): Error {
  return new Error(`${formatLabel(options)} response body exceeded ${options.maxBytes} bytes.`);
}

function createBodyTimeoutError(options: BoundedResponseReadOptions): Error {
  return new Error(`Timed out reading ${formatLabel(options)} response body.`);
}

function formatLabel(options: BoundedResponseReadOptions): string {
  return options.label?.trim() || "HTTP";
}
