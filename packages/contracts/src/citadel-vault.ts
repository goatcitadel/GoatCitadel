// node:crypto is accessed lazily (as a namespace) so merely LOADING this module is
// browser-safe. The contracts barrel re-exports this file, and browser surfaces pull
// the barrel for the types below; a top-level `import { createCipheriv } from "node:crypto"`
// would access Vite's externalized stub at load and crash every page. The seal/open
// functions are only ever called server-side, so the namespace access never runs in a browser.
import * as nodeCrypto from "node:crypto";

export interface SealedValue {
  iv: string; // base64
  ciphertext: string; // base64
  tag: string; // base64 (GCM auth tag)
}

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const KEY_LENGTH = 32; // 256-bit key

export function generateVaultKey(): Buffer {
  return nodeCrypto.randomBytes(KEY_LENGTH);
}

export function sealValue(plaintext: string, key: Buffer): SealedValue {
  const iv = nodeCrypto.randomBytes(IV_LENGTH);
  const cipher = nodeCrypto.createCipheriv(ALGORITHM, key, iv);

  const encryptedParts: Buffer[] = [cipher.update(plaintext, "utf8"), cipher.final()];
  const ciphertext = Buffer.concat(encryptedParts);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function openValue(sealed: SealedValue, key: Buffer): string {
  const iv = Buffer.from(sealed.iv, "base64");
  const ciphertext = Buffer.from(sealed.ciphertext, "base64");
  const tag = Buffer.from(sealed.tag, "base64");

  const decipher = nodeCrypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decryptedParts: Buffer[] = [decipher.update(ciphertext), decipher.final()];
  return Buffer.concat(decryptedParts).toString("utf8");
}

// --- Vault persistence (§13 MVP) ---
// A secret stored in a Citadel's Vault. The plaintext is never persisted: only the
// sealed envelope is, and the per-Citadel master key lives in the OS keychain
// (the Secret Vault is encrypted-at-rest with a single Citadel key for the MVP;
// per-Chamber keys, rotation, and E2EE are the deferred follow-on).

export interface CitadelVaultSecretRecord {
  secretId: string;
  citadelId: string;
  secretName: string;
  sealedValue: SealedValue;
  createdAt: string;
  updatedAt: string;
}

export interface CitadelVaultSecretInput {
  citadelId: string;
  secretName: string;
  sealedValue: SealedValue;
}

/** The safe-to-return view of a Vault secret: name + provenance, never the value. */
export interface CitadelVaultSecretMetadata {
  secretId: string;
  secretName: string;
  createdAt: string;
  updatedAt: string;
}

export function toVaultSecretMetadata(record: CitadelVaultSecretRecord): CitadelVaultSecretMetadata {
  return {
    secretId: record.secretId,
    secretName: record.secretName,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
