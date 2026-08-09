import { createHash, createPublicKey, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import {
  REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
  buildRemoteWorkerPopV2Preimage,
  canonicalJsonString,
  normalizeRemoteWorkerNonceAuthority,
  remoteWorkerNonceAuthorityProtocolBinding,
  resolveRemoteWorkerPopV2Route,
  type RemoteWorkerNonceAuthority,
} from "@goatcitadel/contracts";
import type { RemoteWorkerRequestHeaders, RemoteWorkerTransportIdentity } from "./remote-worker-transport-identity.js";

export const REMOTE_WORKER_POP_V1_SCHEMA_VERSION = "goatcitadel.remote-worker-pop.v1" as const;
/** Legacy alias retained while unprotected callers migrate deliberately to the v2 binary proof. */
export const REMOTE_WORKER_POP_SCHEMA_VERSION = REMOTE_WORKER_POP_V1_SCHEMA_VERSION;
export const REMOTE_WORKER_PROTOCOL_MAX_BODY_BYTES = 512 * 1024;
export const REMOTE_WORKER_PROTOCOL_TIMESTAMP_SKEW_MS = 60_000;
export const REMOTE_WORKER_PROTOCOL_MAX_REPLAY_CACHE_ENTRIES = 100_000;

export const REMOTE_WORKER_PROTOCOL_HEADERS = Object.freeze({
  authorization: "authorization",
  timestamp: "x-goatcitadel-worker-timestamp",
  nonce: "x-goatcitadel-worker-nonce",
  operation: "x-goatcitadel-worker-operation",
  proof: "x-goatcitadel-worker-proof",
  idempotencyKey: "idempotency-key",
} as const);

export type RemoteWorkerAuthorityKind = "bootstrap" | "credential";
export type RemoteWorkerAuthorizationScheme = "GoatWorkerBootstrap" | "Bearer";

interface RemoteWorkerProtocolBodyBase {
  readonly operation: string;
  readonly authorityId: string;
  readonly authorityGeneration: number;
  readonly idempotencyKey: string;
  readonly payload: JsonValue;
}

export interface RemoteWorkerProtocolBodyV1 extends RemoteWorkerProtocolBodyBase {
  readonly schemaVersion: typeof REMOTE_WORKER_POP_V1_SCHEMA_VERSION;
}

export interface RemoteWorkerProtocolBodyV2 extends RemoteWorkerProtocolBodyBase {
  readonly schemaVersion: typeof REMOTE_WORKER_POP_V2_SCHEMA_VERSION;
  readonly workerGeneration: number;
}

export type RemoteWorkerProtocolBody = RemoteWorkerProtocolBodyV1 | RemoteWorkerProtocolBodyV2;

export interface RemoteWorkerResolvedAuthority {
  readonly kind: RemoteWorkerAuthorityKind;
  readonly authorityId: string;
  readonly authorityGeneration: number;
  /** Required for protected v2 proof; distinct from bootstrap/credential generation. */
  readonly workerGeneration?: number;
  readonly authorizationCredentialSha256: string;
  readonly publicKeySpkiDer: Buffer;
  readonly publicKeySpkiSha256: string;
}

export interface RemoteWorkerNonceConsumePort {
  consume(input: {
    readonly authorityId: string;
    readonly authorityGeneration: number;
    readonly nonce: string;
    readonly timestamp: string;
    readonly expiresAt: string;
  }): boolean | Promise<boolean>;
}

/** Fail-closed bounded cache for single-process deployments; durable integrations may inject a storage-backed port. */
export class BoundedRemoteWorkerNonceConsumer implements RemoteWorkerNonceConsumePort {
  readonly #entries = new Map<string, number>();
  readonly #maximumEntries: number;
  readonly #clock: () => Date;

  constructor(input: { readonly maximumEntries: number; readonly clock?: () => Date }) {
    if (
      !Number.isSafeInteger(input.maximumEntries) ||
      input.maximumEntries < 1 ||
      input.maximumEntries > REMOTE_WORKER_PROTOCOL_MAX_REPLAY_CACHE_ENTRIES
    ) {
      throw invalid("Remote worker replay-cache capacity is invalid.");
    }
    this.#maximumEntries = input.maximumEntries;
    this.#clock = input.clock ?? (() => new Date());
  }

  get size(): number {
    return this.#entries.size;
  }

  consume(input: {
    readonly authorityId: string;
    readonly authorityGeneration: number;
    readonly nonce: string;
    readonly timestamp: string;
    readonly expiresAt: string;
  }): boolean {
    const nowMs = this.#clock().getTime();
    if (!Number.isFinite(nowMs)) return false;
    try {
      normalizeIdentifier(input.authorityId, "authority ID", 256);
      positiveSafeInteger(input.authorityGeneration, "authority generation");
      normalizeNonce(input.nonce);
      normalizeTimestamp(input.timestamp);
    } catch {
      return false;
    }
    for (const [key, expiry] of this.#entries) {
      if (expiry <= nowMs) this.#entries.delete(key);
    }
    const expiresAtMs = Date.parse(input.expiresAt);
    if (
      !Number.isFinite(expiresAtMs) ||
      new Date(expiresAtMs).toISOString() !== input.expiresAt ||
      expiresAtMs <= nowMs ||
      expiresAtMs > nowMs + REMOTE_WORKER_PROTOCOL_TIMESTAMP_SKEW_MS * 2
    ) {
      return false;
    }
    const key = sha256Utf8(
      canonicalJsonString({
        authorityId: input.authorityId,
        authorityGeneration: input.authorityGeneration,
        nonce: input.nonce,
      }),
    );
    if (this.#entries.has(key) || this.#entries.size >= this.#maximumEntries) return false;
    this.#entries.set(key, expiresAtMs);
    return true;
  }
}

/**
 * HX-501B1 durable replay-protection boundary. The durable store consumes a
 * nonce under a strict discriminated authority; only the nonce digest, canonical
 * request timestamp, and expiry cross alongside it. The raw nonce and every
 * authorization/transport secret stay on this side of the port.
 */
export interface RemoteWorkerDurableNonceConsumePort {
  consume(input: {
    readonly authority: RemoteWorkerNonceAuthority;
    readonly nonceSha256: string;
    readonly timestamp: string;
    readonly expiresAt: string;
  }): boolean | Promise<boolean>;
}

/** A frozen, fully-materialized durable nonce consumption request. */
export interface RemoteWorkerDurableNonceConsumption {
  readonly authority: RemoteWorkerNonceAuthority;
  readonly authorityId: string;
  readonly authorityGeneration: number;
  readonly nonceSha256: string;
  readonly timestamp: string;
  readonly expiresAt: string;
}

/**
 * Snapshot a durable nonce consumption request. The complete discriminated
 * authority is normalized and frozen synchronously — before any consumption is
 * awaited — and the top-level protocol authority ID/generation must agree
 * exactly with the discriminated binding (bootstrap: bootstrapId/target
 * generation; credential: credentialId/credential generation). The raw nonce is
 * hashed here so only its digest crosses the storage port.
 */
export function snapshotRemoteWorkerDurableNonceConsumption(input: {
  readonly authority: unknown;
  readonly nonce: string;
  readonly timestamp: string;
  readonly authorityId: string;
  readonly authorityGeneration: number;
}): RemoteWorkerDurableNonceConsumption {
  const authority = normalizeRemoteWorkerNonceAuthority(input.authority);
  const binding = remoteWorkerNonceAuthorityProtocolBinding(authority);
  if (input.authorityId !== binding.authorityId || input.authorityGeneration !== binding.authorityGeneration) {
    throw invalid("Remote worker durable nonce authority binding disagrees with the protocol authority.");
  }
  const nonce = normalizeNonce(input.nonce);
  const timestamp = normalizeTimestamp(input.timestamp);
  const expiresAt = new Date(Date.parse(timestamp) + REMOTE_WORKER_PROTOCOL_TIMESTAMP_SKEW_MS).toISOString();
  return Object.freeze({
    authority,
    authorityId: binding.authorityId,
    authorityGeneration: binding.authorityGeneration,
    nonceSha256: sha256Utf8(nonce),
    timestamp,
    expiresAt,
  });
}

/**
 * Await durable consumption of an already-materialized snapshot. Only the
 * digest, timestamp, expiry, and identity-only authority reach the port; the
 * raw nonce never does.
 */
export async function consumeRemoteWorkerDurableNonce(
  port: RemoteWorkerDurableNonceConsumePort,
  snapshot: RemoteWorkerDurableNonceConsumption,
): Promise<boolean> {
  return await port.consume({
    authority: snapshot.authority,
    nonceSha256: snapshot.nonceSha256,
    timestamp: snapshot.timestamp,
    expiresAt: snapshot.expiresAt,
  });
}

export interface RemoteWorkerPopMaterial {
  readonly schemaVersion: typeof REMOTE_WORKER_POP_SCHEMA_VERSION;
  readonly method: "POST";
  readonly rawPath: string;
  readonly bodySha256: string;
  readonly operation: string;
  readonly nonce: string;
  readonly timestamp: string;
  readonly idempotencyKey: string;
  readonly authorityId: string;
  readonly authorityGeneration: number;
  readonly tlsExporterSha256: string;
  readonly certificateDerSha256: string;
  readonly publicKeySpkiSha256: string;
}

export interface RemoteWorkerProofVerificationReceipt {
  readonly schemaVersion: typeof REMOTE_WORKER_POP_V1_SCHEMA_VERSION | typeof REMOTE_WORKER_POP_V2_SCHEMA_VERSION;
  readonly authorityId: string;
  readonly authorityGeneration: number;
  readonly workerGeneration?: number;
  readonly operation: string;
  readonly timestamp: string;
  readonly bodySha256: string;
  readonly publicKeySpkiSha256: string;
  readonly certificateDerSha256: string;
  readonly tlsExporterSha256: string;
  readonly proofOfPossessionReceiptSha256: string;
}

/**
 * A verified request whose replay nonce has not yet been consumed. Live
 * admission uses this split so the nonce can be consumed in the same database
 * transaction that creates the worker generation and first credential.
 * `nonce` remains process-local protocol material and must never cross a
 * storage port; use `snapshotRemoteWorkerDurableNonceConsumption` first.
 */
export interface PreparedRemoteWorkerProofOfPossession {
  readonly body: RemoteWorkerProtocolBody;
  readonly receipt: RemoteWorkerProofVerificationReceipt;
  readonly nonce: Readonly<{
    authorityId: string;
    authorityGeneration: number;
    nonce: string;
    timestamp: string;
    expiresAt: string;
  }>;
}

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export class RemoteWorkerProtocolError extends Error {
  readonly code = "REMOTE_WORKER_PROTOCOL_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "RemoteWorkerProtocolError";
  }
}

export interface PrepareRemoteWorkerProofOfPossessionInput {
  readonly method: string;
  readonly rawPath: string;
  readonly headers: RemoteWorkerRequestHeaders;
  readonly body: unknown;
  readonly expectedOperation: string;
  readonly authority: RemoteWorkerResolvedAuthority;
  /** Protected admission authority must set this; v1 is then rejected without downgrade. */
  readonly proofRequirement?: "legacy_v1_allowed" | "protected_v2_required";
  readonly transportIdentity: RemoteWorkerTransportIdentity;
  readonly now?: Date;
}

export function prepareRemoteWorkerProofOfPossession(
  input: PrepareRemoteWorkerProofOfPossessionInput,
): PreparedRemoteWorkerProofOfPossession {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw invalid("Remote worker verification clock is invalid.");
  if (input.method !== "POST") throw invalid("Remote worker protocol method is invalid.");
  const rawPath = normalizeRawPath(input.rawPath);
  const expectedOperation = normalizeOperation(input.expectedOperation);
  const body = normalizeRemoteWorkerProtocolBody(input.body);
  const proofRequirement = normalizeProofRequirement(input.proofRequirement);
  const authorization = parseAuthorization(requiredHeader(input.headers, REMOTE_WORKER_PROTOCOL_HEADERS.authorization));
  const authority = snapshotResolvedAuthority(input.authority);
  const transportIdentity = snapshotTransportIdentity(input.transportIdentity);
  try {
    const expectedScheme: RemoteWorkerAuthorizationScheme =
      authority.kind === "bootstrap" ? "GoatWorkerBootstrap" : "Bearer";
    if (authorization.scheme !== expectedScheme) {
      throw invalid("Remote worker authorization purpose is invalid.");
    }
    if (!safeHexDigestEqual(sha256Utf8(authorization.credential), authority.authorizationCredentialSha256)) {
      throw invalid("Remote worker authorization credential is invalid.");
    }

    const timestamp = normalizeTimestamp(requiredHeader(input.headers, REMOTE_WORKER_PROTOCOL_HEADERS.timestamp));
    const timestampMs = Date.parse(timestamp);
    if (Math.abs(now.getTime() - timestampMs) > REMOTE_WORKER_PROTOCOL_TIMESTAMP_SKEW_MS) {
      throw invalid("Remote worker request timestamp is outside the freshness window.");
    }
    const nonce = normalizeNonce(requiredHeader(input.headers, REMOTE_WORKER_PROTOCOL_HEADERS.nonce));
    const operation = normalizeOperation(requiredHeader(input.headers, REMOTE_WORKER_PROTOCOL_HEADERS.operation));
    const idempotencyKey = normalizeIdempotencyKey(
      requiredHeader(input.headers, REMOTE_WORKER_PROTOCOL_HEADERS.idempotencyKey),
    );
    const proof = decodeExactBase64Url(
      requiredHeader(input.headers, REMOTE_WORKER_PROTOCOL_HEADERS.proof),
      64,
      "proof",
    );

    if (
      operation !== expectedOperation ||
      body.operation !== operation ||
      body.idempotencyKey !== idempotencyKey ||
      body.authorityId !== authority.authorityId ||
      body.authorityGeneration !== authority.authorityGeneration
    ) {
      throw invalid("Remote worker request envelope disagrees with its authenticated headers or authority.");
    }
    if (!safeHexDigestEqual(transportIdentity.publicKeySpkiSha256, authority.publicKeySpkiSha256)) {
      throw invalid("Remote worker transport key does not match the admitted authority key.");
    }

    if (proofRequirement === "protected_v2_required" && body.schemaVersion !== REMOTE_WORKER_POP_V2_SCHEMA_VERSION) {
      throw invalid("Remote worker protected authority requires proof protocol v2.");
    }
    if (
      body.schemaVersion === REMOTE_WORKER_POP_V2_SCHEMA_VERSION &&
      (authority.workerGeneration === undefined || body.workerGeneration !== authority.workerGeneration)
    ) {
      throw invalid("Remote worker request envelope disagrees with its authenticated worker generation.");
    }

    const bodySha256 = remoteWorkerProtocolBodySha256(body);
    let signedBytes: Buffer;
    if (body.schemaVersion === REMOTE_WORKER_POP_V2_SCHEMA_VERSION) {
      const route = resolveRemoteWorkerPopV2Route(rawPath, operation);
      signedBytes = Buffer.from(
        buildRemoteWorkerPopV2Preimage({
          schemaVersion: REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
          method: "POST",
          rawPath: route.rawPath,
          operation: route.operation,
          bodySha256,
          nonce,
          timestamp,
          idempotencyKey,
          authorityKind: authority.kind,
          authorityId: authority.authorityId,
          authorityGeneration: authority.authorityGeneration,
          workerGeneration: body.workerGeneration,
          tlsExporterSha256: transportIdentity.tlsExporterSha256,
          clientCertificateSha256: transportIdentity.certificateDerSha256,
          workerPublicKeySpkiSha256: authority.publicKeySpkiSha256,
        }),
      );
    } else {
      signedBytes = Buffer.from(
        canonicalJsonString(
          buildRemoteWorkerPopMaterial({
            rawPath,
            bodySha256,
            operation,
            nonce,
            timestamp,
            idempotencyKey,
            authorityId: authority.authorityId,
            authorityGeneration: authority.authorityGeneration,
            transportIdentity,
          }),
        ),
        "utf8",
      );
    }
    const publicKey = readEd25519PublicKey(authority.publicKeySpkiDer);
    const actualSpkiDer = publicKey.export({ format: "der", type: "spki" });
    if (
      !Buffer.isBuffer(actualSpkiDer) ||
      !safeHexDigestEqual(sha256Bytes(actualSpkiDer), authority.publicKeySpkiSha256)
    ) {
      throw invalid("Remote worker admitted authority key pin is invalid.");
    }
    if (!verify(null, signedBytes, publicKey, proof)) {
      throw invalid("Remote worker proof of possession is invalid.");
    }

    const expiresAt = new Date(timestampMs + REMOTE_WORKER_PROTOCOL_TIMESTAMP_SKEW_MS).toISOString();
    const receipt: RemoteWorkerProofVerificationReceipt = Object.freeze({
      schemaVersion: body.schemaVersion,
      authorityId: authority.authorityId,
      authorityGeneration: authority.authorityGeneration,
      ...(body.schemaVersion === REMOTE_WORKER_POP_V2_SCHEMA_VERSION
        ? { workerGeneration: body.workerGeneration }
        : {}),
      operation,
      timestamp,
      bodySha256,
      publicKeySpkiSha256: authority.publicKeySpkiSha256,
      certificateDerSha256: transportIdentity.certificateDerSha256,
      tlsExporterSha256: transportIdentity.tlsExporterSha256,
      proofOfPossessionReceiptSha256: sha256Bytes(signedBytes),
    });
    return Object.freeze({
      body,
      receipt,
      nonce: Object.freeze({
        authorityId: authority.authorityId,
        authorityGeneration: authority.authorityGeneration,
        nonce,
        timestamp,
        expiresAt,
      }),
    });
  } finally {
    transportIdentity.tlsExporter.fill(0);
  }
}

export async function verifyRemoteWorkerProofOfPossession(
  input: PrepareRemoteWorkerProofOfPossessionInput & { readonly nonceConsumer: RemoteWorkerNonceConsumePort },
): Promise<RemoteWorkerProofVerificationReceipt> {
  const prepared = prepareRemoteWorkerProofOfPossession(input);
  let consumed: boolean;
  try {
    consumed = await input.nonceConsumer.consume({
      ...prepared.nonce,
    });
  } catch {
    throw invalid("Remote worker replay protection is unavailable.");
  }
  if (!consumed) throw invalid("Remote worker request nonce was already consumed.");
  return prepared.receipt;
}

export function normalizeRemoteWorkerProtocolBody(value: unknown): RemoteWorkerProtocolBody {
  assertPlainRecord(value, "body");
  const commonKeys = [
    "schemaVersion",
    "operation",
    "authorityId",
    "authorityGeneration",
    "idempotencyKey",
    "payload",
  ] as const;
  if (value.schemaVersion === REMOTE_WORKER_POP_V1_SCHEMA_VERSION) {
    assertExactKeys(value, commonKeys);
  } else if (value.schemaVersion === REMOTE_WORKER_POP_V2_SCHEMA_VERSION) {
    assertExactKeys(value, [...commonKeys, "workerGeneration"]);
  } else {
    throw invalid("Remote worker request body schema is invalid.");
  }
  const operation = normalizeOperation(value.operation);
  const authorityId = normalizeIdentifier(value.authorityId, "authority ID", 256);
  const authorityGeneration = positiveSafeInteger(value.authorityGeneration, "authority generation");
  const idempotencyKey = normalizeIdempotencyKey(value.idempotencyKey);
  const payload = strictJsonValue(value.payload, 0, new Set<object>());
  const common = {
    operation,
    authorityId,
    authorityGeneration,
    idempotencyKey,
    payload,
  } as const;
  const normalized: RemoteWorkerProtocolBody =
    value.schemaVersion === REMOTE_WORKER_POP_V2_SCHEMA_VERSION
      ? Object.freeze({
          schemaVersion: REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
          ...common,
          workerGeneration: positiveSafeInteger(value.workerGeneration, "worker generation"),
        })
      : Object.freeze({ schemaVersion: REMOTE_WORKER_POP_V1_SCHEMA_VERSION, ...common });
  if (Buffer.byteLength(canonicalJsonString(normalized), "utf8") > REMOTE_WORKER_PROTOCOL_MAX_BODY_BYTES) {
    throw invalid("Remote worker request body exceeds its byte limit.");
  }
  return normalized;
}

export function remoteWorkerProtocolBodySha256(body: RemoteWorkerProtocolBody): string {
  return sha256Utf8(canonicalJsonString(normalizeRemoteWorkerProtocolBody(body)));
}

export function buildRemoteWorkerPopMaterial(input: {
  readonly rawPath: string;
  readonly bodySha256: string;
  readonly operation: string;
  readonly nonce: string;
  readonly timestamp: string;
  readonly idempotencyKey: string;
  readonly authorityId: string;
  readonly authorityGeneration: number;
  readonly transportIdentity: Pick<
    RemoteWorkerTransportIdentity,
    "tlsExporter" | "certificateDerSha256" | "publicKeySpkiSha256"
  >;
}): RemoteWorkerPopMaterial {
  const tlsExporterSha256 = sha256Bytes(input.transportIdentity.tlsExporter);
  const material = Object.assign(Object.create(null) as Record<string, unknown>, {
    schemaVersion: REMOTE_WORKER_POP_SCHEMA_VERSION,
    method: "POST" as const,
    rawPath: normalizeRawPath(input.rawPath),
    bodySha256: normalizeSha256(input.bodySha256, "body digest"),
    operation: normalizeOperation(input.operation),
    nonce: normalizeNonce(input.nonce),
    timestamp: normalizeTimestamp(input.timestamp),
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
    authorityId: normalizeIdentifier(input.authorityId, "authority ID", 256),
    authorityGeneration: positiveSafeInteger(input.authorityGeneration, "authority generation"),
    tlsExporterSha256,
    certificateDerSha256: normalizeSha256(input.transportIdentity.certificateDerSha256, "certificate digest"),
    publicKeySpkiSha256: normalizeSha256(input.transportIdentity.publicKeySpkiSha256, "public key digest"),
  });
  return Object.freeze(material) as unknown as RemoteWorkerPopMaterial;
}

function validateResolvedAuthority(authority: RemoteWorkerResolvedAuthority): void {
  if (authority.kind !== "bootstrap" && authority.kind !== "credential") {
    throw invalid("Remote worker authority purpose is invalid.");
  }
  normalizeIdentifier(authority.authorityId, "authority ID", 256);
  positiveSafeInteger(authority.authorityGeneration, "authority generation");
  if (authority.workerGeneration !== undefined) {
    positiveSafeInteger(authority.workerGeneration, "worker generation");
  }
  normalizeSha256(authority.authorizationCredentialSha256, "authorization credential digest");
  normalizeSha256(authority.publicKeySpkiSha256, "public key digest");
  if (!Buffer.isBuffer(authority.publicKeySpkiDer) || authority.publicKeySpkiDer.byteLength > 4_096) {
    throw invalid("Remote worker authority public key is invalid.");
  }
}

function snapshotResolvedAuthority(value: unknown): RemoteWorkerResolvedAuthority {
  assertPlainRecord(value, "resolved authority");
  const keys = [
    "kind",
    "authorityId",
    "authorityGeneration",
    "authorizationCredentialSha256",
    "publicKeySpkiDer",
    "publicKeySpkiSha256",
  ];
  if (Object.prototype.hasOwnProperty.call(value, "workerGeneration")) keys.push("workerGeneration");
  assertExactKeys(value, keys);
  if (!Buffer.isBuffer(value.publicKeySpkiDer)) {
    throw invalid("Remote worker authority public key is invalid.");
  }
  const snapshot: RemoteWorkerResolvedAuthority = Object.freeze({
    kind: value.kind as RemoteWorkerAuthorityKind,
    authorityId: value.authorityId as string,
    authorityGeneration: value.authorityGeneration as number,
    ...(value.workerGeneration === undefined ? {} : { workerGeneration: value.workerGeneration as number }),
    authorizationCredentialSha256: value.authorizationCredentialSha256 as string,
    publicKeySpkiDer: Buffer.from(value.publicKeySpkiDer),
    publicKeySpkiSha256: value.publicKeySpkiSha256 as string,
  });
  validateResolvedAuthority(snapshot);
  return snapshot;
}

function validateTransportIdentity(identity: RemoteWorkerTransportIdentity): void {
  if (identity.source !== "native_mtls") throw invalid("Remote worker transport source is invalid.");
  normalizeSha256(identity.certificateDerSha256, "certificate digest");
  normalizeSha256(identity.publicKeySpkiSha256, "public key digest");
  normalizeSha256(identity.trustAnchorDerSha256, "trust anchor digest");
  normalizeSha256(identity.tlsExporterSha256, "TLS exporter digest");
  if (
    !Buffer.isBuffer(identity.tlsExporter) ||
    identity.tlsExporter.byteLength !== 32 ||
    !safeHexDigestEqual(sha256Bytes(identity.tlsExporter), identity.tlsExporterSha256)
  ) {
    throw invalid("Remote worker TLS channel binding is invalid.");
  }
}

function snapshotTransportIdentity(value: unknown): RemoteWorkerTransportIdentity {
  assertPlainRecord(value, "transport identity");
  assertExactKeys(value, [
    "source",
    "certificateDerSha256",
    "publicKeySpkiSha256",
    "trustAnchorDerSha256",
    "tlsExporterSha256",
    "tlsExporter",
  ]);
  if (!Buffer.isBuffer(value.tlsExporter)) {
    throw invalid("Remote worker TLS channel binding is invalid.");
  }
  const snapshot: RemoteWorkerTransportIdentity = Object.freeze({
    source: value.source as "native_mtls",
    certificateDerSha256: value.certificateDerSha256 as string,
    publicKeySpkiSha256: value.publicKeySpkiSha256 as string,
    trustAnchorDerSha256: value.trustAnchorDerSha256 as string,
    tlsExporterSha256: value.tlsExporterSha256 as string,
    tlsExporter: Buffer.from(value.tlsExporter),
  });
  validateTransportIdentity(snapshot);
  return snapshot;
}

function parseAuthorization(value: string): { scheme: RemoteWorkerAuthorizationScheme; credential: string } {
  const match = /^(GoatWorkerBootstrap|Bearer) ([A-Za-z0-9._~-]{16,4096})$/u.exec(value);
  if (!match) throw invalid("Remote worker authorization header is invalid.");
  return {
    scheme: match[1] as RemoteWorkerAuthorizationScheme,
    credential: match[2] as string,
  };
}

function requiredHeader(headers: RemoteWorkerRequestHeaders, name: string): string {
  const matches = Object.entries(headers).filter(
    ([headerName, value]) => headerName.toLowerCase() === name && value !== undefined,
  );
  if (matches.length !== 1) throw invalid("A required remote worker protocol header is missing or duplicated.");
  const value = matches[0]?.[1];
  if (typeof value !== "string" || value.length === 0 || /[\r\n]/u.test(value)) {
    throw invalid("A required remote worker protocol header is invalid or duplicated.");
  }
  return value;
}

function normalizeRawPath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 2_048 ||
    !value.startsWith("/") ||
    value.includes("?") ||
    value.includes("#") ||
    /\p{Cc}/u.test(value)
  ) {
    throw invalid("Remote worker request path is invalid.");
  }
  return value;
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw invalid("Remote worker request timestamp is invalid.");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw invalid("Remote worker request timestamp is invalid.");
  }
  return value;
}

