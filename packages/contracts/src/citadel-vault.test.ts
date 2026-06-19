import { describe, it, expect } from "vitest";
import { generateVaultKey, sealValue, openValue } from "./citadel-vault-node.js";

describe("citadel-vault", () => {
  describe("generateVaultKey", () => {
    it("returns a 32-byte Buffer", () => {
      const key = generateVaultKey();
      expect(Buffer.isBuffer(key)).toBe(true);
      expect(key.length).toBe(32);
    });

    it("produces different keys on successive calls", () => {
      const key1 = generateVaultKey();
      const key2 = generateVaultKey();
      expect(key1.equals(key2)).toBe(false);
    });
  });

  describe("sealValue / openValue", () => {
    it("round-trips a non-trivial plaintext string", () => {
      const key = generateVaultKey();
      const plaintext = "The quick brown fox jumps over the lazy dog — secret payload #42!";
      const sealed = sealValue(plaintext, key);
      const recovered = openValue(sealed, key);
      expect(recovered).toBe(plaintext);
    });

    it("throws when opened with a different key", () => {
      const key1 = generateVaultKey();
      const key2 = generateVaultKey();
      const sealed = sealValue("sensitive data", key1);
      expect(() => openValue(sealed, key2)).toThrow();
    });

    it("throws when the ciphertext is tampered with", () => {
      const key = generateVaultKey();
      const sealed = sealValue("sensitive data", key);

      // Flip the first byte of the base64-decoded ciphertext, then re-encode.
      const raw = Buffer.from(sealed.ciphertext, "base64");
      raw[0] = (raw[0] ?? 0) ^ 0xff;
      const tampered = { ...sealed, ciphertext: raw.toString("base64") };

      expect(() => openValue(tampered, key)).toThrow();
    });
  });
});
