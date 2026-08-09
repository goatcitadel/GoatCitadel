import { describe, expect, it, vi } from "vitest";
import {
  createGatewayRemoteWorkerAdmissionNativeRequestHandler,
  type RemoteWorkerAdmissionEvidenceVerifier,
} from "./remote-worker-admission-composition.js";
import type { RemoteWorkerAdmissionStorePort } from "./remote-worker-admission-service.js";
import type { EnabledRemoteWorkerRuntimeConfig } from "./remote-worker-runtime-config.js";

describe("remote worker admission production composition", () => {
  it("keeps an enabled listener dark while no pinned remote-evidence verifier is composed", async () => {
    await expect(
      createGatewayRemoteWorkerAdmissionNativeRequestHandler({
        config: enabledConfig(),
        admissionStore: unusedAdmissionStore(),
      }),
    ).resolves.toBeUndefined();
  });

  it("returns a live handler only after evidence preflight succeeds", async () => {
    const assertAvailable = vi.fn(async () => undefined);
    const verifier: RemoteWorkerAdmissionEvidenceVerifier = {
      assertAvailable,
      verify: vi.fn(async () => {
        throw new Error("not exercised");
      }),
    };
    const config = enabledConfig();
    const handler = await createGatewayRemoteWorkerAdmissionNativeRequestHandler({
      config,
      admissionStore: unusedAdmissionStore(),
      createEvidenceVerifier: vi.fn(() => verifier),
    });

    expect(assertAvailable).toHaveBeenCalledTimes(1);
    expect(handler).toBeTypeOf("function");
  });

  it("propagates evidence preflight failure instead of exposing a live handler", async () => {
    const preflightError = new Error("evidence unavailable");
    await expect(
      createGatewayRemoteWorkerAdmissionNativeRequestHandler({
        config: enabledConfig(),
        admissionStore: unusedAdmissionStore(),
        createEvidenceVerifier: () => ({
          assertAvailable: vi.fn(async () => {
            throw preflightError;
          }),
          verify: vi.fn(async () => {
            throw new Error("not exercised");
          }),
        }),
      }),
    ).rejects.toBe(preflightError);
  });
});

function enabledConfig(): EnabledRemoteWorkerRuntimeConfig {
  return Object.freeze({
    enabled: true,
    host: "127.0.0.1",
    port: 9443,
    tls: Object.freeze({
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      requestCert: true,
      rejectUnauthorized: true,
      serverCertificateFile: "C:\\trust\\server.pem",
      serverKeyFile: "C:\\trust\\server-key.pem",
      clientCaFile: "C:\\trust\\client-ca.pem",
      clientCaSha256: "a".repeat(64),
    }),
    manifestSigner: Object.freeze({
      keyId: "release-signer-a",
      publicKeyFile: "C:\\trust\\manifest-signer.pem",
      spkiSha256: "b".repeat(64),
    }),
    bootstrapTtlSeconds: 600,
    credentialTtlSeconds: 900,
  });
}

function unusedAdmissionStore(): RemoteWorkerAdmissionStorePort {
  return {
    findBootstrapBySecretSha256: vi.fn(() => undefined),
    finalizeBootstrapAdmissionWithNonce: vi.fn(() => {
      throw new Error("not exercised");
    }),
  };
}
