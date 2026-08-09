import { createHash, createPublicKey, randomBytes as cryptoRandomBytes, timingSafeEqual } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";
import {
  assertRemoteWorkerBootstrapRecord,
  assertRemoteWorkerGenerationRecord,
  assertRemoteWorkerRuntimeCredentialRecord,
  canonicalJsonString,
  normalizeRemoteWorkerProtectedAdmissionEvidenceWire,
  normalizeRemoteWorkerVerifiedProtectedAdmissionEvidence,
  type FinalizeRemoteWorkerBootstrapAdmissionCommand,
  type RemoteWorkerBootstrapRecord,
  type RemoteWorkerGenerationRecord,
  type RemoteWorkerRuntimeCredentialRecord,
  type RemoteWorkerRuntimeManifest,
  type RemoteWorkerProtectedAdmissionEvidenceWire,
  type RemoteWorkerProtectedAdmissionSignerPin,
  type RemoteWorkerVerifiedProtectedAdmissionEvidence,
} from "@goatcitadel/contracts";
import type {
  FinalizeRemoteWorkerBootstrapAdmissionOutcome,
  FinalizeRemoteWorkerBootstrapAdmissionWithNonceInput,
} from "@goatcitadel/storage";
import {
  RemoteWorkerAttestationError,
  verifyRemoteWorkerRuntimeManifestSignature,
  type RemoteWorkerManifestVerificationReceipt,
} from "./remote-worker-attestation-service.js";
import {
  normalizeRemoteWorkerProtocolBody,
  prepareRemoteWorkerProofOfPossession,
  RemoteWorkerProtocolError,
  snapshotRemoteWorkerDurableNonceConsumption,
  type RemoteWorkerProtocolBody,
  type RemoteWorkerResolvedAuthority,
} from "./remote-worker-protocol.js";
import {
  parseRemoteWorkerRuntimeConfig,
  type EnabledRemoteWorkerRuntimeConfig,
  type RemoteWorkerRuntimeConfig,
} from "./remote-worker-runtime-config.js";
import { loadRemoteWorkerTrustMaterial, type RemoteWorkerTrustMaterial } from "./remote-worker-trust-material.js";
import type { RemoteWorkerRequestHeaders, RemoteWorkerTransportIdentity } from "./remote-worker-transport-identity.js";

export const REMOTE_WORKER_BOOTSTRAP_EXCHANGE_SCHEMA_VERSION =
  "goatcitadel.remote-worker-bootstrap-exchange.v1" as const;
export const REMOTE_WORKER_BOOTSTRAP_EXCHANGE_METHOD = "POST" as const;
export const REMOTE_WORKER_BOOTSTRAP_EXCHANGE_RAW_PATH = "/api/v1/remote-workers/bootstrap-exchanges" as const;
export const REMOTE_WORKER_BOOTSTRAP_EXCHANGE_OPERATION = "bootstrap.exchange" as const;

const REMOTE_WORKER_TRANSPORT_RECEIPT_SCHEMA_VERSION =
  "goatcitadel.remote-worker-native-mtls-transport-receipt.v1" as const;
const REMOTE_WORKER_CREDENTIAL_ISSUANCE_PROOF_SCHEMA_VERSION =
  "goatcitadel.remote-worker-runtime-credential-issuance-proof.v1" as const;

export interface RemoteWorkerBootstrapExchangePayload {
  readonly schemaVersion: typeof REMOTE_WORKER_BOOTSTRAP_EXCHANGE_SCHEMA_VERSION;
  readonly publicKeySpkiBase64Url: string;
  readonly protectedAdmissionEvidence?: RemoteWorkerProtectedAdmissionEvidenceWire;
}

export interface RemoteWorkerAdmissionExchangeInput {
  readonly method: string;
  readonly rawPath: string;
  readonly headers: RemoteWorkerRequestHeaders;
  readonly body: unknown;
  readonly transportIdentity: RemoteWorkerTransportIdentity;
}

export interface RemoteWorkerAdmissionEvidenceVerificationInput {
  readonly registryWorkspaceId: string;
  readonly bootstrapId: string;
  readonly workerId: string;
  readonly nodeId: string;
  readonly targetWorkerGeneration: number;
  readonly platform: string;
  readonly architecture: string;
  readonly runtimeManifest: RemoteWorkerRuntimeManifest;
  readonly runtimeManifestSha256: string;
  readonly workspaceCeilingSha256: string;
  readonly capabilityCeilingSha256: string;
  readonly manifestVerificationReceipt: RemoteWorkerManifestVerificationReceipt;
  readonly preparedBodySha256: string;
  readonly exchangeIdempotencyKey: string;
  readonly publicKeySpkiBase64Url: string;
  readonly publicKeySpkiSha256: string;
  readonly clientCertificateSha256: string;
  readonly transportTrustAnchorSha256: string;
  readonly tlsExporterSha256: string;
  readonly transportReceiptSha256: string;
  readonly proofOfPossessionReceiptSha256: string;
  readonly evidenceNonceSha256: string;
  readonly contextSha256: string;
  readonly protectedAdmissionSignerPin?: RemoteWorkerProtectedAdmissionSignerPin;
  readonly protectedAdmissionEvidenceWire?: RemoteWorkerProtectedAdmissionEvidenceWire;
}

