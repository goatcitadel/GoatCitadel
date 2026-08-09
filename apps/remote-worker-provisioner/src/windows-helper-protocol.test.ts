import { spawn, spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";

import {
  WINDOWS_HELPER_CALLABLE_OPCODE_BITMAP,
  WINDOWS_HELPER_ERROR_CODE,
  WINDOWS_HELPER_ERROR_OPCODE,
  WINDOWS_HELPER_HEADER_BYTES,
  WINDOWS_HELPER_OPCODE,
  WINDOWS_HELPER_ORDINARY_MAX_BYTES,
  WINDOWS_HELPER_PE_MACHINE,
  WINDOWS_HELPER_PROCESS_TIMEOUT_MS,
  WINDOWS_HELPER_RECOGNIZED_OPCODE_BITMAP,
  WINDOWS_HELPER_REQUEST_ID,
  WINDOWS_HELPER_SECRET_MAX_BYTES,
  WINDOWS_PROTECTED_CALLABLE_OPCODE_BITMAP,
  WINDOWS_PROTECTED_ADMISSION_EVIDENCE_ENVELOPE_BYTES,
  WindowsHelperExitError,
  WindowsHelperProcessError,
  WindowsHelperProtocolError,
  decodeWindowsHelperFrame,
  decodeWindowsHelperInspectResponse,
  decodeWindowsHelperRequest,
  decodeWindowsHelperResponse,
  decodeWindowsProtectedCreateKeysetResponse,
  decodeWindowsProtectedAdmissionEvidenceEnvelope,
  decodeWindowsProtectedInspectResponse,
  decodeWindowsProtectedRevokeKeysetResponse,
  decodeWindowsProtectedSignAdmissionEvidenceResponse,
  encodeWindowsHelperFrame,
  encodeWindowsHelperInspectRequest,
  encodeWindowsHelperRequest,
  encodeWindowsProtectedCreateKeysetRequest,
  encodeWindowsProtectedAdmissionEvidenceEnvelope,
  encodeWindowsProtectedRevokeKeysetRequest,
  encodeWindowsProtectedSignAdmissionEvidenceRequest,
  buildWindowsProtectedAdmissionEvidenceSigningBytes,
  runWindowsHelperOneShot,
  runWindowsProvisionerInspect,
  validateWindowsProtectedRequestPayload,
} from "./windows-helper-protocol.js";

function inspectPayload(
  machine: (typeof WINDOWS_HELPER_PE_MACHINE)[keyof typeof WINDOWS_HELPER_PE_MACHINE] = WINDOWS_HELPER_PE_MACHINE.X64,
): Buffer {
  const payload = Buffer.alloc(32);
  payload.writeUInt16LE(1, 0);
  payload.writeUInt16LE(machine, 2);
  payload.writeUInt32LE(WINDOWS_HELPER_ORDINARY_MAX_BYTES, 4);
  payload.writeUInt32LE(WINDOWS_HELPER_SECRET_MAX_BYTES, 8);
  payload.writeUInt32LE(0, 12);
  payload.writeBigUInt64LE(WINDOWS_HELPER_RECOGNIZED_OPCODE_BITMAP, 16);
  payload.writeBigUInt64LE(WINDOWS_HELPER_CALLABLE_OPCODE_BITMAP, 24);
  return payload;
}

function errorResponse(code: number): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeUInt32LE(code, 0);
  return encodeWindowsHelperFrame(WINDOWS_HELPER_ERROR_OPCODE, payload);
}

function protectedInspectPayload(): Buffer {
  const payload = Buffer.alloc(320);
  inspectPayload().copy(payload, 0);
  payload.writeUInt16LE(1, 32);
  payload.writeUInt16LE(0, 34);
  payload.writeBigUInt64LE(WINDOWS_PROTECTED_CALLABLE_OPCODE_BITMAP, 40);
  payload.fill(0xa5, 48, 80);
  payload.writeUInt32LE(256, 116);
  payload.writeUInt32LE(16, 120);
  return payload;
}

const protectedOperationId = Buffer.from("00112233445566778899aabbccddeeff", "hex");
const protectedExpectedState = Buffer.alloc(32, 0x5a);
const protectedObservedState = Buffer.alloc(32, 0x6b);
const protectedResultingState = Buffer.alloc(32, 0x7c);
const canonicalSpkiPrefix = Buffer.from("302a300506032b6570032100", "hex");

function createRequestFixture() {
  return {
    operationId: protectedOperationId,
    expectedStateSha256: protectedExpectedState,
    requestedGeneration: 7n,
    predecessorGeneration: 6n,
  };
}

function revokeRequestFixture() {
  return {
    operationId: protectedOperationId,
    expectedStateSha256: protectedExpectedState,
    generation: 7n,
    reason: "suspected_compromise" as const,
    expectedKeysetReceiptSha256: Buffer.alloc(32, 0x44),
  };
}

function admissionEvidenceEnvelopeFixture() {
  return {
    operationId: protectedOperationId,
    evidenceNonceSha256: Buffer.alloc(32, 0x10),
    workerGeneration: 7n,
    contextSha256: Buffer.alloc(32, 0x20),
    runtimeManifestSha256: Buffer.alloc(32, 0x30),
    workerPublicKeySpkiSha256: Buffer.alloc(32, 0x40),
    downloadVerificationReceiptSha256: Buffer.alloc(32, 0x50),
    installedTreeAttestationSha256: Buffer.alloc(32, 0x60),
    installedTreeVerificationReceiptSha256: Buffer.alloc(32, 0x70),
  };
}

