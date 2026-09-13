import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  WORKER_WIRE_MAX_RESPONSE_BYTES,
  WorkerWireClient,
  WorkerWireClientError,
  __internal,
} from "./worker-wire-client.js";

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

describe("worker request cancellation", () => {
  it("rejects every route after process shutdown even without a request-local signal", async () => {
    const client = new WorkerWireClient(
      {
        host: "127.0.0.1",
        port: 1,
        clientCertificatePem: "",
        clientPrivateKeyPem: "",
        trustAnchorPem: "",
      },
      AbortSignal.abort(),
    );
    const sign = vi.fn();
    await expect(
      client.post({
        rawPath: "/test",
        operation: "test",
        authorization: "fixture",
        idempotencyKey: "fixture",
        buildBody: () => ({}),
        sign,
      }),
    ).rejects.toThrow("before dispatch");
    expect(sign).not.toHaveBeenCalled();
  });
  it("does not open or sign a pre-cancelled request", async () => {
    const client = new WorkerWireClient({
      host: "127.0.0.1",
      port: 1,
      clientCertificatePem: "",
      clientPrivateKeyPem: "",
      trustAnchorPem: "",
    });
    const buildBody = vi.fn();
    const sign = vi.fn();
    await expect(
      client.post({
        rawPath: "/test",
        operation: "test",
        authorization: "fixture",
        idempotencyKey: "fixture",
        buildBody,
        sign,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow("before dispatch");
    expect(buildBody).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });

  it("closes its owned socket when cancelled during a stalled TLS handshake", async () => {
    let accepted: (() => void) | undefined;
    const connected = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const server = createServer((socket) => {
      socket.on("error", () => {});
      socket.resume();
      accepted?.();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test listener");
    const client = new WorkerWireClient({
      host: "127.0.0.1",
      port: address.port,
      clientCertificatePem: "",
      clientPrivateKeyPem: "",
      trustAnchorPem: "",
    });
    const controller = new AbortController();
    const request = client.post({
      rawPath: "/test",
      operation: "test",
      authorization: "fixture",
      idempotencyKey: "fixture",
      buildBody: () => ({}),
      sign: () => "fixture",
      signal: controller.signal,
    });
    const rejected = expect(request).rejects.toThrow("cancelled");
    try {
      await connected;
      controller.abort();
      await rejected;
    } finally {
      controller.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
