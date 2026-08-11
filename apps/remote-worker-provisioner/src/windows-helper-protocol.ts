/* eslint-disable max-lines -- Fixed-offset protected helper codecs stay co-located so their exact wire layouts and fail-closed validation cannot drift. */
import { spawn } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  REMOTE_WORKER_POP_V2_DOMAIN,
  REMOTE_WORKER_POP_V2_PREIMAGE_BYTES,
  REMOTE_WORKER_POP_V2_ROUTE_BINDINGS,
  type RemoteWorkerPopV2RouteBinding,
} from "@goatcitadel/contracts";

export const WINDOWS_HELPER_MAGIC = "GCPW";
export const WINDOWS_HELPER_PROTOCOL_VERSION = 1;
export const WINDOWS_HELPER_HEADER_BYTES = 16;
export const WINDOWS_HELPER_REQUEST_ID = 1;
export const WINDOWS_HELPER_ORDINARY_MAX_BYTES = 2 * 1024 * 1024;
export const WINDOWS_HELPER_SECRET_MAX_BYTES = 8 * 1024;
export const WINDOWS_HELPER_INSPECT_PAYLOAD_BYTES = 32;
export const WINDOWS_PROTECTED_INSPECT_PAYLOAD_BYTES = 320;
export const WINDOWS_PROTECTED_CREATE_KEYSET_REQUEST_BYTES = 72;
export const WINDOWS_PROTECTED_CREATE_KEYSET_RESULT_BYTES = 320;
export const WINDOWS_PROTECTED_REVOKE_KEYSET_REQUEST_BYTES = 100;
export const WINDOWS_PROTECTED_REVOKE_KEYSET_RESULT_BYTES = 200;
export const WINDOWS_PROTECTED_ADMISSION_EVIDENCE_ENVELOPE_BYTES = 288;
export const WINDOWS_PROTECTED_SIGN_ADMISSION_EVIDENCE_REQUEST_BYTES = 384;
export const WINDOWS_PROTECTED_SIGN_ADMISSION_EVIDENCE_RESULT_BYTES = 320;
export const WINDOWS_PROTECTED_SIGN_RUNTIME_POP_V2_REQUEST_BYTES = 384;
export const WINDOWS_PROTECTED_SIGN_RUNTIME_POP_V2_RESULT_BYTES = 184;
export const WINDOWS_PROTECTED_ADMISSION_EVIDENCE_SIGNATURE_DOMAIN =
  "goatcitadel.remote-worker.provisioning-evidence.signature.v1";
export const WINDOWS_PROTECTED_CALLABLE_OPCODE_BITMAP = 0x0000_0000_001d_0002n;
export const WINDOWS_HELPER_ERROR_PAYLOAD_BYTES = 4;
export const WINDOWS_HELPER_INSPECT_ARGUMENT = "--inspect-stdio";

export const WINDOWS_HELPER_PROCESS_TIMEOUT_MS = 5_000;
export const WINDOWS_HELPER_TERMINATION_GRACE_MS = 1_000;
export const WINDOWS_HELPER_STDOUT_MAX_BYTES = WINDOWS_HELPER_HEADER_BYTES + WINDOWS_HELPER_ORDINARY_MAX_BYTES;
export const WINDOWS_HELPER_STDERR_MAX_BYTES = 8 * 1024;

export const WINDOWS_HELPER_OPCODE = Object.freeze({
  INSPECT: 0x01,
  CREATE_KEYSET: 0x10,
  ACQUIRE_KEY_FOR_SIGNING: 0x11,
  SIGN_ADMISSION_EVIDENCE: 0x12,
  REVOKE_LOCAL_KEYSET: 0x13,
  SIGN_RUNTIME_POP_V2: 0x14,
  BEGIN_INSTALL: 0x20,
  SEAL_AND_PUBLISH_INSTALL: 0x21,
  ABANDON_TO_QUARANTINE: 0x22,
  RUN_KEY_INIT_SERVICE: 0x30,
  PUBLISH_CERT_AND_FINALIZE_DISABLED: 0x31,
  INSPECT_FINAL: 0x32,
} as const);

export type WindowsHelperRequestOpcode = (typeof WINDOWS_HELPER_OPCODE)[keyof typeof WINDOWS_HELPER_OPCODE];

export const WINDOWS_HELPER_ERROR_OPCODE = 0x7f;

export const WINDOWS_HELPER_ERROR_CODE = Object.freeze({
  PROTOCOL_INVALID: 1,
  OPERATION_UNAVAILABLE: 2,
  IO_FAILED: 3,
} as const);

export type WindowsHelperErrorCode = (typeof WINDOWS_HELPER_ERROR_CODE)[keyof typeof WINDOWS_HELPER_ERROR_CODE];

export const WINDOWS_HELPER_PE_MACHINE = Object.freeze({
  X64: 0x8664,
  ARM64: 0xaa64,
} as const);

export type WindowsHelperPeMachine = (typeof WINDOWS_HELPER_PE_MACHINE)[keyof typeof WINDOWS_HELPER_PE_MACHINE];

export const WINDOWS_HELPER_RECOGNIZED_OPCODE_BITMAP = 0x0007_0007_001f_0002n;
export const WINDOWS_HELPER_CALLABLE_OPCODE_BITMAP = 0x0000_0000_0000_0002n;

const MAGIC_BYTES = Buffer.from(WINDOWS_HELPER_MAGIC, "ascii");
const REQUEST_OPCODES = new Set<number>(Object.values(WINDOWS_HELPER_OPCODE));
const ERROR_CODES = new Set<number>(Object.values(WINDOWS_HELPER_ERROR_CODE));

export interface WindowsHelperFrame {
  version: number;
  opcode: number;
  flags: number;
  requestId: number;
  payload: Buffer;
}

export interface WindowsHelperInspect {
  schemaVersion: 1;
  machine: WindowsHelperPeMachine;
  ordinaryMaximumBytes: typeof WINDOWS_HELPER_ORDINARY_MAX_BYTES;
  secretMaximumBytes: typeof WINDOWS_HELPER_SECRET_MAX_BYTES;
  flags: 0;
  recognizedOpcodeBitmap: typeof WINDOWS_HELPER_RECOGNIZED_OPCODE_BITMAP;
  callableOpcodeBitmap: typeof WINDOWS_HELPER_CALLABLE_OPCODE_BITMAP;
}

export type WindowsProtectedCustodyPosture =
  | "empty"
  | "active"
  | "no_active_revoked_or_quarantined"
  | "capacity_exhausted_active"
  | "capacity_exhausted_no_active";

export interface WindowsProtectedInspect extends WindowsHelperInspect {
  protectedSchemaVersion: 1;
  custodyPosture: WindowsProtectedCustodyPosture;
  protectedFlags: number;
  protectedCallableOpcodeBitmap: typeof WINDOWS_PROTECTED_CALLABLE_OPCODE_BITMAP;
  stateSha256: Uint8Array;
  activeGeneration: bigint;
  highestBurnedGeneration: bigint;
  committedGenerationCount: number;
  burnedGenerationCount: number;
  totalOperationIdCount: number;
  quarantinedOperationCount: number;
  quarantineResidueCount: number;
  remainingOperationCapacity: number;
  remainingGenerationCapacity: number;
  activeKeysetReceiptSha256: Uint8Array;
  runtimeManifestSpkiSha256: Uint8Array;
  admissionEvidenceSpkiSha256: Uint8Array;
  runtimeManifestSpki: Uint8Array;
  admissionEvidenceSpki: Uint8Array;
}

export interface WindowsProtectedCreateKeysetRequest {
  operationId: Uint8Array;
  expectedStateSha256: Uint8Array;
  requestedGeneration: bigint;
  predecessorGeneration: bigint;
}

export type WindowsProtectedCreateKeysetDisposition =
  | "created"
  | "exact_replay"
  | "stale_state"
  | "changed_replay"
  | "operator_mismatch"
  | "operation_capacity_exhausted"
  | "generation_capacity_exhausted"
  | "attempt_capacity_exhausted"
  | "generation_conflict"
  | "quarantined";

export interface WindowsProtectedCreateKeysetResult {
  disposition: WindowsProtectedCreateKeysetDisposition;
  operationId: Uint8Array;
  requestedGeneration: bigint;
  predecessorGeneration: bigint;
  expectedStateSha256: Uint8Array;
  observedStateSha256: Uint8Array;
  resultingStateSha256: Uint8Array;
  keysetReceiptSha256: Uint8Array;
  runtimeManifestSpkiSha256: Uint8Array;
  admissionEvidenceSpkiSha256: Uint8Array;
  runtimeManifestSpki: Uint8Array;
  admissionEvidenceSpki: Uint8Array;
}

