import { describe, expect, it } from "vitest";
import { readServerSentEvents, readStreamLines } from "./stream-line-reader.js";

function streamOf(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("readStreamLines", () => {
  it("splits lines that span chunks and flushes the unterminated tail", async () => {
    const lines = await collect(readStreamLines(streamOf(["alp", "ha\nbe", "ta\ngam", "ma"])));
    expect(lines).toEqual(["alpha", "beta", "gamma"]);
  });

  it("decodes a multi-byte character split across chunks", async () => {
    const bytes = new TextEncoder().encode("café ☃\n");
    const split = bytes.indexOf(0xc3) + 1;
    const lines = await collect(readStreamLines(streamOf([bytes.slice(0, split), bytes.slice(split)])));
    expect(lines).toEqual(["café ☃"]);
  });

  it("handles CRLF terminators", async () => {
    const lines = await collect(readStreamLines(streamOf(["one\r\ntwo\r", "\nthree\r\n"])));
    expect(lines).toEqual(["one", "two", "three"]);
  });

  it("throws when a single line exceeds maxLineBytes", async () => {
    await expect(
      collect(readStreamLines(streamOf(["x".repeat(40), "y".repeat(40)]), { maxLineBytes: 64 })),
    ).rejects.toThrow(/exceeds/i);
  });

  it("stops when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(collect(readStreamLines(streamOf(["a\n"]), { signal: controller.signal }))).rejects.toThrow();
  });
});

describe("readServerSentEvents", () => {
  it("joins data lines, captures event/id, ignores comments and terminates on a blank line", async () => {
    const events = await collect(
      readServerSentEvents(
        streamOf([": keepalive\n", "event: message\nid: 7\ndata: first\ndata: second\n\n", 'data: {"a":1}\n\n']),
      ),
    );
    expect(events).toEqual([{ event: "message", id: "7", data: "first\nsecond" }, { data: '{"a":1}' }]);
  });

  it("does not emit events without data and strips only one leading space", async () => {
    const events = await collect(
      readServerSentEvents(streamOf(["event: open\n\n", "data:  two spaces\n\n", "data:nospace\n\n"])),
    );
    expect(events).toEqual([{ data: " two spaces" }, { data: "nospace" }]);
  });

  it("reports activity for comment-only keepalive chunks that never surface as events", async () => {
    let activity = 0;
    const events = await collect(
      readServerSentEvents(streamOf([":\n", ":\n", "data: x\n\n"]), { onActivity: () => (activity += 1) }),
    );
    expect(events).toEqual([{ data: "x" }]);
    expect(activity).toBe(3);
  });
});
