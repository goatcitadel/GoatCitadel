import { describe, expect, it } from "vitest";
import { streamSsePayloads } from "./provider-sse-frames.js";

const limits = { maxBytes: 1_000_000, maxEvents: 100, label: "test stream" };

function makeBody(
  chunks: string[],
  closeWhenDrained = false,
): { body: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  const encoder = new TextEncoder();
  let cancelled = false;
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index++]));
      } else {
        // stay open like a live provider connection; only completion-by-reader should end it
        if (closeWhenDrained) controller.close();
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, cancelled: () => cancelled };
}

async function collect(body: ReadableStream<Uint8Array>, l = limits): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for await (const event of streamSsePayloads(body, l)) out.push(event);
  return out;
}

describe("streamSsePayloads", () => {
  it("reassembles frames split across chunks, including mid-delimiter", async () => {
    const { body, cancelled } = makeBody(['data: {"a":', "1}\n", '\ndata: {"b":2}\r', "\n\r", '\ndata: {"c":3}'], true);
    expect(await collect(body)).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    expect(cancelled()).toBe(false);
  });

  it("handles CRLF frame boundaries", async () => {
    const { body } = makeBody(['data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n'], true);
    expect(await collect(body)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("cancels the body when the consumer returns early", async () => {
    const { body, cancelled } = makeBody(['data: {"a":1}\n\n', 'data: {"b":2}\n\n']);
    for await (const event of streamSsePayloads(body, limits)) {
      expect(event).toEqual({ a: 1 });
      break;
    }
    expect(cancelled()).toBe(true);
  });

  it("cancels on [DONE] and reports onDone", async () => {
    let done = false;
    const { body, cancelled } = makeBody(['data: {"a":1}\n\ndata: [DONE]\n\n', 'data: {"b":2}\n\n']);
    const events = await collect(body, { ...limits, onDone: () => (done = true) });
    expect(events).toEqual([{ a: 1 }]);
    expect(done).toBe(true);
    expect(cancelled()).toBe(true);
  });

  it("enforces event and byte limits and cancels", async () => {
    const events = makeBody(['data: {"a":1}\n\ndata: {"b":2}\n\n']);
    await expect(collect(events.body, { ...limits, maxEvents: 1 })).rejects.toThrow("test stream exceeded 1 events.");
    expect(events.cancelled()).toBe(true);
    const bytes = makeBody(['data: {"a":1}\n\n']);
    await expect(collect(bytes.body, { ...limits, maxBytes: 4 })).rejects.toThrow("test stream exceeded 4 bytes.");
    expect(bytes.cancelled()).toBe(true);
  });

  it("cancels when the consumer throws", async () => {
    const { body, cancelled } = makeBody(['data: {"a":1}\n\n', 'data: {"b":2}\n\n']);
    await expect(
      (async () => {
        for await (const _event of streamSsePayloads(body, limits)) {
          throw new Error("consumer failed");
        }
      })(),
    ).rejects.toThrow("consumer failed");
    expect(cancelled()).toBe(true);
  });
});