export interface RemoteWorkerAdmissionEvidenceVerificationResult {
  readonly contextSha256: string;
  readonly downloadVerificationReceiptSha256: string;
  readonly installedTreeAttestationSha256: string;
  readonly installedTreeVerificationReceiptSha256: string;
  readonly verifiedProtectedAdmissionEvidence?: RemoteWorkerVerifiedProtectedAdmissionEvidence;
}

export interface RemoteWorkerAdmissionEvidenceVerifierPort {
  /**
   * Trusted-side verification boundary. Production implementations must
   * verify protected-key authorization and the exact download/install receipt
   * bindings under an operator-pinned keyset. Bare caller-supplied hashes are
   * never sufficient. Throw when provenance or verification is unavailable.
   */
  verify(
    input: RemoteWorkerAdmissionEvidenceVerificationInput,
  ): RemoteWorkerAdmissionEvidenceVerificationResult | Promise<RemoteWorkerAdmissionEvidenceVerificationResult>;
}

export interface RemoteWorkerAdmissionStorePort {
  findBootstrapBySecretSha256(
    bootstrapSecretSha256: string,
  ): RemoteWorkerBootstrapRecord | undefined | Promise<RemoteWorkerBootstrapRecord | undefined>;
  finalizeBootstrapAdmissionWithNonce(
    input: FinalizeRemoteWorkerBootstrapAdmissionWithNonceInput,
  ): FinalizeRemoteWorkerBootstrapAdmissionOutcome | Promise<FinalizeRemoteWorkerBootstrapAdmissionOutcome>;
}

export type RemoteWorkerAdmissionExchangeResult =
  | Readonly<{
      disposition: "admitted";
      generation: RemoteWorkerGenerationRecord;
      credential: RemoteWorkerRuntimeCredentialRecord;
      authorizationScheme: "Bearer";
      credentialSecret: string;
      secretDisposition: "returned_once";
    }>
  | Readonly<{
      disposition: "replayed_without_credential_secret";
      generation: RemoteWorkerGenerationRecord;
      credential: RemoteWorkerRuntimeCredentialRecord;
    }>;

export interface RemoteWorkerAdmissionServiceDependencies {
  readonly admissionStore: RemoteWorkerAdmissionStorePort;
  readonly evidenceVerifier?: RemoteWorkerAdmissionEvidenceVerifierPort;
  readonly readRuntimeConfig?: () => RemoteWorkerRuntimeConfig | Promise<RemoteWorkerRuntimeConfig>;
  readonly loadTrustMaterial?: (
    config: EnabledRemoteWorkerRuntimeConfig,
    now: Date,
  ) => RemoteWorkerTrustMaterial | Promise<RemoteWorkerTrustMaterial>;
  readonly randomBytes?: (size: number) => Buffer;
  readonly now?: () => Date;
}

export class RemoteWorkerAdmissionError extends Error {
  readonly code = "REMOTE_WORKER_ADMISSION_REJECTED";

  public constructor(message: string) {
    super(message);
    this.name = "RemoteWorkerAdmissionError";
  }
}

export class UnavailableRemoteWorkerAdmissionEvidenceVerifier implements RemoteWorkerAdmissionEvidenceVerifierPort {
  public verify(): never {
    throw rejected("Trusted remote worker admission evidence is unavailable.");
  }
}

export const unavailableRemoteWorkerAdmissionEvidenceVerifier: RemoteWorkerAdmissionEvidenceVerifierPort =
  Object.freeze(new UnavailableRemoteWorkerAdmissionEvidenceVerifier());

export class RemoteWorkerAdmissionService {
  private readonly admissionStore: RemoteWorkerAdmissionStorePort;
  private readonly evidenceVerifier: RemoteWorkerAdmissionEvidenceVerifierPort;
  private readonly readRuntimeConfig: () => RemoteWorkerRuntimeConfig | Promise<RemoteWorkerRuntimeConfig>;
  private readonly loadTrustMaterial: (
    config: EnabledRemoteWorkerRuntimeConfig,
    now: Date,
  ) => RemoteWorkerTrustMaterial | Promise<RemoteWorkerTrustMaterial>;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly now: () => Date;

  public constructor(dependencies: RemoteWorkerAdmissionServiceDependencies) {
    this.admissionStore = dependencies.admissionStore;
    this.evidenceVerifier = dependencies.evidenceVerifier ?? unavailableRemoteWorkerAdmissionEvidenceVerifier;
    this.readRuntimeConfig = dependencies.readRuntimeConfig ?? (() => parseRemoteWorkerRuntimeConfig());
    this.loadTrustMaterial =
      dependencies.loadTrustMaterial ?? ((config, now) => loadRemoteWorkerTrustMaterial(config, now));
    this.randomBytes = dependencies.randomBytes ?? cryptoRandomBytes;
    this.now = dependencies.now ?? (() => new Date());
  }

