// The parent supplies only public certificate/key/authority values to this process.
import { connect, createSecureContext } from "node:tls";
process.once("message", async (input) => {
  let socket;
  let done = false;
  const finish = (result) => {
    if (done) return;
    done = true;
    clearTimeout(timeout);
    socket?.destroy();
    process.send(result, () => process.disconnect());
  };
  const timeout = setTimeout(() => finish({ ok: false, phase: "watchdog" }), 9000);
  try {
    const context = createSecureContext({
      ca: input.ca,
      cert: input.cert,
      privateKeyEngine: input.engine,
      privateKeyIdentifier: input.identifier,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      ciphers: input.cipher,
    });
    process.send({ ready: true });
    if (input.wire) {
      const { WorkerWireClient } = await import("../../remote-worker/dist/worker-wire-client.js");
      const client = new WorkerWireClient({
        host: "127.0.0.1",
        port: input.port,
        clientTlsContext: context,
        clientCertificatePem: input.cert,
        trustAnchorPem: input.ca,
      });
      const response = await client.post({
        rawPath: "/fixture",
        operation: "fixture",
        authorization: "fixture",
        idempotencyKey: "fixture",
        buildBody: async ({ tlsExporterSha256 }) => ({ tlsExporterSha256 }),
        sign: async () => "fixture-proof",
      });
      finish({ ok: response.status === 200 && response.body.ok === true, phase: "completed", wire: true });
      return;
    }
    socket = connect({
      host: "127.0.0.1",
      port: input.port,
      servername: "localhost",
      secureContext: context,
      rejectUnauthorized: true,
    });
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.on("error", (error) => finish({ ok: false, phase: "handshake", code: error.code }));
    socket.on("end", () =>
      finish({ ok: socket.authorized && data === "accepted", phase: "completed", cipher: socket.getCipher()?.name }),
    );
  } catch (error) {
    finish({ ok: false, phase: "context", code: error.code });
  }
});
