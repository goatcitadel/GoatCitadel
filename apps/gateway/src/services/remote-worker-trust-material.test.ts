import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { EnabledRemoteWorkerRuntimeConfig } from "./remote-worker-runtime-config.js";
import { REMOTE_WORKER_TRUST_MATERIAL_LIMITS, loadRemoteWorkerTrustMaterial } from "./remote-worker-trust-material.js";

// Public, non-secret test fixture generated solely for HX-501 validation.
const CA_PEM = `-----BEGIN CERTIFICATE-----
MIIBcDCCASKgAwIBAgIUUAaZ0E+T01fsR3PNdE7nIyspwTcwBQYDK2VwMCQxIjAg
BgNVBAMMGUdvYXRDaXRhZGVsIEhYNTAxIFRlc3QgQ0EwHhcNMjYwNzE1MDcyNjA4
WhcNMzYwNzEyMDcyNjA4WjAkMSIwIAYDVQQDDBlHb2F0Q2l0YWRlbCBIWDUwMSBU
ZXN0IENBMCowBQYDK2VwAyEA+cnRfBajpzPvkY91ZG5YP45wshAf3WiDEYVYA8/g
7sKjZjBkMB0GA1UdDgQWBBS1iIXKAhjx+RnM+rir3ivvw43DeDAfBgNVHSMEGDAW
gBS1iIXKAhjx+RnM+rir3ivvw43DeDASBgNVHRMBAf8ECDAGAQH/AgEAMA4GA1Ud
DwEB/wQEAwIBBjAFBgMrZXADQQBLPrseQWSuA0pxbxFfVMP/SfqGJTJeesU8q8+x
LgJZWrKTCKHHPBLzIt/8yikm2Kr2dqTX4UwhSSI+GXmfbTML
-----END CERTIFICATE-----
`;
const SERVER_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBjTCCAT+gAwIBAgIUf/Z6/Foda+RDEzz0zUE480Iyl70wBQYDK2VwMCQxIjAg
BgNVBAMMGUdvYXRDaXRhZGVsIEhYNTAxIFRlc3QgQ0EwHhcNMjYwNzE1MDcyNjA4
WhcNMzYwNzEyMDcyNjA4WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwKjAFBgMrZXAD
IQCJSRHvUwRzUmmYLUU8errkTd4QWvrDDc9snFi9xMajoaOBkjCBjzAaBgNVHREE
EzARgglsb2NhbGhvc3SHBH8AAAEwDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMC
B4AwEwYDVR0lBAwwCgYIKwYBBQUHAwEwHQYDVR0OBBYEFNvCl0GIOkQukz2R9k22
+7Fm0SggMB8GA1UdIwQYMBaAFLWIhcoCGPH5Gcz6uKveK+/DjcN4MAUGAytlcANB
AAkEBmr5zikG6jfo16yaU78ISZiOWCLqMVYq3fcsnJ/xiRWAisPtVI28Lv3fkS7z
brxE/pceFEEYPoOp/HXhIgU=
-----END CERTIFICATE-----
`;
const SERVER_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIC/MaTaqBt7eKZ9mhyxfULgSehe6scjWMvO8JKHNQx45
-----END PRIVATE KEY-----
`;
const SIGNER_PUBLIC_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA9S1rqkkiXXW1ZQXi4XCQJr5HBXJCbhuKl4Mo/bjHVB0=
-----END PUBLIC KEY-----
`;

const NOW = new Date("2026-07-15T08:00:00.000Z");
const cleanupRoots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function lockedRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "goat-worker-trust-"));
  cleanupRoots.push(root);
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot as string;
    const { stdout } = await execFileAsync(join(systemRoot, "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
    const sid = /"(S-1-[0-9-]+)"/u.exec(stdout)?.[1];
    if (sid === undefined) throw new Error("Unable to resolve the Windows test operator SID.");
    await execFileAsync(join(systemRoot, "System32", "icacls.exe"), [
      root,
      "/inheritance:r",
      "/grant:r",
      `*${sid}:(OI)(CI)F`,
      "*S-1-5-18:(OI)(CI)F",
      "*S-1-5-32-544:(OI)(CI)F",
    ]);
  } else {
    await execFileAsync("chmod", ["700", root]);
  }
  return root;
}

async function fixture(overrides: Partial<Record<"cert" | "key" | "ca" | "signer", string | Buffer>> = {}): Promise<{
  readonly config: EnabledRemoteWorkerRuntimeConfig;
  readonly root: string;
}> {
  const root = await lockedRoot();
  const paths = {
    cert: join(root, "server.crt"),
    key: join(root, "server.key"),
    ca: join(root, "client-ca.crt"),
    signer: join(root, "signer.pub"),
  };
  await Promise.all([
    writeFile(paths.cert, overrides.cert ?? SERVER_CERT_PEM),
    writeFile(paths.key, overrides.key ?? SERVER_KEY_PEM),
    writeFile(paths.ca, overrides.ca ?? CA_PEM),
    writeFile(paths.signer, overrides.signer ?? SIGNER_PUBLIC_PEM),
  ]);
  const caSha256 = createHash("sha256").update(new X509Certificate(CA_PEM).raw).digest("hex");
  const signerSha256 = createHash("sha256")
    .update(
      Buffer.from(SIGNER_PUBLIC_PEM.match(/\n([A-Za-z0-9+/=\n]+)-----END/u)?.[1]?.replace(/\n/gu, "") ?? "", "base64"),
    )
    .digest("hex");
  return {
    root,
    config: Object.freeze({
      enabled: true,
      host: "127.0.0.1",
      port: 9443,
      tls: Object.freeze({
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        requestCert: true,
        rejectUnauthorized: true,
        serverCertificateFile: paths.cert,
        serverKeyFile: paths.key,
        clientCaFile: paths.ca,
        clientCaSha256: caSha256,
      }),
      manifestSigner: Object.freeze({
        keyId: "release-2026-07",
        publicKeyFile: paths.signer,
        spkiSha256: signerSha256,
      }),
      bootstrapTtlSeconds: 600,
      credentialTtlSeconds: 900,
    }),
  };
}

describe("remote worker trust material", () => {
  it.runIf(process.platform === "win32")(
    "loads exact DER/SPKI-pinned material through no-follow handles and exposes no raw key bytes",
    async () => {
      const { config } = await fixture();
      const material = await loadRemoteWorkerTrustMaterial(config, NOW);
      expect(material.diagnostics()).toMatchObject({
        serverCertificateChainLength: 1,
        clientCaCertificateDerSha256: config.tls.clientCaSha256,
        manifestSignerSpkiSha256: config.manifestSigner.spkiSha256,
        serverKeyAlgorithm: "ed25519",
      });
      const tls = material.tlsServerOptions();
      expect(Buffer.isBuffer(tls.cert)).toBe(true);
      expect(Buffer.isBuffer(tls.ca)).toBe(true);
      expect(Buffer.isBuffer(tls.key)).toBe(true);
      expect(tls.key.toString("ascii")).toContain("BEGIN PRIVATE KEY");
      expect(JSON.stringify(material.diagnostics())).not.toContain(config.tls.serverKeyFile);
      expect(JSON.stringify(material)).not.toContain("PRIVATE KEY");
      tls.dispose();
      expect(tls.key.every((value) => value === 0)).toBe(true);
      material.dispose();
      material.dispose();
      expect(() => material.tlsServerOptions()).toThrow("no longer active");
    },
    60_000,
  );

  it.runIf(process.platform === "win32")(
    "rejects pin mismatch without reflecting pin or path material",
    async () => {
      const { config } = await fixture();
      const secretPin = "f".repeat(64);
      const bad = { ...config, tls: { ...config.tls, clientCaSha256: secretPin } } as EnabledRemoteWorkerRuntimeConfig;
      let caught: unknown;
      try {
        await loadRemoteWorkerTrustMaterial(bad, NOW);
      } catch (error) {
        caught = error;
      }
      expect(String(caught)).toContain("pin did not match");
      expect(String(caught)).not.toContain(secretPin);
      expect(String(caught)).not.toContain(config.tls.clientCaFile);
    },
    60_000,
  );

  it.runIf(process.platform === "win32")(
    "rejects multiple CA PEM blocks, encrypted keys, mismatched keys, and bounded oversize keys",
    async () => {
      const duplicate = await fixture({ ca: `${CA_PEM}${CA_PEM}` });
      await expect(loadRemoteWorkerTrustMaterial(duplicate.config, NOW)).rejects.toThrow("ambiguous");

      const encrypted = await fixture({
        key: "-----BEGIN ENCRYPTED PRIVATE KEY-----\nYWJj\n-----END ENCRYPTED PRIVATE KEY-----\n",
      });
      await expect(loadRemoteWorkerTrustMaterial(encrypted.config, NOW)).rejects.toThrow("unsupported secret owner");

      const other = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" });
      const mismatch = await fixture({ key: other });
      await expect(loadRemoteWorkerTrustMaterial(mismatch.config, NOW)).rejects.toThrow("do not match");

      const oversized = await fixture({
        key: Buffer.alloc(REMOTE_WORKER_TRUST_MATERIAL_LIMITS.serverPrivateKeyBytes + 1, 0x61),
      });
      await expect(loadRemoteWorkerTrustMaterial(oversized.config, NOW)).rejects.toThrow("could not be loaded");
    },
    120_000,
  );

  it.runIf(process.platform === "win32")(
    "rejects private-key prefix, suffix, second material, weak RSA, and unsupported EC curves",
    async () => {
      for (const key of [
        `ignored-prefix\n${SERVER_KEY_PEM}`,
        `${SERVER_KEY_PEM}ignored-suffix\n`,
        `${SERVER_KEY_PEM}${SERVER_KEY_PEM}`,
      ]) {
        const injected = await fixture({ key });
        await expect(loadRemoteWorkerTrustMaterial(injected.config, NOW)).rejects.toThrow(/ambiguous|extra data/u);
      }
      for (const overrides of [
        { cert: `${SERVER_CERT_PEM}\n` },
        { ca: `${CA_PEM}\n` },
        { signer: `${SIGNER_PUBLIC_PEM}\n` },
      ]) {
        const injected = await fixture(overrides);
        await expect(loadRemoteWorkerTrustMaterial(injected.config, NOW)).rejects.toThrow(/extra data|invalid/u);
      }
      const weakRsa = generateKeyPairSync("rsa", { modulusLength: 1_024 }).privateKey.export({
        format: "pem",
        type: "pkcs8",
      });
      const weak = await fixture({ key: weakRsa });
      await expect(loadRemoteWorkerTrustMaterial(weak.config, NOW)).rejects.toThrow("minimum strength");

      const unsupportedEc = generateKeyPairSync("ec", { namedCurve: "secp256k1" }).privateKey.export({
        format: "pem",
        type: "pkcs8",
      });
      const unsupported = await fixture({ key: unsupportedEc });
      await expect(loadRemoteWorkerTrustMaterial(unsupported.config, NOW)).rejects.toThrow("curve is unsupported");
    },
    180_000,
  );
});
