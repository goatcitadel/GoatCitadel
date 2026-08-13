import { describe, expect, it } from "vitest";
import { WORKER_WIRE_MAX_RESPONSE_BYTES, WorkerWireClientError, __internal } from "./worker-wire-client.js";

describe("worker wire response bounds", () => {
  it("accepts a response exactly at the configured byte ceiling", () => {
    const chunks: Buffer[] = [];
    const bytes = __internal.appendBoundedResponseChunk(chunks, Buffer.alloc(WORKER_WIRE_MAX_RESPONSE_BYTES), 0);

    expect(bytes).toBe(WORKER_WIRE_MAX_RESPONSE_BYTES);
    expect(chunks).toHaveLength(1);
  });

  it("rejects a response before retaining bytes above the configured ceiling", () => {
    const chunks: Buffer[] = [Buffer.from("kept")];

    expect(() =>
      __internal.appendBoundedResponseChunk(chunks, Buffer.alloc(2), WORKER_WIRE_MAX_RESPONSE_BYTES - 1),
    ).toThrow(WorkerWireClientError);
    expect(chunks).toHaveLength(1);
  });

  it("parses a bounded HTTP JSON response", () => {
    const response = Buffer.from(
      'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{"ok":true}',
      "utf8",
    );

    expect(__internal.parseHttpResponse(response)).toEqual({ status: 200, body: { ok: true } });
  });
});
