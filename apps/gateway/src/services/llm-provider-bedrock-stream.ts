import { EventStreamCodec } from "@smithy/eventstream-codec";

const DEFAULT_MAX_BEDROCK_STREAM_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_BEDROCK_STREAM_EVENTS = 4096;
const PRELUDE_LENGTH_BYTES = 4;
const MIN_FRAME_BYTES = 16;

export interface BedrockStreamEvent {
  eventType: string;
  messageType: "event" | "exception" | "error";
  exceptionType?: string;
  payload: Record<string, unknown>;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const toUtf8 = (bytes: Uint8Array): string => textDecoder.decode(bytes);
const fromUtf8 = (text: string): Uint8Array => textEncoder.encode(text);
const codec = new EventStreamCodec(toUtf8, fromUtf8);

/**
 * Decodes the AWS binary event stream (`application/vnd.amazon.eventstream`)
 * into JSON events. Frames may arrive split at any byte; each complete frame
 * is CRC-checked by the codec before its headers and JSON body are read.
 */
export async function* decodeBedrockEventStream(
  body: ReadableStream<Uint8Array>,
  limits: { maxBytes?: number; maxEvents?: number } = {},
): AsyncGenerator<BedrockStreamEvent> {
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BEDROCK_STREAM_BYTES;
  const maxEvents = limits.maxEvents ?? DEFAULT_MAX_BEDROCK_STREAM_EVENTS;
  const reader = body.getReader();
  let buffer: Uint8Array = new Uint8Array(0);
  let receivedBytes = 0;
  let eventCount = 0;
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        throw new Error(`Bedrock event stream exceeded ${maxBytes} bytes.`);
      }
      buffer = appendBytes(buffer, value);
      while (buffer.byteLength >= PRELUDE_LENGTH_BYTES) {
        const totalLength = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(0, false);
        if (totalLength < MIN_FRAME_BYTES) {
          throw new Error("Bedrock event stream frame is malformed.");
        }
        if (buffer.byteLength < totalLength) break;
        const frameBytes = buffer.subarray(0, totalLength);
        buffer = buffer.subarray(totalLength);
        eventCount += 1;
        if (eventCount > maxEvents) {
          throw new Error(`Bedrock event stream exceeded ${maxEvents} events.`);
        }
        yield decodeBedrockFrame(frameBytes);
      }
    }
    finished = true;
    if (buffer.byteLength > 0) {
      throw new Error("Bedrock event stream ended mid-frame");
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function decodeBedrockFrame(frameBytes: Uint8Array): BedrockStreamEvent {
  const message = codec.decode(frameBytes);
  const header = (name: string): string | undefined => {
    const value = message.headers[name];
    return value?.type === "string" ? value.value : undefined;
  };
  const rawMessageType = header(":message-type");
  const messageType: BedrockStreamEvent["messageType"] =
    rawMessageType === "exception" || rawMessageType === "error" ? rawMessageType : "event";
  const exceptionType = header(":exception-type") ?? header(":error-code");
  const payload = parseFramePayload(message.body);
  const errorMessage = header(":error-message");
  return {
    eventType: header(":event-type") ?? exceptionType ?? "",
    messageType,
    ...(exceptionType ? { exceptionType } : {}),
    payload: errorMessage && payload.message === undefined ? { ...payload, message: errorMessage } : payload,
  };
}

function parseFramePayload(body: Uint8Array): Record<string, unknown> {
  if (body.byteLength === 0) return {};
  const text = textDecoder.decode(body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Bedrock event stream frame body is not valid JSON.");
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right;
  const merged = new Uint8Array(left.byteLength + right.byteLength);
  merged.set(left, 0);
  merged.set(right, left.byteLength);
  return merged;
}
