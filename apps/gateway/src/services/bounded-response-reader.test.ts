import { describe, expect, it } from "vitest";
import { readBoundedResponseText } from "./bounded-response-reader.js";

describe("readBoundedResponseText", () => {
  it("rejects responses whose content-length exceeds the configured limit", async () => {
    await expect(
      readBoundedResponseText(
        new Response("{}", {
          headers: { "content-length": "1024" },
        }),
        { maxBytes: 8, timeoutMs: 1000, label: "provider" },
      ),
    ).rejects.toThrow("provider response body exceeded 8 bytes");
  });

  it("cancels streaming bodies once the configured byte limit is crossed", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("abcd"));
        controller.enqueue(new TextEncoder().encode("efgh"));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(
      readBoundedResponseText(new Response(stream), { maxBytes: 6, timeoutMs: 1000, label: "connector" }),
    ).rejects.toThrow("connector response body exceeded 6 bytes");
    expect(cancelled).toBe(true);
  });

  it("decodes bounded streaming text successfully", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello "));
        controller.enqueue(new TextEncoder().encode("world"));
        controller.close();
      },
    });

    await expect(
      readBoundedResponseText(new Response(stream), { maxBytes: 64, timeoutMs: 1000, label: "artifact" }),
    ).resolves.toBe("hello world");
  });
});
