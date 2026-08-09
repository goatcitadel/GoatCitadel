import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import {
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_RUNTIME_CREDENTIAL_PURPOSE,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  buildRemoteWorkerRuntimeCredentialClaims,
  canonicalJsonString,
  remoteWorkerRuntimeCredentialClaimsSha256,
  type FinalizeRemoteWorkerBootstrapAdmissionCommand,
  type RemoteWorkerBootstrapRecord,
  type RemoteWorkerRuntimeManifest,
} from "@goatcitadel/contracts";
import type {
  FinalizeRemoteWorkerBootstrapAdmissionOutcome,
  FinalizeRemoteWorkerBootstrapAdmissionWithNonceInput,
} from "@goatcitadel/storage";
import { RemoteWorkerAdmissionRepository, createDatabase } from "@goatcitadel/storage";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  REMOTE_WORKER_BOOTSTRAP_EXCHANGE_METHOD,
  REMOTE_WORKER_BOOTSTRAP_EXCHANGE_OPERATION,
  REMOTE_WORKER_BOOTSTRAP_EXCHANGE_RAW_PATH,
  REMOTE_WORKER_BOOTSTRAP_EXCHANGE_SCHEMA_VERSION,
  RemoteWorkerAdmissionService,
  type RemoteWorkerAdmissionEvidenceVerificationInput,
  type RemoteWorkerAdmissionEvidenceVerificationResult,
} from "./remote-worker-admission-service.js";
import {
  REMOTE_WORKER_POP_SCHEMA_VERSION,
  REMOTE_WORKER_PROTOCOL_HEADERS,
  buildRemoteWorkerPopMaterial,
  remoteWorkerProtocolBodySha256,
  type RemoteWorkerProtocolBody,
} from "./remote-worker-protocol.js";
import type { EnabledRemoteWorkerRuntimeConfig } from "./remote-worker-runtime-config.js";
import type { RemoteWorkerTrustMaterial } from "./remote-worker-trust-material.js";
import type { RemoteWorkerTransportIdentity } from "./remote-worker-transport-identity.js";

const NOW = new Date();
const BOOTSTRAP_BYTES = Buffer.alloc(32, 0x22);
const BOOTSTRAP_SECRET = BOOTSTRAP_BYTES.toString("base64url");
const NONCE_BYTES = Buffer.alloc(32, 0x33);
const NONCE = NONCE_BYTES.toString("base64url");
const EVIDENCE: Omit<RemoteWorkerAdmissionEvidenceVerificationResult, "contextSha256"> = Object.freeze({
  downloadVerificationReceiptSha256: digest("download"),
  installedTreeAttestationSha256: digest("installed-tree-attestation"),
  installedTreeVerificationReceiptSha256: digest("installed-tree-receipt"),
});

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

interface Fixture {
  readonly input: {
    method: string;
    rawPath: string;
    headers: Record<string, string>;
    body: RemoteWorkerProtocolBody;
    transportIdentity: RemoteWorkerTransportIdentity;
  };
  bootstrap: RemoteWorkerBootstrapRecord;
  disposition: FinalizeRemoteWorkerBootstrapAdmissionOutcome["disposition"];
  readonly store: {
    findBootstrapBySecretSha256: Mock<(bootstrapSecretSha256: string) => RemoteWorkerBootstrapRecord | undefined>;
    finalizeBootstrapAdmissionWithNonce: Mock<
      (input: FinalizeRemoteWorkerBootstrapAdmissionWithNonceInput) => FinalizeRemoteWorkerBootstrapAdmissionOutcome
    >;
  };
  readonly evidenceVerifier: {
    verify: Mock<
      (
        input: RemoteWorkerAdmissionEvidenceVerificationInput,
      ) => RemoteWorkerAdmissionEvidenceVerificationResult | Promise<RemoteWorkerAdmissionEvidenceVerificationResult>
    >;
  };
  readonly readRuntimeConfig: Mock<() => EnabledRemoteWorkerRuntimeConfig>;
  readonly loadTrustMaterial: Mock<(config: EnabledRemoteWorkerRuntimeConfig, now: Date) => RemoteWorkerTrustMaterial>;
  readonly trustDispose: Mock<() => void>;
  readonly randomBytes: Mock<(size: number) => Buffer>;
  readonly generatedBuffers: Buffer[];
  readonly order: string[];
  readonly clientPrivateKey: KeyObject;
  nextCredentialByte: number;
  lastEvidenceInput?: RemoteWorkerAdmissionEvidenceVerificationInput;
}