export type WindowsProtectedRevokeReason = "operator_requested" | "suspected_compromise" | "retired";

export interface WindowsProtectedRevokeKeysetRequest {
  operationId: Uint8Array;
  expectedStateSha256: Uint8Array;
  generation: bigint;
  reason: WindowsProtectedRevokeReason;
  expectedKeysetReceiptSha256: Uint8Array;
}

export type WindowsProtectedRevokeKeysetDisposition =
  | "revoked"
  | "exact_replay"
  | "stale_state"
  | "changed_replay"
  | "operator_mismatch"
  | "operation_capacity_exhausted"
  | "attempt_capacity_exhausted"
  | "generation_not_found"
  | "receipt_mismatch"
  | "already_revoked";

export interface WindowsProtectedRevokeKeysetResult {
  disposition: WindowsProtectedRevokeKeysetDisposition;
  operationId: Uint8Array;
  generation: bigint;
  reason: WindowsProtectedRevokeReason;
  expectedStateSha256: Uint8Array;
  observedStateSha256: Uint8Array;
  resultingStateSha256: Uint8Array;
  keysetReceiptSha256: Uint8Array;
  revokeControlSha256: Uint8Array;
}

/** Canonical, secret-free bytes signed by the protected admission-evidence key. */
export interface WindowsProtectedAdmissionEvidenceEnvelope {
  operationId: Uint8Array;
  evidenceNonceSha256: Uint8Array;
  workerGeneration: bigint;
  contextSha256: Uint8Array;
  runtimeManifestSha256: Uint8Array;
  workerPublicKeySpkiSha256: Uint8Array;
  downloadVerificationReceiptSha256: Uint8Array;
  installedTreeAttestationSha256: Uint8Array;
  installedTreeVerificationReceiptSha256: Uint8Array;
}

export interface WindowsProtectedSignAdmissionEvidenceRequest {
  operationId: Uint8Array;
  expectedStateSha256: Uint8Array;
  expectedGeneration: bigint;
  expectedKeysetReceiptSha256: Uint8Array;
  envelope: WindowsProtectedAdmissionEvidenceEnvelope;
}

export type WindowsProtectedSignAdmissionEvidenceDisposition =
  | "signed"
  | "exact_replay"
  | "stale_state"
  | "keyset_unavailable"
  | "changed_replay"
  | "operator_mismatch"
  | "replay_capacity_exhausted"
  | "signing_failed";

export interface WindowsProtectedSignAdmissionEvidenceResult {
  disposition: WindowsProtectedSignAdmissionEvidenceDisposition;
  operationId: Uint8Array;
  generation: bigint;
  envelopeSha256: Uint8Array;
  keysetReceiptSha256: Uint8Array;
  admissionEvidenceSpkiSha256: Uint8Array;
  admissionEvidenceSpki: Uint8Array;
  signature: Uint8Array;
  protectedStateSha256: Uint8Array;
  requestSha256: Uint8Array;
}

export interface WindowsProtectedRemoteWorkerPopV2Material {
  routeCode: RemoteWorkerPopV2RouteBinding["code"];
  authorityKindCode: 1 | 2;
  authorityGeneration: bigint;
  workerGeneration: bigint;
  timestampEpochMs: bigint;
  workerPublicKeySpkiSha256: Uint8Array;
}

export interface WindowsProtectedSignRuntimePopV2Request {
  expectedStateSha256: Uint8Array;
  expectedGeneration: bigint;
  expectedKeysetReceiptSha256: Uint8Array;
  preimage: Uint8Array;
}

export type WindowsProtectedSignRuntimePopV2Disposition =
  | "signed"
  | "stale_state"
  | "keyset_unavailable"
  | "operation_authority_mismatch"
  | "signing_failed";

export interface WindowsProtectedSignRuntimePopV2Result {
  disposition: WindowsProtectedSignRuntimePopV2Disposition;
  keysetReceiptSha256: Uint8Array;
  runtimeManifestSpkiSha256: Uint8Array;
  runtimeManifestSpki: Uint8Array;
  signature: Uint8Array;
}

export type WindowsHelperResponse =
  | {
      kind: "success";
      requestOpcode: WindowsHelperRequestOpcode;
      payload: Buffer;
    }
  | {
      kind: "error";
      code: WindowsHelperErrorCode;
    };

export interface WindowsHelperProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
}

export interface WindowsHelperRunOptions {
  /** Tests may shorten the deadline, but callers cannot exceed the fixed cap. */
  timeoutMs?: number;
}

export class WindowsHelperProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WindowsHelperProtocolError";
  }
}

export type WindowsHelperProcessErrorReason =
  | "spawn_failed"
  | "stdin_failed"
  | "process_error"
  | "timed_out"
  | "stdout_limit"
  | "stderr_limit"
  | "termination_failed";

export class WindowsHelperProcessError extends Error {
  public readonly reason: WindowsHelperProcessErrorReason;

  public constructor(reason: WindowsHelperProcessErrorReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WindowsHelperProcessError";
    this.reason = reason;
  }
}

export class WindowsHelperExitError extends Error {
  public readonly result: WindowsHelperProcessResult;

  public constructor(result: WindowsHelperProcessResult) {
    super(`Windows provisioner inspect exited unsuccessfully (exit=${String(result.exitCode)})`);
    this.name = "WindowsHelperExitError";
    this.result = result;
  }
}

function assertUint8(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new WindowsHelperProtocolError(`${field} must be an unsigned 8-bit integer`);
  }
}

function assertPayload(payload: Uint8Array, maximumBytes: number): void {
  if (!(payload instanceof Uint8Array)) {
    throw new WindowsHelperProtocolError("payload must be a byte array");
  }
  if (payload.byteLength > maximumBytes) {
    throw new WindowsHelperProtocolError(`payload exceeds the ${String(maximumBytes)}-byte limit`);
  }
}

function isRequestOpcode(value: number): value is WindowsHelperRequestOpcode {
  return REQUEST_OPCODES.has(value);
}

function isErrorCode(value: number): value is WindowsHelperErrorCode {
  return ERROR_CODES.has(value);
}

export function encodeWindowsHelperFrame(opcode: number, payload: Uint8Array = new Uint8Array()): Buffer {
  assertUint8(opcode, "opcode");
  assertPayload(payload, WINDOWS_HELPER_ORDINARY_MAX_BYTES);

  const frame = Buffer.alloc(WINDOWS_HELPER_HEADER_BYTES + payload.byteLength);
  MAGIC_BYTES.copy(frame, 0);
  frame.writeUInt16LE(WINDOWS_HELPER_PROTOCOL_VERSION, 4);
  frame.writeUInt8(opcode, 6);
  frame.writeUInt8(0, 7);
  frame.writeUInt32LE(WINDOWS_HELPER_REQUEST_ID, 8);
  frame.writeUInt32LE(payload.byteLength, 12);
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(frame, WINDOWS_HELPER_HEADER_BYTES);
  return frame;
}

export function encodeWindowsHelperRequest(
  opcode: WindowsHelperRequestOpcode,
  payload: Uint8Array = new Uint8Array(),
): Buffer {
  if (!isRequestOpcode(opcode)) {
    throw new WindowsHelperProtocolError("opcode is not in the closed request-opcode set");
  }
  return encodeWindowsHelperFrame(opcode, payload);
}

export function encodeWindowsHelperInspectRequest(): Buffer {
  return encodeWindowsHelperRequest(WINDOWS_HELPER_OPCODE.INSPECT);
}