  public async exchange(input: RemoteWorkerAdmissionExchangeInput): Promise<RemoteWorkerAdmissionExchangeResult> {
    let credentialBytes: Buffer | undefined;
    let transportIdentity: RemoteWorkerTransportIdentity | undefined;
    try {
      const request = snapshotExchangeInput(input);
      transportIdentity = request.transportIdentity;
      const bootstrapSecretSha256 = bootstrapAuthorizationSha256(request.headers);
      const storedBootstrap = await this.admissionStore.findBootstrapBySecretSha256(bootstrapSecretSha256);
      if (storedBootstrap === undefined) {
        throw rejected("Remote worker bootstrap authority is unavailable.");
      }
      const bootstrap = snapshotBootstrap(storedBootstrap);
      const genericBody = normalizeRemoteWorkerProtocolBody(request.body);
      const normalizedPayload = normalizeBootstrapExchangePayload(genericBody.payload);
      const body: RemoteWorkerProtocolBody = Object.freeze({
        ...genericBody,
        payload: normalizedPayload.payload as unknown as RemoteWorkerProtocolBody["payload"],
      });
      const publicKeySpkiSha256 = sha256Bytes(normalizedPayload.publicKeySpkiDer);
      const authority: RemoteWorkerResolvedAuthority = Object.freeze({
        kind: "bootstrap",
        authorityId: bootstrap.bootstrapId,
        authorityGeneration: bootstrap.targetWorkerGeneration,
        authorizationCredentialSha256: bootstrapSecretSha256,
        publicKeySpkiDer: normalizedPayload.publicKeySpkiDer,
        publicKeySpkiSha256,
      });

      const now = snapshotClock(this.now());
      const prepared = prepareRemoteWorkerProofOfPossession({
        method: request.method,
        rawPath: request.rawPath,
        headers: request.headers,
        body,
        expectedOperation: REMOTE_WORKER_BOOTSTRAP_EXCHANGE_OPERATION,
        authority,
        transportIdentity: request.transportIdentity,
        now,
      });
      request.transportIdentity.tlsExporter.fill(0);

      const manifestTrust = await this.verifyStoredManifest(bootstrap, now);
      const runtimeManifestSha256 = sha256Utf8(canonicalJsonString(bootstrap.runtimeManifest));
      const transportReceiptSha256 = remoteWorkerTransportReceiptSha256({
        receipt: prepared.receipt,
        trustAnchorDerSha256: request.transportIdentity.trustAnchorDerSha256,
      });
      const durableNonce = snapshotRemoteWorkerDurableNonceConsumption({
        authority: Object.freeze({
          kind: "bootstrap",
          registryWorkspaceId: bootstrap.registryWorkspaceId,
          bootstrapId: bootstrap.bootstrapId,
          workerId: bootstrap.workerId,
          targetWorkerGeneration: bootstrap.targetWorkerGeneration,
        }),
        nonce: prepared.nonce.nonce,
        timestamp: prepared.nonce.timestamp,
        authorityId: prepared.nonce.authorityId,
        authorityGeneration: prepared.nonce.authorityGeneration,
      });
      const evidenceContext = remoteWorkerAdmissionEvidenceContext({
        bootstrap,
        runtimeManifestSha256,
        manifestVerificationReceipt: manifestTrust.receipt,
        preparedBodySha256: prepared.receipt.bodySha256,
        exchangeIdempotencyKey: prepared.body.idempotencyKey,
        publicKeySpkiSha256,
        clientCertificateSha256: prepared.receipt.certificateDerSha256,
        transportTrustAnchorSha256: request.transportIdentity.trustAnchorDerSha256,
        tlsExporterSha256: prepared.receipt.tlsExporterSha256,
        transportReceiptSha256,
        proofOfPossessionReceiptSha256: prepared.receipt.proofOfPossessionReceiptSha256,
      });
      const evidence = normalizeEvidenceVerificationResult(
        await this.evidenceVerifier.verify(
          Object.freeze({
            registryWorkspaceId: bootstrap.registryWorkspaceId,
            bootstrapId: bootstrap.bootstrapId,
            workerId: bootstrap.workerId,
            nodeId: bootstrap.nodeId,
            targetWorkerGeneration: bootstrap.targetWorkerGeneration,
            platform: bootstrap.platform,
            architecture: bootstrap.architecture,
            runtimeManifest: bootstrap.runtimeManifest,
            runtimeManifestSha256,
            workspaceCeilingSha256: bootstrap.workspaceCeilingSha256,
            capabilityCeilingSha256: bootstrap.capabilityCeilingSha256,
            manifestVerificationReceipt: manifestTrust.receipt,
            preparedBodySha256: prepared.receipt.bodySha256,
            exchangeIdempotencyKey: prepared.body.idempotencyKey,
            publicKeySpkiBase64Url: normalizedPayload.payload.publicKeySpkiBase64Url,
            publicKeySpkiSha256,
            clientCertificateSha256: prepared.receipt.certificateDerSha256,
            transportTrustAnchorSha256: request.transportIdentity.trustAnchorDerSha256,
            tlsExporterSha256: prepared.receipt.tlsExporterSha256,
            transportReceiptSha256,
            proofOfPossessionReceiptSha256: prepared.receipt.proofOfPossessionReceiptSha256,
            evidenceNonceSha256: durableNonce.nonceSha256,
            contextSha256: evidenceContext.contextSha256,
            ...(bootstrap.protectedAdmissionSignerPin === undefined
              ? {}
              : { protectedAdmissionSignerPin: bootstrap.protectedAdmissionSignerPin }),
            ...(normalizedPayload.payload.protectedAdmissionEvidence === undefined
              ? {}
              : { protectedAdmissionEvidenceWire: normalizedPayload.payload.protectedAdmissionEvidence }),
          }),
        ),
        evidenceContext.contextSha256,
        bootstrap.protectedAdmissionSignerPin !== undefined,
      );

      const generatedCredentialBytes = this.randomBytes(32);
      if (!Buffer.isBuffer(generatedCredentialBytes)) {
        throw rejected("Remote worker credential generation is unavailable.");
      }
      credentialBytes = generatedCredentialBytes;
      if (credentialBytes.byteLength !== 32) {
        throw rejected("Remote worker credential generation is unavailable.");
      }
      const credentialSecret = credentialBytes.toString("base64url");
      if (credentialSecret.length !== 43) {
        throw rejected("Remote worker credential generation is unavailable.");
      }
      const credentialTokenSha256 = sha256Utf8(credentialSecret);
      const credentialIssuanceProofSha256 = remoteWorkerCredentialIssuanceProofSha256({
        bootstrap,
        publicKeySpkiSha256,
        runtimeManifestSha256,
        transportReceiptSha256,
        proofOfPossessionReceiptSha256: prepared.receipt.proofOfPossessionReceiptSha256,
        evidence,
        credentialExpiresInSeconds: manifestTrust.credentialTtlSeconds,
        exchangeIdempotencyKey: prepared.body.idempotencyKey,
      });
      const command: FinalizeRemoteWorkerBootstrapAdmissionCommand = Object.freeze({
        expectedRegistryWorkspaceId: bootstrap.registryWorkspaceId,
        expectedBootstrapId: bootstrap.bootstrapId,
        expectedTargetWorkerGeneration: bootstrap.targetWorkerGeneration,
        bootstrapSecretSha256,
        verifiedPublicKeySpkiSha256: publicKeySpkiSha256,
        verifiedClientCertificateSha256: prepared.receipt.certificateDerSha256,
        verifiedRuntimeManifestSha256: runtimeManifestSha256,
        verifiedWorkspaceCeilingSha256: bootstrap.workspaceCeilingSha256,
        verifiedCapabilityCeilingSha256: bootstrap.capabilityCeilingSha256,
        verifiedTransportIdentitySource: "native_mtls",
        verifiedTransportTrustAnchorSha256: request.transportIdentity.trustAnchorDerSha256,
        verifiedTransportReceiptSha256: transportReceiptSha256,
        verifiedProofOfPossessionReceiptSha256: prepared.receipt.proofOfPossessionReceiptSha256,
        verifiedDownloadReceiptSha256: evidence.downloadVerificationReceiptSha256,
        verifiedInstalledTreeAttestationSha256: evidence.installedTreeAttestationSha256,
        verifiedInstalledTreeReceiptSha256: evidence.installedTreeVerificationReceiptSha256,
        credentialIssuanceProofSha256,
        credentialExpiresInSeconds: manifestTrust.credentialTtlSeconds,
        credentialTokenSha256,
        exchangeIdempotencyKey: prepared.body.idempotencyKey,
        ...(evidence.verifiedProtectedAdmissionEvidence === undefined
          ? {}
          : { verifiedProtectedAdmissionEvidence: evidence.verifiedProtectedAdmissionEvidence }),
      });
      const outcome = snapshotAdmissionOutcome(
        await this.admissionStore.finalizeBootstrapAdmissionWithNonce(
          Object.freeze({
            nonce: Object.freeze({
              authority: durableNonce.authority,
              nonceSha256: durableNonce.nonceSha256,
              timestamp: durableNonce.timestamp,
              expiresAt: durableNonce.expiresAt,
            }),
            command,
          }),
        ),
        bootstrap,
        command,
      );
      if (outcome.disposition === "replayed_without_credential_secret") {
        return Object.freeze({
          disposition: outcome.disposition,
          generation: outcome.generation,
          credential: outcome.credential,
        });
      }

      if (sha256Utf8(credentialSecret) !== credentialTokenSha256) {
        throw rejected("Remote worker credential generation is unavailable.");
      }
      return Object.freeze({
        disposition: "admitted",
        generation: outcome.generation,
        credential: outcome.credential,
        authorizationScheme: "Bearer",
        credentialSecret,
        secretDisposition: "returned_once",
      });
    } catch (error) {
      if (error instanceof RemoteWorkerAdmissionError) throw error;
      if (error instanceof RemoteWorkerProtocolError) {
        throw rejected("Remote worker admission proof is invalid.");
      }
      if (error instanceof RemoteWorkerAttestationError) {
        throw rejected("Remote worker runtime manifest trust verification failed.");
      }
      throw rejected("Remote worker admission could not be completed.");
    } finally {
      credentialBytes?.fill(0);
      transportIdentity?.tlsExporter.fill(0);
    }
  }

