import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

const utf8 = new TextEncoder();

/**
 * Isomorphic SHA-256 hex digest of a UTF-8 string.
 *
 * `@goatcitadel/contracts` is imported by BOTH the Node runtime (gateway,
 * storage) and the Mission Control Next browser bundle, so its shared hashers
 * must not import `node:crypto` — doing so drags it into the vite production
 * build and fails rollup ("createHash is not exported by
 * __vite-browser-external"). `@noble/hashes` is a synchronous, audited,
 * dependency-free isomorphic implementation, and this digest is byte-identical
 * to `createHash("sha256").update(value, "utf8").digest("hex")` (asserted in
 * governed-mutations.test.ts), so every previously stored governance/settlement
 * fingerprint stays valid. `node:crypto` remains only in the genuinely
 * Node-only Vault primitives (`citadel-vault-node`).
 */
export function sha256Hex(value: string): string {
  return bytesToHex(sha256(utf8.encode(value)));
}