export function decodeWindowsHelperFrame(
  bytes: Uint8Array,
  maximumPayloadBytes = WINDOWS_HELPER_ORDINARY_MAX_BYTES,
): WindowsHelperFrame {
  if (!(bytes instanceof Uint8Array)) {
    throw new WindowsHelperProtocolError("frame must be a byte array");
  }
  if (!Number.isInteger(maximumPayloadBytes) || maximumPayloadBytes < 0) {
    throw new WindowsHelperProtocolError("maximum payload length is invalid");
  }
  if (bytes.byteLength < WINDOWS_HELPER_HEADER_BYTES) {
    throw new WindowsHelperProtocolError("frame header is truncated");
  }
  if (bytes.byteLength > WINDOWS_HELPER_HEADER_BYTES + maximumPayloadBytes) {
    throw new WindowsHelperProtocolError("frame exceeds the allowed total length");
  }

  const frame = Buffer.from(bytes);
  if (!frame.subarray(0, MAGIC_BYTES.byteLength).equals(MAGIC_BYTES)) {
    throw new WindowsHelperProtocolError("frame magic is invalid");
  }

  const version = frame.readUInt16LE(4);
  const opcode = frame.readUInt8(6);
  const flags = frame.readUInt8(7);
  const requestId = frame.readUInt32LE(8);
  const payloadLength = frame.readUInt32LE(12);

  if (version !== WINDOWS_HELPER_PROTOCOL_VERSION) {
    throw new WindowsHelperProtocolError("frame version is invalid");
  }
  if (flags !== 0) {
    throw new WindowsHelperProtocolError("frame flags are invalid");
  }
  if (requestId !== WINDOWS_HELPER_REQUEST_ID) {
    throw new WindowsHelperProtocolError("frame request ID is invalid");
  }
  if (payloadLength > maximumPayloadBytes) {
    throw new WindowsHelperProtocolError("declared payload exceeds the allowed limit");
  }

  const expectedLength = WINDOWS_HELPER_HEADER_BYTES + payloadLength;
  if (frame.byteLength !== expectedLength) {
    throw new WindowsHelperProtocolError(
      frame.byteLength < expectedLength ? "frame payload is truncated" : "frame has trailing bytes",
    );
  }

  return {
    version,
    opcode,
    flags,
    requestId,
    payload: Buffer.from(frame.subarray(WINDOWS_HELPER_HEADER_BYTES)),
  };
}

export function decodeWindowsHelperRequest(bytes: Uint8Array): WindowsHelperFrame & {
  opcode: WindowsHelperRequestOpcode;
} {
  const frame = decodeWindowsHelperFrame(bytes);
  if (!isRequestOpcode(frame.opcode)) {
    throw new WindowsHelperProtocolError("opcode is not in the closed request-opcode set");
  }
  return { ...frame, opcode: frame.opcode };
}

export function decodeWindowsHelperResponse(
  bytes: Uint8Array,
  requestOpcode: WindowsHelperRequestOpcode,
): WindowsHelperResponse {
  if (!isRequestOpcode(requestOpcode)) {
    throw new WindowsHelperProtocolError("expected opcode is not in the closed request-opcode set");
  }
  const maximumPayloadBytes =
    requestOpcode === WINDOWS_HELPER_OPCODE.ACQUIRE_KEY_FOR_SIGNING
      ? WINDOWS_HELPER_SECRET_MAX_BYTES
      : WINDOWS_HELPER_ORDINARY_MAX_BYTES;
  const frame = decodeWindowsHelperFrame(bytes, maximumPayloadBytes);

  if (frame.opcode === WINDOWS_HELPER_ERROR_OPCODE) {
    if (frame.payload.byteLength !== WINDOWS_HELPER_ERROR_PAYLOAD_BYTES) {
      throw new WindowsHelperProtocolError("error response payload length is invalid");
    }
    const code = frame.payload.readUInt32LE(0);
    if (!isErrorCode(code)) {
      throw new WindowsHelperProtocolError("error response code is invalid");
    }
    return { kind: "error", code };
  }

  const expectedOpcode = requestOpcode | 0x80;
  if (frame.opcode !== expectedOpcode) {
    throw new WindowsHelperProtocolError("success response opcode does not match the request");
  }
  return { kind: "success", requestOpcode, payload: frame.payload };
}

export function decodeWindowsHelperInspectResponse(bytes: Uint8Array): WindowsHelperInspect {
  const response = decodeWindowsHelperResponse(bytes, WINDOWS_HELPER_OPCODE.INSPECT);
  if (response.kind === "error") {
    throw new WindowsHelperProtocolError(`inspect returned protocol error ${String(response.code)}`);
  }
  if (response.payload.byteLength !== WINDOWS_HELPER_INSPECT_PAYLOAD_BYTES) {
    throw new WindowsHelperProtocolError("inspect payload length is invalid");
  }

  const payload = response.payload;
  const schemaVersion = payload.readUInt16LE(0);
  const machine = payload.readUInt16LE(2);
  const ordinaryMaximumBytes = payload.readUInt32LE(4);
  const secretMaximumBytes = payload.readUInt32LE(8);
  const flags = payload.readUInt32LE(12);
  const recognizedOpcodeBitmap = payload.readBigUInt64LE(16);
  const callableOpcodeBitmap = payload.readBigUInt64LE(24);

  if (schemaVersion !== 1) {
    throw new WindowsHelperProtocolError("inspect schema version is invalid");
  }
  if (machine !== WINDOWS_HELPER_PE_MACHINE.X64 && machine !== WINDOWS_HELPER_PE_MACHINE.ARM64) {
    throw new WindowsHelperProtocolError("inspect PE machine is invalid");
  }
  if (ordinaryMaximumBytes !== WINDOWS_HELPER_ORDINARY_MAX_BYTES) {
    throw new WindowsHelperProtocolError("inspect ordinary maximum is invalid");
  }
  if (secretMaximumBytes !== WINDOWS_HELPER_SECRET_MAX_BYTES) {
    throw new WindowsHelperProtocolError("inspect secret maximum is invalid");
  }
  if (flags !== 0) {
    throw new WindowsHelperProtocolError("inspect flags are invalid");
  }
  if (recognizedOpcodeBitmap !== WINDOWS_HELPER_RECOGNIZED_OPCODE_BITMAP) {
    throw new WindowsHelperProtocolError("inspect recognized-opcode bitmap is invalid");
  }
  if (callableOpcodeBitmap !== WINDOWS_HELPER_CALLABLE_OPCODE_BITMAP) {
    throw new WindowsHelperProtocolError("inspect callable-opcode bitmap is invalid");
  }

  return {
    schemaVersion,
    machine,
    ordinaryMaximumBytes,
    secretMaximumBytes,
    flags,
    recognizedOpcodeBitmap,
    callableOpcodeBitmap,
  };
}

const CREATE_DISPOSITIONS = [
  "created",
  "exact_replay",
  "stale_state",
  "changed_replay",
  "operator_mismatch",
  "operation_capacity_exhausted",
  "generation_capacity_exhausted",
  "attempt_capacity_exhausted",
  "generation_conflict",
  "quarantined",
] as const;
const REVOKE_DISPOSITIONS = [
  "revoked",
  "exact_replay",
  "stale_state",
  "changed_replay",
  "operator_mismatch",
  "operation_capacity_exhausted",
  "attempt_capacity_exhausted",
  "generation_not_found",
  "receipt_mismatch",
  "already_revoked",
] as const;
const REVOKE_REASONS = ["operator_requested", "suspected_compromise", "retired"] as const;
const SIGN_ADMISSION_EVIDENCE_DISPOSITIONS = [
  "signed",
  "exact_replay",
  "stale_state",
  "keyset_unavailable",
  "changed_replay",
  "operator_mismatch",
  "replay_capacity_exhausted",
  "signing_failed",
] as const;
const SIGN_RUNTIME_POP_V2_DISPOSITIONS = Object.freeze({
  1: "signed",
  3: "stale_state",
  4: "keyset_unavailable",
  5: "operation_authority_mismatch",
  8: "signing_failed",
} as const);
const CUSTODY_POSTURES = [
  "empty",
  "active",
  "no_active_revoked_or_quarantined",
  "capacity_exhausted_active",
  "capacity_exhausted_no_active",
] as const;

function exactBytes(value: Uint8Array, length: number, field: string, nonzero = false): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new WindowsHelperProtocolError(`${field} must be exactly ${String(length)} bytes`);
  }
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (nonzero && bytes.every((byte) => byte === 0)) {
    throw new WindowsHelperProtocolError(`${field} must be nonzero`);
  }
  return bytes;
}

function exactU64(value: bigint, field: string, nonzero = false): bigint {
  if (typeof value !== "bigint" || value < 0n || value > 0xffff_ffff_ffff_ffffn || (nonzero && value === 0n)) {
    throw new WindowsHelperProtocolError(`${field} is outside the unsigned 64-bit range`);
  }
  return value;
}

function requireZero(bytes: Buffer, offset: number, length: number, field: string): void {
  if (!bytes.subarray(offset, offset + length).every((byte) => byte === 0)) {
    throw new WindowsHelperProtocolError(`${field} must be zero`);
  }
}

function requireNonzero(bytes: Buffer, offset: number, length: number, field: string): void {
  if (bytes.subarray(offset, offset + length).every((byte) => byte === 0)) {
    throw new WindowsHelperProtocolError(`${field} must be populated`);
  }
}

