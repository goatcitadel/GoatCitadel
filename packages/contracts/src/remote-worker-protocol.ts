import { sha256BytesHex, sha256Hex } from "./sha256.js";

export const REMOTE_WORKER_POP_V2_SCHEMA_VERSION = "goatcitadel.remote-worker-pop.v2" as const;
export const REMOTE_WORKER_POP_V2_DOMAIN = "goatcitadel.remote-worker-pop.v2\0" as const;

export const REMOTE_WORKER_POP_V2_ROUTE_BINDINGS = Object.freeze([
  Object.freeze({
    code: 1,
    method: "POST",
    rawPath: "/api/v1/remote-workers/bootstrap-exchanges",
    operation: "bootstrap.exchange",
    authorityKind: "bootstrap",
  }),
  Object.freeze({
    code: 2,
    method: "POST",
    rawPath: "/api/v1/remote-workers/assignment-syncs",
    operation: "assignment.sync",
    authorityKind: "credential",
  }),
  Object.freeze({
    code: 3,
    method: "POST",
    rawPath: "/api/v1/remote-workers/assignment-lease-renewals",
    operation: "assignment.lease.renew",
    authorityKind: "credential",
  }),
  Object.freeze({
    code: 4,
    method: "POST",
    rawPath: "/api/v1/remote-workers/assignment-event-batches",
    operation: "assignment.events.append",
    authorityKind: "credential",
  }),
  Object.freeze({
    code: 5,
    method: "POST",
    rawPath: "/api/v1/remote-workers/assignment-control-reads",
    operation: "assignment.control.read",
    authorityKind: "credential",
  }),
  Object.freeze({
    code: 6,
    method: "POST",
    rawPath: "/api/v1/remote-workers/assignment-settlements",
    operation: "assignment.settle",
    authorityKind: "credential",
  }),
  Object.freeze({
    code: 7,
    method: "POST",
    rawPath: "/api/v1/remote-workers/mesh-node-admissions",
    operation: "mesh.node.admit",
    authorityKind: "credential",
  }),
] as const);

export type RemoteWorkerPopV2RouteBinding = (typeof REMOTE_WORKER_POP_V2_ROUTE_BINDINGS)[number];
export type RemoteWorkerPopV2Operation = RemoteWorkerPopV2RouteBinding["operation"];
export type RemoteWorkerPopV2RawPath = RemoteWorkerPopV2RouteBinding["rawPath"];
export type RemoteWorkerPopV2AuthorityKind = RemoteWorkerPopV2RouteBinding["authorityKind"];

export interface RemoteWorkerPopV2Input {
  readonly schemaVersion: typeof REMOTE_WORKER_POP_V2_SCHEMA_VERSION;
  readonly method: "POST";
  readonly rawPath: RemoteWorkerPopV2RawPath;
  readonly operation: RemoteWorkerPopV2Operation;
  readonly bodySha256: string;
  readonly nonce: string;
  readonly timestamp: string;
  readonly idempotencyKey: string;
  readonly authorityKind: RemoteWorkerPopV2AuthorityKind;
  readonly authorityId: string;
  readonly authorityGeneration: number;
  readonly workerGeneration: number;
  readonly tlsExporterSha256: string;
  readonly clientCertificateSha256: string;
  readonly workerPublicKeySpkiSha256: string;
}

export interface RemoteWorkerPopV2Material extends RemoteWorkerPopV2Input {
  readonly routeCode: RemoteWorkerPopV2RouteBinding["code"];
  readonly timestampEpochMs: number;
  readonly nonceSha256: string;
  readonly authorityIdSha256: string;
  readonly idempotencyKeySha256: string;
}

const UTF8 = new TextEncoder();
const DOMAIN_BYTES = UTF8.encode(REMOTE_WORKER_POP_V2_DOMAIN);
const FIXED_HEADER_BYTES = 4;
const UINT64_FIELDS = 3;
const SHA256_FIELDS = 7;
export const REMOTE_WORKER_POP_V2_FIXED_MATERIAL_BYTES = FIXED_HEADER_BYTES + UINT64_FIELDS * 8 + SHA256_FIELDS * 32;
export const REMOTE_WORKER_POP_V2_PREIMAGE_BYTES = DOMAIN_BYTES.byteLength + REMOTE_WORKER_POP_V2_FIXED_MATERIAL_BYTES;

