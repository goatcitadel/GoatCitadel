import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  canonicalJsonString,
  type RemoteWorkerRuntimeManifest,
} from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  REMOTE_WORKER_ATTESTATION_MAX_FILE_BYTES,
  REMOTE_WORKER_ATTESTATION_MAX_TOTAL_BYTES,
  REMOTE_WORKER_INSTALLED_TREE_ATTESTATION_SCHEMA_VERSION,
  REMOTE_WORKER_INSTALLED_TREE_SCHEMA_VERSION,
  REMOTE_WORKER_VENDOR_TREE_SCHEMA_VERSION,
  verifyRemoteWorkerInstalledTreeAttestation,
  verifyRemoteWorkerRuntimeManifestSignature,
  type RemoteWorkerInstalledTreeAttestation,
  type RemoteWorkerInstalledTreeFile,
} from "./remote-worker-attestation-service.js";

const NOW = new Date("2026-07-14T20:00:00.000Z");
const SIGNER_KEY_ID = "release-2026-07";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function file(path: string, role: RemoteWorkerInstalledTreeFile["role"], seed: string): RemoteWorkerInstalledTreeFile {
  const stat = sha256(`stat:${seed}`);
  return {
    path,
    role,
    kind: "regular_file",
    sizeBytes: Buffer.byteLength(seed, "utf8") + 10,
    sha256: sha256(`file:${seed}`),
    identity: `device-1:inode-${seed}`,
    beforeStatSha256: stat,
    afterStatSha256: stat,
    immutable: true,
  };
}

interface AttestationFixture {
  manifest: RemoteWorkerRuntimeManifest;
  attestation: RemoteWorkerInstalledTreeAttestation;
  signerPublicKeySpkiDer: Buffer;
  signerSpkiSha256: string;
}

function fixture(): AttestationFixture {
  const files = [
    file("bundle/worker.js", "bundle", "bundle"),
    file("launcher/worker.mjs", "launcher", "launcher"),
    file("locks/pnpm-lock.yaml", "dependency_lock", "lock"),
    file("runtime/bootstrap.js", "runtime", "runtime"),
    file("vendor/pkg/index.js", "vendor", "vendor"),
  ];
  const totalBytes = files.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const rootIdentity = "volume-7:file-id-42";
  const treeSha256 = installedTreeSha256(rootIdentity, files, totalBytes);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signerPublicKeySpkiDer = publicKey.export({ format: "der", type: "spki" });
  const vendorFiles = files.filter((entry) => entry.role === "vendor");
  const payload = {
    schemaVersion: REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    bundleSha256: files[0]!.sha256,
    dependencyLockSha256: files[2]!.sha256,
    vendorTreeSha256: sha256(
      canonicalJsonString({ schemaVersion: REMOTE_WORKER_VENDOR_TREE_SCHEMA_VERSION, files: vendorFiles }),
    ),
    launcherSha256: files[1]!.sha256,
    installedTreeManifestSha256: treeSha256,
    installedTreeFileCount: files.length,
    platform: "windows",
    architecture: "x64",
  };
  const payloadSha256 = sha256(canonicalJsonString(payload));
  const manifest: RemoteWorkerRuntimeManifest = {
    payload,
    payloadSha256,
    signatureAlgorithm: "ed25519",
    signerKeyId: SIGNER_KEY_ID,
    signatureBase64Url: sign(null, Buffer.from(canonicalJsonString(payload), "utf8"), privateKey).toString("base64url"),
  };
  const scannedAt = NOW.toISOString();
  const attestationSha256 = installedTreeAttestationSha256({
    runtimeManifestPayloadSha256: payloadSha256,
    scannedAt,
    rootIdentity,
    totalBytes,
    treeSha256,
  });
  return {
    manifest,
    signerPublicKeySpkiDer,
    signerSpkiSha256: sha256(signerPublicKeySpkiDer),
    attestation: {
      schemaVersion: REMOTE_WORKER_INSTALLED_TREE_ATTESTATION_SCHEMA_VERSION,
      runtimeManifestPayloadSha256: payloadSha256,
      scannedAt,
      rootIdentity,
      files,
      totalBytes,
      treeSha256,
      attestationSha256,
    },
  };
}

function installedTreeSha256(
  rootIdentity: string,
  files: readonly RemoteWorkerInstalledTreeFile[],
  totalBytes: number,
): string {
  return sha256(
    canonicalJsonString({
      schemaVersion: REMOTE_WORKER_INSTALLED_TREE_SCHEMA_VERSION,
      rootIdentity,
      files,
      totalBytes,
    }),
  );
}

