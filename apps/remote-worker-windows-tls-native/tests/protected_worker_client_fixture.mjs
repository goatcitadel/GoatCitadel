// Test launcher: receives certificates and native key references, never signing-key bytes.
// The ordinary worker CLI does not load an arbitrary engine from JSON.
import { createRequire } from "node:module";
import { runWorkerProcess } from "../../remote-worker/dist/worker-process-runtime.js";
import { createWindowsProtectedWorkerTransport } from "../../remote-worker/dist/worker-windows-protected-transport.js";
const require = createRequire(import.meta.url);

const abort = new AbortController();
process.once("disconnect", () => abort.abort());
process.once("message", async (input) => {
  const timeout = setTimeout(() => abort.abort(), 15000);
  let result;
  try {
    if (JSON.stringify(input).includes("PRIVATE KEY") || Object.hasOwn(input.ticket, "protectedSignerPrivateKeyPem"))
      throw new Error("The protected worker fixture received private signing material.");
    const { transport, protectedKeys } = createWindowsProtectedWorkerTransport(
      {
        transport: { host: "127.0.0.1", port: input.port, clientCertificatePem: input.cert, trustAnchorPem: input.ca },
        tlsKeyIdentifier: input.identifier,
        admissionSignerSpkiBase64Url: input.ticket.protectedSignerPublicKeySpkiBase64Url,
      },
      require(input.guardAddon),
    );
    let report;
    await runWorkerProcess(
      {
        transport,
        ticket: input.ticket,
        stateDir: input.stateDir,
        reportFile: input.reportFile,
        runId: input.runId,
        stopAfter: input.stopAfter,
        runMode: "once",
      },
      {
        signal: abort.signal,
        protectedKeys,
        publishReport: async (value) => {
          report = value;
        },
      },
    );
    result = { ok: true, report };
  } catch (error) {
    result = { ok: false, error: String(error.message).slice(0, 1000) };
  } finally {
    clearTimeout(timeout);
    abort.abort();
  }
  process.send(result, () => process.disconnect());
});
