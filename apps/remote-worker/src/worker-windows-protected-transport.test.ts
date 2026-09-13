import { X509Certificate, generateKeyPairSync } from "node:crypto";
import { encodeWindowsTlsKeyIdentifier } from "@goatcitadel/remote-worker-provisioner/windows-tls-key-identifier";
import { describe, expect, it, vi } from "vitest";
import { CA_PEM, CLIENT_CERT_PEM, CLIENT_KEY_PEM } from "./worker-wire-client-tls.test-fixture.js";
import { createWindowsProtectedWorkerTransport } from "./worker-windows-protected-transport.js";

function fixture() {
  const publicKey = new X509Certificate(CLIENT_CERT_PEM).publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64url");
  return {
    transport: { host: "127.0.0.1", port: 9443, clientCertificatePem: CLIENT_CERT_PEM, trustAnchorPem: CA_PEM },
    tlsKeyIdentifier: encodeWindowsTlsKeyIdentifier({
      keysetGeneration: 1,
      stateSha256: "11".repeat(32),
      keysetReceiptSha256: "22".repeat(32),
      workerPublicKeySpkiBase64Url: publicKey,
      helperExecutablePath: "C:\\GoatFixture\\client.exe",
      helperExecutableSha256: "33".repeat(32),
    }),
    admissionSignerSpkiBase64Url: publicKey,
  };
}

describe.runIf(process.platform === "win32")("protected Windows transport loading", () => {
  it("rejects private key inputs before consulting the native guard", () => {
    const guard = { pin: vi.fn() };
    const input = fixture();
    const ambiguous = { ...input, transport: { ...input.transport, clientPrivateKeyPem: CLIENT_KEY_PEM } };
    expect(() => createWindowsProtectedWorkerTransport(ambiguous, guard)).toThrow("private key");
    expect(guard.pin).not.toHaveBeenCalled();
  });
  it("rejects a key reference that differs from its TLS certificate before loading native code", () => {
    const guard = { pin: vi.fn() };
    const input = fixture();
    const otherPublicKey = generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "der" })
      .toString("base64url");
    input.tlsKeyIdentifier = encodeWindowsTlsKeyIdentifier({
      keysetGeneration: 1,
      stateSha256: "11".repeat(32),
      keysetReceiptSha256: "22".repeat(32),
      workerPublicKeySpkiBase64Url: otherPublicKey,
      helperExecutablePath: "C:\\GoatFixture\\client.exe",
      helperExecutableSha256: "33".repeat(32),
    });
    expect(() => createWindowsProtectedWorkerTransport(input, guard)).toThrow("TLS certificate");
    expect(guard.pin).not.toHaveBeenCalled();
  });
  it("propagates guard refusal without attempting a TLS context or a signing fallback", () => {
    const guard = {
      pin: vi.fn(() => {
        throw new Error("changed installed image");
      }),
    };
    expect(() => createWindowsProtectedWorkerTransport(fixture(), guard)).toThrow("changed installed image");
    expect(guard.pin).toHaveBeenCalledOnce();
  });
});
