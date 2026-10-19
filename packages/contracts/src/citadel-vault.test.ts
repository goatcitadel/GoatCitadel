import { describe, it, expect } from "vitest";
import {
  generateVaultKey,
  openValue,
  sealValue,
  unwrapKey,
  vaultDekWrapAad,
  vaultSecretAad,
  wrapKey,
} from "./citadel-vault-node.js";

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

  describe("associated data binding", () => {
    const binding = { citadelId: "c1", chamberId: "ch1", secretId: "s1", keyId: "k1" };

    it("round-trips with associated data", () => {
      const key = generateVaultKey();
      const sealed = sealValue("bound value", key, vaultSecretAad(binding));
      expect(openValue(sealed, key, vaultSecretAad(binding))).toBe("bound value");
    });

    it.each(["citadelId", "chamberId", "secretId", "keyId"] as const)("fails to open when %s differs", (field) => {
      const key = generateVaultKey();
      const sealed = sealValue("bound value", key, vaultSecretAad(binding));
      const moved = { ...binding, [field]: `${binding[field]}-other` };
      expect(() => openValue(sealed, key, vaultSecretAad(moved))).toThrow();
    });

    it("fails to open a bound envelope without associated data", () => {
      const key = generateVaultKey();
      const sealed = sealValue("bound value", key, vaultSecretAad(binding));
      expect(() => openValue(sealed, key)).toThrow();
    });

    it("opens a legacy envelope sealed without associated data", () => {
      const key = generateVaultKey();
      const legacy = sealValue("legacy value", key);
      expect(openValue(legacy, key)).toBe("legacy value");
    });

    it("emits the exact canonical secret AAD", () => {
      expect(vaultSecretAad({ citadelId: "c1", chamberId: null, secretId: "s1", keyId: "k1" }).toString("utf8")).toBe(
        '{"purpose":"goatcitadel.vault.secret","v":2,"citadelId":"c1","chamberId":null,"secretId":"s1","keyId":"k1"}',
      );
    });

    it("emits a citadel scope for a null Chamber and a chamber scope otherwise", () => {
      const base = { citadelId: "c1", keyId: "k1", dekVersion: 3, kekVersion: 2 };
      expect(vaultDekWrapAad({ ...base, chamberId: null }).toString("utf8")).toBe(
        '{"purpose":"goatcitadel.vault.dek-wrap","v":2,"citadelId":"c1","scope":"citadel","chamberId":null,"keyId":"k1","dekVersion":3,"kekVersion":2}',
      );
      expect(vaultDekWrapAad({ ...base, chamberId: "ch1" }).toString("utf8")).toBe(
        '{"purpose":"goatcitadel.vault.dek-wrap","v":2,"citadelId":"c1","scope":"chamber","chamberId":"ch1","keyId":"k1","dekVersion":3,"kekVersion":2}',
      );
    });
  });

  describe("wrapKey / unwrapKey", () => {
    const aadInput = { citadelId: "c1", chamberId: "ch1", keyId: "k1", dekVersion: 1, kekVersion: 1 };

    it("round-trips a data key", () => {
      const kek = generateVaultKey();
      const dek = generateVaultKey();
      const wrapped = wrapKey(dek, kek, vaultDekWrapAad(aadInput));
      expect(unwrapKey(wrapped, kek, vaultDekWrapAad(aadInput)).equals(dek)).toBe(true);
    });

    it("fails to unwrap under another Chamber's associated data", () => {
      const kek = generateVaultKey();
      const wrapped = wrapKey(generateVaultKey(), kek, vaultDekWrapAad(aadInput));
      expect(() => unwrapKey(wrapped, kek, vaultDekWrapAad({ ...aadInput, chamberId: "ch2" }))).toThrow();
    });

    it("rejects a payload that is not 32 bytes", () => {
      const kek = generateVaultKey();
      const aad = vaultDekWrapAad(aadInput);
      const short = sealValue("x".repeat(16), kek, aad);
      expect(() => unwrapKey(short, kek, aad)).toThrow(/32 bytes/);
    });

    it("refuses to wrap a key that is not 32 bytes", () => {
      expect(() => wrapKey(Buffer.alloc(16, 1), generateVaultKey(), vaultDekWrapAad(aadInput))).toThrow(/32 bytes/);
    });
  });
});