function normalizeNonce(value: unknown): string {
  if (typeof value !== "string") throw invalid("Remote worker request nonce is invalid.");
  decodeExactBase64Url(value, 32, "nonce");
  return value;
}

function normalizeOperation(value: unknown): string {
  if (typeof value !== "string" || value.length > 128 || !/^[a-z][a-z0-9_.-]*$/u.test(value)) {
    throw invalid("Remote worker operation is invalid.");
  }
  return value;
}

function normalizeProofRequirement(
  value: PrepareRemoteWorkerProofOfPossessionInput["proofRequirement"],
): "legacy_v1_allowed" | "protected_v2_required" {
  if (value === undefined || value === "legacy_v1_allowed") return "legacy_v1_allowed";
  if (value === "protected_v2_required") return value;
  throw invalid("Remote worker proof requirement is invalid.");
}

function normalizeIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || value.length > 512 || !/^[A-Za-z0-9][A-Za-z0-9._:~-]*$/u.test(value)) {
    throw invalid("Remote worker idempotency key is invalid.");
  }
  return value;
}

function normalizeIdentifier(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/u.test(value)
  ) {
    throw invalid(`Remote worker ${label} is invalid.`);
  }
  return value;
}

function normalizeSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw invalid(`Remote worker ${label} is invalid.`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw invalid(`Remote worker ${label} is invalid.`);
  }
  return value as number;
}

