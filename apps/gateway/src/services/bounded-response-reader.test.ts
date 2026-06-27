import { describe, expect, it } from "vitest";
import {
  BoundedResponseReadError,
  readBoundedResponseBytes,
  readBoundedResponseJson,
  readBoundedResponseText,
} from "./bounded-response-reader.js";

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

  it("parses bounded JSON successfully", async () => {
    await expect(
      readBoundedResponseJson<{ ok: boolean }>(new Response(JSON.stringify({ ok: true })), {
        maxBytes: 64,
        timeoutMs: 1000,
        label: "oauth",
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects malformed JSON with a typed parse error", async () => {
    await expect(
      readBoundedResponseJson(new Response("{"), {
        maxBytes: 64,
        timeoutMs: 1000,
        label: "oauth",
      }),
    ).rejects.toMatchObject({
      name: "BoundedResponseReadError",
      code: "body_parse",
      label: "oauth",
    } satisfies Partial<BoundedResponseReadError>);
  });

  it("rejects empty JSON bodies with a typed missing-body error", async () => {
    await expect(
      readBoundedResponseJson(new Response(""), {
        maxBytes: 64,
        timeoutMs: 1000,
        label: "oauth",
      }),
    ).rejects.toMatchObject({
      name: "BoundedResponseReadError",
      code: "body_missing",
      label: "oauth",
    } satisfies Partial<BoundedResponseReadError>);
  });

  it("reads bounded streaming bytes successfully", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    });

    await expect(
      readBoundedResponseBytes(new Response(stream), { maxBytes: 3, timeoutMs: 1000, label: "download" }),
    ).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });
});
