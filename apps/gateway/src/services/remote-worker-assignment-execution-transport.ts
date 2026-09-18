import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";
import { canonicalJsonString } from "@goatcitadel/contracts";
import { REMOTE_WORKER_PROTOCOL_MAX_BODY_BYTES } from "./remote-worker-protocol.js";
import { assertPlainRecord, digest, exactOwnDataFields, rejected, safeDigestEqual } from "./remote-worker-assignment-execution-validators.js";
import type { RemoteWorkerRequestHeaders, RemoteWorkerTransportIdentity } from "./remote-worker-transport-identity.js";

export function snapshotExecutionResponse<T extends object>(value: T): T {
  const encoded = canonicalJsonString(value);
  if (Buffer.byteLength(encoded, "utf8") > REMOTE_WORKER_PROTOCOL_MAX_BODY_BYTES) {
    throw rejected("Remote worker assignment execution response exceeds its byte limit.");
  }
  return freezeJson(JSON.parse(encoded) as T) as T;
}

function freezeJson(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => freezeJson(item)));
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) result[key] = freezeJson(item);
    return Object.freeze(result);
  }
  return value;
}

export function snapshotHeaders(value: unknown): RemoteWorkerRequestHeaders {
  assertPlainRecord(value, "request headers");
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
    throw rejected("Remote worker assignment execution headers are invalid.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length > 32) throw rejected("Remote worker assignment execution headers are invalid.");
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [rawName, descriptor] of Object.entries(descriptors)) {
    const name = rawName.toLowerCase();
    if (
      rawName !== name ||
      name.length < 1 ||
      name.length > 128 ||
      !/^[a-z0-9-]+$/u.test(name) ||
      Object.hasOwn(result, name) ||
      !descriptor.enumerable ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      typeof descriptor.value !== "string" ||
      descriptor.value.length > 8_192 ||
      /[\r\n]/u.test(descriptor.value)
    ) {
      throw rejected("Remote worker assignment execution headers are invalid.");
    }
    result[name] = descriptor.value;
  }
  return Object.freeze(result);
}

export function snapshotTransportIdentity(value: unknown): RemoteWorkerTransportIdentity {
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
    [],
    "transport identity",
  );
  if (
    !Buffer.isBuffer(fields.tlsExporter) ||
    nodeUtilTypes.isProxy(fields.tlsExporter) ||
    fields.tlsExporter.byteLength !== 32
  ) {
    throw rejected("Remote worker assignment execution TLS exporter is invalid.");
  }
  const snapshot: RemoteWorkerTransportIdentity = Object.freeze({
    source: fields.source as "native_mtls",
    certificateDerSha256: digest(fields.certificateDerSha256, "certificateDerSha256"),
    publicKeySpkiSha256: digest(fields.publicKeySpkiSha256, "publicKeySpkiSha256"),
    trustAnchorDerSha256: digest(fields.trustAnchorDerSha256, "trustAnchorDerSha256"),
    tlsExporterSha256: digest(fields.tlsExporterSha256, "tlsExporterSha256"),
    tlsExporter: Buffer.from(fields.tlsExporter),
  });
  if (
    snapshot.source !== "native_mtls" ||
    !safeDigestEqual(createHash("sha256").update(snapshot.tlsExporter).digest("hex"), snapshot.tlsExporterSha256)
  ) {
    snapshot.tlsExporter.fill(0);
    throw rejected("Remote worker assignment execution transport identity is invalid.");
  }
  return snapshot;
}