function signAdmissionEvidenceRequestFixture() {
  return {
    operationId: protectedOperationId,
    expectedStateSha256: protectedExpectedState,
    expectedGeneration: 7n,
    expectedKeysetReceiptSha256: Buffer.alloc(32, 0x44),
    envelope: admissionEvidenceEnvelopeFixture(),
  };
}

const admissionEvidencePrivateKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex"),
  ]),
  format: "der",
  type: "pkcs8",
});
const admissionEvidenceSpki = createPublicKey(admissionEvidencePrivateKey).export({
  format: "der",
  type: "spki",
});

function signAdmissionEvidenceResultPayload(disposition: number): Buffer {
  const request = signAdmissionEvidenceRequestFixture();
  const requestFrame = encodeWindowsProtectedSignAdmissionEvidenceRequest(request);
  const requestBody = requestFrame.subarray(WINDOWS_HELPER_HEADER_BYTES);
  const envelope = requestBody.subarray(96);
  const payload = Buffer.alloc(320);
  payload.writeUInt16LE(1, 0);
  payload.writeUInt16LE(disposition, 2);
  protectedOperationId.copy(payload, 8);
  payload.writeBigUInt64LE(7n, 24);
  createHash("sha256").update(envelope).digest().copy(payload, 32);
  if (disposition === 1 || disposition === 2) {
    request.expectedKeysetReceiptSha256.copy(payload, 64);
    createHash("sha256").update(admissionEvidenceSpki).digest().copy(payload, 96);
    admissionEvidenceSpki.copy(payload, 128);
    sign(null, buildWindowsProtectedAdmissionEvidenceSigningBytes(envelope), admissionEvidencePrivateKey).copy(
      payload,
      172,
    );
  }
  protectedExpectedState.copy(payload, 236);
  createHash("sha256").update(requestBody).digest().copy(payload, 268);
  return payload;
}

function createResultPayload(disposition: number): Buffer {
  const payload = Buffer.alloc(320);
  payload.writeUInt16LE(1, 0);
  payload.writeUInt16LE(disposition, 2);
  protectedOperationId.copy(payload, 8);
  payload.writeBigUInt64LE(7n, 24);
  payload.writeBigUInt64LE(6n, 32);
  protectedExpectedState.copy(payload, 40);
  const carriesCommittedKeyset = disposition === 1 || disposition === 2;
  const currentAtBothOffsets = disposition !== 1 && disposition !== 10;
  protectedObservedState.copy(payload, 72);
  (currentAtBothOffsets ? protectedObservedState : protectedResultingState).copy(payload, 104);
  if (carriesCommittedKeyset) {
    payload.fill(0x11, 136, 232);
    canonicalSpkiPrefix.copy(payload, 232);
    payload.fill(0x22, 244, 276);
    canonicalSpkiPrefix.copy(payload, 276);
    payload.fill(0x33, 288, 320);
  }
  return payload;
}

function revokeResultPayload(disposition: number): Buffer {
  const payload = Buffer.alloc(200);
  payload.writeUInt16LE(1, 0);
  payload.writeUInt16LE(disposition, 2);
  protectedOperationId.copy(payload, 8);
  payload.writeBigUInt64LE(7n, 24);
  payload.writeUInt32LE(2, 32);
  protectedExpectedState.copy(payload, 40);
  protectedObservedState.copy(payload, 72);
  (disposition === 1 ? protectedResultingState : protectedObservedState).copy(payload, 104);
  if (disposition === 1 || disposition === 2) payload.fill(0x55, 136, 200);
  return payload;
}

describe("GCPW v1 frame contract", () => {
  it("encodes the exact empty INSPECT request bytes", () => {
    expect(encodeWindowsHelperInspectRequest().toString("hex")).toBe("47435057010001000100000000000000");
  });

  it("serializes payload length and bytes without padding", () => {
    const frame = encodeWindowsHelperRequest(
      WINDOWS_HELPER_OPCODE.SIGN_ADMISSION_EVIDENCE,
      Buffer.from([0x00, 0x7f, 0xff]),
    );
    expect(frame.byteLength).toBe(WINDOWS_HELPER_HEADER_BYTES + 3);
    expect(frame.toString("hex")).toBe("47435057010012000100000003000000007fff");
    expect(decodeWindowsHelperRequest(frame)).toMatchObject({
      version: 1,
      opcode: WINDOWS_HELPER_OPCODE.SIGN_ADMISSION_EVIDENCE,
      flags: 0,
      requestId: WINDOWS_HELPER_REQUEST_ID,
      payload: Buffer.from([0x00, 0x7f, 0xff]),
    });
  });

  it("rejects every truncated header prefix", () => {
    const frame = encodeWindowsHelperInspectRequest();
    for (let length = 0; length < WINDOWS_HELPER_HEADER_BYTES; length += 1) {
      expect(() => decodeWindowsHelperFrame(frame.subarray(0, length))).toThrow(WindowsHelperProtocolError);
    }
  });

  it("rejects invalid magic, version, flags, and request ID", () => {
    const mutations: Array<[number, number]> = [
      [0, 0],
      [4, 2],
      [7, 1],
      [8, 2],
    ];
    for (const [offset, value] of mutations) {
      const frame = encodeWindowsHelperInspectRequest();
      frame[offset] = value;
      expect(() => decodeWindowsHelperFrame(frame)).toThrow(WindowsHelperProtocolError);
    }
  });

  it("rejects truncated payloads, trailing bytes, and over-cap declarations", () => {
    const withPayload = encodeWindowsHelperFrame(0x02, Buffer.from([1]));
    expect(() => decodeWindowsHelperFrame(withPayload.subarray(0, -1))).toThrow(/payload is truncated/);
    expect(() => decodeWindowsHelperFrame(Buffer.concat([withPayload, Buffer.from([0])]))).toThrow(/trailing bytes/);

    const overCap = encodeWindowsHelperInspectRequest();
    overCap.writeUInt32LE(WINDOWS_HELPER_ORDINARY_MAX_BYTES + 1, 12);
    expect(() => decodeWindowsHelperFrame(overCap)).toThrow(/exceeds the allowed limit/);
    expect(() =>
      decodeWindowsHelperFrame(Buffer.alloc(WINDOWS_HELPER_HEADER_BYTES + WINDOWS_HELPER_ORDINARY_MAX_BYTES + 1)),
    ).toThrow(/exceeds the allowed total length/);
  });

  it("allows a generic unknown opcode frame but rejects it as a closed request", () => {
    const unknown = encodeWindowsHelperFrame(0x02);
    expect(decodeWindowsHelperFrame(unknown).opcode).toBe(0x02);
    expect(() => decodeWindowsHelperRequest(unknown)).toThrow(/closed request-opcode set/);
  });

  it("enforces encoder integer and payload bounds", () => {
    expect(() => encodeWindowsHelperFrame(-1)).toThrow(WindowsHelperProtocolError);
    expect(() => encodeWindowsHelperFrame(256)).toThrow(WindowsHelperProtocolError);
    expect(() => encodeWindowsHelperFrame(1, Buffer.alloc(WINDOWS_HELPER_ORDINARY_MAX_BYTES + 1))).toThrow(/exceeds/);
  });
});