  private async verifyStoredManifest(
    bootstrap: RemoteWorkerBootstrapRecord,
    now: Date,
  ): Promise<{
    readonly receipt: RemoteWorkerManifestVerificationReceipt;
    readonly credentialTtlSeconds: number;
  }> {
    const config = await this.readRuntimeConfig();
    if (config.enabled !== true) {
      throw rejected("Remote worker runtime trust configuration is unavailable.");
    }
    const trustMaterial = await this.loadTrustMaterial(config, now);
    let signerPublicKeySpkiDer: Buffer | undefined;
    try {
      signerPublicKeySpkiDer = trustMaterial.manifestSignerPublicKeySpkiDer();
      const receipt = verifyRemoteWorkerRuntimeManifestSignature({
        manifest: bootstrap.runtimeManifest,
        expectedSignerKeyId: config.manifestSigner.keyId,
        expectedSignerSpkiSha256: config.manifestSigner.spkiSha256,
        signerPublicKeySpkiDer,
      });
      return Object.freeze({ receipt, credentialTtlSeconds: config.credentialTtlSeconds });
    } finally {
      signerPublicKeySpkiDer?.fill(0);
      trustMaterial.dispose();
    }
  }
}

function snapshotExchangeInput(value: unknown): {
  readonly method: typeof REMOTE_WORKER_BOOTSTRAP_EXCHANGE_METHOD;
  readonly rawPath: typeof REMOTE_WORKER_BOOTSTRAP_EXCHANGE_RAW_PATH;
  readonly headers: RemoteWorkerRequestHeaders;
  readonly body: unknown;
  readonly transportIdentity: RemoteWorkerTransportIdentity;
} {
  const fields = exactOwnDataFields(
    value,
    ["method", "rawPath", "headers", "body", "transportIdentity"],
    "exchange input",
  );
  if (
    fields.method !== REMOTE_WORKER_BOOTSTRAP_EXCHANGE_METHOD ||
    fields.rawPath !== REMOTE_WORKER_BOOTSTRAP_EXCHANGE_RAW_PATH
  ) {
    throw rejected("Remote worker admission exchange target is invalid.");
  }
  return Object.freeze({
    method: REMOTE_WORKER_BOOTSTRAP_EXCHANGE_METHOD,
    rawPath: REMOTE_WORKER_BOOTSTRAP_EXCHANGE_RAW_PATH,
    headers: snapshotRequestHeaders(fields.headers),
    body: fields.body,
    transportIdentity: snapshotTransportIdentity(fields.transportIdentity),
  });
}