function sha256(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

export function encodeWindowsProtectedAdmissionEvidenceEnvelope(
  input: WindowsProtectedAdmissionEvidenceEnvelope,
): Buffer {
  const envelope = Buffer.alloc(WINDOWS_PROTECTED_ADMISSION_EVIDENCE_ENVELOPE_BYTES);
  envelope.write("GCAE", 0, "ascii");
  envelope.writeUInt16LE(1, 4);
  envelope.writeUInt8(1, 6);
  envelope.writeUInt32LE(WINDOWS_PROTECTED_ADMISSION_EVIDENCE_ENVELOPE_BYTES, 8);
  exactBytes(input.operationId, 16, "envelope.operationId", true).copy(envelope, 16);
  exactBytes(input.evidenceNonceSha256, 32, "envelope.evidenceNonceSha256", true).copy(envelope, 32);
  envelope.writeBigUInt64LE(exactU64(input.workerGeneration, "envelope.workerGeneration", true), 64);
  exactBytes(input.contextSha256, 32, "envelope.contextSha256", true).copy(envelope, 96);
  exactBytes(input.runtimeManifestSha256, 32, "envelope.runtimeManifestSha256", true).copy(envelope, 128);
  exactBytes(input.workerPublicKeySpkiSha256, 32, "envelope.workerPublicKeySpkiSha256", true).copy(envelope, 160);
  exactBytes(input.downloadVerificationReceiptSha256, 32, "envelope.downloadVerificationReceiptSha256", true).copy(
    envelope,
    192,
  );
  exactBytes(input.installedTreeAttestationSha256, 32, "envelope.installedTreeAttestationSha256", true).copy(
    envelope,
    224,
  );
  exactBytes(
    input.installedTreeVerificationReceiptSha256,
    32,
    "envelope.installedTreeVerificationReceiptSha256",
    true,
  ).copy(envelope, 256);
  return envelope;
}

export function decodeWindowsProtectedAdmissionEvidenceEnvelope(
  bytes: Uint8Array,
): WindowsProtectedAdmissionEvidenceEnvelope {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== WINDOWS_PROTECTED_ADMISSION_EVIDENCE_ENVELOPE_BYTES) {
    throw new WindowsHelperProtocolError("admission-evidence envelope length is invalid");
  }
  const envelope = Buffer.from(bytes);
  if (
    envelope.toString("ascii", 0, 4) !== "GCAE" ||
    envelope.readUInt16LE(4) !== 1 ||
    envelope.readUInt8(6) !== 1 ||
    envelope.readUInt8(7) !== 0 ||
    envelope.readUInt32LE(8) !== WINDOWS_PROTECTED_ADMISSION_EVIDENCE_ENVELOPE_BYTES ||
    envelope.readUInt32LE(12) !== 0
  ) {
    throw new WindowsHelperProtocolError("admission-evidence envelope header is invalid");
  }
  requireNonzero(envelope, 16, 16, "admission-evidence operation ID");
  requireNonzero(envelope, 32, 32, "admission-evidence nonce hash");
  if (envelope.readBigUInt64LE(64) === 0n) {
    throw new WindowsHelperProtocolError("admission-evidence worker generation must be nonzero");
  }
  requireZero(envelope, 72, 24, "admission-evidence reserved field");
  for (const [offset, field] of [
    [96, "context hash"],
    [128, "runtime manifest hash"],
    [160, "worker public-key hash"],
    [192, "download verification receipt hash"],
    [224, "installed-tree attestation hash"],
    [256, "installed-tree verification receipt hash"],
  ] as const) {
    requireNonzero(envelope, offset, 32, `admission-evidence ${field}`);
  }
  return {
    operationId: Buffer.from(envelope.subarray(16, 32)),
    evidenceNonceSha256: Buffer.from(envelope.subarray(32, 64)),
    workerGeneration: envelope.readBigUInt64LE(64),
    contextSha256: Buffer.from(envelope.subarray(96, 128)),
    runtimeManifestSha256: Buffer.from(envelope.subarray(128, 160)),
    workerPublicKeySpkiSha256: Buffer.from(envelope.subarray(160, 192)),
    downloadVerificationReceiptSha256: Buffer.from(envelope.subarray(192, 224)),
    installedTreeAttestationSha256: Buffer.from(envelope.subarray(224, 256)),
    installedTreeVerificationReceiptSha256: Buffer.from(envelope.subarray(256, 288)),
  };
}

export function buildWindowsProtectedAdmissionEvidenceSigningBytes(envelope: Uint8Array): Buffer {
  decodeWindowsProtectedAdmissionEvidenceEnvelope(envelope);
  return Buffer.concat([
    Buffer.from(`${WINDOWS_PROTECTED_ADMISSION_EVIDENCE_SIGNATURE_DOMAIN}\0`, "utf8"),
    Buffer.from(envelope),
  ]);
}

export function validateWindowsProtectedRemoteWorkerPopV2Preimage(
  value: Uint8Array,
): WindowsProtectedRemoteWorkerPopV2Material {
  if (!(value instanceof Uint8Array) || value.byteLength !== REMOTE_WORKER_POP_V2_PREIMAGE_BYTES) {
    throw new WindowsHelperProtocolError("remote-worker PoP-v2 preimage length is invalid");
  }
  const preimage = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const domain = Buffer.from(REMOTE_WORKER_POP_V2_DOMAIN, "utf8");
  if (
    domain.byteLength !== 33 ||
    !preimage.subarray(0, domain.byteLength).equals(domain) ||
    preimage.readUInt8(domain.byteLength) !== 2 ||
    preimage.readUInt8(domain.byteLength + 1) !== 1
  ) {
    throw new WindowsHelperProtocolError("remote-worker PoP-v2 domain or fixed header is invalid");
  }
  const routeCode = preimage.readUInt8(domain.byteLength + 2);
  const authorityKindCode = preimage.readUInt8(domain.byteLength + 3);
  const route = REMOTE_WORKER_POP_V2_ROUTE_BINDINGS.find((candidate) => candidate.code === routeCode);
  const expectedAuthorityKindCode =
    route?.authorityKind === "bootstrap" ? 1 : route?.authorityKind === "credential" ? 2 : 0;
  if (route === undefined || authorityKindCode !== expectedAuthorityKindCode) {
    throw new WindowsHelperProtocolError("remote-worker PoP-v2 route and authority purpose are invalid");
  }
  const authorityGeneration = preimage.readBigUInt64BE(domain.byteLength + 4);
  const workerGeneration = preimage.readBigUInt64BE(domain.byteLength + 12);
  const timestampEpochMs = preimage.readBigUInt64BE(domain.byteLength + 20);
  const maximumSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);
  if (
    authorityGeneration === 0n ||
    authorityGeneration > maximumSafeInteger ||
    workerGeneration === 0n ||
    workerGeneration > maximumSafeInteger ||
    timestampEpochMs > maximumSafeInteger
  ) {
    throw new WindowsHelperProtocolError("remote-worker PoP-v2 integer authority is invalid");
  }
  const workerPublicKeyOffset = domain.byteLength + 28 + 4 * 32;
  return {
    routeCode: route.code,
    authorityKindCode: authorityKindCode as 1 | 2,
    authorityGeneration,
    workerGeneration,
    timestampEpochMs,
    workerPublicKeySpkiSha256: Buffer.from(preimage.subarray(workerPublicKeyOffset, workerPublicKeyOffset + 32)),
  };
}

