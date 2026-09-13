import { createHash } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createServer, type TLSSocket } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerWireClient, WORKER_WIRE_ABSOLUTE_TIMEOUT_MS, type WorkerWireRequest } from "./worker-wire-client.js";
import {
  CA_PEM,
  CLIENT_CERT_PEM,
  CLIENT_KEY_PEM,
  SERVER_CERT_PEM,
  SERVER_KEY_PEM,
} from "./worker-wire-client-tls.test-fixture.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function fixture() {
  const sockets = new Set<TLSSocket>();
  const received: { head: string; body: string }[] = [];
  const server = createServer(
    {
      key: SERVER_KEY_PEM,
      cert: SERVER_CERT_PEM,
      ca: CA_PEM,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
    },
    (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => socket.destroy());
      let request = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        request = Buffer.concat([request, chunk]);
        const split = request.indexOf("\r\n\r\n");
        if (split < 0) return;
        const head = request.subarray(0, split).toString("ascii");
        const length = Number(/Content-Length: (\d+)/u.exec(head)?.[1]);
        if (request.byteLength < split + 4 + length) return;
        received.push({ head, body: request.subarray(split + 4).toString("utf8") });
        socket.end(
          'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{"ok":true}',
        );
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TLS listener");
  const controller = new AbortController();
  const client = new WorkerWireClient(
    {
      host: "127.0.0.1",
      port: address.port,
      clientCertificatePem: CLIENT_CERT_PEM,
      clientPrivateKeyPem: CLIENT_KEY_PEM,
      trustAnchorPem: CA_PEM,
    },
    controller.signal,
  );
  return {
    client,
    controller,
    received,
    async close() {
      controller.abort();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function request(overrides: Partial<WorkerWireRequest> = {}): WorkerWireRequest {
  return {
    rawPath: "/test",
    operation: "test",
    authorization: "fixture",
    idempotencyKey: "fixture",
    buildBody: () => ({ task: "original" }),
    sign: () => "fixture-proof",
    ...overrides,
  };
}

afterEach(() => vi.useRealTimers());

describe("worker asynchronous signing over real mTLS", () => {
  it("awaits channel-bound evidence and its exact signature before sending any HTTP bytes", async () => {
    const f = await fixture();
    const building = deferred<void>();
    const body = deferred<Readonly<Record<string, unknown>>>();
    const signing = deferred<void>();
    const signature = deferred<string>();
    const signer = vi.fn((material) => {
      expect(material.bodySha256).toBe(createHash("sha256").update('{"task":"original"}').digest("hex"));
      expect(material.tlsExporterSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(material.signal.aborted).toBe(false);
      signing.resolve();
      return signature.promise;
    });
    const outcome = f.client.post(
      request({
        buildBody: () => {
          building.resolve();
          return body.promise;
        },
        sign: signer,
      }),
    );
    try {
      await building.promise;
      expect(signer).not.toHaveBeenCalled();
      expect(f.received).toEqual([]);
      body.resolve({ task: "original" });
      await signing.promise;
      expect(f.received).toEqual([]);
      signature.resolve("asynchronous-proof");
      await expect(outcome).resolves.toEqual({ status: 200, body: { ok: true } });
      expect(f.received).toEqual([
        {
          head: expect.stringContaining("x-goatcitadel-worker-proof: asynchronous-proof"),
          body: '{"task":"original"}',
        },
      ]);
    } finally {
      body.resolve({ task: "original" });
      signature.resolve("cleanup");
      await f.close();
      await outcome.catch(() => undefined);
    }
  });

  it("snapshots request authority and headers before awaiting a signature", async () => {
    const f = await fixture();
    const signing = deferred<void>();
    const signature = deferred<string>();
    const headers = { "x-fixture-authority": "original" };
    const call = {
      ...request(),
      extraHeaders: headers,
      sign: () => {
        signing.resolve();
        return signature.promise;
      },
    };
    const outcome = f.client.post(call);
    try {
      await signing.promise;
      call.rawPath = "/changed";
      call.authorization = "changed";
      call.idempotencyKey = "changed";
      headers["x-fixture-authority"] = "changed";
      signature.resolve("original-proof");
      await outcome;
      expect(f.received[0]?.head).toContain("POST /test HTTP/1.1");
      expect(f.received[0]?.head).toContain("authorization: fixture");
      expect(f.received[0]?.head).toContain("idempotency-key: fixture");
      expect(f.received[0]?.head).toContain("x-fixture-authority: original");
      expect(f.received[0]?.head).not.toContain("changed");
    } finally {
      signature.resolve("cleanup");
      await f.close();
      await outcome.catch(() => undefined);
    }
  });

  it("does not invoke the signer if shutdown happens while evidence is being prepared", async () => {
    const f = await fixture();
    const building = deferred<AbortSignal>();
    const body = deferred<Readonly<Record<string, unknown>>>();
    const sign = vi.fn(() => "late-proof");
    const outcome = f.client.post(
      request({
        buildBody: (channel) => {
          building.resolve(channel.signal);
          return body.promise;
        },
        sign,
      }),
    );
    const rejected = expect(outcome).rejects.toThrow("cancelled");
    try {
      const signal = await building.promise;
      f.controller.abort();
      await rejected;
      expect(signal.aborted).toBe(true);
      body.resolve({ late: true });
      await nextTurn();
      expect(sign).not.toHaveBeenCalled();
      expect(f.received).toEqual([]);
    } finally {
      body.resolve({});
      await f.close();
    }
  });

  it("aborts an outstanding signer and consumes a late rejection without sending", async () => {
    const f = await fixture();
    const signing = deferred<AbortSignal>();
    const signature = deferred<string>();
    const outcome = f.client.post(
      request({
        sign: (material) => {
          signing.resolve(material.signal);
          return signature.promise;
        },
      }),
    );
    const rejected = expect(outcome).rejects.toThrow("cancelled");
    try {
      const signal = await signing.promise;
      f.controller.abort();
      await rejected;
      expect(signal.aborted).toBe(true);
      signature.reject(new Error("Signer stopped after cancellation"));
      await nextTurn();
      expect(f.received).toEqual([]);
    } finally {
      signature.resolve("cleanup");
      await f.close();
    }
  });

  it("retains the absolute deadline while the native signer is pending", async () => {
    const f = await fixture();
    const signing = deferred<AbortSignal>();
    const signature = deferred<string>();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const outcome = f.client.post(
      request({
        sign: (material) => {
          signing.resolve(material.signal);
          return signature.promise;
        },
      }),
    );
    const rejected = expect(outcome).rejects.toThrow("deadline");
    try {
      const signal = await signing.promise;
      await vi.advanceTimersByTimeAsync(WORKER_WIRE_ABSOLUTE_TIMEOUT_MS + 1);
      await rejected;
      expect(signal.aborted).toBe(true);
      signature.resolve("too-late");
      await nextTurn();
      expect(f.received).toEqual([]);
    } finally {
      vi.useRealTimers();
      signature.resolve("cleanup");
      await f.close();
    }
  });

  it("rejects signing failures before sending the request", async () => {
    const f = await fixture();
    try {
      await expect(
        f.client.post(
          request({
            sign: async () => {
              throw new Error("Protected key was revoked");
            },
          }),
        ),
      ).rejects.toThrow("revoked");
      expect(f.received).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("keeps concurrent signatures bound to their original TLS connections", async () => {
    const f = await fixture();
    const first = deferred<string>();
    const second = deferred<string>();
    const readyA = deferred<string>();
    const readyB = deferred<string>();
    const a = f.client.post(
      request({
        idempotencyKey: "first",
        buildBody: () => ({ task: "first" }),
        sign: (material) => {
          readyA.resolve(material.tlsExporterSha256);
          return first.promise;
        },
      }),
    );
    const b = f.client.post(
      request({
        idempotencyKey: "second",
        buildBody: () => ({ task: "second" }),
        sign: (material) => {
          readyB.resolve(material.tlsExporterSha256);
          return second.promise;
        },
      }),
    );
    try {
      const [exporterA, exporterB] = await Promise.all([readyA.promise, readyB.promise]);
      expect(exporterA).not.toBe(exporterB);
      second.resolve("second-proof");
      await b;
      first.resolve("first-proof");
      await a;
      expect(f.received.map((row) => row.body)).toEqual(['{"task":"second"}', '{"task":"first"}']);
      expect(f.received[0]?.head).toContain("x-goatcitadel-worker-proof: second-proof");
      expect(f.received[1]?.head).toContain("x-goatcitadel-worker-proof: first-proof");
    } finally {
      first.resolve("cleanup");
      second.resolve("cleanup");
      await f.close();
      await Promise.allSettled([a, b]);
    }
  });
});