function bootstrapAuthorizationSha256(headers: RemoteWorkerRequestHeaders): string {
  const matches = Object.entries(headers).filter(
    ([name, value]) => name.toLowerCase() === "authorization" && value !== undefined,
  );
  if (matches.length !== 1 || typeof matches[0]?.[1] !== "string") {
    throw rejected("Remote worker bootstrap authorization is invalid.");
  }
  const match = /^GoatWorkerBootstrap ([A-Za-z0-9_-]{43})$/u.exec(matches[0][1]);
  if (match === null) throw rejected("Remote worker bootstrap authorization is invalid.");
  return sha256Utf8(match[1] as string);
}

function normalizeBootstrapExchangePayload(value: unknown): {
  readonly payload: RemoteWorkerBootstrapExchangePayload;
  readonly publicKeySpkiDer: Buffer;
} {
  const candidate = value as { protectedAdmissionEvidence?: unknown };
  const hasProtectedEvidence =
    candidate !== null &&
    typeof candidate === "object" &&
    Object.prototype.hasOwnProperty.call(candidate, "protectedAdmissionEvidence");
  const fields = exactOwnDataFields(
    value,
    hasProtectedEvidence
      ? ["schemaVersion", "publicKeySpkiBase64Url", "protectedAdmissionEvidence"]
      : ["schemaVersion", "publicKeySpkiBase64Url"],
    "exchange payload",
  );
  if (fields.schemaVersion !== REMOTE_WORKER_BOOTSTRAP_EXCHANGE_SCHEMA_VERSION) {
    throw rejected("Remote worker bootstrap exchange payload is invalid.");
  }
  if (typeof fields.publicKeySpkiBase64Url !== "string" || !/^[A-Za-z0-9_-]+$/u.test(fields.publicKeySpkiBase64Url)) {
    throw rejected("Remote worker bootstrap exchange public key is invalid.");
  }
  const publicKeySpkiDer = Buffer.from(fields.publicKeySpkiBase64Url, "base64url");
  if (
    publicKeySpkiDer.byteLength < 1 ||
    publicKeySpkiDer.byteLength > 4_096 ||
    publicKeySpkiDer.toString("base64url") !== fields.publicKeySpkiBase64Url
  ) {
    throw rejected("Remote worker bootstrap exchange public key is invalid.");
  }
  try {
    const publicKey = createPublicKey({ key: publicKeySpkiDer, format: "der", type: "spki" });
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new Error("unsupported key");
    }
    const canonicalDer = publicKey.export({ format: "der", type: "spki" });
    if (
      !Buffer.isBuffer(canonicalDer) ||
      canonicalDer.byteLength !== publicKeySpkiDer.byteLength ||
      !timingSafeEqual(canonicalDer, publicKeySpkiDer)
    ) {
      throw new Error("noncanonical key");
    }
  } catch {
    throw rejected("Remote worker bootstrap exchange public key is invalid.");
  }
  return Object.freeze({
    payload: Object.freeze({
      schemaVersion: REMOTE_WORKER_BOOTSTRAP_EXCHANGE_SCHEMA_VERSION,
      publicKeySpkiBase64Url: fields.publicKeySpkiBase64Url,
      ...(hasProtectedEvidence
        ? {
            protectedAdmissionEvidence: normalizeRemoteWorkerProtectedAdmissionEvidenceWire(
              fields.protectedAdmissionEvidence,
            ),
          }
        : {}),
    }),
    publicKeySpkiDer,
  });
}