export function validateWindowsProtectedRequestPayload(opcode: WindowsHelperRequestOpcode, payload: Uint8Array): void {
  const body = Buffer.from(payload);
  if (opcode === WINDOWS_HELPER_OPCODE.INSPECT) {
    if (body.byteLength !== 0) throw new WindowsHelperProtocolError("inspect request payload must be empty");
    return;
  }
  if (opcode === WINDOWS_HELPER_OPCODE.CREATE_KEYSET) {
    if (body.byteLength !== WINDOWS_PROTECTED_CREATE_KEYSET_REQUEST_BYTES) {
      throw new WindowsHelperProtocolError("create request payload length is invalid");
    }
    requireNonzero(body, 0, 16, "create request operation ID");
    requireNonzero(body, 16, 32, "create request expected state");
    if (body.readUInt16LE(48) !== 1) throw new WindowsHelperProtocolError("create request schema is invalid");
    requireZero(body, 50, 2, "create request reserved field");
    if (body.readBigUInt64LE(52) === 0n)
      throw new WindowsHelperProtocolError("create requested generation must be nonzero");
    requireZero(body, 68, 4, "create request trailing reserved field");
    return;
  }
  if (opcode === WINDOWS_HELPER_OPCODE.REVOKE_LOCAL_KEYSET) {
    if (body.byteLength !== WINDOWS_PROTECTED_REVOKE_KEYSET_REQUEST_BYTES) {
      throw new WindowsHelperProtocolError("revoke request payload length is invalid");
    }
    requireNonzero(body, 0, 16, "revoke request operation ID");
    requireNonzero(body, 16, 32, "revoke request expected state");
    if (body.readUInt16LE(48) !== 1) throw new WindowsHelperProtocolError("revoke request schema is invalid");
    requireZero(body, 50, 2, "revoke request reserved field");
    if (body.readBigUInt64LE(52) === 0n) throw new WindowsHelperProtocolError("revoke generation must be nonzero");
    if (body.readUInt32LE(60) < 1 || body.readUInt32LE(60) > 3) {
      throw new WindowsHelperProtocolError("revoke reason is outside the closed set");
    }
    requireZero(body, 64, 4, "revoke request reserved field");
    requireNonzero(body, 68, 32, "revoke request expected receipt hash");
    return;
  }
  if (opcode === WINDOWS_HELPER_OPCODE.SIGN_ADMISSION_EVIDENCE) {
    if (body.byteLength !== WINDOWS_PROTECTED_SIGN_ADMISSION_EVIDENCE_REQUEST_BYTES) {
      throw new WindowsHelperProtocolError("sign admission-evidence request payload length is invalid");
    }
    requireNonzero(body, 0, 16, "sign admission-evidence request operation ID");
    requireNonzero(body, 16, 32, "sign admission-evidence request expected state");
    if (body.readUInt16LE(48) !== 1 || body.readUInt8(50) !== 2 || body.readUInt8(51) !== 0) {
      throw new WindowsHelperProtocolError("sign admission-evidence request header is invalid");
    }
    if (body.readBigUInt64LE(52) === 0n) {
      throw new WindowsHelperProtocolError("sign admission-evidence request generation must be nonzero");
    }
    requireNonzero(body, 60, 32, "sign admission-evidence request expected receipt hash");
    if (body.readUInt32LE(92) !== WINDOWS_PROTECTED_ADMISSION_EVIDENCE_ENVELOPE_BYTES) {
      throw new WindowsHelperProtocolError("sign admission-evidence envelope length is invalid");
    }
    const envelope = decodeWindowsProtectedAdmissionEvidenceEnvelope(body.subarray(96));
    if (!body.subarray(0, 16).equals(envelope.operationId)) {
      throw new WindowsHelperProtocolError("sign admission-evidence operation ID does not bind the envelope");
    }
    if (body.readBigUInt64LE(52) !== envelope.workerGeneration) {
      throw new WindowsHelperProtocolError("sign admission-evidence generation does not bind the envelope");
    }
    return;
  }
  if (opcode === WINDOWS_HELPER_OPCODE.SIGN_RUNTIME_POP_V2) {
    if (body.byteLength !== WINDOWS_PROTECTED_SIGN_RUNTIME_POP_V2_REQUEST_BYTES) {
      throw new WindowsHelperProtocolError("sign runtime PoP-v2 request payload length is invalid");
    }
    requireZero(body, 0, 16, "sign runtime PoP-v2 caller operation placeholder");
    requireNonzero(body, 16, 32, "sign runtime PoP-v2 request expected state");
    if (body.readUInt16LE(48) !== 1 || body.readUInt8(50) !== 3 || body.readUInt8(51) !== 0) {
      throw new WindowsHelperProtocolError("sign runtime PoP-v2 request header is invalid");
    }
    const expectedGeneration = body.readBigUInt64LE(52);
    if (expectedGeneration === 0n || expectedGeneration > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new WindowsHelperProtocolError("sign runtime PoP-v2 request generation is invalid");
    }
    requireNonzero(body, 60, 32, "sign runtime PoP-v2 request expected receipt hash");
    if (body.readUInt32LE(92) !== REMOTE_WORKER_POP_V2_PREIMAGE_BYTES) {
      throw new WindowsHelperProtocolError("sign runtime PoP-v2 preimage length is invalid");
    }
    const material = validateWindowsProtectedRemoteWorkerPopV2Preimage(
      body.subarray(96, 96 + REMOTE_WORKER_POP_V2_PREIMAGE_BYTES),
    );
    if (material.workerGeneration !== expectedGeneration) {
      throw new WindowsHelperProtocolError("sign runtime PoP-v2 generation does not bind the preimage");
    }
    requireZero(
      body,
      96 + REMOTE_WORKER_POP_V2_PREIMAGE_BYTES,
      WINDOWS_PROTECTED_SIGN_RUNTIME_POP_V2_REQUEST_BYTES - 96 - REMOTE_WORKER_POP_V2_PREIMAGE_BYTES,
      "sign runtime PoP-v2 trailing reserved field",
    );
  }
}

function protectedSuccessPayload(bytes: Uint8Array, opcode: WindowsHelperRequestOpcode, exactLength: number): Buffer {
  const response = decodeWindowsHelperResponse(bytes, opcode);
  if (response.kind === "error") {
    throw new WindowsHelperProtocolError(`protected operation returned protocol error ${String(response.code)}`);
  }
  if (response.payload.byteLength !== exactLength) {
    throw new WindowsHelperProtocolError("protected response payload length is invalid");
  }
  return response.payload;
}

export function encodeWindowsProtectedCreateKeysetRequest(input: WindowsProtectedCreateKeysetRequest): Buffer {
  const body = Buffer.alloc(WINDOWS_PROTECTED_CREATE_KEYSET_REQUEST_BYTES);
  exactBytes(input.operationId, 16, "operationId", true).copy(body, 0);
  exactBytes(input.expectedStateSha256, 32, "expectedStateSha256", true).copy(body, 16);
  body.writeUInt16LE(1, 48);
  body.writeBigUInt64LE(exactU64(input.requestedGeneration, "requestedGeneration", true), 52);
  body.writeBigUInt64LE(exactU64(input.predecessorGeneration, "predecessorGeneration"), 60);
  return encodeWindowsHelperRequest(WINDOWS_HELPER_OPCODE.CREATE_KEYSET, body);
}

export function encodeWindowsProtectedRevokeKeysetRequest(input: WindowsProtectedRevokeKeysetRequest): Buffer {
  const reason = REVOKE_REASONS.indexOf(input.reason) + 1;
  if (reason === 0) throw new WindowsHelperProtocolError("reason is outside the closed revoke-reason set");
  const body = Buffer.alloc(WINDOWS_PROTECTED_REVOKE_KEYSET_REQUEST_BYTES);
  exactBytes(input.operationId, 16, "operationId", true).copy(body, 0);
  exactBytes(input.expectedStateSha256, 32, "expectedStateSha256", true).copy(body, 16);
  body.writeUInt16LE(1, 48);
  body.writeBigUInt64LE(exactU64(input.generation, "generation", true), 52);
  body.writeUInt32LE(reason, 60);
  exactBytes(input.expectedKeysetReceiptSha256, 32, "expectedKeysetReceiptSha256", true).copy(body, 68);
  return encodeWindowsHelperRequest(WINDOWS_HELPER_OPCODE.REVOKE_LOCAL_KEYSET, body);
}

export function encodeWindowsProtectedSignAdmissionEvidenceRequest(
  input: WindowsProtectedSignAdmissionEvidenceRequest,
): Buffer {
  const operationId = exactBytes(input.operationId, 16, "operationId", true);
  const generation = exactU64(input.expectedGeneration, "expectedGeneration", true);
  const envelope = encodeWindowsProtectedAdmissionEvidenceEnvelope(input.envelope);
  if (!operationId.equals(envelope.subarray(16, 32))) {
    throw new WindowsHelperProtocolError("operationId must equal envelope.operationId");
  }
  if (generation !== envelope.readBigUInt64LE(64)) {
    throw new WindowsHelperProtocolError("expectedGeneration must equal envelope.workerGeneration");
  }
  const body = Buffer.alloc(WINDOWS_PROTECTED_SIGN_ADMISSION_EVIDENCE_REQUEST_BYTES);
  operationId.copy(body, 0);
  exactBytes(input.expectedStateSha256, 32, "expectedStateSha256", true).copy(body, 16);
  body.writeUInt16LE(1, 48);
  body.writeUInt8(2, 50);
  body.writeBigUInt64LE(generation, 52);
  exactBytes(input.expectedKeysetReceiptSha256, 32, "expectedKeysetReceiptSha256", true).copy(body, 60);
  body.writeUInt32LE(WINDOWS_PROTECTED_ADMISSION_EVIDENCE_ENVELOPE_BYTES, 92);
  envelope.copy(body, 96);
  return encodeWindowsHelperRequest(WINDOWS_HELPER_OPCODE.SIGN_ADMISSION_EVIDENCE, body);
}

