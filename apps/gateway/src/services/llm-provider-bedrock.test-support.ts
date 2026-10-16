import { EventStreamCodec } from "@smithy/eventstream-codec";

const streamCodec = new EventStreamCodec(
  (bytes) => new TextDecoder().decode(bytes),
  (text) => new TextEncoder().encode(text),
);

export function bedrockEventFrame(eventType: string, payload: unknown, messageType = "event"): Uint8Array {
  return streamCodec.encode({
    headers: {
      ":event-type": { type: "string", value: eventType },
      ":message-type": { type: "string", value: messageType },
      ":content-type": { type: "string", value: "application/json" },
      ...(messageType === "exception" ? { ":exception-type": { type: "string", value: eventType } } : {}),
    },
    body: new TextEncoder().encode(JSON.stringify(payload)),
  });
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function streamOf(bytes: Uint8Array, splitEvery: number): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += splitEvery) {
        controller.enqueue(bytes.slice(offset, offset + splitEvery));
      }
      controller.close();
    },
  });
}

export function bedrockEventStreamResponse(bytes: Uint8Array, splitEvery = 100000): Response {
  return new Response(streamOf(bytes, splitEvery), {
    status: 200,
    headers: { "content-type": "application/vnd.amazon.eventstream" },
  });
}