function normalizeEvidenceVerificationResult(
  value: unknown,
  expectedContextSha256: string,
  protectedEvidenceRequired: boolean,
): RemoteWorkerAdmissionEvidenceVerificationResult {
  const candidate = value as { verifiedProtectedAdmissionEvidence?: unknown };
  const hasProtectedEvidence =
    candidate !== null &&
    typeof candidate === "object" &&
    Object.prototype.hasOwnProperty.call(candidate, "verifiedProtectedAdmissionEvidence");
  const fields = exactOwnDataFields(
    value,
    hasProtectedEvidence
      ? [
          "contextSha256",
          "downloadVerificationReceiptSha256",
          "installedTreeAttestationSha256",
          "installedTreeVerificationReceiptSha256",
          "verifiedProtectedAdmissionEvidence",
        ]
      : [
          "contextSha256",
          "downloadVerificationReceiptSha256",
          "installedTreeAttestationSha256",
          "installedTreeVerificationReceiptSha256",
        ],
    "trusted evidence result",
  );
  const contextSha256 = sha256Value(fields.contextSha256, "trusted evidence context");
  if (hasProtectedEvidence !== protectedEvidenceRequired) {
    throw rejected("Remote worker protected admission evidence is unavailable.");
  }
  const verifiedProtectedAdmissionEvidence = hasProtectedEvidence
    ? normalizeRemoteWorkerVerifiedProtectedAdmissionEvidence(fields.verifiedProtectedAdmissionEvidence)
    : undefined;
  if (!safeDigestEqual(contextSha256, verifiedProtectedAdmissionEvidence?.contextSha256 ?? expectedContextSha256)) {
    throw rejected("Remote worker trusted evidence context is invalid.");
  }
  const result = Object.freeze({
    contextSha256,
    downloadVerificationReceiptSha256: sha256Value(
      fields.downloadVerificationReceiptSha256,
      "download verification receipt",
    ),
    installedTreeAttestationSha256: sha256Value(fields.installedTreeAttestationSha256, "installed-tree attestation"),
    installedTreeVerificationReceiptSha256: sha256Value(
      fields.installedTreeVerificationReceiptSha256,
      "installed-tree verification receipt",
    ),
    ...(verifiedProtectedAdmissionEvidence === undefined ? {} : { verifiedProtectedAdmissionEvidence }),
  });
  if (
    verifiedProtectedAdmissionEvidence !== undefined &&
    (result.downloadVerificationReceiptSha256 !==
      verifiedProtectedAdmissionEvidence.downloadVerificationReceiptSha256 ||
      result.installedTreeAttestationSha256 !== verifiedProtectedAdmissionEvidence.installedTreeAttestationSha256 ||
      result.installedTreeVerificationReceiptSha256 !==
        verifiedProtectedAdmissionEvidence.installedTreeVerificationReceiptSha256)
  ) {
    throw rejected("Remote worker protected admission evidence is inconsistent.");
  }
  return result;
}

function remoteWorkerAdmissionEvidenceContext(input: {
  readonly bootstrap: RemoteWorkerBootstrapRecord;
  readonly runtimeManifestSha256: string;
  readonly manifestVerificationReceipt: RemoteWorkerManifestVerificationReceipt;
  readonly preparedBodySha256: string;
  readonly exchangeIdempotencyKey: string;
  readonly publicKeySpkiSha256: string;
  readonly clientCertificateSha256: string;
  readonly transportTrustAnchorSha256: string;
  readonly tlsExporterSha256: string;
  readonly transportReceiptSha256: string;
  readonly proofOfPossessionReceiptSha256: string;
}): { readonly contextSha256: string } {
  const material = Object.freeze({
    schemaVersion: "goatcitadel.remote-worker-admission-evidence-context.v1",
    registryWorkspaceId: input.bootstrap.registryWorkspaceId,
    bootstrapId: input.bootstrap.bootstrapId,
    workerId: input.bootstrap.workerId,
    nodeId: input.bootstrap.nodeId,
    targetWorkerGeneration: input.bootstrap.targetWorkerGeneration,
    platform: input.bootstrap.platform,
    architecture: input.bootstrap.architecture,
    runtimeManifestSha256: input.runtimeManifestSha256,
    runtimeManifestPayloadSha256: input.bootstrap.runtimeManifest.payloadSha256,
    manifestVerificationReceiptSha256: input.manifestVerificationReceipt.manifestVerificationReceiptSha256,
    workspaceCeilingSha256: input.bootstrap.workspaceCeilingSha256,
    capabilityCeilingSha256: input.bootstrap.capabilityCeilingSha256,
    preparedBodySha256: input.preparedBodySha256,
    exchangeIdempotencyKey: input.exchangeIdempotencyKey,
    publicKeySpkiSha256: input.publicKeySpkiSha256,
    clientCertificateSha256: input.clientCertificateSha256,
    transportTrustAnchorSha256: input.transportTrustAnchorSha256,
    tlsExporterSha256: input.tlsExporterSha256,
    transportReceiptSha256: input.transportReceiptSha256,
    proofOfPossessionReceiptSha256: input.proofOfPossessionReceiptSha256,
  });
  return Object.freeze({ contextSha256: sha256Utf8(canonicalJsonString(material)) });
}

