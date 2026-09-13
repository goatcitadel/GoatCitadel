import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  WINDOWS_HELPER_OPCODE,
  encodeWindowsHelperFrame,
  encodeWindowsProtectedSignTlsClientCertificateVerifyRequest,
  decodeWindowsProtectedSignTlsClientCertificateVerifyResponse,
  validateWindowsProtectedRequestPayload,
} from "./windows-helper-protocol.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const spki = publicKey.export({ format: "der", type: "spki" });
const keySha256 = createHash("sha256").update(spki).digest();
const certificateVerify = (hashBytes = 32) =>
  Buffer.concat([
    Buffer.alloc(64, 0x20),
    Buffer.from("TLS 1.3, client CertificateVerify\0", "ascii"),
    Buffer.alloc(hashBytes, 0x17),
  ]);
const request = (preimage = certificateVerify()) => ({
  expectedStateSha256: Buffer.alloc(32, 0x41),
  expectedGeneration: 7n,
  expectedKeysetReceiptSha256: Buffer.alloc(32, 0x51),
  expectedWorkerPublicKeySpkiSha256: keySha256,
  preimage,
});
function response(input = request(), disposition = 1) {
  const payload = Buffer.alloc(184);
  payload.writeUInt16LE(1, 0);
  payload.writeUInt16LE(disposition, 2);
  if (disposition === 1) {
    input.expectedKeysetReceiptSha256.copy(payload, 8);
    keySha256.copy(payload, 40);
    spki.copy(payload, 72);
    sign(null, input.preimage, privateKey).copy(payload, 116);
  }
  return encodeWindowsHelperFrame(WINDOWS_HELPER_OPCODE.SIGN_TLS_CLIENT_CERTIFICATE_VERIFY | 0x80, payload);
}

describe("protected TLS client CertificateVerify", () => {
  it.each([32, 48])("encodes exact SHA-%i transcript material with an unassigned local operation", (hashBytes) => {
    const input = request(certificateVerify(hashBytes));
    const frame = encodeWindowsProtectedSignTlsClientCertificateVerifyRequest(input);
    expect(frame.byteLength).toBe(296);
    expect(frame[6]).toBe(0x15);
    const body = frame.subarray(16);
    expect(body.subarray(0, 16)).toEqual(Buffer.alloc(16));
    expect(body.readBigUInt64LE(52)).toBe(7n);
    expect(body.subarray(96, 128)).toEqual(keySha256);
    expect(body.subarray(128, 128 + input.preimage.byteLength)).toEqual(input.preimage);
    expect(() => validateWindowsProtectedRequestPayload(0x15, body)).not.toThrow();
    expect(decodeWindowsProtectedSignTlsClientCertificateVerifyResponse(response(input), input).disposition).toBe(
      "signed",
    );
  });

  it("refuses other TLS purposes, arbitrary signing bytes, and every truncated prefix", () => {
    const valid = certificateVerify();
    for (let length = 0; length < valid.length; length++) {
      expect(() =>
        encodeWindowsProtectedSignTlsClientCertificateVerifyRequest(request(valid.subarray(0, length))),
      ).toThrow();
    }
    for (let offset = 0; offset < 98; offset++) {
      const changed = Buffer.from(valid);
      changed.writeUInt8(changed.readUInt8(offset) ^ 1, offset);
      expect(() => encodeWindowsProtectedSignTlsClientCertificateVerifyRequest(request(changed))).toThrow();
    }
    for (const hashBytes of [31, 33, 47, 49, 64]) {
      expect(() =>
        encodeWindowsProtectedSignTlsClientCertificateVerifyRequest(request(certificateVerify(hashBytes))),
      ).toThrow();
    }
  });

  it("rejects caller-authored operation IDs, changed purpose, padding, and missing authority", () => {
    const body = encodeWindowsProtectedSignTlsClientCertificateVerifyRequest(request()).subarray(16);
    for (const offset of [0, 48, 50, 51, 92, 258, 279]) {
      const changed = Buffer.from(body);
      changed.writeUInt8(changed.readUInt8(offset) ^ 1, offset);
      expect(() => validateWindowsProtectedRequestPayload(0x15, changed)).toThrow();
    }
    for (const field of [
      "expectedStateSha256",
      "expectedKeysetReceiptSha256",
      "expectedWorkerPublicKeySpkiSha256",
    ] as const) {
      expect(() =>
        encodeWindowsProtectedSignTlsClientCertificateVerifyRequest({ ...request(), [field]: Buffer.alloc(32) }),
      ).toThrow();
    }
    for (const expectedGeneration of [0n, -1n, 9007199254740992n]) {
      expect(() =>
        encodeWindowsProtectedSignTlsClientCertificateVerifyRequest({ ...request(), expectedGeneration }),
      ).toThrow();
    }
  });

  it("verifies the exact key, receipt and transcript before exposing a signature", () => {
    const input = request();
    const valid = response(input);
    for (const offset of [2, 4, 8, 40, 72, 116, 180]) {
      const changed = Buffer.from(valid);
      changed.writeUInt8(changed.readUInt8(16 + offset) ^ 1, 16 + offset);
      expect(() => decodeWindowsProtectedSignTlsClientCertificateVerifyResponse(changed, input)).toThrow();
    }
    const changedPreimage = Buffer.from(input.preimage);
    changedPreimage.writeUInt8(changedPreimage.readUInt8(changedPreimage.length - 1) ^ 1, changedPreimage.length - 1);
    expect(() =>
      decodeWindowsProtectedSignTlsClientCertificateVerifyResponse(valid, { ...input, preimage: changedPreimage }),
    ).toThrow();
    expect(() =>
      decodeWindowsProtectedSignTlsClientCertificateVerifyResponse(valid, {
        ...input,
        expectedWorkerPublicKeySpkiSha256: Buffer.alloc(32, 0x21),
      }),
    ).toThrow();
  });

  it.each([3, 4, 5, 8])("accepts rejection %i only without returned signing authority", (disposition) => {
    const input = request();
    const rejected = response(input, disposition);
    expect(decodeWindowsProtectedSignTlsClientCertificateVerifyResponse(rejected, input).signature).toEqual(
      Buffer.alloc(64),
    );
    rejected[16 + 40] = 1;
    expect(() => decodeWindowsProtectedSignTlsClientCertificateVerifyResponse(rejected, input)).toThrow();
  });
});
