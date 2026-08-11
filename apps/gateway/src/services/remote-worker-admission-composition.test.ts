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

  it("keeps the entire listener dark while atomic M3 or assignment ownership is absent", async () => {
    const createEvidenceVerifier = vi.fn(() => unusedVerifier());
    await expect(
      createGatewayRemoteWorkerAdmissionNativeRequestHandler({
        config: enabledConfig(),
        admissionStore: unusedAdmissionStore() as never,
        createEvidenceVerifier,
      }),
    ).resolves.toBeUndefined();
    await expect(
      createGatewayRemoteWorkerAdmissionNativeRequestHandler({
        config: enabledConfig(),
        admissionStore: unusedAdmissionStore() as never,
        meshNodeAdmissionStore: unusedMeshAdmissionStore(),
        createEvidenceVerifier,
      }),
    ).resolves.toBeUndefined();
    // Assignment RPC present but dispatch (routes 8-10) absent keeps the listener dark.
    await expect(
      createGatewayRemoteWorkerAdmissionNativeRequestHandler({
        config: enabledConfig(),
        admissionStore: unusedAdmissionStore() as never,
        meshNodeAdmissionStore: unusedMeshAdmissionStore(),
        assignmentProtocol: unusedAssignmentProtocol(),
        createEvidenceVerifier,
      }),
    ).resolves.toBeUndefined();
    // Dispatch present but the routes 11-12 execution owner absent keeps it dark too.
    await expect(
      createGatewayRemoteWorkerAdmissionNativeRequestHandler({
        config: enabledConfig(),
        admissionStore: unusedAdmissionStore() as never,
        meshNodeAdmissionStore: unusedMeshAdmissionStore(),
        assignmentProtocol: unusedAssignmentProtocol(),
        assignmentDispatch: unusedAssignmentDispatch(),
        createEvidenceVerifier,
      }),
    ).resolves.toBeUndefined();
    expect(createEvidenceVerifier).not.toHaveBeenCalled();
  });

  it("returns a live mux only after every owner preflight succeeds", async () => {
    const assertAvailable = vi.fn(async () => undefined);
    const verifier: RemoteWorkerAdmissionEvidenceVerifier = {
      assertAvailable,
      verify: vi.fn(async () => {
        throw new Error("not exercised");
      }),
    };
    const config = enabledConfig();
    const meshNodeAdmissionStore = unusedMeshAdmissionStore();
    const assignmentProtocol = unusedAssignmentProtocol();
    const assignmentDispatch = unusedAssignmentDispatch();
    const assignmentExecution = unusedAssignmentExecution();
    const handler = await createGatewayRemoteWorkerAdmissionNativeRequestHandler({
      config,
      admissionStore: unusedAdmissionStore() as never,
      meshNodeAdmissionStore,
      assignmentProtocol,
      assignmentDispatch,
      assignmentExecution,
      createEvidenceVerifier: vi.fn(() => verifier),
    });

    expect(assertAvailable).toHaveBeenCalledTimes(1);
    expect(meshNodeAdmissionStore.assertAvailable).toHaveBeenCalledTimes(1);
    expect(assignmentProtocol.assertAvailable).toHaveBeenCalledTimes(1);
    expect(assignmentDispatch.assertAvailable).toHaveBeenCalledTimes(1);
    expect(assignmentExecution.assertAvailable).toHaveBeenCalledTimes(1);
    expect(handler).toBeTypeOf("function");
  });

  it("propagates an execution owner preflight failure instead of exposing a live handler", async () => {
    const preflightError = new Error("execution owner unavailable");
    await expect(
      createGatewayRemoteWorkerAdmissionNativeRequestHandler({
        config: enabledConfig(),
        admissionStore: unusedAdmissionStore() as never,
        meshNodeAdmissionStore: unusedMeshAdmissionStore(),
        assignmentProtocol: unusedAssignmentProtocol(),
        assignmentDispatch: unusedAssignmentDispatch(),
        assignmentExecution: {
          assertAvailable: vi.fn(async () => {
            throw preflightError;
          }),
          execute: vi.fn(async () => {
            throw new Error("not exercised");
          }),
        },
        createEvidenceVerifier: () => unusedVerifier(),
      }),
    ).rejects.toBe(preflightError);
  });

  it("propagates evidence preflight failure instead of exposing a live handler", async () => {
    const preflightError = new Error("evidence unavailable");
    await expect(
      createGatewayRemoteWorkerAdmissionNativeRequestHandler({
        config: enabledConfig(),
        admissionStore: unusedAdmissionStore() as never,
        meshNodeAdmissionStore: unusedMeshAdmissionStore(),
        assignmentProtocol: unusedAssignmentProtocol(),
        assignmentDispatch: unusedAssignmentDispatch(),
        assignmentExecution: unusedAssignmentExecution(),
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

function unusedVerifier(): RemoteWorkerAdmissionEvidenceVerifier {
  return {
    assertAvailable: vi.fn(async () => undefined),
    verify: vi.fn(async () => {
      throw new Error("not exercised");
    }),
  };
}

function unusedMeshAdmissionStore() {
  return {
    assertAvailable: vi.fn(async () => undefined),
    admitWithNonce: vi.fn(async () => {
      throw new Error("not exercised");
    }),
  };
}

function unusedAssignmentProtocol() {
  return {
    assertAvailable: vi.fn(async () => undefined),
    execute: vi.fn(async () => {
      throw new Error("not exercised");
    }),
  };
}

function unusedAssignmentDispatch() {
  return {
    assertAvailable: vi.fn(async () => undefined),
    execute: vi.fn(async () => {
      throw new Error("not exercised");
    }),
  };
}

function unusedAssignmentExecution() {
  return {
    assertAvailable: vi.fn(async () => undefined),
    execute: vi.fn(async () => {
      throw new Error("not exercised");
    }),
  };
}

function unusedAdmissionStore(): RemoteWorkerAdmissionStorePort {
  return {
    findBootstrapBySecretSha256: vi.fn(() => undefined),
    finalizeBootstrapAdmissionWithNonce: vi.fn(() => {
      throw new Error("not exercised");
    }),
  };
}
