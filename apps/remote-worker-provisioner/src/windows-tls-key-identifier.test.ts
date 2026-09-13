import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeWindowsTlsKeyIdentifier,
  encodeWindowsTlsKeyIdentifier,
  WINDOWS_TLS_KEY_IDENTIFIER_PREFIX,
} from "./windows-tls-key-identifier.js";

const spki = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
const input = {
  keysetGeneration: 7,
  stateSha256: "11".repeat(32),
  keysetReceiptSha256: "22".repeat(32),
  workerPublicKeySpkiBase64Url: spki.toString("base64url"),
  helperExecutablePath: "C:\\Program Files\\GoatCitadel\\GoatCitadelRemoteWorkerProvisionerClient.exe",
  helperExecutableSha256: "33".repeat(32),
};

describe("protected TLS key identifiers", () => {
  it("roundtrips only public key and pinned helper authority with fixed offsets", () => {
    const identifier = encodeWindowsTlsKeyIdentifier(input);
    expect(decodeWindowsTlsKeyIdentifier(identifier)).toEqual(input);
    expect(identifier.startsWith(WINDOWS_TLS_KEY_IDENTIFIER_PREFIX)).toBe(true);
    const bytes = Buffer.from(identifier.slice(WINDOWS_TLS_KEY_IDENTIFIER_PREFIX.length), "hex");
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("GCTK");
    expect(bytes.readUInt16LE(4)).toBe(1);
    expect(bytes.readBigUInt64LE(8)).toBe(7n);
    expect(bytes.subarray(80, 112)).toEqual(createHash("sha256").update(spki).digest());
    expect(bytes.subarray(188).toString("utf16le")).toBe(input.helperExecutablePath);
  });
  it("rejects missing, zero, unsafe or noncanonical authority", () => {
    for (const generation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() => encodeWindowsTlsKeyIdentifier({ ...input, keysetGeneration: generation })).toThrow();
    for (const field of ["stateSha256", "keysetReceiptSha256", "helperExecutableSha256"] as const)
      for (const value of ["00".repeat(32), "AA".repeat(32), "ab", " " + input[field]])
        expect(() => encodeWindowsTlsKeyIdentifier({ ...input, [field]: value })).toThrow();
  });
  it.each([
    "relative.exe",
    "\\\\server\\share\\client.exe",
    "\\\\?\\C:\\client.exe",
    "C:/client.exe",
    "C:\\a\\..\\client.exe",
    "C:\\client.exe:stream",
    "C:\\a.\\client.exe",
    "C:\\a \\client.exe",
    "C:\\a\\\\client.exe",
    "C:\\a\u0000.exe",
    'C:\\a".exe',
  ])("rejects ambiguous or nonlocal helper paths: %s", (path) => {
    expect(() => encodeWindowsTlsKeyIdentifier({ ...input, helperExecutablePath: path })).toThrow();
  });
  it("preserves bounded Unicode helper paths", () => {
    const value = { ...input, helperExecutablePath: "F:\\Goat Citadel\\測試\\client.exe" };
    expect(decodeWindowsTlsKeyIdentifier(encodeWindowsTlsKeyIdentifier(value))).toEqual(value);
    expect(() =>
      encodeWindowsTlsKeyIdentifier({ ...input, helperExecutablePath: "C:\\" + "a".repeat(1021) }),
    ).toThrow();
  });
  it("rejects every truncated identifier and trailing bytes", () => {
    const id = encodeWindowsTlsKeyIdentifier(input);
    for (let length = 0; length < id.length; length++)
      expect(() => decodeWindowsTlsKeyIdentifier(id.slice(0, length))).toThrow();
    expect(() => decodeWindowsTlsKeyIdentifier(id + "00")).toThrow();
    expect(() => decodeWindowsTlsKeyIdentifier(id.toUpperCase())).toThrow();
  });
  it("checks the embedded public-key hash and Ed25519 encoding", () => {
    const id = encodeWindowsTlsKeyIdentifier(input);
    const bytes = Buffer.from(id.slice(WINDOWS_TLS_KEY_IDENTIFIER_PREFIX.length), "hex");
    for (const offset of [0, 4, 6, 80, 112, 124]) {
      const changed = Buffer.from(bytes);
      changed.writeUInt8(changed.readUInt8(offset) ^ 1, offset);
      expect(() =>
        decodeWindowsTlsKeyIdentifier(WINDOWS_TLS_KEY_IDENTIFIER_PREFIX + changed.toString("hex")),
      ).toThrow();
    }
    expect(() =>
      encodeWindowsTlsKeyIdentifier({
        ...input,
        workerPublicKeySpkiBase64Url: input.workerPublicKeySpkiBase64Url + "=",
      }),
    ).toThrow();
  });
});
