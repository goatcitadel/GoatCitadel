export interface BoundedResponseReadOptions {
  maxBytes: number;
  timeoutMs: number;
  label?: string;
}

export type BoundedResponseReadErrorCode =
  | "body_limit"
  | "body_timeout"
  | "body_parse"
  | "body_missing"
  | "body_incomplete"
  | "body_no_payload"
  | "body_event_limit";

export class BoundedResponseReadError extends Error {
  public constructor(
    public readonly code: BoundedResponseReadErrorCode,
    message: string,
    public readonly label: string,
  ) {
    super(message);
    this.name = "BoundedResponseReadError";
  }
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

export async function readBoundedResponseJson<T = unknown>(
  response: Response,
  options: BoundedResponseReadOptions,
): Promise<T> {
  const body = await readBoundedResponseText(response, options);
  if (!body.trim()) {
    throw createBodyMissingError(options);
  }
  try {
    return JSON.parse(body) as T;
  } catch (error) {
    throw createBodyParseError(options, error);
  }
}

export async function readBoundedResponseBytes(
  response: Response,
  options: BoundedResponseReadOptions,
): Promise<Uint8Array> {
  assertResponseBodyWithinLimit(response, options);
  if (!response.body) {
    const body = await withTimeout(response.arrayBuffer(), options);
    if (body.byteLength > options.maxBytes) {
      throw createBodyLimitError(options);
    }
    return new Uint8Array(body);
  }

  const reader = response.body.getReader();
  const deadlineMs = Date.now() + options.timeoutMs;
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const chunk = await readBodyChunkWithDeadline(reader, deadlineMs, options);
      if (chunk.done) {
        return concatChunks(chunks, receivedBytes);
      }
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > options.maxBytes) {
        await cancelBodyReader(reader);
        throw createBodyLimitError(options);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
}

function assertResponseBodyWithinLimit(response: Response, options: BoundedResponseReadOptions): void {
  const contentLength = response.headers?.get?.("content-length");
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
    void cancelBodyReader(reader).catch(() => undefined);
    throw createBodyTimeoutError(options);
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
        timer = setTimeout(() => {
          reject(createBodyTimeoutError(options));
          void cancelBodyReader(reader).catch(() => undefined);
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

function concatChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function cancelBodyReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Best-effort cleanup only; the caller already has a terminal read outcome.
  }
}

function createBodyLimitError(options: BoundedResponseReadOptions): Error {
  const label = formatLabel(options);
  return new BoundedResponseReadError(
    "body_limit",
    `${label} response body exceeded ${options.maxBytes} bytes.`,
    label,
  );
}

function createBodyTimeoutError(options: BoundedResponseReadOptions): Error {
  const label = formatLabel(options);
  return new BoundedResponseReadError("body_timeout", `Timed out reading ${label} response body.`, label);
}

function createBodyParseError(options: BoundedResponseReadOptions, cause: unknown): Error {
  const label = formatLabel(options);
  const reason = cause instanceof Error ? cause.message : "parse failed";
  return new BoundedResponseReadError("body_parse", `${label} response body was not valid JSON: ${reason}`, label);
}

function createBodyMissingError(options: BoundedResponseReadOptions): Error {
  const label = formatLabel(options);
  return new BoundedResponseReadError("body_missing", `${label} response body was empty.`, label);
}

function formatLabel(options: BoundedResponseReadOptions): string {
  return options.label?.trim() || "HTTP";
}
