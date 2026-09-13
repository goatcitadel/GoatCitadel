import { createHash } from "node:crypto";

export const WINDOWS_TLS_KEY_IDENTIFIER_PREFIX = "goatcitadel-tls-v1:";
export const WINDOWS_TLS_KEY_IDENTIFIER_HEADER_BYTES = 188;
export const WINDOWS_TLS_HELPER_PATH_MAX_CHARACTERS = 1023;
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Public, admitted authority only. No private key or reusable bearer belongs here. */
export interface WindowsTlsKeyIdentifierInput {
  readonly keysetGeneration: number;
  readonly stateSha256: string;
  readonly keysetReceiptSha256: string;
  readonly workerPublicKeySpkiBase64Url: string;
  readonly helperExecutablePath: string;
  readonly helperExecutableSha256: string;
}

function digest(value: string): Buffer {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value) || /^0+$/u.test(value))
    throw new Error("Protected TLS key identifier requires a nonzero canonical digest.");
  return Buffer.from(value, "hex");
}

export function assertWindowsTlsHelperPath(value: string): void {
  if (
    typeof value !== "string" ||
    value.length > WINDOWS_TLS_HELPER_PATH_MAX_CHARACTERS ||
    !/^[A-Za-z]:\\/u.test(value) ||
    /[<>"|?*/]/u.test(value) ||
    value.slice(2).includes(":")
  )
    throw new Error("Protected TLS helper path must be an unambiguous local drive path.");
  for (const component of value.slice(3).split("\\")) {
    if (!component || /[. ]$/u.test(component) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(component))
      throw new Error("Protected TLS helper path contains an invalid component.");
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32) throw new Error("Protected TLS helper path contains a control character.");
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("Protected TLS helper path has invalid UTF-16.");
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error("Protected TLS helper path has invalid UTF-16.");
  }
}

export function encodeWindowsTlsKeyIdentifier(input: WindowsTlsKeyIdentifierInput): string {
  if (!Number.isSafeInteger(input.keysetGeneration) || input.keysetGeneration <= 0)
    throw new Error("Protected TLS keyset generation is invalid.");
  assertWindowsTlsHelperPath(input.helperExecutablePath);
  const spki = Buffer.from(input.workerPublicKeySpkiBase64Url, "base64url");
  if (
    spki.length !== 44 ||
    spki.toString("base64url") !== input.workerPublicKeySpkiBase64Url ||
    !spki.subarray(0, 12).equals(SPKI_PREFIX) ||
    spki.subarray(12).every((byte) => byte === 0)
  )
    throw new Error("Protected TLS key must be canonical Ed25519 public SPKI.");
  const bytes = Buffer.alloc(WINDOWS_TLS_KEY_IDENTIFIER_HEADER_BYTES + input.helperExecutablePath.length * 2);
  bytes.write("GCTK", 0, "ascii");
  bytes.writeUInt16LE(1, 4);
  bytes.writeUInt16LE(input.helperExecutablePath.length, 6);
  bytes.writeBigUInt64LE(BigInt(input.keysetGeneration), 8);
  digest(input.stateSha256).copy(bytes, 16);
  digest(input.keysetReceiptSha256).copy(bytes, 48);
  createHash("sha256").update(spki).digest().copy(bytes, 80);
  spki.copy(bytes, 112);
  digest(input.helperExecutableSha256).copy(bytes, 156);
  bytes.write(input.helperExecutablePath, 188, "utf16le");
  return WINDOWS_TLS_KEY_IDENTIFIER_PREFIX + bytes.toString("hex");
}

export function decodeWindowsTlsKeyIdentifier(identifier: string): WindowsTlsKeyIdentifierInput {
  const maximum =
    WINDOWS_TLS_KEY_IDENTIFIER_PREFIX.length +
    2 * (WINDOWS_TLS_KEY_IDENTIFIER_HEADER_BYTES + 2 * WINDOWS_TLS_HELPER_PATH_MAX_CHARACTERS);
  if (
    typeof identifier !== "string" ||
    identifier.length > maximum ||
    !identifier.startsWith(WINDOWS_TLS_KEY_IDENTIFIER_PREFIX)
  )
    throw new Error("Protected TLS key identifier prefix or length is invalid.");
  const hex = identifier.slice(WINDOWS_TLS_KEY_IDENTIFIER_PREFIX.length);
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(hex))
    throw new Error("Protected TLS key identifier is not canonical hex.");
  const bytes = Buffer.from(hex, "hex");
  if (
    bytes.length < 196 ||
    bytes.subarray(0, 4).toString("ascii") !== "GCTK" ||
    bytes.readUInt16LE(4) !== 1 ||
    bytes.length !== 188 + bytes.readUInt16LE(6) * 2 ||
    bytes.readBigUInt64LE(8) > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new Error("Protected TLS key identifier header is invalid.");
  const input = {
    keysetGeneration: Number(bytes.readBigUInt64LE(8)),
    stateSha256: bytes.subarray(16, 48).toString("hex"),
    keysetReceiptSha256: bytes.subarray(48, 80).toString("hex"),
    workerPublicKeySpkiBase64Url: bytes.subarray(112, 156).toString("base64url"),
    helperExecutablePath: bytes.subarray(188).toString("utf16le"),
    helperExecutableSha256: bytes.subarray(156, 188).toString("hex"),
  };
  if (encodeWindowsTlsKeyIdentifier(input) !== identifier)
    throw new Error("Protected TLS key identifier authority is invalid.");
  return Object.freeze(input);
}