/**
 * Normalize the only seven worker-callable protocol purposes. Keeping method,
 * route, operation, and authority purpose in one closed table prevents a
 * protected key from becoming a generic signing oracle.
 */
export function normalizeRemoteWorkerPopV2Material(value: unknown): RemoteWorkerPopV2Material {
  const fields = exactDataFields(
    value,
    [
      "schemaVersion",
      "method",
      "rawPath",
      "operation",
      "bodySha256",
      "nonce",
      "timestamp",
      "idempotencyKey",
      "authorityKind",
      "authorityId",
      "authorityGeneration",
      "workerGeneration",
      "tlsExporterSha256",
      "clientCertificateSha256",
      "workerPublicKeySpkiSha256",
    ],
    "material",
  );
  if (fields.schemaVersion !== REMOTE_WORKER_POP_V2_SCHEMA_VERSION || fields.method !== "POST") {
    throw invalid("schema or method");
  }
  const route = resolveRemoteWorkerPopV2Route(fields.rawPath, fields.operation);
  if (fields.authorityKind !== route.authorityKind) throw invalid("authority purpose");
  const nonce = canonicalBase64Url(fields.nonce, 32, "nonce");
  const timestamp = canonicalTimestamp(fields.timestamp);
  const authorityId = boundedIdentifier(fields.authorityId, "authority ID", 256);
  const idempotencyKey = boundedIdempotencyKey(fields.idempotencyKey);
  const normalized = Object.freeze({
    schemaVersion: REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
    method: "POST" as const,
    rawPath: route.rawPath,
    operation: route.operation,
    bodySha256: sha256Digest(fields.bodySha256, "request body"),
    nonce,
    timestamp: timestamp.value,
    idempotencyKey,
    authorityKind: route.authorityKind,
    authorityId,
    authorityGeneration: positiveSafeInteger(fields.authorityGeneration, "authority generation"),
    workerGeneration: positiveSafeInteger(fields.workerGeneration, "worker generation"),
    tlsExporterSha256: sha256Digest(fields.tlsExporterSha256, "TLS exporter"),
    clientCertificateSha256: sha256Digest(fields.clientCertificateSha256, "client certificate"),
    workerPublicKeySpkiSha256: sha256Digest(fields.workerPublicKeySpkiSha256, "worker public key"),
    routeCode: route.code,
    timestampEpochMs: timestamp.epochMs,
    nonceSha256: sha256BytesHex(decodeBase64Url(nonce)),
    authorityIdSha256: sha256Hex(authorityId),
    idempotencyKeySha256: sha256Hex(idempotencyKey),
  });
  return normalized;
}

/**
 * Build the exact Ed25519 preimage for protected remote-worker proof v2.
 *
 * Binary material after the NUL-terminated domain is fixed at 252 bytes:
 * version, method, route, authority-kind; three unsigned 64-bit integers;
 * then seven SHA-256 digests (body, nonce, exporter, certificate, worker SPKI,
 * authority ID, and idempotency key), all in the order encoded below.
 */
export function buildRemoteWorkerPopV2Preimage(input: RemoteWorkerPopV2Input): Uint8Array {
  const material = normalizeRemoteWorkerPopV2Material(input);
  const output = new Uint8Array(REMOTE_WORKER_POP_V2_PREIMAGE_BYTES);
  output.set(DOMAIN_BYTES, 0);
  let offset = DOMAIN_BYTES.byteLength;
  output[offset++] = 2;
  output[offset++] = 1; // POST
  output[offset++] = material.routeCode;
  output[offset++] = material.authorityKind === "bootstrap" ? 1 : 2;
  offset = writeSafeUint64(output, offset, material.authorityGeneration);
  offset = writeSafeUint64(output, offset, material.workerGeneration);
  offset = writeSafeUint64(output, offset, material.timestampEpochMs);
  for (const digest of [
    material.bodySha256,
    material.nonceSha256,
    material.tlsExporterSha256,
    material.clientCertificateSha256,
    material.workerPublicKeySpkiSha256,
    material.authorityIdSha256,
    material.idempotencyKeySha256,
  ]) {
    offset = writeSha256(output, offset, digest);
  }
  if (offset !== output.byteLength) throw invalid("fixed binary length");
  return output;
}