function signedManifest(): {
  readonly manifest: RemoteWorkerRuntimeManifest;
  readonly signerSpkiDer: Buffer;
  readonly signerSpkiSha256: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signerSpkiDer = publicKey.export({ format: "der", type: "spki" });
  const payload = Object.freeze({
    schemaVersion: REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    bundleSha256: digest("bundle"),
    dependencyLockSha256: digest("lock"),
    vendorTreeSha256: digest("vendor"),
    launcherSha256: digest("launcher"),
    installedTreeManifestSha256: digest("tree"),
    installedTreeFileCount: 5,
    platform: "windows",
    architecture: "x64",
  });
  return {
    manifest: Object.freeze({
      payload,
      payloadSha256: digest(canonicalJsonString(payload)),
      signatureAlgorithm: "ed25519",
      signerKeyId: "release-key-1",
      signatureBase64Url: sign(null, Buffer.from(canonicalJsonString(payload), "utf8"), privateKey).toString(
        "base64url",
      ),
    }),
    signerSpkiDer,
    signerSpkiSha256: digest(signerSpkiDer),
  };
}

function createFixture(): Fixture {
  const manifest = signedManifest();
  const workspaceCeilingSha256 = digest(canonicalJsonString(["default"]));
  const capabilityCeilingSha256 = digest(canonicalJsonString(["durable_compute"]));
  const bootstrap: RemoteWorkerBootstrapRecord = {
    registryWorkspaceId: "default",
    bootstrapId: "bootstrap-1",
    workerId: "worker-1",
    nodeId: "node-1",
    targetWorkerGeneration: 1,
    workerLabel: "Office worker",
    platform: "windows",
    architecture: "x64",
    runtimeManifest: manifest.manifest,
    allowedWorkspaceIds: ["default"],
    workspaceCeilingSha256,
    capabilityClasses: ["durable_compute"],
    capabilityCeilingSha256,
    state: "pending",
    expiresAt: "2026-07-15T20:05:00.000Z",
    createdByActorId: "operator-1",
    idempotencyKey: "bootstrap-create-1",
    requestSha256: digest("bootstrap-request"),
    createdAt: "2026-07-15T19:59:00.000Z",
  };
  const clientKeyPair = generateKeyPairSync("ed25519");
  const publicKeySpkiDer = clientKeyPair.publicKey.export({ format: "der", type: "spki" });
  const publicKeySpkiSha256 = digest(publicKeySpkiDer);
  const tlsExporter = Buffer.alloc(32, 0x44);
  const transportIdentity: RemoteWorkerTransportIdentity = {
    source: "native_mtls",
    certificateDerSha256: digest("certificate"),
    publicKeySpkiSha256,
    trustAnchorDerSha256: digest("client-ca"),
    tlsExporterSha256: digest(tlsExporter),
    tlsExporter,
  };
  const body: RemoteWorkerProtocolBody = {
    schemaVersion: REMOTE_WORKER_POP_SCHEMA_VERSION,
    operation: REMOTE_WORKER_BOOTSTRAP_EXCHANGE_OPERATION,
    authorityId: bootstrap.bootstrapId,
    authorityGeneration: bootstrap.targetWorkerGeneration,
    idempotencyKey: "exchange-1",
    payload: {
      schemaVersion: REMOTE_WORKER_BOOTSTRAP_EXCHANGE_SCHEMA_VERSION,
      publicKeySpkiBase64Url: publicKeySpkiDer.toString("base64url"),
    },
  };
  const material = buildRemoteWorkerPopMaterial({
    rawPath: REMOTE_WORKER_BOOTSTRAP_EXCHANGE_RAW_PATH,
    bodySha256: remoteWorkerProtocolBodySha256(body),
    operation: REMOTE_WORKER_BOOTSTRAP_EXCHANGE_OPERATION,
    nonce: NONCE,
    timestamp: NOW.toISOString(),
    idempotencyKey: body.idempotencyKey,
    authorityId: body.authorityId,
    authorityGeneration: body.authorityGeneration,
    transportIdentity,
  });
  const headers = {
    [REMOTE_WORKER_PROTOCOL_HEADERS.authorization]: `GoatWorkerBootstrap ${BOOTSTRAP_SECRET}`,
    [REMOTE_WORKER_PROTOCOL_HEADERS.timestamp]: NOW.toISOString(),
    [REMOTE_WORKER_PROTOCOL_HEADERS.nonce]: NONCE,
    [REMOTE_WORKER_PROTOCOL_HEADERS.operation]: REMOTE_WORKER_BOOTSTRAP_EXCHANGE_OPERATION,
    [REMOTE_WORKER_PROTOCOL_HEADERS.proof]: sign(
      null,
      Buffer.from(canonicalJsonString(material), "utf8"),
      clientKeyPair.privateKey,
    ).toString("base64url"),
    [REMOTE_WORKER_PROTOCOL_HEADERS.idempotencyKey]: body.idempotencyKey,
  };
  const runtimeConfig: EnabledRemoteWorkerRuntimeConfig = Object.freeze({
    enabled: true,
    host: "127.0.0.1",
    port: 9443,
    tls: Object.freeze({
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      requestCert: true,
      rejectUnauthorized: true,
      serverCertificateFile: "C:\\fixtures\\server.crt",
      serverKeyFile: "C:\\fixtures\\server.key",
      clientCaFile: "C:\\fixtures\\client-ca.crt",
      clientCaSha256: digest("client-ca"),
    }),
    manifestSigner: Object.freeze({
      keyId: "release-key-1",
      publicKeyFile: "C:\\fixtures\\manifest.pem",
      spkiSha256: manifest.signerSpkiSha256,
    }),
    bootstrapTtlSeconds: 300,
    credentialTtlSeconds: 900,
  });
  const trustDispose = vi.fn();
  const trustMaterial: RemoteWorkerTrustMaterial = {
    tlsServerOptions: vi.fn(() => {
      throw new Error("not used");
    }),
    manifestSignerPublicKeySpkiDer: vi.fn(() => Buffer.from(manifest.signerSpkiDer)),
    diagnostics: vi.fn(() => {
      throw new Error("not used");
    }),
    dispose: trustDispose,
  };
  const order: string[] = [];
  const generatedBuffers: Buffer[] = [];
  const fixture: Fixture = {
    input: {
      method: REMOTE_WORKER_BOOTSTRAP_EXCHANGE_METHOD,
      rawPath: REMOTE_WORKER_BOOTSTRAP_EXCHANGE_RAW_PATH,
      headers,
      body,
      transportIdentity,
    },
    bootstrap,
    disposition: "admitted",
    store: {
      findBootstrapBySecretSha256: vi.fn(() => fixture.bootstrap),
      finalizeBootstrapAdmissionWithNonce: vi.fn((input: FinalizeRemoteWorkerBootstrapAdmissionWithNonceInput) => {
        order.push("finalize");
        return admissionOutcome(input.command, fixture.bootstrap, fixture.disposition);
      }),
    },
    evidenceVerifier: {
      verify: vi.fn((input: RemoteWorkerAdmissionEvidenceVerificationInput) => {
        order.push("evidence");
        fixture.lastEvidenceInput = input;
        return Object.freeze({ contextSha256: input.contextSha256, ...EVIDENCE });
      }),
    },
    readRuntimeConfig: vi.fn(() => runtimeConfig),
    loadTrustMaterial: vi.fn(() => trustMaterial),
    trustDispose,
    randomBytes: vi.fn((size: number) => {
      order.push("random");
      expect(size).toBe(32);
      const bytes = Buffer.alloc(32, fixture.nextCredentialByte);
      generatedBuffers.push(bytes);
      return bytes;
    }),
    generatedBuffers,
    order,
    clientPrivateKey: clientKeyPair.privateKey,
    nextCredentialByte: 0x55,
  };
  return fixture;
}