function installedTreeAttestationSha256(input: {
  runtimeManifestPayloadSha256: string;
  scannedAt: string;
  rootIdentity: string;
  totalBytes: number;
  treeSha256: string;
}): string {
  return sha256(
    canonicalJsonString({
      schemaVersion: REMOTE_WORKER_INSTALLED_TREE_ATTESTATION_SCHEMA_VERSION,
      ...input,
    }),
  );
}

function rehashAttestation(attestation: RemoteWorkerInstalledTreeAttestation): RemoteWorkerInstalledTreeAttestation {
  const treeSha256 = installedTreeSha256(attestation.rootIdentity, attestation.files, attestation.totalBytes);
  return {
    ...attestation,
    treeSha256,
    attestationSha256: installedTreeAttestationSha256({
      runtimeManifestPayloadSha256: attestation.runtimeManifestPayloadSha256,
      scannedAt: attestation.scannedAt,
      rootIdentity: attestation.rootIdentity,
      totalBytes: attestation.totalBytes,
      treeSha256,
    }),
  };
}

async function verifyFixture(value: AttestationFixture) {
  return verifyRemoteWorkerInstalledTreeAttestation({
    manifest: value.manifest,
    expectedSignerKeyId: SIGNER_KEY_ID,
    expectedSignerSpkiSha256: value.signerSpkiSha256,
    signerPublicKeySpkiDer: value.signerPublicKeySpkiDer,
    root: "C:\\installed\\goatcitadel-worker",
    scanner: { scan: () => value.attestation },
    now: NOW,
  });
}