describe("W1B1A protected GCPW codecs", () => {
  const operationId = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const state = Buffer.alloc(32, 0x5a);

  it("keeps protected codecs separate and encodes caller-owned mutation authority exactly", () => {
    const create = decodeWindowsHelperRequest(
      encodeWindowsProtectedCreateKeysetRequest({
        operationId,
        expectedStateSha256: state,
        requestedGeneration: 7n,
        predecessorGeneration: 6n,
      }),
    );
    expect(create.payload).toHaveLength(72);
    expect(create.payload.subarray(0, 16)).toEqual(operationId);
    expect(create.payload.subarray(16, 48)).toEqual(state);
    expect(create.payload.readUInt16LE(48)).toBe(1);
    expect(create.payload.subarray(50, 52)).toEqual(Buffer.alloc(2));
    expect(create.payload.readBigUInt64LE(52)).toBe(7n);
    expect(create.payload.readBigUInt64LE(60)).toBe(6n);
    expect(create.payload.subarray(68)).toEqual(Buffer.alloc(4));

    const receipt = Buffer.alloc(32, 0x33);
    const revoke = decodeWindowsHelperRequest(
      encodeWindowsProtectedRevokeKeysetRequest({
        operationId,
        expectedStateSha256: state,
        generation: 7n,
        reason: "suspected_compromise",
        expectedKeysetReceiptSha256: receipt,
      }),
    );
    expect(revoke.payload).toHaveLength(100);
    expect(revoke.payload.subarray(0, 48)).toEqual(create.payload.subarray(0, 48));
    expect(revoke.payload.readBigUInt64LE(52)).toBe(7n);
    expect(revoke.payload.readUInt32LE(60)).toBe(2);
    expect(revoke.payload.subarray(68)).toEqual(receipt);
  });

  it("rejects zero or malformed caller authority", () => {
    expect(() =>
      encodeWindowsProtectedCreateKeysetRequest({
        operationId: Buffer.alloc(16),
        expectedStateSha256: state,
        requestedGeneration: 1n,
        predecessorGeneration: 0n,
      }),
    ).toThrow(WindowsHelperProtocolError);
    expect(() =>
      encodeWindowsProtectedCreateKeysetRequest({
        operationId,
        expectedStateSha256: Buffer.alloc(32),
        requestedGeneration: 1n,
        predecessorGeneration: 0n,
      }),
    ).toThrow(WindowsHelperProtocolError);

    for (const invalid of [
      { ...createRequestFixture(), operationId: Buffer.alloc(15, 1) },
      { ...createRequestFixture(), operationId: Buffer.alloc(17, 1) },
      { ...createRequestFixture(), expectedStateSha256: Buffer.alloc(31, 1) },
      { ...createRequestFixture(), expectedStateSha256: Buffer.alloc(33, 1) },
      { ...createRequestFixture(), requestedGeneration: 0n },
      { ...createRequestFixture(), requestedGeneration: -1n },
      { ...createRequestFixture(), requestedGeneration: 0x1_0000_0000_0000_0000n },
      { ...createRequestFixture(), requestedGeneration: 7 as unknown as bigint },
    ]) {
      expect(() => encodeWindowsProtectedCreateKeysetRequest(invalid)).toThrow(WindowsHelperProtocolError);
    }

    for (const invalid of [
      { ...revokeRequestFixture(), operationId: Buffer.alloc(16) },
      { ...revokeRequestFixture(), expectedStateSha256: Buffer.alloc(32) },
      { ...revokeRequestFixture(), generation: 0n },
      { ...revokeRequestFixture(), reason: "unknown" as "suspected_compromise" },
      { ...revokeRequestFixture(), expectedKeysetReceiptSha256: Buffer.alloc(31, 1) },
      { ...revokeRequestFixture(), expectedKeysetReceiptSha256: Buffer.alloc(32) },
    ]) {
      expect(() => encodeWindowsProtectedRevokeKeysetRequest(invalid)).toThrow(WindowsHelperProtocolError);
    }
  });

  it("decodes the full protected inspect without widening the direct decoder", () => {
    const frame = encodeWindowsHelperFrame(0x81, protectedInspectPayload());
    const decoded = decodeWindowsProtectedInspectResponse(frame);
    expect(decoded.stateSha256).toEqual(Buffer.alloc(32, 0xa5));
    expect(decoded.protectedCallableOpcodeBitmap).toBe(WINDOWS_PROTECTED_CALLABLE_OPCODE_BITMAP);
    expect(decoded.remainingOperationCapacity).toBe(256);
    expect(() => decodeWindowsHelperInspectResponse(frame)).toThrow(WindowsHelperProtocolError);
  });

  it("requires exact response operation identity and reserved bytes", () => {
    const createRequest = {
      operationId,
      expectedStateSha256: state,
      requestedGeneration: 7n,
      predecessorGeneration: 6n,
    };
    const create = Buffer.alloc(320);
    create.writeUInt16LE(1, 0);
    create.writeUInt16LE(1, 2);
    operationId.copy(create, 8);
    create.writeBigUInt64LE(7n, 24);
    create.writeBigUInt64LE(6n, 32);
    state.copy(create, 40);
    create.fill(1, 136, 232);
    Buffer.from("302a300506032b6570032100", "hex").copy(create, 232);
    create.fill(2, 244, 276);
    Buffer.from("302a300506032b6570032100", "hex").copy(create, 276);
    create.fill(3, 288, 320);
    expect(
      decodeWindowsProtectedCreateKeysetResponse(encodeWindowsHelperFrame(0x90, create), createRequest).disposition,
    ).toBe("created");
    expect(() =>
      decodeWindowsProtectedCreateKeysetResponse(encodeWindowsHelperFrame(0x90, create), {
        ...createRequest,
        operationId: Buffer.alloc(16, 1),
      }),
    ).toThrow(WindowsHelperProtocolError);

    const revokeRequest = {
      operationId,
      expectedStateSha256: state,
      generation: 7n,
      reason: "operator_requested" as const,
      expectedKeysetReceiptSha256: Buffer.alloc(32, 4),
    };
    const revoke = Buffer.alloc(200);
    revoke.writeUInt16LE(1, 0);
    revoke.writeUInt16LE(1, 2);
    operationId.copy(revoke, 8);
    revoke.writeBigUInt64LE(7n, 24);
    revoke.writeUInt32LE(1, 32);
    state.copy(revoke, 40);
    revoke.fill(4, 136, 200);
    expect(
      decodeWindowsProtectedRevokeKeysetResponse(encodeWindowsHelperFrame(0x93, revoke), revokeRequest).disposition,
    ).toBe("revoked");
    revoke[36] = 1;
    expect(() =>
      decodeWindowsProtectedRevokeKeysetResponse(encodeWindowsHelperFrame(0x93, revoke), revokeRequest),
    ).toThrow(WindowsHelperProtocolError);
  });

  it("accepts every closed disposition only with its exact authority layout", () => {
    const createNames = [
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
    for (let disposition = 1; disposition <= createNames.length; disposition += 1) {
      const payload = createResultPayload(disposition);
      if (disposition === 10) protectedResultingState.copy(payload, 104);
      expect(
        decodeWindowsProtectedCreateKeysetResponse(encodeWindowsHelperFrame(0x90, payload), createRequestFixture())
          .disposition,
      ).toBe(createNames[disposition - 1]);
    }

    const revokeNames = [
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
    for (let disposition = 1; disposition <= revokeNames.length; disposition += 1) {
      expect(
        decodeWindowsProtectedRevokeKeysetResponse(
          encodeWindowsHelperFrame(0x93, revokeResultPayload(disposition)),
          revokeRequestFixture(),
        ).disposition,
      ).toBe(revokeNames[disposition - 1]);
    }
  });

  it("rejects every mutation of fixed CREATE result authority and state semantics", () => {
    const canonical = createResultPayload(1);
    const mutations: Array<(payload: Buffer) => void> = [
      (payload) => payload.writeUInt16LE(2, 0),
      (payload) => payload.writeUInt16LE(0, 2),
      (payload) => payload.writeUInt16LE(11, 2),
      (payload) => payload.writeUInt32LE(1, 4),
      (payload) => {
        payload[8] = payload[8]! ^ 1;
      },
      (payload) => payload.writeBigUInt64LE(8n, 24),
      (payload) => payload.writeBigUInt64LE(5n, 32),
      (payload) => {
        payload[40] = payload[40]! ^ 1;
      },
      (payload) => payload.fill(0, 136, 168),
      (payload) => payload.fill(0, 168, 200),
      (payload) => payload.fill(0, 200, 232),
      (payload) => {
        payload[232] = payload[232]! ^ 1;
      },
      (payload) => payload.fill(0, 244, 276),
      (payload) => {
        payload[276] = payload[276]! ^ 1;
      },
      (payload) => payload.fill(0, 288, 320),
    ];
    for (const mutate of mutations) {
      const payload = Buffer.from(canonical);
      mutate(payload);
      expect(() =>
        decodeWindowsProtectedCreateKeysetResponse(encodeWindowsHelperFrame(0x90, payload), createRequestFixture()),
      ).toThrow(WindowsHelperProtocolError);
    }
    expect(() =>
      decodeWindowsProtectedCreateKeysetResponse(
        encodeWindowsHelperFrame(0x90, canonical.subarray(0, 319)),
        createRequestFixture(),
      ),
    ).toThrow(WindowsHelperProtocolError);
    expect(() =>
      decodeWindowsProtectedCreateKeysetResponse(
        encodeWindowsHelperFrame(0x90, Buffer.concat([canonical, Buffer.alloc(1)])),
        createRequestFixture(),
      ),
    ).toThrow(WindowsHelperProtocolError);

    const rejection = createResultPayload(3);
    rejection[136] = 1;
    expect(() =>
      decodeWindowsProtectedCreateKeysetResponse(encodeWindowsHelperFrame(0x90, rejection), createRequestFixture()),
    ).toThrow(WindowsHelperProtocolError);
    const mismatchedCurrent = createResultPayload(3);
    protectedResultingState.copy(mismatchedCurrent, 104);
    expect(() =>
      decodeWindowsProtectedCreateKeysetResponse(
        encodeWindowsHelperFrame(0x90, mismatchedCurrent),
        createRequestFixture(),
      ),
    ).toThrow(WindowsHelperProtocolError);
  });

  it("rejects every mutation of fixed REVOKE result authority and state semantics", () => {
    const canonical = revokeResultPayload(1);
    const mutations: Array<(payload: Buffer) => void> = [
      (payload) => payload.writeUInt16LE(2, 0),
      (payload) => payload.writeUInt16LE(0, 2),
      (payload) => payload.writeUInt16LE(11, 2),
      (payload) => payload.writeUInt32LE(1, 4),
      (payload) => {
        payload[8] = payload[8]! ^ 1;
      },
      (payload) => payload.writeBigUInt64LE(8n, 24),
      (payload) => payload.writeUInt32LE(0, 32),
      (payload) => payload.writeUInt32LE(4, 32),
      (payload) => payload.writeUInt32LE(1, 36),
      (payload) => {
        payload[40] = payload[40]! ^ 1;
      },
      (payload) => payload.fill(0, 136, 168),
      (payload) => payload.fill(0, 168, 200),
    ];
    for (const mutate of mutations) {
      const payload = Buffer.from(canonical);
      mutate(payload);
      expect(() =>
        decodeWindowsProtectedRevokeKeysetResponse(encodeWindowsHelperFrame(0x93, payload), revokeRequestFixture()),
      ).toThrow(WindowsHelperProtocolError);
    }
    const rejection = revokeResultPayload(8);
    rejection[136] = 1;
    expect(() =>
      decodeWindowsProtectedRevokeKeysetResponse(encodeWindowsHelperFrame(0x93, rejection), revokeRequestFixture()),
    ).toThrow(WindowsHelperProtocolError);
    const mismatchedCurrent = revokeResultPayload(8);
    protectedResultingState.copy(mismatchedCurrent, 104);
    expect(() =>
      decodeWindowsProtectedRevokeKeysetResponse(
        encodeWindowsHelperFrame(0x93, mismatchedCurrent),
        revokeRequestFixture(),
      ),
    ).toThrow(WindowsHelperProtocolError);
  });

  it("serializes one deterministic, fixed-size, secret-free admission-evidence envelope", () => {
    const input = admissionEvidenceEnvelopeFixture();
    const first = encodeWindowsProtectedAdmissionEvidenceEnvelope(input);
    const second = encodeWindowsProtectedAdmissionEvidenceEnvelope(input);
    expect(first).toEqual(second);
    expect(first).toHaveLength(WINDOWS_PROTECTED_ADMISSION_EVIDENCE_ENVELOPE_BYTES);
    expect(first.subarray(0, 16).toString("hex")).toBe("47434145010001002001000000000000");
    expect(decodeWindowsProtectedAdmissionEvidenceEnvelope(first)).toEqual(input);
    expect(buildWindowsProtectedAdmissionEvidenceSigningBytes(first).subarray(-first.byteLength)).toEqual(first);

    for (const mutate of [
      (value: Buffer) => {
        value[0] = 0;
      },
      (value: Buffer) => value.writeUInt16LE(2, 4),
      (value: Buffer) => value.writeUInt8(2, 6),
      (value: Buffer) => value.writeUInt8(1, 7),
      (value: Buffer) => value.writeUInt32LE(287, 8),
      (value: Buffer) => value.writeUInt32LE(1, 12),
      (value: Buffer) => value.fill(0, 16, 32),
      (value: Buffer) => value.fill(0, 32, 64),
      (value: Buffer) => value.writeBigUInt64LE(0n, 64),
      (value: Buffer) => value.writeUInt8(1, 72),
      (value: Buffer) => value.fill(0, 96, 128),
      (value: Buffer) => value.fill(0, 256, 288),
    ]) {
      const invalid = Buffer.from(first);
      mutate(invalid);
      expect(() => decodeWindowsProtectedAdmissionEvidenceEnvelope(invalid)).toThrow(WindowsHelperProtocolError);
    }
    expect(() => decodeWindowsProtectedAdmissionEvidenceEnvelope(first.subarray(0, -1))).toThrow(
      WindowsHelperProtocolError,
    );
    expect(() =>
      decodeWindowsProtectedAdmissionEvidenceEnvelope(Buffer.concat([first, Buffer.alloc(1)])),
    ).toThrow(WindowsHelperProtocolError);
  });

  it("binds the admission-evidence request operation, generation, state, receipt, and exact envelope", () => {
    const request = signAdmissionEvidenceRequestFixture();
    const frame = encodeWindowsProtectedSignAdmissionEvidenceRequest(request);
    const decoded = decodeWindowsHelperRequest(frame);
    expect(decoded.opcode).toBe(WINDOWS_HELPER_OPCODE.SIGN_ADMISSION_EVIDENCE);
    expect(decoded.payload).toHaveLength(384);
    expect(decoded.payload.subarray(0, 16)).toEqual(request.operationId);
    expect(decoded.payload.subarray(16, 48)).toEqual(request.expectedStateSha256);
    expect(decoded.payload.readUInt16LE(48)).toBe(1);
    expect(decoded.payload.readUInt8(50)).toBe(2);
    expect(decoded.payload.readUInt8(51)).toBe(0);
    expect(decoded.payload.readBigUInt64LE(52)).toBe(7n);
    expect(decoded.payload.subarray(60, 92)).toEqual(request.expectedKeysetReceiptSha256);
    expect(decoded.payload.readUInt32LE(92)).toBe(288);
    expect(() => validateWindowsProtectedRequestPayload(decoded.opcode, decoded.payload)).not.toThrow();

    expect(() =>
      encodeWindowsProtectedSignAdmissionEvidenceRequest({
        ...request,
        operationId: Buffer.alloc(16, 0x99),
      }),
    ).toThrow(/must equal envelope/);
    expect(() =>
      encodeWindowsProtectedSignAdmissionEvidenceRequest({
        ...request,
        expectedGeneration: 8n,
      }),
    ).toThrow(/must equal envelope/);

    for (const mutate of [
      (value: Buffer) => value.writeUInt16LE(2, 48),
      (value: Buffer) => value.writeUInt8(1, 50),
      (value: Buffer) => value.writeUInt8(1, 51),
      (value: Buffer) => value.writeBigUInt64LE(0n, 52),
      (value: Buffer) => value.fill(0, 60, 92),
      (value: Buffer) => value.writeUInt32LE(287, 92),
      (value: Buffer) => {
        value[112] = value[112]! ^ 1;
      },
      (value: Buffer) => value.writeBigUInt64LE(8n, 160),
    ]) {
      const invalid = Buffer.from(decoded.payload);
      mutate(invalid);
      expect(() =>
        validateWindowsProtectedRequestPayload(WINDOWS_HELPER_OPCODE.SIGN_ADMISSION_EVIDENCE, invalid),
      ).toThrow(WindowsHelperProtocolError);
    }
    expect(() =>
      validateWindowsProtectedRequestPayload(
        WINDOWS_HELPER_OPCODE.SIGN_ADMISSION_EVIDENCE,
        decoded.payload.subarray(0, -1),
      ),
    ).toThrow(WindowsHelperProtocolError);
    expect(() =>
      validateWindowsProtectedRequestPayload(
        WINDOWS_HELPER_OPCODE.SIGN_ADMISSION_EVIDENCE,
        Buffer.concat([decoded.payload, Buffer.alloc(1)]),
      ),
    ).toThrow(WindowsHelperProtocolError);
  });

  it("verifies signed and replayed admission evidence in the fixed domain and rejects malformed receipts", () => {
    const request = signAdmissionEvidenceRequestFixture();
    for (const [number, name] of [
      [1, "signed"],
      [2, "exact_replay"],
      [3, "stale_state"],
      [4, "keyset_unavailable"],
      [5, "changed_replay"],
      [6, "operator_mismatch"],
      [7, "replay_capacity_exhausted"],
      [8, "signing_failed"],
    ] as const) {
      const result = decodeWindowsProtectedSignAdmissionEvidenceResponse(
        encodeWindowsHelperFrame(0x92, signAdmissionEvidenceResultPayload(number)),
        request,
      );
      expect(result.disposition).toBe(name);
      if (number <= 2) {
        expect(result.keysetReceiptSha256).toEqual(request.expectedKeysetReceiptSha256);
        expect(result.admissionEvidenceSpki).toEqual(admissionEvidenceSpki);
        expect(result.signature).not.toEqual(Buffer.alloc(64));
      } else {
        expect(result.signature).toEqual(Buffer.alloc(64));
      }
    }

    const canonical = signAdmissionEvidenceResultPayload(1);
    for (const mutate of [
      (value: Buffer) => value.writeUInt16LE(2, 0),
      (value: Buffer) => value.writeUInt16LE(0, 2),
      (value: Buffer) => value.writeUInt16LE(9, 2),
      (value: Buffer) => value.writeUInt32LE(1, 4),
      (value: Buffer) => {
        value[8] = value[8]! ^ 1;
      },
      (value: Buffer) => value.writeBigUInt64LE(8n, 24),
      (value: Buffer) => {
        value[32] = value[32]! ^ 1;
      },
      (value: Buffer) => value.fill(0, 64, 96),
      (value: Buffer) => {
        value[96] = value[96]! ^ 1;
      },
      (value: Buffer) => {
        value[128] = value[128]! ^ 1;
      },
      (value: Buffer) => value.fill(0, 172, 236),
      (value: Buffer) => {
        value[172] = value[172]! ^ 1;
      },
      (value: Buffer) => {
        value[236] = value[236]! ^ 1;
      },
      (value: Buffer) => {
        value[268] = value[268]! ^ 1;
      },
      (value: Buffer) => value.writeUInt8(1, 300),
    ]) {
      const invalid = Buffer.from(canonical);
      mutate(invalid);
      expect(() =>
        decodeWindowsProtectedSignAdmissionEvidenceResponse(encodeWindowsHelperFrame(0x92, invalid), request),
      ).toThrow(WindowsHelperProtocolError);
    }

    const wrongDomain = Buffer.from(canonical);
    const requestBody = encodeWindowsProtectedSignAdmissionEvidenceRequest(request).subarray(WINDOWS_HELPER_HEADER_BYTES);
    sign(null, requestBody.subarray(96), admissionEvidencePrivateKey).copy(wrongDomain, 172);
    expect(() =>
      decodeWindowsProtectedSignAdmissionEvidenceResponse(encodeWindowsHelperFrame(0x92, wrongDomain), request),
    ).toThrow(/fixed domain/);
    expect(() =>
      decodeWindowsProtectedSignAdmissionEvidenceResponse(encodeWindowsHelperFrame(0x93, canonical), request),
    ).toThrow(/does not match/);
    expect(() =>
      decodeWindowsProtectedSignAdmissionEvidenceResponse(
        encodeWindowsHelperFrame(0x92, canonical.subarray(0, -1)),
        request,
      ),
    ).toThrow(WindowsHelperProtocolError);

    const rejectionWithAuthority = signAdmissionEvidenceResultPayload(5);
    rejectionWithAuthority[64] = 1;
    expect(() =>
      decodeWindowsProtectedSignAdmissionEvidenceResponse(
        encodeWindowsHelperFrame(0x92, rejectionWithAuthority),
        request,
      ),
    ).toThrow(/rejection authority/);
  });
});

describe("GCPW v1 responses", () => {
  it("decodes the exact INSPECT payload for both supported machines", () => {
    for (const machine of [WINDOWS_HELPER_PE_MACHINE.X64, WINDOWS_HELPER_PE_MACHINE.ARM64]) {
      const frame = encodeWindowsHelperFrame(0x81, inspectPayload(machine));
      expect(decodeWindowsHelperInspectResponse(frame)).toEqual({
        schemaVersion: 1,
        machine,
        ordinaryMaximumBytes: WINDOWS_HELPER_ORDINARY_MAX_BYTES,
        secretMaximumBytes: WINDOWS_HELPER_SECRET_MAX_BYTES,
        flags: 0,
        recognizedOpcodeBitmap: WINDOWS_HELPER_RECOGNIZED_OPCODE_BITMAP,
        callableOpcodeBitmap: WINDOWS_HELPER_CALLABLE_OPCODE_BITMAP,
      });
    }
  });

  it("decodes each exact four-byte error response", () => {
    expect(errorResponse(WINDOWS_HELPER_ERROR_CODE.PROTOCOL_INVALID).toString("hex")).toBe(
      "4743505701007f00010000000400000001000000",
    );
    for (const code of Object.values(WINDOWS_HELPER_ERROR_CODE)) {
      expect(decodeWindowsHelperResponse(errorResponse(code), WINDOWS_HELPER_OPCODE.INSPECT)).toEqual({
        kind: "error",
        code,
      });
    }
  });

  it("rejects unknown error codes and non-four-byte error payloads", () => {
    expect(() => decodeWindowsHelperResponse(errorResponse(4), WINDOWS_HELPER_OPCODE.INSPECT)).toThrow(
      /code is invalid/,
    );
    expect(() =>
      decodeWindowsHelperResponse(
        encodeWindowsHelperFrame(WINDOWS_HELPER_ERROR_OPCODE, Buffer.alloc(3)),
        WINDOWS_HELPER_OPCODE.INSPECT,
      ),
    ).toThrow(/payload length is invalid/);
  });

  it("rejects a success opcode that does not match the request", () => {
    expect(() => decodeWindowsHelperResponse(encodeWindowsHelperFrame(0x90), WINDOWS_HELPER_OPCODE.INSPECT)).toThrow(
      /does not match/,
    );
  });

  it("applies the 8 KiB response cap to the future secret opcode", () => {
    const frame = encodeWindowsHelperFrame(
      WINDOWS_HELPER_OPCODE.ACQUIRE_KEY_FOR_SIGNING | 0x80,
      Buffer.alloc(WINDOWS_HELPER_SECRET_MAX_BYTES + 1),
    );
    expect(() => decodeWindowsHelperResponse(frame, WINDOWS_HELPER_OPCODE.ACQUIRE_KEY_FOR_SIGNING)).toThrow(
      /exceeds the allowed total length/,
    );
  });

  it("rejects every mutation of the fixed INSPECT facts", () => {
    const mutations: Array<(payload: Buffer) => void> = [
      (payload) => payload.writeUInt16LE(2, 0),
      (payload) => payload.writeUInt16LE(0x014c, 2),
      (payload) => payload.writeUInt32LE(WINDOWS_HELPER_ORDINARY_MAX_BYTES - 1, 4),
      (payload) => payload.writeUInt32LE(WINDOWS_HELPER_SECRET_MAX_BYTES - 1, 8),
      (payload) => payload.writeUInt32LE(1, 12),
      (payload) => payload.writeBigUInt64LE(0n, 16),
      (payload) => payload.writeBigUInt64LE(0n, 24),
    ];
    for (const mutate of mutations) {
      const payload = inspectPayload();
      mutate(payload);
      expect(() => decodeWindowsHelperInspectResponse(encodeWindowsHelperFrame(0x81, payload))).toThrow(
        WindowsHelperProtocolError,
      );
    }
  });

  it("rejects error and wrong-length INSPECT payloads", () => {
    expect(() =>
      decodeWindowsHelperInspectResponse(errorResponse(WINDOWS_HELPER_ERROR_CODE.OPERATION_UNAVAILABLE)),
    ).toThrow(/returned protocol error/);
    expect(() => decodeWindowsHelperInspectResponse(encodeWindowsHelperFrame(0x81, Buffer.alloc(31)))).toThrow(
      /payload length is invalid/,
    );
  });
});

describe("bounded one-shot runner", () => {
  it("requires an absolute executable path and a bounded timeout", async () => {
    await expect(runWindowsHelperOneShot("relative.exe", encodeWindowsHelperInspectRequest())).rejects.toMatchObject({
      reason: "spawn_failed",
    });
    await expect(
      runWindowsHelperOneShot(process.execPath, encodeWindowsHelperInspectRequest(), {
        timeoutMs: 0,
      }),
    ).rejects.toMatchObject({ reason: "timed_out" });
    await expect(
      runWindowsHelperOneShot(process.execPath, encodeWindowsHelperInspectRequest(), {
        timeoutMs: WINDOWS_HELPER_PROCESS_TIMEOUT_MS + 1,
      }),
    ).rejects.toMatchObject({ reason: "timed_out" });
  });

  it("reports a spawn failure without executing through a shell", async () => {
    const missing = `${process.execPath}.definitely-missing`;
    await expect(runWindowsHelperOneShot(missing, encodeWindowsHelperInspectRequest())).rejects.toBeInstanceOf(
      WindowsHelperProcessError,
    );
  });

  it("treats a nonzero process exit as an inspect failure", async () => {
    await expect(runWindowsProvisionerInspect(process.execPath)).rejects.toBeInstanceOf(WindowsHelperExitError);
  });
});

const configuredNativeExe = process.env.GOATCITADEL_REMOTE_WORKER_PROVISIONER_EXE;
const hasNativeExe = process.platform === "win32" && configuredNativeExe !== undefined;
const nativeIt = hasNativeExe ? it : it.skip;

describe("actual production Windows provisioner executable", () => {
  nativeIt("uses the absolute configured executable for exact INSPECT success bytes", async () => {
    expect(configuredNativeExe).toBeDefined();
    expect(isAbsolute(configuredNativeExe ?? "")).toBe(true);

    const result = await runWindowsHelperOneShot(configuredNativeExe as string, encodeWindowsHelperInspectRequest());
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toEqual(Buffer.alloc(0));
    const decoded = decodeWindowsHelperInspectResponse(result.stdout);
    expect(result.stdout).toEqual(encodeWindowsHelperFrame(0x81, inspectPayload(decoded.machine)));
    await expect(runWindowsProvisionerInspect(configuredNativeExe as string)).resolves.toEqual(decoded);
  });

  nativeIt("waits for request EOF before emitting the INSPECT response", async () => {
    expect(configuredNativeExe).toBeDefined();
    const child = spawn(configuredNativeExe as string, ["--inspect-stdio"], {
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });

    child.stdin.write(encodeWindowsHelperInspectRequest());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(child.exitCode).toBeNull();
    expect(Buffer.concat(stdout)).toEqual(Buffer.alloc(0));

    child.stdin.end();
    let eofTimer: NodeJS.Timeout | undefined;
    const disposition = await Promise.race([
      closed,
      new Promise<never>(
        (_resolve, reject) =>
          (eofTimer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("production provisioner did not close after request EOF"));
          }, WINDOWS_HELPER_PROCESS_TIMEOUT_MS)),
      ),
    ]);
    if (eofTimer !== undefined) clearTimeout(eofTimer);
    expect(disposition).toEqual({ code: 0, signal: null });
    expect(Buffer.concat(stderr)).toEqual(Buffer.alloc(0));
    const response = Buffer.concat(stdout);
    const decoded = decodeWindowsHelperInspectResponse(response);
    expect(response).toEqual(encodeWindowsHelperFrame(0x81, inspectPayload(decoded.machine)));
  });

  nativeIt("returns exact protocol errors with nonzero exits", async () => {
    expect(configuredNativeExe).toBeDefined();

    for (const opcode of Object.values(WINDOWS_HELPER_OPCODE)) {
      if (opcode === WINDOWS_HELPER_OPCODE.INSPECT) continue;
      const unavailable = await runWindowsHelperOneShot(
        configuredNativeExe as string,
        encodeWindowsHelperRequest(opcode),
      );
      expect(unavailable.exitCode).not.toBe(0);
      expect(unavailable.stdout).toEqual(errorResponse(WINDOWS_HELPER_ERROR_CODE.OPERATION_UNAVAILABLE));
    }

    const invalid = encodeWindowsHelperInspectRequest();
    invalid[7] = 1;
    const rejected = await runWindowsHelperOneShot(configuredNativeExe as string, invalid);
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stdout).toEqual(errorResponse(WINDOWS_HELPER_ERROR_CODE.PROTOCOL_INVALID));
  });

  nativeIt("rejects missing, unknown, and extra arguments before protocol output", () => {
    expect(configuredNativeExe).toBeDefined();
    for (const args of [[], ["--unknown"], ["--inspect-stdio", "extra"]]) {
      const result = spawnSync(configuredNativeExe as string, args, {
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: true,
        env: {},
        input: encodeWindowsHelperInspectRequest(),
        timeout: WINDOWS_HELPER_PROCESS_TIMEOUT_MS,
        maxBuffer: WINDOWS_HELPER_ORDINARY_MAX_BYTES,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stdout).toEqual(Buffer.alloc(0));
    }
  });
});