function bindFixtureToBootstrap(fixture: Fixture, bootstrap: RemoteWorkerBootstrapRecord): void {
  fixture.bootstrap = bootstrap;
  fixture.input.body = {
    ...fixture.input.body,
    authorityId: bootstrap.bootstrapId,
    authorityGeneration: bootstrap.targetWorkerGeneration,
  };
  const material = buildRemoteWorkerPopMaterial({
    rawPath: fixture.input.rawPath,
    bodySha256: remoteWorkerProtocolBodySha256(fixture.input.body),
    operation: REMOTE_WORKER_BOOTSTRAP_EXCHANGE_OPERATION,
    nonce: NONCE,
    timestamp: NOW.toISOString(),
    idempotencyKey: fixture.input.body.idempotencyKey,
    authorityId: bootstrap.bootstrapId,
    authorityGeneration: bootstrap.targetWorkerGeneration,
    transportIdentity: fixture.input.transportIdentity,
  });
  fixture.input.headers[REMOTE_WORKER_PROTOCOL_HEADERS.proof] = sign(
    null,
    Buffer.from(canonicalJsonString(material), "utf8"),
    fixture.clientPrivateKey,
  ).toString("base64url");
}

function bindFixtureToFreshTlsConnection(fixture: Fixture, exporterByte: number, nonceByte: number): void {
  const tlsExporter = Buffer.alloc(32, exporterByte);
  const nonce = Buffer.alloc(32, nonceByte).toString("base64url");
  fixture.input.transportIdentity = {
    ...fixture.input.transportIdentity,
    tlsExporter,
    tlsExporterSha256: digest(tlsExporter),
  };
  fixture.input.headers[REMOTE_WORKER_PROTOCOL_HEADERS.nonce] = nonce;
  const material = buildRemoteWorkerPopMaterial({
    rawPath: fixture.input.rawPath,
    bodySha256: remoteWorkerProtocolBodySha256(fixture.input.body),
    operation: REMOTE_WORKER_BOOTSTRAP_EXCHANGE_OPERATION,
    nonce,
    timestamp: NOW.toISOString(),
    idempotencyKey: fixture.input.body.idempotencyKey,
    authorityId: fixture.input.body.authorityId,
    authorityGeneration: fixture.input.body.authorityGeneration,
    transportIdentity: fixture.input.transportIdentity,
  });
  fixture.input.headers[REMOTE_WORKER_PROTOCOL_HEADERS.proof] = sign(
    null,
    Buffer.from(canonicalJsonString(material), "utf8"),
    fixture.clientPrivateKey,
  ).toString("base64url");
}

