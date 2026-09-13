import { createSecureContext, createServer } from "node:tls";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { WorkerWireClient, type WorkerTransportMaterial } from "./worker-wire-client.js";
import {
  CA_PEM,
  CLIENT_CERT_PEM,
  CLIENT_KEY_PEM,
  SERVER_CERT_PEM,
  SERVER_KEY_PEM,
} from "./worker-wire-client-tls.test-fixture.js";

const publicMaterial = { host: "127.0.0.1", port: 1, clientCertificatePem: "", trustAnchorPem: "" };

describe("worker TLS key ownership", () => {
  it("rejects ambiguous key ownership before opening a connection", () => {
    expect(
      () =>
        new WorkerWireClient({
          ...publicMaterial,
          clientPrivateKeyPem: "fixture",
          clientTlsContext: createSecureContext(),
        } as unknown as WorkerTransportMaterial),
    ).toThrow("exactly one TLS key source");
  });
  it("rejects missing key ownership before opening a connection", () => {
    expect(() => new WorkerWireClient(publicMaterial as WorkerTransportMaterial)).toThrow("exactly one TLS key source");
  });
  it("rejects a context that negotiates TLS 1.2 before preparing or sending HTTP", async () => {
    let prepared = false;
    let received = 0;
    const server = createServer(
      {
        key: SERVER_KEY_PEM,
        cert: SERVER_CERT_PEM,
        ca: CA_PEM,
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        maxVersion: "TLSv1.2",
      },
      (socket) => {
        socket.on("data", (chunk) => {
          received += chunk.length;
          socket.destroy();
        });
        socket.on("error", () => {});
      },
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test listener");
    const client = new WorkerWireClient({
      host: "127.0.0.1",
      port: address.port,
      clientCertificatePem: CLIENT_CERT_PEM,
      trustAnchorPem: CA_PEM,
      clientTlsContext: createSecureContext({
        key: CLIENT_KEY_PEM,
        cert: CLIENT_CERT_PEM,
        ca: CA_PEM,
        minVersion: "TLSv1.2",
        maxVersion: "TLSv1.2",
      }),
    });
    try {
      await expect(
        client.post({
          rawPath: "/fixture",
          operation: "fixture",
          authorization: "fixture",
          idempotencyKey: "fixture",
          buildBody: () => {
            prepared = true;
            return {};
          },
          sign: () => "fixture",
        }),
      ).rejects.toThrow("TLS 1.3");
      expect(prepared).toBe(false);
      expect(received).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
