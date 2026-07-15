import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJsonString } from "./canonical-json.js";
import {
  REMOTE_WORKER_CAPABILITY_CLASSES,
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_ROUTE_ACCESS_CLASS,
  REMOTE_WORKER_RUNTIME_CREDENTIAL_CLAIMS_SCHEMA_VERSION,
  REMOTE_WORKER_RUNTIME_CREDENTIAL_PURPOSE,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  assertRemoteWorkerBootstrapRecord,
  assertRemoteWorkerRuntimeCredentialClaims,
  assertRemoteWorkerRuntimeCredentialRecord,
  assertRemoteWorkerRuntimeManifest,
  buildRemoteWorkerRuntimeCredentialClaims,
  evaluateRemoteWorkerRuntimeCredentialRoutePolicy,
  normalizeCreateRemoteWorkerBootstrapCommand,
  normalizeCreateRemoteWorkerBootstrapRequest,
  normalizeFinalizeRemoteWorkerBootstrapAdmissionCommand,
  normalizeRemoteWorkerGenerationControlInput,
  normalizeRotateRemoteWorkerRuntimeCredentialCommand,
  remoteWorkerBootstrapAdmissionReplayMaterial,
  remoteWorkerBootstrapReplayMaterial,
  remoteWorkerRuntimeCredentialClaimsSha256,
  remoteWorkerRuntimeCredentialRotationReplayMaterial,
  type CreateRemoteWorkerBootstrapCommand,
  type CreateRemoteWorkerBootstrapRequest,
  type FinalizeRemoteWorkerBootstrapAdmissionCommand,
  type RemoteWorkerRuntimeCredentialClaims,
  type RemoteWorkerRuntimeManifest,
  type RotateRemoteWorkerRuntimeCredentialCommand,
} from "./remote-worker-admission.js";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const D = (value: string) => digest(value);

function runtimeManifest(overrides: Partial<RemoteWorkerRuntimeManifest> = {}): RemoteWorkerRuntimeManifest {
  const payload = {
    schemaVersion: REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    bundleSha256: D("bundle"),
    dependencyLockSha256: D("lock"),
    vendorTreeSha256: D("vendor"),
    launcherSha256: D("launcher"),
    installedTreeManifestSha256: D("tree"),
    installedTreeFileCount: 42,
    platform: "windows",
    architecture: "x64",
  } as const;
  return {
    payload,
    payloadSha256: D(canonicalJsonString(payload)),
    signatureAlgorithm: "ed25519",
    signerKeyId: "release-key-1",
    signatureBase64Url: "A".repeat(86),
    ...overrides,
  };
}

function bootstrapRequest(): CreateRemoteWorkerBootstrapRequest {
  return {
    registryWorkspaceId: "default",
    workerLabel: "Office worker",
    platform: "windows",
    architecture: "x64",
    runtimeManifest: runtimeManifest(),
    allowedWorkspaceIds: ["default", "research"],
    capabilityClasses: ["artifact_stage", "durable_compute", "gateway_inference"],
    expiresInSeconds: 300,
    idempotencyKey: "bootstrap-office-1",
  };
}

function bootstrapCommand(
  overrides: Partial<CreateRemoteWorkerBootstrapCommand> = {},
): CreateRemoteWorkerBootstrapCommand {
  return {
    ...bootstrapRequest(),
    createdByActorId: "operator-a",
    bootstrapSecretSha256: D("bootstrap-secret"),
    ...overrides,
  };
}

function finalizeCommand(
  overrides: Partial<FinalizeRemoteWorkerBootstrapAdmissionCommand> = {},
): FinalizeRemoteWorkerBootstrapAdmissionCommand {
  return {
    expectedRegistryWorkspaceId: "default",
    expectedBootstrapId: "bootstrap-a",
    expectedTargetWorkerGeneration: 1,
    bootstrapSecretSha256: D("bootstrap-secret"),
    verifiedPublicKeySpkiSha256: D("spki"),
    verifiedClientCertificateSha256: D("certificate"),
    verifiedRuntimeManifestSha256: runtimeManifest().payloadSha256,
    verifiedWorkspaceCeilingSha256: D(canonicalJsonString(["default", "research"])),
    verifiedCapabilityCeilingSha256: D(canonicalJsonString(["artifact_stage", "durable_compute", "gateway_inference"])),
    verifiedTransportIdentitySource: "native_mtls",
    verifiedTransportTrustAnchorSha256: D("anchor"),
    verifiedTransportReceiptSha256: D("transport"),
    verifiedProofOfPossessionReceiptSha256: D("pop"),
    verifiedDownloadReceiptSha256: D("download"),
    verifiedInstalledTreeAttestationSha256: D("attestation"),
    verifiedInstalledTreeReceiptSha256: D("tree-receipt"),
    credentialIssuanceProofSha256: D("issuance"),
    credentialExpiresInSeconds: 900,
    credentialTokenSha256: D("credential-token"),
    exchangeIdempotencyKey: "exchange-office-1",
    ...overrides,
  };
}