export function resolveRemoteWorkerPopV2Route(rawPath: unknown, operation: unknown): RemoteWorkerPopV2RouteBinding {
  const route = REMOTE_WORKER_POP_V2_ROUTE_BINDINGS.find(
    (candidate) => candidate.rawPath === rawPath && candidate.operation === operation,
  );
  if (route === undefined) throw invalid("route and operation binding");
  return route;
}

function exactDataFields(value: unknown, required: readonly string[], label: string): Record<string, unknown> {
  const prototype = value === null || typeof value !== "object" ? undefined : Object.getPrototypeOf(value);
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (prototype !== Object.prototype && prototype !== null)
  ) {
    throw invalid(label);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const allowed = new Set(required);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    required.some((key) => !Object.prototype.hasOwnProperty.call(descriptors, key)) ||
    keys.some((key) => {
      const descriptor = descriptors[key as string];
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  ) {
    throw invalid(label);
  }
  const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) fields[key] = descriptors[key]?.value;
  return fields;
}

function canonicalBase64Url(value: unknown, byteLength: number, label: string): string {
  const encodedLength = Math.ceil((byteLength * 4) / 3);
  if (typeof value !== "string" || value.length !== encodedLength || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw invalid(label);
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const finalIndex = alphabet.indexOf(value.at(-1) ?? "");
  const remainder = byteLength % 3;
  if ((remainder === 1 && (finalIndex & 15) !== 0) || (remainder === 2 && (finalIndex & 3) !== 0)) {
    throw invalid(label);
  }
  return value;
}

function decodeBase64Url(value: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const output = new Uint8Array(Math.floor((value.length * 6) / 8));
  let accumulator = 0;
  let availableBits = 0;
  let outputOffset = 0;
  for (const character of value) {
    accumulator = (accumulator << 6) | alphabet.indexOf(character);
    availableBits += 6;
    if (availableBits >= 8) {
      availableBits -= 8;
      output[outputOffset++] = (accumulator >> availableBits) & 0xff;
      accumulator &= availableBits === 0 ? 0 : (1 << availableBits) - 1;
    }
  }
  return output;
}

function boundedIdentifier(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/u.test(value)
  ) {
    throw invalid(label);
  }
  return value;
}

function boundedIdempotencyKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:~-]*$/u.test(value)
  ) {
    throw invalid("idempotency key");
  }
  return value;
}

function canonicalTimestamp(value: unknown): { readonly value: string; readonly epochMs: number } {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw invalid("timestamp");
  }
  const epochMs = Date.parse(value);
  if (!Number.isSafeInteger(epochMs) || epochMs < 0 || new Date(epochMs).toISOString() !== value) {
    throw invalid("timestamp");
  }
  return { value, epochMs };
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw invalid(label);
  return value as number;
}

function sha256Digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw invalid(`${label} digest`);
  return value;
}

function writeSafeUint64(output: Uint8Array, offset: number, value: number): number {
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  view.setUint32(offset, Math.floor(value / 0x1_0000_0000), false);
  view.setUint32(offset + 4, value >>> 0, false);
  return offset + 8;
}

function writeSha256(output: Uint8Array, offset: number, digest: string): number {
  for (let index = 0; index < 32; index += 1) {
    output[offset + index] = Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16);
  }
  return offset + 32;
}

function invalid(label: string): TypeError {
  return new TypeError(`Remote worker proof v2 ${label} is invalid.`);
}