function remoteWorkerTransportReceiptSha256(input: {
  readonly receipt: {
    readonly publicKeySpkiSha256: string;
    readonly certificateDerSha256: string;
    readonly tlsExporterSha256: string;
  };
  readonly trustAnchorDerSha256: string;
}): string {
  return sha256Utf8(
    canonicalJsonString({
      schemaVersion: REMOTE_WORKER_TRANSPORT_RECEIPT_SCHEMA_VERSION,
      source: "native_mtls",
      certificateDerSha256: input.receipt.certificateDerSha256,
      publicKeySpkiSha256: input.receipt.publicKeySpkiSha256,
      trustAnchorDerSha256: input.trustAnchorDerSha256,
      tlsExporterSha256: input.receipt.tlsExporterSha256,
    }),
  );
}

function remoteWorkerCredentialIssuanceProofSha256(input: {
  readonly bootstrap: RemoteWorkerBootstrapRecord;
  readonly publicKeySpkiSha256: string;
  readonly runtimeManifestSha256: string;
  readonly transportReceiptSha256: string;
  readonly proofOfPossessionReceiptSha256: string;
  readonly evidence: RemoteWorkerAdmissionEvidenceVerificationResult;
  readonly credentialExpiresInSeconds: number;
  readonly exchangeIdempotencyKey: string;
}): string {
  return sha256Utf8(
    canonicalJsonString({
      schemaVersion: REMOTE_WORKER_CREDENTIAL_ISSUANCE_PROOF_SCHEMA_VERSION,
      registryWorkspaceId: input.bootstrap.registryWorkspaceId,
      bootstrapId: input.bootstrap.bootstrapId,
      workerId: input.bootstrap.workerId,
      nodeId: input.bootstrap.nodeId,
      targetWorkerGeneration: input.bootstrap.targetWorkerGeneration,
      publicKeySpkiSha256: input.publicKeySpkiSha256,
      runtimeManifestSha256: input.runtimeManifestSha256,
      workspaceCeilingSha256: input.bootstrap.workspaceCeilingSha256,
      capabilityCeilingSha256: input.bootstrap.capabilityCeilingSha256,
      transportReceiptSha256: input.transportReceiptSha256,
      proofOfPossessionReceiptSha256: input.proofOfPossessionReceiptSha256,
      evidenceContextSha256: input.evidence.contextSha256,
      downloadVerificationReceiptSha256: input.evidence.downloadVerificationReceiptSha256,
      installedTreeAttestationSha256: input.evidence.installedTreeAttestationSha256,
      installedTreeVerificationReceiptSha256: input.evidence.installedTreeVerificationReceiptSha256,
      credentialExpiresInSeconds: input.credentialExpiresInSeconds,
      exchangeIdempotencyKey: input.exchangeIdempotencyKey,
    }),
  );
}

function snapshotAdmissionOutcome(
  value: unknown,
  bootstrap: RemoteWorkerBootstrapRecord,
  command: FinalizeRemoteWorkerBootstrapAdmissionCommand,
): FinalizeRemoteWorkerBootstrapAdmissionOutcome {
  const fields = exactOwnDataFields(value, ["disposition", "generation", "credential"], "admission outcome");
  if (fields.disposition !== "admitted" && fields.disposition !== "replayed_without_credential_secret") {
    throw rejected("Remote worker admission storage outcome is invalid.");
  }
  const generation = snapshotPlainData(fields.generation);
  const credential = snapshotPlainData(fields.credential);
  try {
    assertRemoteWorkerGenerationRecord(generation);
    assertRemoteWorkerRuntimeCredentialRecord(credential);
  } catch {
    throw rejected("Remote worker admission storage outcome is invalid.");
  }
  if (
    generation.registryWorkspaceId !== bootstrap.registryWorkspaceId ||
    generation.workerId !== bootstrap.workerId ||
    generation.nodeId !== bootstrap.nodeId ||
    generation.workerGeneration !== bootstrap.targetWorkerGeneration ||
    generation.bootstrapId !== bootstrap.bootstrapId ||
    generation.publicKeySpkiSha256 !== command.verifiedPublicKeySpkiSha256 ||
    generation.clientCertificateSha256 !== command.verifiedClientCertificateSha256 ||
    generation.runtimeManifestSha256 !== command.verifiedRuntimeManifestSha256 ||
    generation.workspaceCeilingSha256 !== bootstrap.workspaceCeilingSha256 ||
    generation.capabilityCeilingSha256 !== bootstrap.capabilityCeilingSha256 ||
    generation.exchangeIdempotencyKey !== command.exchangeIdempotencyKey ||
    credential.registryWorkspaceId !== generation.registryWorkspaceId ||
    credential.workerId !== generation.workerId ||
    credential.workerGeneration !== generation.workerGeneration ||
    (fields.disposition === "admitted" && credential.issuanceProofSha256 !== command.credentialIssuanceProofSha256) ||
    credential.idempotencyKey !== command.exchangeIdempotencyKey
  ) {
    throw rejected("Remote worker admission storage outcome is invalid.");
  }
  return Object.freeze({
    disposition: fields.disposition,
    generation,
    credential,
  });
}