export function encodeWindowsProtectedSignRuntimePopV2Request(input: WindowsProtectedSignRuntimePopV2Request): Buffer {
  const expectedState = exactBytes(input.expectedStateSha256, 32, "expectedStateSha256", true);
  const expectedGeneration = exactU64(input.expectedGeneration, "expectedGeneration", true);
  if (expectedGeneration > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new WindowsHelperProtocolError("expectedGeneration is outside the contract-safe integer range");
  }
  const expectedReceipt = exactBytes(input.expectedKeysetReceiptSha256, 32, "expectedKeysetReceiptSha256", true);
  const preimage = exactBytes(input.preimage, REMOTE_WORKER_POP_V2_PREIMAGE_BYTES, "preimage");
  const material = validateWindowsProtectedRemoteWorkerPopV2Preimage(preimage);
  if (material.workerGeneration !== expectedGeneration) {
    throw new WindowsHelperProtocolError("expectedGeneration must equal the PoP-v2 worker generation");
  }
  const body = Buffer.alloc(WINDOWS_PROTECTED_SIGN_RUNTIME_POP_V2_REQUEST_BYTES);
  expectedState.copy(body, 16);
  body.writeUInt16LE(1, 48);
  body.writeUInt8(3, 50);
  body.writeBigUInt64LE(expectedGeneration, 52);
  expectedReceipt.copy(body, 60);
  body.writeUInt32LE(REMOTE_WORKER_POP_V2_PREIMAGE_BYTES, 92);
  preimage.copy(body, 96);
  return encodeWindowsHelperRequest(WINDOWS_HELPER_OPCODE.SIGN_RUNTIME_POP_V2, body);
}

export function decodeWindowsProtectedInspectResponse(bytes: Uint8Array): WindowsProtectedInspect {
  const payload = protectedSuccessPayload(
    bytes,
    WINDOWS_HELPER_OPCODE.INSPECT,
    WINDOWS_PROTECTED_INSPECT_PAYLOAD_BYTES,
  );
  const legacyFrame = encodeWindowsHelperFrame(WINDOWS_HELPER_OPCODE.INSPECT | 0x80, payload.subarray(0, 32));
  const legacy = decodeWindowsHelperInspectResponse(legacyFrame);
  if (payload.readUInt16LE(32) !== 1) throw new WindowsHelperProtocolError("protected inspect schema is invalid");
  const posture = CUSTODY_POSTURES[payload.readUInt16LE(34)];
  if (posture === undefined) throw new WindowsHelperProtocolError("protected inspect posture is invalid");
  const protectedFlags = payload.readUInt32LE(36);
  if ((protectedFlags & ~0x7) !== 0) throw new WindowsHelperProtocolError("protected inspect flags are invalid");
  if (payload.readBigUInt64LE(40) !== WINDOWS_PROTECTED_CALLABLE_OPCODE_BITMAP) {
    throw new WindowsHelperProtocolError("protected callable-opcode bitmap is invalid");
  }
  requireZero(payload, 124, 4, "protected inspect reserved field");
  requireZero(payload, 312, 8, "protected inspect trailing reserved field");
  const activeGeneration = payload.readBigUInt64LE(80);
  const activeReceipt = Buffer.from(payload.subarray(128, 160));
  const runtimeHash = Buffer.from(payload.subarray(160, 192));
  const evidenceHash = Buffer.from(payload.subarray(192, 224));
  const runtimeSpki = Buffer.from(payload.subarray(224, 268));
  const evidenceSpki = Buffer.from(payload.subarray(268, 312));
  if (
    activeGeneration === 0n &&
    !Buffer.concat([activeReceipt, runtimeHash, evidenceHash, runtimeSpki, evidenceSpki]).every((b) => b === 0)
  ) {
    throw new WindowsHelperProtocolError("inactive protected inspect contains keyset authority");
  }
  return {
    ...legacy,
    protectedSchemaVersion: 1,
    custodyPosture: posture,
    protectedFlags,
    protectedCallableOpcodeBitmap: WINDOWS_PROTECTED_CALLABLE_OPCODE_BITMAP,
    stateSha256: Buffer.from(payload.subarray(48, 80)),
    activeGeneration,
    highestBurnedGeneration: payload.readBigUInt64LE(88),
    committedGenerationCount: payload.readUInt32LE(96),
    burnedGenerationCount: payload.readUInt32LE(100),
    totalOperationIdCount: payload.readUInt32LE(104),
    quarantinedOperationCount: payload.readUInt32LE(108),
    quarantineResidueCount: payload.readUInt32LE(112),
    remainingOperationCapacity: payload.readUInt32LE(116),
    remainingGenerationCapacity: payload.readUInt32LE(120),
    activeKeysetReceiptSha256: activeReceipt,
    runtimeManifestSpkiSha256: runtimeHash,
    admissionEvidenceSpkiSha256: evidenceHash,
    runtimeManifestSpki: runtimeSpki,
    admissionEvidenceSpki: evidenceSpki,
  };
}

export function decodeWindowsProtectedCreateKeysetResponse(
  bytes: Uint8Array,
  expectedRequest: WindowsProtectedCreateKeysetRequest,
): WindowsProtectedCreateKeysetResult {
  const expectedId = exactBytes(expectedRequest.operationId, 16, "operationId", true);
  const expectedState = exactBytes(expectedRequest.expectedStateSha256, 32, "expectedStateSha256", true);
  const payload = protectedSuccessPayload(
    bytes,
    WINDOWS_HELPER_OPCODE.CREATE_KEYSET,
    WINDOWS_PROTECTED_CREATE_KEYSET_RESULT_BYTES,
  );
  if (payload.readUInt16LE(0) !== 1 || payload.readUInt32LE(4) !== 0)
    throw new WindowsHelperProtocolError("create result header is invalid");
  const disposition = CREATE_DISPOSITIONS[payload.readUInt16LE(2) - 1];
  if (disposition === undefined) throw new WindowsHelperProtocolError("create result disposition is invalid");
  if (!payload.subarray(8, 24).equals(expectedId))
    throw new WindowsHelperProtocolError("create result operation ID differs from request");
  if (
    payload.readBigUInt64LE(24) !== exactU64(expectedRequest.requestedGeneration, "requestedGeneration", true) ||
    payload.readBigUInt64LE(32) !== exactU64(expectedRequest.predecessorGeneration, "predecessorGeneration")
  ) {
    throw new WindowsHelperProtocolError("create result generation authority differs from request");
  }
  if (!payload.subarray(40, 72).equals(expectedState)) {
    throw new WindowsHelperProtocolError("create result expected state differs from request");
  }
  if (
    disposition !== "created" &&
    disposition !== "quarantined" &&
    !payload.subarray(72, 104).equals(payload.subarray(104, 136))
  ) {
    throw new WindowsHelperProtocolError("create non-mutating result changed protected state");
  }
  const carriesKeyset = disposition === "created" || disposition === "exact_replay";
  if (carriesKeyset) {
    requireNonzero(payload, 136, 32, "create result receipt hash");
    requireNonzero(payload, 168, 32, "create result runtime SPKI hash");
    requireNonzero(payload, 200, 32, "create result evidence SPKI hash");
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    if (!payload.subarray(232, 244).equals(spkiPrefix) || !payload.subarray(276, 288).equals(spkiPrefix)) {
      throw new WindowsHelperProtocolError("create result SPKI is not canonical Ed25519");
    }
    requireNonzero(payload, 244, 32, "create result runtime public key");
    requireNonzero(payload, 288, 32, "create result evidence public key");
  } else {
    requireZero(payload, 136, 184, "create rejection keyset authority");
  }
  return {
    disposition,
    operationId: Buffer.from(payload.subarray(8, 24)),
    requestedGeneration: payload.readBigUInt64LE(24),
    predecessorGeneration: payload.readBigUInt64LE(32),
    expectedStateSha256: Buffer.from(payload.subarray(40, 72)),
    observedStateSha256: Buffer.from(payload.subarray(72, 104)),
    resultingStateSha256: Buffer.from(payload.subarray(104, 136)),
    keysetReceiptSha256: Buffer.from(payload.subarray(136, 168)),
    runtimeManifestSpkiSha256: Buffer.from(payload.subarray(168, 200)),
    admissionEvidenceSpkiSha256: Buffer.from(payload.subarray(200, 232)),
    runtimeManifestSpki: Buffer.from(payload.subarray(232, 276)),
    admissionEvidenceSpki: Buffer.from(payload.subarray(276, 320)),
  };
}

