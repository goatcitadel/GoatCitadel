import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SealedValue } from "./citadel-vault.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const KEY_LENGTH = 32; // 256-bit key

export function generateVaultKey(): Buffer {
  return randomBytes(KEY_LENGTH);
}

export function sealValue(plaintext: string, key: Buffer): SealedValue {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

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

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decryptedParts: Buffer[] = [decipher.update(ciphertext), decipher.final()];
  return Buffer.concat(decryptedParts).toString("utf8");
}