function admissionOutcome(
  command: FinalizeRemoteWorkerBootstrapAdmissionCommand,
  bootstrap: RemoteWorkerBootstrapRecord,
  disposition: FinalizeRemoteWorkerBootstrapAdmissionOutcome["disposition"],
): FinalizeRemoteWorkerBootstrapAdmissionOutcome {
  const claims = buildRemoteWorkerRuntimeCredentialClaims({
    registryWorkspaceId: bootstrap.registryWorkspaceId,
    workerId: bootstrap.workerId,
    workerGeneration: bootstrap.targetWorkerGeneration,
    allowedWorkspaceIds: bootstrap.allowedWorkspaceIds,
    capabilityClasses: bootstrap.capabilityClasses,
  });
  return {
    disposition,
    generation: {
      registryWorkspaceId: bootstrap.registryWorkspaceId,
      workerId: bootstrap.workerId,
      nodeId: bootstrap.nodeId,
      workerGeneration: bootstrap.targetWorkerGeneration,
      bootstrapId: bootstrap.bootstrapId,
      publicKeySpkiSha256: command.verifiedPublicKeySpkiSha256,
      clientCertificateSha256: command.verifiedClientCertificateSha256,
      runtimeManifestSha256: command.verifiedRuntimeManifestSha256,
      workspaceCeilingSha256: command.verifiedWorkspaceCeilingSha256,
      capabilityCeilingSha256: command.verifiedCapabilityCeilingSha256,
      transportIdentitySource: command.verifiedTransportIdentitySource,
      transportTrustAnchorSha256: command.verifiedTransportTrustAnchorSha256,
      transportVerificationReceiptSha256: command.verifiedTransportReceiptSha256,
      proofOfPossessionReceiptSha256: command.verifiedProofOfPossessionReceiptSha256,
      downloadVerificationReceiptSha256: command.verifiedDownloadReceiptSha256,
      installedTreeAttestationSha256: command.verifiedInstalledTreeAttestationSha256,
      installedTreeVerificationReceiptSha256: command.verifiedInstalledTreeReceiptSha256,
      exchangeIdempotencyKey: command.exchangeIdempotencyKey,
      exchangeRequestSha256: digest("exchange-request"),
      admittedAt: NOW.toISOString(),
    },
    credential: {
      registryWorkspaceId: bootstrap.registryWorkspaceId,
      workerId: bootstrap.workerId,
      workerGeneration: bootstrap.targetWorkerGeneration,
      credentialGeneration: 1,
      credentialId: "credential-1",
      purpose: REMOTE_WORKER_RUNTIME_CREDENTIAL_PURPOSE,
      claims,
      claimsSha256: remoteWorkerRuntimeCredentialClaimsSha256(claims),
      issuanceProofSha256: command.credentialIssuanceProofSha256,
      idempotencyKey: command.exchangeIdempotencyKey,
      requestSha256: digest("exchange-request"),
      issuedAt: NOW.toISOString(),
      expiresAt: "2026-07-15T20:15:00.000Z",
    },
  };
}