export function decodeWindowsProtectedRevokeKeysetResponse(
  bytes: Uint8Array,
  expectedRequest: WindowsProtectedRevokeKeysetRequest,
): WindowsProtectedRevokeKeysetResult {
  const expectedId = exactBytes(expectedRequest.operationId, 16, "operationId", true);
  const expectedState = exactBytes(expectedRequest.expectedStateSha256, 32, "expectedStateSha256", true);
  const payload = protectedSuccessPayload(
    bytes,
    WINDOWS_HELPER_OPCODE.REVOKE_LOCAL_KEYSET,
    WINDOWS_PROTECTED_REVOKE_KEYSET_RESULT_BYTES,
  );
  if (payload.readUInt16LE(0) !== 1 || payload.readUInt32LE(4) !== 0)
    throw new WindowsHelperProtocolError("revoke result header is invalid");
  const disposition = REVOKE_DISPOSITIONS[payload.readUInt16LE(2) - 1];
  const reason = REVOKE_REASONS[payload.readUInt32LE(32) - 1];
  if (disposition === undefined || reason === undefined)
    throw new WindowsHelperProtocolError("revoke result closed enum is invalid");
  requireZero(payload, 36, 4, "revoke result reserved field");
  if (!payload.subarray(8, 24).equals(expectedId))
    throw new WindowsHelperProtocolError("revoke result operation ID differs from request");
  const expectedReason = REVOKE_REASONS.indexOf(expectedRequest.reason) + 1;
  if (
    payload.readBigUInt64LE(24) !== exactU64(expectedRequest.generation, "generation", true) ||
    payload.readUInt32LE(32) !== expectedReason
  ) {
    throw new WindowsHelperProtocolError("revoke result generation or reason differs from request");
  }
  if (!payload.subarray(40, 72).equals(expectedState)) {
    throw new WindowsHelperProtocolError("revoke result expected state differs from request");
  }
  if (disposition !== "revoked" && !payload.subarray(72, 104).equals(payload.subarray(104, 136))) {
    throw new WindowsHelperProtocolError("revoke non-mutating result changed protected state");
  }
  if (disposition === "revoked" || disposition === "exact_replay") {
    requireNonzero(payload, 136, 32, "revoke result receipt hash");
    requireNonzero(payload, 168, 32, "revoke result control hash");
  } else {
    requireZero(payload, 136, 64, "revoke rejection authority");
  }
  return {
    disposition,
    operationId: Buffer.from(payload.subarray(8, 24)),
    generation: payload.readBigUInt64LE(24),
    reason,
    expectedStateSha256: Buffer.from(payload.subarray(40, 72)),
    observedStateSha256: Buffer.from(payload.subarray(72, 104)),
    resultingStateSha256: Buffer.from(payload.subarray(104, 136)),
    keysetReceiptSha256: Buffer.from(payload.subarray(136, 168)),
    revokeControlSha256: Buffer.from(payload.subarray(168, 200)),
  };
}

export function decodeWindowsProtectedSignAdmissionEvidenceResponse(
  bytes: Uint8Array,
  expectedRequest: WindowsProtectedSignAdmissionEvidenceRequest,
): WindowsProtectedSignAdmissionEvidenceResult {
  const expectedId = exactBytes(expectedRequest.operationId, 16, "operationId", true);
  const expectedState = exactBytes(expectedRequest.expectedStateSha256, 32, "expectedStateSha256", true);
  const expectedGeneration = exactU64(expectedRequest.expectedGeneration, "expectedGeneration", true);
  const expectedReceipt = exactBytes(
    expectedRequest.expectedKeysetReceiptSha256,
    32,
    "expectedKeysetReceiptSha256",
    true,
  );
  const requestFrame = encodeWindowsProtectedSignAdmissionEvidenceRequest(expectedRequest);
  const requestBody = requestFrame.subarray(WINDOWS_HELPER_HEADER_BYTES);
  const envelope = requestBody.subarray(96);
  const payload = protectedSuccessPayload(
    bytes,
    WINDOWS_HELPER_OPCODE.SIGN_ADMISSION_EVIDENCE,
    WINDOWS_PROTECTED_SIGN_ADMISSION_EVIDENCE_RESULT_BYTES,
  );
  if (payload.readUInt16LE(0) !== 1 || payload.readUInt32LE(4) !== 0) {
    throw new WindowsHelperProtocolError("sign admission-evidence result header is invalid");
  }
  const disposition = SIGN_ADMISSION_EVIDENCE_DISPOSITIONS[payload.readUInt16LE(2) - 1];
  if (disposition === undefined) {
    throw new WindowsHelperProtocolError("sign admission-evidence result disposition is invalid");
  }
  requireZero(payload, 300, 20, "sign admission-evidence trailing reserved field");
  if (!payload.subarray(8, 24).equals(expectedId)) {
    throw new WindowsHelperProtocolError("sign admission-evidence result operation ID differs from request");
  }
  if (payload.readBigUInt64LE(24) !== expectedGeneration) {
    throw new WindowsHelperProtocolError("sign admission-evidence result generation differs from request");
  }
  if (!payload.subarray(32, 64).equals(sha256(envelope))) {
    throw new WindowsHelperProtocolError("sign admission-evidence result envelope hash differs from canonical bytes");
  }
  if (!payload.subarray(268, 300).equals(sha256(requestBody))) {
    throw new WindowsHelperProtocolError("sign admission-evidence result request hash differs from canonical bytes");
  }
  requireNonzero(payload, 236, 32, "sign admission-evidence protected state hash");

  const carriesSignature = disposition === "signed" || disposition === "exact_replay";
  if (carriesSignature) {
    if (!payload.subarray(64, 96).equals(expectedReceipt)) {
      throw new WindowsHelperProtocolError("sign admission-evidence result keyset receipt differs from request");
    }
    if (!payload.subarray(236, 268).equals(expectedState)) {
      throw new WindowsHelperProtocolError("sign admission-evidence successful result changed protected state");
    }
    requireNonzero(payload, 96, 32, "sign admission-evidence SPKI hash");
    const spki = payload.subarray(128, 172);
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    if (!spki.subarray(0, 12).equals(spkiPrefix)) {
      throw new WindowsHelperProtocolError("sign admission-evidence SPKI is not canonical Ed25519");
    }
    requireNonzero(spki, 12, 32, "sign admission-evidence public key");
    if (!payload.subarray(96, 128).equals(sha256(spki))) {
      throw new WindowsHelperProtocolError("sign admission-evidence SPKI hash is invalid");
    }
    requireNonzero(payload, 172, 64, "sign admission-evidence signature");
    let verified: boolean;
    try {
      const publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
      verified = verify(
        null,
        buildWindowsProtectedAdmissionEvidenceSigningBytes(envelope),
        publicKey,
        payload.subarray(172, 236),
      );
    } catch (error) {
      throw new WindowsHelperProtocolError(
        `sign admission-evidence public receipt is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!verified) {
      throw new WindowsHelperProtocolError("sign admission-evidence signature does not verify in its fixed domain");
    }
  } else {
    requireZero(payload, 64, 172, "sign admission-evidence rejection authority");
  }
  return {
    disposition,
    operationId: Buffer.from(payload.subarray(8, 24)),
    generation: payload.readBigUInt64LE(24),
    envelopeSha256: Buffer.from(payload.subarray(32, 64)),
    keysetReceiptSha256: Buffer.from(payload.subarray(64, 96)),
    admissionEvidenceSpkiSha256: Buffer.from(payload.subarray(96, 128)),
    admissionEvidenceSpki: Buffer.from(payload.subarray(128, 172)),
    signature: Buffer.from(payload.subarray(172, 236)),
    protectedStateSha256: Buffer.from(payload.subarray(236, 268)),
    requestSha256: Buffer.from(payload.subarray(268, 300)),
  };
}

export function decodeWindowsProtectedSignRuntimePopV2Response(
  bytes: Uint8Array,
  expectedRequest: WindowsProtectedSignRuntimePopV2Request,
): WindowsProtectedSignRuntimePopV2Result {
  const requestFrame = encodeWindowsProtectedSignRuntimePopV2Request(expectedRequest);
  const requestBody = requestFrame.subarray(WINDOWS_HELPER_HEADER_BYTES);
  const material = validateWindowsProtectedRemoteWorkerPopV2Preimage(
    requestBody.subarray(96, 96 + REMOTE_WORKER_POP_V2_PREIMAGE_BYTES),
  );
  const expectedReceipt = exactBytes(
    expectedRequest.expectedKeysetReceiptSha256,
    32,
    "expectedKeysetReceiptSha256",
    true,
  );
  const payload = protectedSuccessPayload(
    bytes,
    WINDOWS_HELPER_OPCODE.SIGN_RUNTIME_POP_V2,
    WINDOWS_PROTECTED_SIGN_RUNTIME_POP_V2_RESULT_BYTES,
  );
  if (payload.readUInt16LE(0) !== 1 || payload.readUInt32LE(4) !== 0) {
    throw new WindowsHelperProtocolError("sign runtime PoP-v2 result header is invalid");
  }
  const disposition =
    SIGN_RUNTIME_POP_V2_DISPOSITIONS[payload.readUInt16LE(2) as keyof typeof SIGN_RUNTIME_POP_V2_DISPOSITIONS];
  if (disposition === undefined) {
    throw new WindowsHelperProtocolError("sign runtime PoP-v2 result disposition is invalid");
  }
  requireZero(payload, 180, 4, "sign runtime PoP-v2 trailing reserved field");
  const carriesSignature = disposition === "signed";
  if (carriesSignature) {
    if (!payload.subarray(8, 40).equals(expectedReceipt)) {
      throw new WindowsHelperProtocolError("sign runtime PoP-v2 result keyset receipt differs from request");
    }
    const spkiHash = payload.subarray(40, 72);
    const spki = payload.subarray(72, 116);
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    if (!spki.subarray(0, spkiPrefix.byteLength).equals(spkiPrefix)) {
      throw new WindowsHelperProtocolError("sign runtime PoP-v2 SPKI is not canonical Ed25519");
    }
    requireNonzero(spki, spkiPrefix.byteLength, 32, "sign runtime PoP-v2 public key");
    if (!spkiHash.equals(sha256(spki)) || !spkiHash.equals(material.workerPublicKeySpkiSha256)) {
      throw new WindowsHelperProtocolError("sign runtime PoP-v2 SPKI differs from the protected proof authority");
    }
    requireNonzero(payload, 116, 64, "sign runtime PoP-v2 signature");
    let verified: boolean;
    try {
      const publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
      verified = verify(null, expectedRequest.preimage, publicKey, payload.subarray(116, 180));
    } catch (error) {
      throw new WindowsHelperProtocolError(
        `sign runtime PoP-v2 public receipt is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!verified) {
      throw new WindowsHelperProtocolError("sign runtime PoP-v2 signature does not verify over the exact preimage");
    }
  } else {
    requireZero(payload, 8, 172, "sign runtime PoP-v2 rejection authority");
  }
  return {
    disposition,
    keysetReceiptSha256: Buffer.from(payload.subarray(8, 40)),
    runtimeManifestSpkiSha256: Buffer.from(payload.subarray(40, 72)),
    runtimeManifestSpki: Buffer.from(payload.subarray(72, 116)),
    signature: Buffer.from(payload.subarray(116, 180)),
  };
}

function validateRunInputs(executablePath: string, requestFrame: Uint8Array, options: WindowsHelperRunOptions): number {
  if (typeof executablePath !== "string" || !isAbsolute(executablePath) || executablePath.includes("\0")) {
    throw new WindowsHelperProcessError("spawn_failed", "Windows provisioner executable path must be absolute");
  }
  if (!(requestFrame instanceof Uint8Array)) {
    throw new WindowsHelperProtocolError("request frame must be a byte array");
  }
  if (requestFrame.byteLength > WINDOWS_HELPER_STDOUT_MAX_BYTES) {
    throw new WindowsHelperProtocolError("request frame exceeds the ordinary frame limit");
  }
  const timeoutMs = options.timeoutMs ?? WINDOWS_HELPER_PROCESS_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > WINDOWS_HELPER_PROCESS_TIMEOUT_MS) {
    throw new WindowsHelperProcessError(
      "timed_out",
      `timeout must be an integer from 1 through ${String(WINDOWS_HELPER_PROCESS_TIMEOUT_MS)}`,
    );
  }
  return timeoutMs;
}