describe("remote worker runtime and installed-tree attestation", () => {
  it("verifies a pinned Ed25519 manifest and a fresh immutable installed tree", async () => {
    const value = fixture();
    const scan = vi.fn(() => value.attestation);
    const receipt = await verifyRemoteWorkerInstalledTreeAttestation({
      manifest: value.manifest,
      expectedSignerKeyId: SIGNER_KEY_ID,
      expectedSignerSpkiSha256: value.signerSpkiSha256,
      signerPublicKeySpkiDer: value.signerPublicKeySpkiDer,
      root: "C:\\installed\\goatcitadel-worker",
      scanner: { scan },
      now: NOW,
    });
    expect(scan).toHaveBeenCalledWith({
      root: "C:\\installed\\goatcitadel-worker",
      maxFileCount: 10_000,
      maxFileBytes: REMOTE_WORKER_ATTESTATION_MAX_FILE_BYTES,
      maxTotalBytes: REMOTE_WORKER_ATTESTATION_MAX_TOTAL_BYTES,
    });
    expect(receipt).toMatchObject({
      treeSha256: value.manifest.payload.installedTreeManifestSha256,
      installedTreeAttestationSha256: value.attestation.attestationSha256,
      fileCount: value.attestation.files.length,
      totalBytes: value.attestation.totalBytes,
      scannedAt: NOW.toISOString(),
      manifest: {
        signerKeyId: SIGNER_KEY_ID,
        signerSpkiSha256: value.signerSpkiSha256,
        payloadSha256: value.manifest.payloadSha256,
      },
    });
    expect(receipt.manifest.manifestVerificationReceiptSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("verifies the signature over canonical payload bytes, not the payload hash string", () => {
    const value = fixture();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ format: "der", type: "spki" });
    const forged = {
      ...value.manifest,
      signatureBase64Url: sign(null, Buffer.from(value.manifest.payloadSha256, "utf8"), privateKey).toString(
        "base64url",
      ),
    };
    expect(() =>
      verifyRemoteWorkerRuntimeManifestSignature({
        manifest: forged,
        expectedSignerKeyId: SIGNER_KEY_ID,
        expectedSignerSpkiSha256: sha256(spki),
        signerPublicKeySpkiDer: spki,
      }),
    ).toThrow("manifest signature is invalid");
  });

  it("rejects accessor-backed manifests without reading them", () => {
    const value = fixture();
    let payloadReads = 0;
    const manifest = { ...value.manifest };
    Object.defineProperty(manifest, "payload", {
      enumerable: true,
      configurable: true,
      get: () => {
        payloadReads += 1;
        return value.manifest.payload;
      },
    });

    expect(() =>
      verifyRemoteWorkerRuntimeManifestSignature({
        manifest,
        expectedSignerKeyId: SIGNER_KEY_ID,
        expectedSignerSpkiSha256: value.signerSpkiSha256,
        signerPublicKeySpkiDer: value.signerPublicKeySpkiDer,
      }),
    ).toThrow("manifest contract is invalid");
    expect(payloadReads).toBe(0);
  });

  it("binds an awaited installed-tree scan to one frozen signed-manifest snapshot", async () => {
    const value = fixture();
    let releaseScan!: () => void;
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    const changedFiles = value.attestation.files.map((entry, index) =>
      index === 1 ? { ...entry, sha256: "f".repeat(64) } : entry,
    );
    const changedTreeSha256 = installedTreeSha256(
      value.attestation.rootIdentity,
      changedFiles,
      value.attestation.totalBytes,
    );
    const changedPayload = {
      ...value.manifest.payload,
      launcherSha256: changedFiles[1]!.sha256,
      installedTreeManifestSha256: changedTreeSha256,
    };
    const changedPayloadSha256 = sha256(canonicalJsonString(changedPayload));
    const changedAttestation = rehashAttestation({
      ...value.attestation,
      runtimeManifestPayloadSha256: changedPayloadSha256,
      files: changedFiles,
    });

    const pending = verifyRemoteWorkerInstalledTreeAttestation({
      manifest: value.manifest,
      expectedSignerKeyId: SIGNER_KEY_ID,
      expectedSignerSpkiSha256: value.signerSpkiSha256,
      signerPublicKeySpkiDer: value.signerPublicKeySpkiDer,
      root: "C:\\installed\\goatcitadel-worker",
      scanner: {
        scan: async () => {
          await scanGate;
          return changedAttestation;
        },
      },
      now: NOW,
    });

    (value.manifest as { payload: RemoteWorkerRuntimeManifest["payload"] }).payload = changedPayload;
    (value.manifest as { payloadSha256: string }).payloadSha256 = changedPayloadSha256;
    releaseScan();

    await expect(pending).rejects.toThrow("bound to a different manifest");
  });

  it("rejects the wrong signer ID, signer SPKI pin, key, and signature", () => {
    const value = fixture();
    const base = {
      manifest: value.manifest,
      expectedSignerKeyId: SIGNER_KEY_ID,
      expectedSignerSpkiSha256: value.signerSpkiSha256,
      signerPublicKeySpkiDer: value.signerPublicKeySpkiDer,
    };
    expect(() => verifyRemoteWorkerRuntimeManifestSignature({ ...base, expectedSignerKeyId: "other-release" })).toThrow(
      "signer is not authorized",
    );
    expect(() =>
      verifyRemoteWorkerRuntimeManifestSignature({ ...base, expectedSignerSpkiSha256: "f".repeat(64) }),
    ).toThrow("key pin did not match");
    const otherKey = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
    expect(() =>
      verifyRemoteWorkerRuntimeManifestSignature({
        ...base,
        signerPublicKeySpkiDer: otherKey,
        expectedSignerSpkiSha256: sha256(otherKey),
      }),
    ).toThrow("manifest signature is invalid");
    expect(() =>
      verifyRemoteWorkerRuntimeManifestSignature({
        ...base,
        manifest: { ...value.manifest, signatureBase64Url: Buffer.alloc(64, 8).toString("base64url") },
      }),
    ).toThrow("manifest signature is invalid");
  });

  it("keeps tree content hashing non-circular while binding manifest hash in attestationSha256", () => {
    const value = fixture();
    const changedManifestHash = "f".repeat(64);
    const changedAttestation = rehashAttestation({
      ...value.attestation,
      runtimeManifestPayloadSha256: changedManifestHash,
    });
    expect(changedAttestation.treeSha256).toBe(value.attestation.treeSha256);
    expect(changedAttestation.attestationSha256).not.toBe(value.attestation.attestationSha256);
    expect(changedAttestation.attestationSha256).toBe(
      installedTreeAttestationSha256({
        runtimeManifestPayloadSha256: changedManifestHash,
        scannedAt: value.attestation.scannedAt,
        rootIdentity: value.attestation.rootIdentity,
        totalBytes: value.attestation.totalBytes,
        treeSha256: value.attestation.treeSha256,
      }),
    );
  });

  it("rejects unknown/missing top-level and file fields", async () => {
    const unknownTop = fixture();
    unknownTop.attestation = { ...unknownTop.attestation, unexpected: true } as RemoteWorkerInstalledTreeAttestation;
    await expect(verifyFixture(unknownTop)).rejects.toThrow("missing or unknown fields");

    const missingTop = fixture();
    const { scannedAt: _scannedAt, ...withoutScannedAt } = missingTop.attestation;
    missingTop.attestation = withoutScannedAt as RemoteWorkerInstalledTreeAttestation;
    await expect(verifyFixture(missingTop)).rejects.toThrow("missing or unknown fields");

    const unknownFile = fixture();
    unknownFile.attestation = {
      ...unknownFile.attestation,
      files: [{ ...unknownFile.attestation.files[0]!, extra: true }, ...unknownFile.attestation.files.slice(1)],
    } as RemoteWorkerInstalledTreeAttestation;
    await expect(verifyFixture(unknownFile)).rejects.toThrow("missing or unknown fields");
  });

  it.each([
    "/absolute/file.js",
    "C:/drive/file.js",
    "\\\\server\\share\\file.js",
    "vendor\\pkg\\file.js",
    "vendor/../escape.js",
    "vendor/./file.js",
    "vendor//file.js",
    "vendor/control\u0000.js",
    "vendor/cafe\u0301.js",
    "vendor/file.js:stream",
    "vendor/file.js.",
    "vendor/file.js ",
    "vendor/CON",
    "vendor/aux.txt",
    "vendor/LPT1.js",
    "vendor/NUL.txt/child.js",
    "vendor/COM\u00b9.txt",
    `${"a".repeat(513)}.js`,
  ])("rejects the unsafe or non-canonical relative path %#", async (path) => {
    const value = fixture();
    value.attestation = {
      ...value.attestation,
      files: value.attestation.files.map((entry, index) => (index === 0 ? { ...entry, path } : entry)),
    };
    await expect(verifyFixture(value)).rejects.toThrow("file path is invalid");
  });

  it("rejects unsorted paths and case-fold collisions", async () => {
    const unsorted = fixture();
    unsorted.attestation = {
      ...unsorted.attestation,
      files: [unsorted.attestation.files[1]!, unsorted.attestation.files[0]!, ...unsorted.attestation.files.slice(2)],
    };
    await expect(verifyFixture(unsorted)).rejects.toThrow("not in canonical byte order");

    const collision = fixture();
    collision.attestation = {
      ...collision.attestation,
      files: [
        { ...collision.attestation.files[0]!, path: "bundle/Worker.js" },
        { ...collision.attestation.files[0]!, path: "bundle/worker.js", role: "runtime" },
        ...collision.attestation.files.slice(1),
      ],
    };
    await expect(verifyFixture(collision)).rejects.toThrow("case-fold collision");

    const alias = fixture();
    alias.attestation = {
      ...alias.attestation,
      files: alias.attestation.files.map((entry, index) =>
        index === 1 ? { ...entry, identity: alias.attestation.files[0]!.identity } : entry,
      ),
    };
    await expect(verifyFixture(alias)).rejects.toThrow("identity alias");
  });

  it.each(["symlink", "reparse_point", "directory", "socket"])(
    "rejects the non-regular installed-tree kind %s",
    async (kind) => {
      const value = fixture();
      value.attestation = {
        ...value.attestation,
        files: value.attestation.files.map((entry, index) =>
          index === 4 ? { ...entry, kind: kind as "regular_file" } : entry,
        ),
      };
      await expect(verifyFixture(value)).rejects.toThrow("symlink, reparse point, or non-regular file");
    },
  );

  it("rejects mutable files, stat drift, and invalid scanner identities", async () => {
    const mutable = fixture();
    mutable.attestation = {
      ...mutable.attestation,
      files: mutable.attestation.files.map((entry, index) =>
        index === 4 ? ({ ...entry, immutable: false } as unknown as RemoteWorkerInstalledTreeFile) : entry,
      ),
    };
    await expect(verifyFixture(mutable)).rejects.toThrow("mutable files");

    const drift = fixture();
    drift.attestation = {
      ...drift.attestation,
      files: drift.attestation.files.map((entry, index) =>
        index === 4 ? { ...entry, afterStatSha256: "f".repeat(64) } : entry,
      ),
    };
    await expect(verifyFixture(drift)).rejects.toThrow("changed during scanning");

    for (const patch of [
      { rootIdentity: " root-id" },
      { files: fixture().attestation.files.map((entry, index) => (index === 0 ? { ...entry, identity: "" } : entry)) },
    ]) {
      const invalid = fixture();
      invalid.attestation = { ...invalid.attestation, ...patch };
      await expect(verifyFixture(invalid)).rejects.toThrow(/identity/u);
    }
  });

  it("rejects role cardinality and signed role digest mismatches", async () => {
    const duplicateBundle = fixture();
    duplicateBundle.attestation = rehashAttestation({
      ...duplicateBundle.attestation,
      files: duplicateBundle.attestation.files.map((entry, index) =>
        index === 3 ? { ...entry, role: "bundle" } : entry,
      ),
    });
    await expect(verifyFixture(duplicateBundle)).rejects.toThrow("bundle digest does not match");

    const noVendor = fixture();
    noVendor.attestation = rehashAttestation({
      ...noVendor.attestation,
      files: noVendor.attestation.files.map((entry) =>
        entry.role === "vendor" ? { ...entry, role: "runtime" } : entry,
      ),
    });
    await expect(verifyFixture(noVendor)).rejects.toThrow("has no vendor files");

    const changedVendor = fixture();
    changedVendor.attestation = rehashAttestation({
      ...changedVendor.attestation,
      files: changedVendor.attestation.files.map((entry) =>
        entry.role === "vendor" ? { ...entry, sha256: "e".repeat(64) } : entry,
      ),
    });
    await expect(verifyFixture(changedVendor)).rejects.toThrow("vendor tree digest does not match");
  });

  it("rejects count, per-file bytes, total bytes, tree digest, and manifest/attestation binding drift", async () => {
    const count = fixture();
    const countFiles = count.attestation.files.slice(0, -1);
    count.attestation = rehashAttestation({
      ...count.attestation,
      files: countFiles,
      totalBytes: countFiles.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    });
    await expect(verifyFixture(count)).rejects.toThrow("file count does not match");

    const largeFile = fixture();
    largeFile.attestation = {
      ...largeFile.attestation,
      files: largeFile.attestation.files.map((entry, index) =>
        index === 0 ? { ...entry, sizeBytes: REMOTE_WORKER_ATTESTATION_MAX_FILE_BYTES + 1 } : entry,
      ),
    };
    await expect(verifyFixture(largeFile)).rejects.toThrow("file size is invalid");

    const tooManyFiles = fixture();
    tooManyFiles.attestation = {
      ...tooManyFiles.attestation,
      files: Array.from({ length: 10_001 }, (_, index) => ({
        ...tooManyFiles.attestation.files[0]!,
        path: `bundle/${index.toString().padStart(5, "0")}.js`,
        identity: `identity-${index}`,
      })),
    };
    await expect(verifyFixture(tooManyFiles)).rejects.toThrow("file list is invalid");

    const total = fixture();
    total.attestation = { ...total.attestation, totalBytes: total.attestation.totalBytes + 1 };
    await expect(verifyFixture(total)).rejects.toThrow("total byte count is invalid");

    const excessiveTotal = fixture();
    excessiveTotal.attestation = {
      ...excessiveTotal.attestation,
      totalBytes: REMOTE_WORKER_ATTESTATION_MAX_TOTAL_BYTES + 1,
    };
    await expect(verifyFixture(excessiveTotal)).rejects.toThrow("total bytes is invalid");

    const tree = fixture();
    tree.attestation = { ...tree.attestation, treeSha256: "f".repeat(64) };
    await expect(verifyFixture(tree)).rejects.toThrow("attestation digest is invalid");

    const binding = fixture();
    binding.attestation = {
      ...binding.attestation,
      runtimeManifestPayloadSha256: "f".repeat(64),
    };
    await expect(verifyFixture(binding)).rejects.toThrow("evidence binding is invalid");
  });

  it("rejects stale/future scans and keeps scanner secrets out of bounded errors", async () => {
    for (const scannedAt of ["2026-07-14T19:54:59.999Z", "2026-07-14T20:01:00.001Z", "2026-07-14T20:00:00Z"]) {
      const value = fixture();
      value.attestation = { ...value.attestation, scannedAt };
      await expect(verifyFixture(value)).rejects.toThrow(/timestamp|stale|future/u);
    }

    const value = fixture();
    const scannerSecret = "operator-private-root-and-token";
    let caught: unknown;
    try {
      await verifyRemoteWorkerInstalledTreeAttestation({
        manifest: value.manifest,
        expectedSignerKeyId: SIGNER_KEY_ID,
        expectedSignerSpkiSha256: value.signerSpkiSha256,
        signerPublicKeySpkiDer: value.signerPublicKeySpkiDer,
        root: "C:\\installed\\goatcitadel-worker",
        scanner: {
          scan: () => {
            throw new Error(scannerSecret);
          },
        },
        now: NOW,
      });
    } catch (error) {
      caught = error;
    }
    const rendered = `${String(caught)} ${JSON.stringify(caught)}`;
    expect(rendered).not.toContain(scannerSecret);
    expect(rendered).not.toContain("C:\\installed\\goatcitadel-worker");
    expect(rendered.length).toBeLessThan(512);
  });
});
