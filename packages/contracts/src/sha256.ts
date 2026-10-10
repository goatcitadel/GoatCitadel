import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes as portableHexToBytes, toBytes } from "@noble/hashes/utils";

const utf8 = new TextEncoder();
// Resolve builtins only on supported Node runtimes. Static node imports would
// break the browser bundle; browsers and older Node versions retain Noble.
const nativeCrypto =
  typeof process !== "undefined" && typeof process.getBuiltinModule === "function"
    ? process.getBuiltinModule("crypto")
    : undefined;
const nativeBuffer =
  typeof process !== "undefined" && typeof process.getBuiltinModule === "function"
    ? process.getBuiltinModule("buffer").Buffer
    : undefined;

/**
 * Isomorphic SHA-256 hex digest of a UTF-8 string.
 *
 * Node uses its native SHA-256 implementation; browsers use Noble. Both hash
 * the same TextEncoder bytes, preserving stored governance fingerprints and
 * UTF-8 replacement of malformed surrogate pairs.
 */
export function sha256Hex(value: string): string {
  return sha256BytesHex(utf8.encode(value));
}

/** Isomorphic SHA-256 hex digest of exact caller-owned bytes. */
export function sha256BytesHex(value: Uint8Array): string {
  const bytes = toBytes(value);
  return nativeCrypto ? nativeCrypto.createHash("sha256").update(bytes).digest("hex") : bytesToHex(sha256(bytes));
}

/** Strict hex decoding with an exact-size, caller-owned byte array. */
export function hexToBytes(value: string): Uint8Array {
  // Buffer's decoder silently truncates malformed hex. Delegate invalid input
  // to Noble to preserve its validation and errors in every runtime.
  if (!nativeBuffer || typeof value !== "string" || value.length % 2 !== 0 || /[^0-9a-fA-F]/u.test(value)) {
    return portableHexToBytes(value);
  }
  return new Uint8Array(nativeBuffer.from(value, "hex"));
}