export async function runWindowsHelperOneShot(
  executablePath: string,
  requestFrame: Uint8Array,
  options: WindowsHelperRunOptions = {},
): Promise<WindowsHelperProcessResult> {
  const timeoutMs = validateRunInputs(executablePath, requestFrame, options);

  return await new Promise<WindowsHelperProcessResult>((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let spawned = false;
    let stdinError: Error | undefined;
    let terminalCause: Error | undefined;
    let terminalReason: "process_error" | "timed_out" | "stdout_limit" | "stderr_limit" | undefined;
    let terminationTimer: NodeJS.Timeout | undefined;

    const child = spawn(executablePath, [WINDOWS_HELPER_INSPECT_ARGUMENT], {
      cwd: undefined,
      env: {},
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stop = (reason: "process_error" | "timed_out" | "stdout_limit" | "stderr_limit", cause?: Error): void => {
      if (terminalReason !== undefined || settled) return;
      terminalReason = reason;
      terminalCause = cause;
      child.stdin.destroy();
      let killAccepted = false;
      try {
        killAccepted = child.kill("SIGKILL");
      } catch (error) {
        terminalCause = error instanceof Error ? error : new Error(String(error));
      }
      terminationTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
        child.unref();
        reject(
          new WindowsHelperProcessError(
            "termination_failed",
            killAccepted
              ? "Windows provisioner helper did not close after forced termination"
              : "Windows provisioner helper could not be forcibly terminated",
            terminalCause === undefined ? undefined : { cause: terminalCause },
          ),
        );
      }, WINDOWS_HELPER_TERMINATION_GRACE_MS);
    };

    const timer = setTimeout(() => stop("timed_out"), timeoutMs);

    child.once("spawn", () => {
      spawned = true;
    });

    child.stdout.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += bytes.byteLength;
      if (stdoutBytes > WINDOWS_HELPER_STDOUT_MAX_BYTES) {
        stop("stdout_limit");
        return;
      }
      stdoutChunks.push(bytes);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += bytes.byteLength;
      if (stderrBytes > WINDOWS_HELPER_STDERR_MAX_BYTES) {
        stop("stderr_limit");
        return;
      }
      stderrChunks.push(bytes);
    });

    child.once("error", (error) => {
      if (settled) return;
      if (!spawned) {
        clearTimeout(timer);
        settled = true;
        reject(
          new WindowsHelperProcessError("spawn_failed", "Windows provisioner helper could not be started", {
            cause: error,
          }),
        );
        return;
      }
      stop("process_error", error);
    });

    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (terminationTimer !== undefined) clearTimeout(terminationTimer);
      if (settled) return;
      settled = true;
      if (terminalReason !== undefined) {
        const messages = {
          process_error: "Windows provisioner helper failed after it started",
          timed_out: "Windows provisioner helper exceeded its fixed deadline",
          stdout_limit: "Windows provisioner helper exceeded the stdout limit",
          stderr_limit: "Windows provisioner helper exceeded the stderr limit",
        } as const;
        reject(
          new WindowsHelperProcessError(
            terminalReason,
            messages[terminalReason],
            terminalCause === undefined ? undefined : { cause: terminalCause },
          ),
        );
        return;
      }
      if (stdinError !== undefined) {
        reject(
          new WindowsHelperProcessError(
            "stdin_failed",
            "Windows provisioner helper did not accept the complete request frame",
            { cause: stdinError },
          ),
        );
        return;
      }
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdoutChunks, stdoutBytes),
        stderr: Buffer.concat(stderrChunks, stderrBytes),
      });
    });

    child.stdin.on("error", (error) => {
      // Wait for close so the child cannot be orphaned, then fail closed even if
      // it emitted success bytes without accepting the complete request frame.
      stdinError = error;
    });
    child.stdin.end(Buffer.from(requestFrame));
  });
}

export async function runWindowsProvisionerInspect(
  executablePath: string,
  options: WindowsHelperRunOptions = {},
): Promise<WindowsHelperInspect> {
  const result = await runWindowsHelperOneShot(executablePath, encodeWindowsHelperInspectRequest(), options);
  if (result.exitCode !== 0 || result.signal !== null) {
    throw new WindowsHelperExitError(result);
  }
  if (result.stderr.byteLength !== 0) {
    throw new WindowsHelperProtocolError("successful inspect emitted stderr bytes");
  }
  return decodeWindowsHelperInspectResponse(result.stdout);
}