function snapshotBootstrap(value: unknown): RemoteWorkerBootstrapRecord {
  const snapshot = snapshotPlainData(value);
  try {
    assertRemoteWorkerBootstrapRecord(snapshot);
  } catch {
    throw rejected("Remote worker bootstrap authority is invalid.");
  }
  return snapshot;
}

function snapshotTransportIdentity(value: unknown): RemoteWorkerTransportIdentity {
  const fields = exactOwnDataFields(
    value,
    [
      "source",
      "certificateDerSha256",
      "publicKeySpkiSha256",
      "trustAnchorDerSha256",
      "tlsExporterSha256",
      "tlsExporter",
    ],
    "transport identity",
  );
  if (fields.source !== "native_mtls" || !Buffer.isBuffer(fields.tlsExporter)) {
    throw rejected("Remote worker transport identity is invalid.");
  }
  const tlsExporter = Buffer.from(fields.tlsExporter);
  const tlsExporterSha256 = sha256Value(fields.tlsExporterSha256, "TLS exporter");
  if (tlsExporter.byteLength !== 32 || !safeDigestEqual(sha256Bytes(tlsExporter), tlsExporterSha256)) {
    tlsExporter.fill(0);
    throw rejected("Remote worker transport identity is invalid.");
  }
  return Object.freeze({
    source: "native_mtls",
    certificateDerSha256: sha256Value(fields.certificateDerSha256, "client certificate"),
    publicKeySpkiSha256: sha256Value(fields.publicKeySpkiSha256, "transport public key"),
    trustAnchorDerSha256: sha256Value(fields.trustAnchorDerSha256, "transport trust anchor"),
    tlsExporterSha256,
    tlsExporter,
  });
}

function snapshotRequestHeaders(value: unknown): RemoteWorkerRequestHeaders {
  assertPlainRecord(value, "request headers");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot: Record<string, string | readonly string[] | undefined> = Object.create(null) as Record<
    string,
    string | readonly string[] | undefined
  >;
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw rejected("Remote worker request headers are invalid.");
    }
    const member = descriptor.value;
    if (member === undefined || typeof member === "string") {
      snapshot[name] = member;
    } else if (
      Array.isArray(member) &&
      !nodeUtilTypes.isProxy(member) &&
      member.every((item) => typeof item === "string")
    ) {
      snapshot[name] = Object.freeze([...member]);
    } else {
      throw rejected("Remote worker request headers are invalid.");
    }
  }
  return Object.freeze(snapshot);
}

function snapshotPlainData<T>(value: T): T {
  return snapshotPlainDataInner(value, 0, new Set<object>()) as T;
}

function snapshotPlainDataInner(value: unknown, depth: number, seen: Set<object>): unknown {
  if (depth > 64) throw rejected("Remote worker trusted data is invalid.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw rejected("Remote worker trusted data is invalid.");
    return value;
  }
  if (typeof value === "object" && nodeUtilTypes.isProxy(value)) {
    throw rejected("Remote worker trusted data is invalid.");
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw rejected("Remote worker trusted data is invalid.");
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
    const lengthDescriptor = descriptors.length;
    if (
      lengthDescriptor?.get !== undefined ||
      lengthDescriptor?.set !== undefined ||
      typeof lengthDescriptor?.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > 10_000
    ) {
      throw rejected("Remote worker trusted data is invalid.");
    }
    const length = lengthDescriptor.value;
    const expectedKeys = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
    if (
      Object.keys(descriptors).some((key) => !expectedKeys.has(key)) ||
      Array.from({ length }, (_, index) => descriptors[String(index)]).some(
        (descriptor) =>
          descriptor === undefined ||
          !descriptor.enumerable ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined,
      )
    ) {
      throw rejected("Remote worker trusted data is invalid.");
    }
    const snapshot = Object.freeze(
      Array.from({ length }, (_, index) => snapshotPlainDataInner(descriptors[String(index)]?.value, depth + 1, seen)),
    );
    seen.delete(value);
    return snapshot;
  }
  assertPlainRecord(value, "trusted data");
  if (seen.has(value)) throw rejected("Remote worker trusted data is invalid.");
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(descriptors).sort()) {
    const descriptor = descriptors[key] as PropertyDescriptor;
    if (!descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw rejected("Remote worker trusted data is invalid.");
    }
    snapshot[key] = snapshotPlainDataInner(descriptor.value, depth + 1, seen);
  }
  seen.delete(value);
  return Object.freeze(snapshot);
}

function exactOwnDataFields(value: unknown, expected: readonly string[], label: string): Record<string, unknown> {
  assertPlainRecord(value, label);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Object.keys(descriptors).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index]) ||
    Object.values(descriptors).some(
      (descriptor) => !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined,
    )
  ) {
    throw rejected(`Remote worker ${label} is invalid.`);
  }
  const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const name of expected) fields[name] = descriptors[name]?.value;
  return fields;
}

function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    throw rejected(`Remote worker ${label} is invalid.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw rejected(`Remote worker ${label} is invalid.`);
  }
}

function snapshotClock(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw rejected("Remote worker admission clock is invalid.");
  }
  return new Date(value.getTime());
}

function sha256Value(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw rejected(`Remote worker ${label} is invalid.`);
  }
  return value;
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeDigestEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function rejected(message: string): RemoteWorkerAdmissionError {
  return new RemoteWorkerAdmissionError(message);
}
