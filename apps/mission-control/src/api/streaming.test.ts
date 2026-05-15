import { describe, expect, it, vi } from "vitest";

import { consumeSseResponse, iterateSsePayloads, parseSseJson } from "./streaming";

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function collectPayloads(body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<string[]> {
  const payloads: string[] = [];
  for await (const payload of iterateSsePayloads(body, signal)) {
    payloads.push(payload);
  }
  return payloads;
}

describe("streaming SSE helpers", () => {
  it("parses data events, skips non-data frames, and reports default stream errors", async () => {
    const chunks: unknown[] = [];

    await expect(
      consumeSseResponse(
        sseStream(["event: ping\n\n", 'data: {"type":"delta","text":"hello"}\n\n', 'data: {"type":"error"}\n\n']),
        (chunk) => chunks.push(chunk),
      ),
    ).rejects.toThrow("Streaming request failed.");

    expect(chunks).toEqual([{ type: "delta", text: "hello" }, { type: "error" }]);
  });

  it("surfaces malformed, incomplete, and overlarge SSE payloads with bounded previews", async () => {
    expect(() => parseSseJson("   ")).toThrow("Malformed SSE event payload: (empty)");

    await expect(collectPayloads(sseStream(["data: ", "x".repeat(400), "\n"]))).rejects.toThrow(
      /SSE stream ended with incomplete event data: data: x+\.\.\./,
    );

    await expect(collectPayloads(sseStream(["data: ", "x".repeat(1_000_000)]))).rejects.toThrow(
      "Streaming response exceeded the SSE buffer limit before a complete event was received.",
    );
  });

  it("treats aborts as silent stream completion in DOM and fallback error runtimes", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(collectPayloads(sseStream(['data: {"type":"delta"}\n\n']), controller.signal)).resolves.toEqual([]);

    const originalDomException = globalThis.DOMException;
    vi.stubGlobal("DOMException", undefined);
    const fallbackController = new AbortController();
    fallbackController.abort();

    await expect(
      collectPayloads(sseStream(['data: {"type":"delta"}\n\n']), fallbackController.signal),
    ).resolves.toEqual([]);

    vi.stubGlobal("DOMException", originalDomException);
  });
});