function rotationCommand(
  overrides: Partial<RotateRemoteWorkerRuntimeCredentialCommand> = {},
): RotateRemoteWorkerRuntimeCredentialCommand {
  return {
    registryWorkspaceId: "default",
    workerId: "worker-a",
    workerGeneration: 1,
    expectedCredentialId: "credential-1",
    expectedCredentialGeneration: 1,
    verifiedTransportReceiptSha256: D("transport-2"),
    verifiedProofOfPossessionReceiptSha256: D("pop-2"),
    credentialIssuanceProofSha256: D("issuance-2"),
    expiresInSeconds: 900,
    credentialTokenSha256: D("token-2"),
    idempotencyKey: "rotate-2",
    ...overrides,
  };
}

function runtimeClaims(): RemoteWorkerRuntimeCredentialClaims {
  return buildRemoteWorkerRuntimeCredentialClaims({
    registryWorkspaceId: "default",
    workerId: "worker-a",
    workerGeneration: 1,
    allowedWorkspaceIds: ["default", "research"],
    capabilityClasses: ["artifact_stage", "durable_compute", "gateway_inference"],
  });
}

describe("remote worker admission contracts", () => {
  it("binds the manifest digest to canonical payload bytes using browser-safe SHA-256 parity", () => {
    const manifest = runtimeManifest();
    expect(manifest.payloadSha256).toBe(
      createHash("sha256").update(canonicalJsonString(manifest.payload)).digest("hex"),
    );
    expect(() => assertRemoteWorkerRuntimeManifest(manifest)).not.toThrow();
    expect(() => assertRemoteWorkerRuntimeManifest({ ...manifest, payloadSha256: D("wrong-payload") })).toThrow(
      /does not match/u,
    );
    expect(() =>
      assertRemoteWorkerRuntimeManifest({
        ...manifest,
        payload: { ...manifest.payload, protocolVersion: "worker.v2" },
      }),
    ).toThrow(/protocol version/u);
    expect(() => assertRemoteWorkerRuntimeManifest({ ...manifest, signatureAlgorithm: "rsa" })).toThrow(/signature/u);
    expect(() => assertRemoteWorkerRuntimeManifest({ ...manifest, signatureBase64Url: "A".repeat(85) })).toThrow(
      /base64url/u,
    );
    expect(() =>
      assertRemoteWorkerRuntimeManifest({
        ...manifest,
        payload: { ...manifest.payload, installedTreeFileCount: 10_001 },
      }),
    ).toThrow(/10000/u);
  });

  it("never echoes an attacker-controlled unknown field name", () => {
    const secretField = "apiKey_SUPER_SECRET_abc123";
    let message = "";
    try {
      assertRemoteWorkerRuntimeManifest({ ...runtimeManifest(), [secretField]: "private-value" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/contains unknown fields/u);
    expect(message).not.toContain(secretField);
    expect(message).not.toContain("private-value");
  });

  it("separates the bounded operator request from the internal secret-bearing persistence command", () => {
    const request = normalizeCreateRemoteWorkerBootstrapRequest(bootstrapRequest());
    const command = normalizeCreateRemoteWorkerBootstrapCommand(bootstrapCommand());
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(command)).toBe(true);
    expect(request).not.toHaveProperty("createdByActorId");
    expect(request).not.toHaveProperty("bootstrapSecretSha256");
    expect(command.createdByActorId).toBe("operator-a");
    expect(command.bootstrapSecretSha256).toBe(D("bootstrap-secret"));

    for (const legacyField of [
      "expectedPublicKeySpkiSha256",
      "expectedClientCertificateSha256",
      "createdByActorId",
      "bootstrapSecretSha256",
    ]) {
      expect(() =>
        normalizeCreateRemoteWorkerBootstrapRequest({
          ...bootstrapRequest(),
          [legacyField]: legacyField.includes("Sha256") ? D(legacyField) : "operator-a",
        } as never),
      ).toThrow(/unknown fields/u);
    }
    expect(() =>
      normalizeCreateRemoteWorkerBootstrapCommand({
        ...bootstrapCommand(),
        expectedPublicKeySpkiSha256: D("legacy-spki"),
      } as never),
    ).toThrow(/unknown fields/u);
  });

  it("enforces exact sorted scope ceilings and signed platform identity", () => {
    const normalized = normalizeCreateRemoteWorkerBootstrapRequest(bootstrapRequest());
    expect(normalized.allowedWorkspaceIds).toEqual(["default", "research"]);
    expect(normalized.capabilityClasses).toEqual(["artifact_stage", "durable_compute", "gateway_inference"]);
    expect(REMOTE_WORKER_CAPABILITY_CLASSES).toHaveLength(9);
    expect(() =>
      normalizeCreateRemoteWorkerBootstrapRequest({
        ...bootstrapRequest(),
        allowedWorkspaceIds: ["research", "default"],
      }),
    ).toThrow(/sorted and unique/u);
    expect(() =>
      normalizeCreateRemoteWorkerBootstrapRequest({ ...bootstrapRequest(), allowedWorkspaceIds: ["research"] }),
    ).toThrow(/include registryWorkspaceId/u);
    expect(() => normalizeCreateRemoteWorkerBootstrapRequest({ ...bootstrapRequest(), platform: "linux" })).toThrow(
      /must match/u,
    );
    expect(() => normalizeCreateRemoteWorkerBootstrapRequest({ ...bootstrapRequest(), expiresInSeconds: 601 })).toThrow(
      /600/u,
    );
  });

  it("accepts only trusted verified exchange and rotation command shapes", () => {
    expect(Object.isFrozen(normalizeFinalizeRemoteWorkerBootstrapAdmissionCommand(finalizeCommand()))).toBe(true);
    expect(Object.isFrozen(normalizeRotateRemoteWorkerRuntimeCredentialCommand(rotationCommand()))).toBe(true);
    expect(() =>
      normalizeFinalizeRemoteWorkerBootstrapAdmissionCommand({
        ...finalizeCommand(),
        observedPublicKeySpkiSha256: D("legacy-observed"),
      } as never),
    ).toThrow(/unknown fields/u);
    expect(() =>
      normalizeFinalizeRemoteWorkerBootstrapAdmissionCommand({
        ...finalizeCommand(),
        credentialClaimsSha256: D("caller-claim"),
      } as never),
    ).toThrow(/unknown fields/u);
    expect(() =>
      normalizeFinalizeRemoteWorkerBootstrapAdmissionCommand({
        ...finalizeCommand(),
        expectedTargetWorkerGeneration: 0,
      }),
    ).toThrow(/positive/u);
    expect(() =>
      normalizeRotateRemoteWorkerRuntimeCredentialCommand({
        ...rotationCommand(),
        credentialClaimsSha256: D("caller-claim"),
      } as never),
    ).toThrow(/unknown fields/u);
    expect(() =>
      normalizeRotateRemoteWorkerRuntimeCredentialCommand({ ...rotationCommand(), expiresInSeconds: 0 }),
    ).toThrow(/positive/u);
    expect(() =>
      normalizeRotateRemoteWorkerRuntimeCredentialCommand({ ...rotationCommand(), expectedCredentialId: "" }),
    ).toThrow(/canonical identifier/u);
  });

  it("builds semantic replay material that excludes generated secret and token hashes", () => {
    const claims = runtimeClaims();
    const bootstrapA = remoteWorkerBootstrapReplayMaterial(bootstrapCommand());
    const bootstrapB = remoteWorkerBootstrapReplayMaterial(
      bootstrapCommand({ bootstrapSecretSha256: D("different-bootstrap-secret") }),
    );
    expect(bootstrapA).toEqual(bootstrapB);
    const exchangeA = remoteWorkerBootstrapAdmissionReplayMaterial(finalizeCommand(), "bootstrap-a", claims);
    const exchangeB = remoteWorkerBootstrapAdmissionReplayMaterial(
      finalizeCommand({
        bootstrapSecretSha256: D("different-bootstrap-secret"),
        credentialTokenSha256: D("different-token"),
      }),
      "bootstrap-a",
      claims,
    );
    expect(exchangeA).toEqual(exchangeB);
    expect(exchangeA).toMatchObject({
      expectedRegistryWorkspaceId: "default",
      expectedBootstrapId: "bootstrap-a",
      expectedTargetWorkerGeneration: 1,
    });
    expect(
      remoteWorkerBootstrapAdmissionReplayMaterial(
        finalizeCommand({ expectedBootstrapId: "bootstrap-b" }),
        "bootstrap-a",
        claims,
      ),
    ).not.toEqual(exchangeA);
    const rotationA = remoteWorkerRuntimeCredentialRotationReplayMaterial(rotationCommand(), claims);
    const rotationB = remoteWorkerRuntimeCredentialRotationReplayMaterial(
      rotationCommand({ credentialTokenSha256: D("different-token") }),
      claims,
    );
    expect(rotationA).toEqual(rotationB);
    expect(rotationA).toMatchObject({
      expectedCredentialId: "credential-1",
      expectedCredentialGeneration: 1,
    });
    expect(
      remoteWorkerRuntimeCredentialRotationReplayMaterial(rotationCommand({ expectedCredentialGeneration: 2 }), claims),
    ).not.toEqual(rotationA);
    expect(JSON.stringify({ bootstrapA, exchangeA, rotationA })).not.toMatch(
      /bootstrapSecretSha256|credentialTokenSha256/u,
    );
  });

  it("derives an exact immutable credential claims envelope and binds its canonical digest", () => {
    const claims = runtimeClaims();
    expect(claims).toMatchObject({
      schemaVersion: REMOTE_WORKER_RUNTIME_CREDENTIAL_CLAIMS_SCHEMA_VERSION,
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      purpose: REMOTE_WORKER_RUNTIME_CREDENTIAL_PURPOSE,
      routeAccessClass: REMOTE_WORKER_ROUTE_ACCESS_CLASS,
      registryWorkspaceId: "default",
      workerId: "worker-a",
      workerGeneration: 1,
      workspaceCeilingSha256: D(canonicalJsonString(["default", "research"])),
      capabilityCeilingSha256: D(canonicalJsonString(["artifact_stage", "durable_compute", "gateway_inference"])),
    });
    expect(Object.isFrozen(claims)).toBe(true);
    expect(Object.isFrozen(claims.allowedWorkspaceIds)).toBe(true);
    expect(remoteWorkerRuntimeCredentialClaimsSha256(claims)).toBe(D(canonicalJsonString(claims)));
    const unicodeClaims = buildRemoteWorkerRuntimeCredentialClaims({
      registryWorkspaceId: "default",
      workerId: "worker-unicode",
      workerGeneration: 1,
      allowedWorkspaceIds: ["default", "😀", "\uE000"],
      capabilityClasses: ["durable_compute"],
    });
    expect(remoteWorkerRuntimeCredentialClaimsSha256(unicodeClaims)).toBe(D(canonicalJsonString(unicodeClaims)));
    expect(() => assertRemoteWorkerRuntimeCredentialClaims(claims)).not.toThrow();
    expect(() =>
      assertRemoteWorkerRuntimeCredentialClaims({ ...claims, allowedWorkspaceIds: ["default", "other"] }),
    ).toThrow(/workspace ceiling digest/u);
    expect(JSON.stringify(claims)).not.toMatch(/credentialId|credentialGeneration|issuedAt|expiresAt/u);
  });

  it("binds credential records to claims while keeping credential instance metadata outside the envelope", () => {
    const claims = runtimeClaims();
    const record = {
      registryWorkspaceId: "default",
      workerId: "worker-a",
      workerGeneration: 1,
      credentialGeneration: 2,
      credentialId: "credential-2",
      purpose: REMOTE_WORKER_RUNTIME_CREDENTIAL_PURPOSE,
      claims,
      claimsSha256: remoteWorkerRuntimeCredentialClaimsSha256(claims),
      issuanceProofSha256: D("issuance"),
      idempotencyKey: "rotation-2",
      requestSha256: D("request"),
      issuedAt: "2026-07-14T12:00:00.000Z",
      expiresAt: "2026-07-14T12:15:00.000Z",
    };
    expect(() => assertRemoteWorkerRuntimeCredentialRecord(record)).not.toThrow();
    expect(() => assertRemoteWorkerRuntimeCredentialRecord({ ...record, workerGeneration: 2 })).toThrow(
      /metadata does not match/u,
    );
    expect(() => assertRemoteWorkerRuntimeCredentialRecord({ ...record, claimsSha256: D("wrong") })).toThrow(
      /digest does not match/u,
    );
  });

  it("default-denies non-worker routes and enforces exact workspace and capability subsets", () => {
    const claims = runtimeClaims();
    const allowed = evaluateRemoteWorkerRuntimeCredentialRoutePolicy(claims, {
      routeAccessClass: "remote-worker",
      workspaceId: "research",
      requiredCapabilityClasses: ["durable_compute", "gateway_inference"],
    });
    expect(allowed).toEqual({
      allowed: true,
      reasonCode: "allowed_by_remote_worker_ceiling",
      capabilityActivationGranted: false,
    });
    for (const routeAccessClass of ["generic", "operator"]) {
      expect(
        evaluateRemoteWorkerRuntimeCredentialRoutePolicy(claims, {
          routeAccessClass,
          workspaceId: "default",
          requiredCapabilityClasses: ["durable_compute"],
        }),
      ).toMatchObject({ allowed: false, reasonCode: "route_access_class_denied" });
    }
    expect(
      evaluateRemoteWorkerRuntimeCredentialRoutePolicy(claims, {
        routeAccessClass: "remote-worker",
        workspaceId: "private",
        requiredCapabilityClasses: ["durable_compute"],
      }),
    ).toMatchObject({ allowed: false, reasonCode: "workspace_ceiling_denied" });
    expect(
      evaluateRemoteWorkerRuntimeCredentialRoutePolicy(claims, {
        routeAccessClass: "remote-worker",
        workspaceId: "default",
        requiredCapabilityClasses: ["governed_code"],
      }),
    ).toMatchObject({ allowed: false, reasonCode: "capability_ceiling_denied" });
    expect(
      evaluateRemoteWorkerRuntimeCredentialRoutePolicy(claims, {
        routeAccessClass: "remote-worker",
        workspaceId: "default",
        requiredCapabilityClasses: [],
      }),
    ).toMatchObject({ allowed: false, reasonCode: "invalid_route_policy_request" });
    expect(
      evaluateRemoteWorkerRuntimeCredentialRoutePolicy(
        { ...claims, workspaceCeilingSha256: D("wrong") },
        {
          routeAccessClass: "remote-worker",
          workspaceId: "default",
          requiredCapabilityClasses: ["durable_compute"],
        },
      ),
    ).toMatchObject({ allowed: false, reasonCode: "invalid_credential_claims" });
  });

  it("keeps controls content-free and public bootstrap projections secret-free", () => {
    expect(
      normalizeRemoteWorkerGenerationControlInput({
        registryWorkspaceId: "default",
        workerId: "worker-a",
        workerGeneration: 1,
        reasonCode: "operator.quarantine",
        reasonSha256: D("private operator reason"),
        actorId: "operator-a",
        idempotencyKey: "quarantine-a",
      }).reasonCode,
    ).toBe("operator.quarantine");
    const record = {
      registryWorkspaceId: "default",
      bootstrapId: "bootstrap-a",
      workerId: "worker-a",
      nodeId: "node-a",
      targetWorkerGeneration: 1,
      workerLabel: "Office worker",
      platform: "windows",
      architecture: "x64",
      runtimeManifest: runtimeManifest(),
      allowedWorkspaceIds: ["default"],
      workspaceCeilingSha256: D(canonicalJsonString(["default"])),
      capabilityClasses: ["durable_compute"],
      capabilityCeilingSha256: D(canonicalJsonString(["durable_compute"])),
      createdByActorId: "operator-a",
      idempotencyKey: "bootstrap-a",
      requestSha256: D("request"),
      createdAt: "2026-07-14T12:00:00.000Z",
      expiresAt: "2026-07-14T12:05:00.000Z",
      state: "pending" as const,
    };
    expect(() => assertRemoteWorkerBootstrapRecord(record)).not.toThrow();
    expect(() =>
      assertRemoteWorkerBootstrapRecord({
        ...record,
        allowedWorkspaceIds: ["default", "research"],
      }),
    ).toThrow(/workspace ceiling digest does not match/u);
    expect(() =>
      assertRemoteWorkerBootstrapRecord({
        ...record,
        capabilityCeilingSha256: D("wrong-capability-ceiling"),
      }),
    ).toThrow(/capability ceiling digest does not match/u);
    expect(() =>
      assertRemoteWorkerBootstrapRecord({
        ...record,
        platform: "linux",
      }),
    ).toThrow(/runtime target does not match/u);
    expect(JSON.stringify(record)).not.toMatch(/bootstrapSecret|credentialToken|expectedPublicKey|expectedClient/u);
  });
});