function decodeExactBase64Url(value: string, expectedBytes: number, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw invalid(`Remote worker ${label} encoding is invalid.`);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== expectedBytes || decoded.toString("base64url") !== value) {
    throw invalid(`Remote worker ${label} encoding is invalid.`);
  }
  return decoded;
}

function readEd25519PublicKey(spkiDer: Buffer): KeyObject {
  try {
    const key = createPublicKey({ key: spkiDer, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    return key;
  } catch {
    throw invalid("Remote worker authority public key is invalid.");
  }
}

function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`Remote worker ${label} must be a plain record.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalid(`Remote worker ${label} must be a plain record.`);
  }
  if (
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (descriptor) => descriptor.get !== undefined || descriptor.set !== undefined,
    )
  ) {
    throw invalid(`Remote worker ${label} must contain only plain data fields.`);
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw invalid("Remote worker request body has missing or unknown fields.");
  }
}

function strictJsonValue(value: unknown, depth: number, seen: Set<object>): JsonValue {
  if (depth > 64) throw invalid("Remote worker request body nesting is too deep.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw invalid("Remote worker request body number is invalid.");
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw invalid("Remote worker request body contains a cycle.");
    seen.add(value);
    const normalized = Object.freeze(value.map((item) => strictJsonValue(item, depth + 1, seen)));
    seen.delete(value);
    return normalized;
  }
  assertPlainRecord(value, "request body value");
  if (seen.has(value)) throw invalid("Remote worker request body contains a cycle.");
  seen.add(value);
  const normalized: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(value).sort()) {
    if (key.length === 0 || key.normalize("NFC") !== key || /\p{Cc}/u.test(key)) {
      throw invalid("Remote worker request body field name is invalid.");
    }
    const member = value[key];
    if (
      member === undefined ||
      typeof member === "function" ||
      typeof member === "symbol" ||
      typeof member === "bigint"
    ) {
      throw invalid("Remote worker request body contains a non-JSON value.");
    }
    normalized[key] = strictJsonValue(member, depth + 1, seen);
  }
  seen.delete(value);
  return Object.freeze(normalized);
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeHexDigestEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function invalid(message: string): RemoteWorkerProtocolError {
  return new RemoteWorkerProtocolError(message);
}