function service(fixture: Fixture, includeEvidence = true): RemoteWorkerAdmissionService {
  return new RemoteWorkerAdmissionService({
    admissionStore: fixture.store,
    ...(includeEvidence ? { evidenceVerifier: fixture.evidenceVerifier } : {}),
    readRuntimeConfig: fixture.readRuntimeConfig,
    loadTrustMaterial: fixture.loadTrustMaterial,
    randomBytes: fixture.randomBytes,
    now: () => NOW,
  });
}

describe("RemoteWorkerAdmissionService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves only by exact-token bootstrap-secret hash and atomically admits with server-derived evidence", async () => {
    const fixture = createFixture();
    const result = await service(fixture).exchange(fixture.input);

    expect(fixture.store.findBootstrapBySecretSha256).toHaveBeenCalledWith(digest(BOOTSTRAP_SECRET));
    expect(fixture.order).toEqual(["evidence", "random", "finalize"]);
    expect(fixture.trustDispose).toHaveBeenCalledOnce();
    expect(fixture.lastEvidenceInput).toMatchObject({
      registryWorkspaceId: "default",
      bootstrapId: "bootstrap-1",
      workerId: "worker-1",
      nodeId: "node-1",
      targetWorkerGeneration: 1,
      platform: "windows",
      architecture: "x64",
      runtimeManifestSha256: digest(canonicalJsonString(fixture.bootstrap.runtimeManifest)),
      workspaceCeilingSha256: fixture.bootstrap.workspaceCeilingSha256,
      capabilityCeilingSha256: fixture.bootstrap.capabilityCeilingSha256,
      exchangeIdempotencyKey: "exchange-1",
      publicKeySpkiSha256: fixture.input.transportIdentity.publicKeySpkiSha256,
      clientCertificateSha256: fixture.input.transportIdentity.certificateDerSha256,
      transportTrustAnchorSha256: fixture.input.transportIdentity.trustAnchorDerSha256,
      tlsExporterSha256: fixture.input.transportIdentity.tlsExporterSha256,
    });
    expect(fixture.lastEvidenceInput?.contextSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(fixture.lastEvidenceInput?.transportReceiptSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(fixture.lastEvidenceInput?.proofOfPossessionReceiptSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.isFrozen(fixture.lastEvidenceInput)).toBe(true);
    expect(JSON.stringify(fixture.lastEvidenceInput)).not.toContain(BOOTSTRAP_SECRET);

    const finalized = fixture.store.finalizeBootstrapAdmissionWithNonce.mock.calls[0]?.[0] as
      | FinalizeRemoteWorkerBootstrapAdmissionWithNonceInput
      | undefined;
    expect(finalized?.nonce).toEqual({
      authority: {
        kind: "bootstrap",
        registryWorkspaceId: "default",
        bootstrapId: "bootstrap-1",
        workerId: "worker-1",
        targetWorkerGeneration: 1,
      },
      nonceSha256: digest(NONCE),
      timestamp: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    });
    expect(finalized?.command).toMatchObject({
      expectedRegistryWorkspaceId: "default",
      expectedBootstrapId: "bootstrap-1",
      expectedTargetWorkerGeneration: 1,
      bootstrapSecretSha256: digest(BOOTSTRAP_SECRET),
      verifiedTransportIdentitySource: "native_mtls",
      verifiedDownloadReceiptSha256: EVIDENCE.downloadVerificationReceiptSha256,
      verifiedInstalledTreeAttestationSha256: EVIDENCE.installedTreeAttestationSha256,
      verifiedInstalledTreeReceiptSha256: EVIDENCE.installedTreeVerificationReceiptSha256,
      credentialExpiresInSeconds: 900,
      exchangeIdempotencyKey: "exchange-1",
    });
    expect(JSON.stringify(finalized)).not.toContain(BOOTSTRAP_SECRET);

    expect(result).toMatchObject({
      disposition: "admitted",
      authorizationScheme: "Bearer",
      credentialSecret: Buffer.alloc(32, 0x55).toString("base64url"),
      secretDisposition: "returned_once",
    });
    expect("credentialSecret" in result ? result.credentialSecret : undefined).toHaveLength(43);
    expect(finalized?.command.credentialTokenSha256).toBe(digest(Buffer.alloc(32, 0x55).toString("base64url")));
    expect(fixture.generatedBuffers[0]).toEqual(Buffer.alloc(32));
  });

  it("recognizes exact committed replay before nonce consumption and never returns the new candidate secret", async () => {
    const fixture = createFixture();
    const admissionService = service(fixture);
    const first = await admissionService.exchange(fixture.input);
    const firstCall = fixture.store.finalizeBootstrapAdmissionWithNonce.mock
      .calls[0]?.[0] as FinalizeRemoteWorkerBootstrapAdmissionWithNonceInput;
    fixture.bootstrap = { ...fixture.bootstrap, state: "consumed" };
    fixture.disposition = "replayed_without_credential_secret";
    fixture.nextCredentialByte = 0x66;
    bindFixtureToFreshTlsConnection(fixture, 0x45, 0x34);
    const second = await admissionService.exchange(fixture.input);
    const secondCall = fixture.store.finalizeBootstrapAdmissionWithNonce.mock
      .calls[1]?.[0] as FinalizeRemoteWorkerBootstrapAdmissionWithNonceInput;

    expect(first.disposition).toBe("admitted");
    expect(Object.keys(second)).toEqual(["disposition", "generation", "credential"]);
    expect(second.disposition).toBe("replayed_without_credential_secret");
    expect(JSON.stringify(second)).not.toContain(Buffer.alloc(32, 0x66).toString("base64url"));
    expect(secondCall.command.credentialTokenSha256).not.toBe(firstCall.command.credentialTokenSha256);
    expect(secondCall.command.verifiedTransportReceiptSha256).not.toBe(
      firstCall.command.verifiedTransportReceiptSha256,
    );
    expect(secondCall.command.credentialIssuanceProofSha256).not.toBe(firstCall.command.credentialIssuanceProofSha256);
    expect(fixture.generatedBuffers).toHaveLength(2);
    expect(fixture.generatedBuffers[1]).toEqual(Buffer.alloc(32));
  });

  it("integrates with the durable admission repository so nonce, generation, and credential commit atomically", async () => {
    const fixture = createFixture();
    const db = createDatabase({ dbPath: ":memory:" });
    try {
      const repository = new RemoteWorkerAdmissionRepository(db);
      const storedBootstrap = repository.createBootstrap({
        registryWorkspaceId: fixture.bootstrap.registryWorkspaceId,
        workerLabel: fixture.bootstrap.workerLabel,
        platform: fixture.bootstrap.platform,
        architecture: fixture.bootstrap.architecture,
        runtimeManifest: fixture.bootstrap.runtimeManifest,
        allowedWorkspaceIds: fixture.bootstrap.allowedWorkspaceIds,
        capabilityClasses: fixture.bootstrap.capabilityClasses,
        expiresInSeconds: 300,
        createdByActorId: fixture.bootstrap.createdByActorId,
        idempotencyKey: fixture.bootstrap.idempotencyKey,
        bootstrapSecretSha256: digest(BOOTSTRAP_SECRET),
      }).record;
      bindFixtureToBootstrap(fixture, storedBootstrap);
      const admissionService = new RemoteWorkerAdmissionService({
        admissionStore: repository,
        evidenceVerifier: fixture.evidenceVerifier,
        readRuntimeConfig: fixture.readRuntimeConfig,
        loadTrustMaterial: fixture.loadTrustMaterial,
        randomBytes: fixture.randomBytes,
        now: () => NOW,
      });

      const admitted = await admissionService.exchange(fixture.input);

      expect(admitted.disposition).toBe("admitted");
      const returnedSecret = admitted.disposition === "admitted" ? admitted.credentialSecret : "";
      expect(returnedSecret).toHaveLength(43);
      expect(
        Number(
          (
            db.prepare("SELECT COUNT(*) AS count FROM remote_worker_bootstrap_request_nonces").get() as {
              count: number | bigint;
            }
          ).count,
        ),
      ).toBe(1);
      expect(
        Number(
          (
            db.prepare("SELECT COUNT(*) AS count FROM remote_worker_generations").get() as {
              count: number | bigint;
            }
          ).count,
        ),
      ).toBe(1);
      const persisted = JSON.stringify({
        bootstraps: db.prepare("SELECT bootstrap_secret_sha256 FROM remote_worker_bootstrap_requests").all(),
        credentials: db.prepare("SELECT token_sha256 FROM remote_worker_runtime_credentials").all(),
      });
      expect(persisted).not.toContain(BOOTSTRAP_SECRET);
      expect(persisted).not.toContain(returnedSecret);

      fixture.nextCredentialByte = 0x66;
      bindFixtureToFreshTlsConnection(fixture, 0x45, 0x34);
      const replay = await admissionService.exchange(fixture.input);

      expect(replay.disposition).toBe("replayed_without_credential_secret");
      expect(replay).not.toHaveProperty("credentialSecret");
      expect(
        Number(
          (
            db.prepare("SELECT COUNT(*) AS count FROM remote_worker_bootstrap_request_nonces").get() as {
              count: number | bigint;
            }
          ).count,
        ),
      ).toBe(1);
      expect(
        Number(
          (
            db.prepare("SELECT COUNT(*) AS count FROM remote_worker_generations").get() as {
              count: number | bigint;
            }
          ).count,
        ),
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  it("fails closed at the default trusted-evidence gate before generating or finalizing a credential", async () => {
    const fixture = createFixture();
    await expect(service(fixture, false).exchange(fixture.input)).rejects.toThrow(
      "Trusted remote worker admission evidence is unavailable",
    );
    expect(fixture.randomBytes).not.toHaveBeenCalled();
    expect(fixture.store.finalizeBootstrapAdmissionWithNonce).not.toHaveBeenCalled();
  });

  it("rejects non-buffer and wrong-length RNG output without finalizing or leaking candidate bytes", async () => {
    const shortCandidate = Buffer.alloc(31, 0x77);
    for (const candidate of [shortCandidate, "RNG_SECRET_CANARY_4f18"] as const) {
      const fixture = createFixture();
      fixture.randomBytes.mockReturnValue(candidate as never);
      let caught: unknown;
      try {
        await service(fixture).exchange(fixture.input);
      } catch (error) {
        caught = error;
      }
      const rendered = `${String(caught)} ${JSON.stringify(caught)}`;
      expect(rendered).toContain("credential generation is unavailable");
      expect(rendered).not.toContain("RNG_SECRET_CANARY_4f18");
      expect(rendered).not.toContain(Buffer.alloc(31, 0x77).toString("base64url"));
      expect(fixture.store.finalizeBootstrapAdmissionWithNonce).not.toHaveBeenCalled();
    }
    expect(shortCandidate).toEqual(Buffer.alloc(31));
  });

  it("rejects trusted receipts whose echoed context does not match the prepared authority and transport", async () => {
    const fixture = createFixture();
    fixture.evidenceVerifier.verify.mockImplementation(() => ({
      contextSha256: digest("transplanted-context"),
      ...EVIDENCE,
    }));
    await expect(service(fixture).exchange(fixture.input)).rejects.toThrow("trusted evidence context is invalid");
    expect(fixture.randomBytes).not.toHaveBeenCalled();
    expect(fixture.store.finalizeBootstrapAdmissionWithNonce).not.toHaveBeenCalled();
  });

  it("requires the exact private operation, path, payload, canonical Ed25519 SPKI, and mTLS key binding", async () => {
    const mutations: Array<(fixture: Fixture) => void> = [
      (fixture) => {
        fixture.input.rawPath = "/api/v1/remote-workers/other";
      },
      (fixture) => {
        fixture.input.body = {
          ...fixture.input.body,
          payload: {
            ...(fixture.input.body.payload as Record<string, unknown>),
            unexpectedVerifiedHash: digest("forged"),
          },
        } as RemoteWorkerProtocolBody;
      },
      (fixture) => {
        fixture.input.body = {
          ...fixture.input.body,
          payload: {
            schemaVersion: REMOTE_WORKER_BOOTSTRAP_EXCHANGE_SCHEMA_VERSION,
            publicKeySpkiBase64Url: Buffer.alloc(44, 0x77).toString("base64url"),
          },
        };
      },
      (fixture) => {
        fixture.input.transportIdentity = {
          ...fixture.input.transportIdentity,
          publicKeySpkiSha256: digest("different-key"),
        };
      },
    ];
    for (const mutate of mutations) {
      const fixture = createFixture();
      mutate(fixture);
      await expect(service(fixture).exchange(fixture.input)).rejects.toThrow(/invalid|could not be completed/u);
      expect(fixture.evidenceVerifier.verify).not.toHaveBeenCalled();
      expect(fixture.randomBytes).not.toHaveBeenCalled();
      expect(fixture.store.finalizeBootstrapAdmissionWithNonce).not.toHaveBeenCalled();
    }
  });

  it("reverifies the stored manifest against server config and trust before privileged evidence", async () => {
    const fixture = createFixture();
    const original = fixture.readRuntimeConfig() as EnabledRemoteWorkerRuntimeConfig;
    fixture.readRuntimeConfig.mockReturnValue({
      ...original,
      manifestSigner: {
        ...original.manifestSigner,
        spkiSha256: digest("wrong-signer"),
      },
    });
    await expect(service(fixture).exchange(fixture.input)).rejects.toThrow("manifest trust verification failed");
    expect(fixture.evidenceVerifier.verify).not.toHaveBeenCalled();
    expect(fixture.randomBytes).not.toHaveBeenCalled();
    expect(fixture.store.finalizeBootstrapAdmissionWithNonce).not.toHaveBeenCalled();
  });

  it("rejects accessor and proxy canaries without invoking getters or leaking attacker text", async () => {
    const accessorFixture = createFixture();
    let reads = 0;
    Object.defineProperty(accessorFixture.input, "method", {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        return REMOTE_WORKER_BOOTSTRAP_EXCHANGE_METHOD;
      },
    });
    await expect(service(accessorFixture).exchange(accessorFixture.input)).rejects.toThrow(/invalid/u);
    expect(reads).toBe(0);
    expect(accessorFixture.store.findBootstrapBySecretSha256).not.toHaveBeenCalled();

    const secretCanary = "ADMISSION_PROXY_SECRET_CANARY_7a92";
    const proxyFixture = createFixture();
    proxyFixture.input.body = new Proxy(proxyFixture.input.body, {
      getPrototypeOf: () => {
        throw new Error(secretCanary);
      },
    });
    let caught: unknown;
    try {
      await service(proxyFixture).exchange(proxyFixture.input);
    } catch (error) {
      caught = error;
    }
    const rendered = `${String(caught)} ${JSON.stringify(caught)}`;
    expect(rendered).not.toContain(secretCanary);
    expect(rendered.length).toBeLessThan(512);
    expect(proxyFixture.evidenceVerifier.verify).not.toHaveBeenCalled();
    expect(proxyFixture.store.finalizeBootstrapAdmissionWithNonce).not.toHaveBeenCalled();

    const benignProxyFixture = createFixture();
    await expect(service(benignProxyFixture).exchange(new Proxy(benignProxyFixture.input, {}))).rejects.toThrow(
      /completed|invalid/u,
    );
    expect(benignProxyFixture.store.findBootstrapBySecretSha256).not.toHaveBeenCalled();
    expect(benignProxyFixture.evidenceVerifier.verify).not.toHaveBeenCalled();
    expect(benignProxyFixture.store.finalizeBootstrapAdmissionWithNonce).not.toHaveBeenCalled();
  });

  it("does not promote caller-selected authority even when signed envelope fields are changed", async () => {
    const fixture = createFixture();
    fixture.input.body = { ...fixture.input.body, authorityId: "forged-bootstrap" };
    await expect(service(fixture).exchange(fixture.input)).rejects.toThrow("admission proof is invalid");
    expect(fixture.store.findBootstrapBySecretSha256).toHaveBeenCalledWith(digest(BOOTSTRAP_SECRET));
    expect(fixture.store.finalizeBootstrapAdmissionWithNonce).not.toHaveBeenCalled();
  });
});
