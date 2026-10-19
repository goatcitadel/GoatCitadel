import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SealedValue } from "./citadel-vault.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const KEY_LENGTH = 32; // 256-bit key

export function generateVaultKey(): Buffer {
  return randomBytes(KEY_LENGTH);
}

/**
 * Seals a value. `aad` binds the envelope to its owner (see `vaultSecretAad`);
 * omitting it produces the legacy v1 envelope.
 */
export function sealValue(plaintext: string, key: Buffer, aad?: Buffer): SealedValue {
  return sealBytes(Buffer.from(plaintext, "utf8"), key, aad);
}

export function openValue(sealed: SealedValue, key: Buffer, aad?: Buffer): string {
  return openBytes(sealed, key, aad).toString("utf8");
}

/** Wraps a data key under a key-encryption key. Both must be 256-bit. */
export function wrapKey(dek: Buffer, kek: Buffer, aad: Buffer): SealedValue {
  assertKeyLength(dek);
  return sealBytes(dek, kek, aad);
}

export function unwrapKey(wrapped: SealedValue, kek: Buffer, aad: Buffer): Buffer {
  const dek = openBytes(wrapped, kek, aad);
  if (dek.length !== KEY_LENGTH) {
    dek.fill(0);
    throw new Error("A Vault data key must be 32 bytes.");
  }
  return dek;
}

export interface VaultSecretAadInput {
  citadelId: string;
  chamberId: string | null;
  secretId: string;
  keyId: string;
}

export interface VaultDekWrapAadInput {
  citadelId: string;
  chamberId: string | null;
  keyId: string;
  dekVersion: number;
  kekVersion: number;
}

/** Canonical associated data for a sealed secret. Key order is part of the format. */
export function vaultSecretAad(input: VaultSecretAadInput): Buffer {
  return Buffer.from(
    JSON.stringify({
      purpose: "goatcitadel.vault.secret",
      v: 2,
      citadelId: input.citadelId,
      chamberId: input.chamberId,
      secretId: input.secretId,
      keyId: input.keyId,
    }),
    "utf8",
  );
}

/** Canonical associated data for a wrapped data key. Key order is part of the format. */
export function vaultDekWrapAad(input: VaultDekWrapAadInput): Buffer {
  return Buffer.from(
    JSON.stringify({
      purpose: "goatcitadel.vault.dek-wrap",
      v: 2,
      citadelId: input.citadelId,
      scope: input.chamberId === null ? "citadel" : "chamber",
      chamberId: input.chamberId,
      keyId: input.keyId,
      dekVersion: input.dekVersion,
      kekVersion: input.kekVersion,
    }),
    "utf8",
  );
}

function sealBytes(plaintext: Buffer, key: Buffer, aad?: Buffer): SealedValue {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  if (aad) cipher.setAAD(aad);

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: tag.toString("base64"),
  };
}

function openBytes(sealed: SealedValue, key: Buffer, aad?: Buffer): Buffer {
  const iv = Buffer.from(sealed.iv, "base64");
  const ciphertext = Buffer.from(sealed.ciphertext, "base64");
  const tag = Buffer.from(sealed.tag, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function assertKeyLength(key: Buffer): void {
  if (key.length !== KEY_LENGTH) {
    throw new Error("A Vault data key must be 32 bytes.");
  }
}
