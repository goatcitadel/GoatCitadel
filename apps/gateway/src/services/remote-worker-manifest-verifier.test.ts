import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  canonicalJsonString,
  type RemoteWorkerRuntimeManifest,
} from "@goatcitadel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  createConfiguredRemoteWorkerManifestVerifier,
  RemoteWorkerManifestRejectedError,
  RemoteWorkerManifestVerifierUnavailableError,
} from "./remote-worker-manifest-verifier.js";
import { readRemoteWorkerNoFollowFile } from "./remote-worker-installed-tree-scanner.js";
import { REMOTE_WORKER_RUNTIME_ENV } from "./remote-worker-runtime-config.js";

const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("configured remote worker manifest verifier", () => {
  it("verifies the configured signer ID, SPKI pin, and Ed25519 signature", async () => {
    const fixture = await signerFixture();
    const signerBytes = await readRemoteWorkerNoFollowFile(
      fixture.env[REMOTE_WORKER_RUNTIME_ENV.manifestSignerPublicKeyFile]!,
      16 * 1024,
    );
    try {
      expect(signerBytes.byteLength).toBeGreaterThan(0);
    } finally {
      signerBytes.fill(0);
    }
    const receipt = await createConfiguredRemoteWorkerManifestVerifier(fixture.env).verify(fixture.manifest);

    expect(receipt).toMatchObject({
      signerKeyId: "release-signer-a",
      signerSpkiSha256: fixture.spkiSha256,
      payloadSha256: fixture.manifest.payloadSha256,
    });
    expect(receipt.manifestVerificationReceiptSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects a shape-valid manifest from the wrong signer or with a wrong signature", async () => {
    const fixture = await signerFixture();
    const verifier = createConfiguredRemoteWorkerManifestVerifier(fixture.env);

    await expect(verifier.verify({ ...fixture.manifest, signerKeyId: "release-signer-b" })).rejects.toBeInstanceOf(
      RemoteWorkerManifestRejectedError,
    );

    const signature = Buffer.from(fixture.manifest.signatureBase64Url, "base64url");
    signature[0] = signature[0]! ^ 0x01;
    await expect(
      verifier.verify({ ...fixture.manifest, signatureBase64Url: signature.toString("base64url") }),
    ).rejects.toBeInstanceOf(RemoteWorkerManifestRejectedError);
  });

  it("fails closed as unavailable when runtime trust is disabled, incomplete, or pinned to another key", async () => {
    const fixture = await signerFixture();
    await expect(createConfiguredRemoteWorkerManifestVerifier({}).verify(fixture.manifest)).rejects.toBeInstanceOf(
      RemoteWorkerManifestVerifierUnavailableError,
    );

    await expect(
      createConfiguredRemoteWorkerManifestVerifier({ [REMOTE_WORKER_RUNTIME_ENV.enabled]: "true" }).verify(
        fixture.manifest,
      ),
    ).rejects.toBeInstanceOf(RemoteWorkerManifestVerifierUnavailableError);

    await expect(
      createConfiguredRemoteWorkerManifestVerifier({
        ...fixture.env,
        [REMOTE_WORKER_RUNTIME_ENV.manifestSignerSpkiSha256]: "f".repeat(64),
      }).verify(fixture.manifest),
    ).rejects.toBeInstanceOf(RemoteWorkerManifestVerifierUnavailableError);
  });
});

async function signerFixture(): Promise<{
  env: Record<string, string>;
  manifest: RemoteWorkerRuntimeManifest;
  spkiSha256: string;
}> {
  const root = await lockedSignerRoot();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyFile = join(root, "manifest-signer.pem");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" });
  await writeFile(publicKeyFile, publicKeyPem, { mode: 0o600 });
  const spkiDer = publicKey.export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(spkiDer)) throw new Error("Expected an SPKI buffer.");
  const spkiSha256 = digest(spkiDer);
  const payload = {
    schemaVersion: REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    bundleSha256: "1".repeat(64),
    dependencyLockSha256: "2".repeat(64),
    vendorTreeSha256: "3".repeat(64),
    launcherSha256: "4".repeat(64),
    installedTreeManifestSha256: "5".repeat(64),
    installedTreeFileCount: 5,
    platform: "windows",
    architecture: "x64",
  } as const;
  const payloadBytes = Buffer.from(canonicalJsonString(payload), "utf8");
  const manifest: RemoteWorkerRuntimeManifest = {
    payload,
    payloadSha256: digest(payloadBytes),
    signatureAlgorithm: "ed25519",
    signerKeyId: "release-signer-a",
    signatureBase64Url: sign(null, payloadBytes, privateKey).toString("base64url"),
  };
  return {
    manifest,
    spkiSha256,
    env: {
      [REMOTE_WORKER_RUNTIME_ENV.enabled]: "true",
      [REMOTE_WORKER_RUNTIME_ENV.host]: "127.0.0.1",
      [REMOTE_WORKER_RUNTIME_ENV.port]: "7443",
      [REMOTE_WORKER_RUNTIME_ENV.serverCertificateFile]: join(root, "unused-server-cert.pem"),
      [REMOTE_WORKER_RUNTIME_ENV.serverKeyFile]: join(root, "unused-server-key.pem"),
      [REMOTE_WORKER_RUNTIME_ENV.clientCaFile]: join(root, "unused-client-ca.pem"),
      [REMOTE_WORKER_RUNTIME_ENV.clientCaSha256]: "a".repeat(64),
      [REMOTE_WORKER_RUNTIME_ENV.manifestSignerKeyId]: "release-signer-a",
      [REMOTE_WORKER_RUNTIME_ENV.manifestSignerPublicKeyFile]: publicKeyFile,
      [REMOTE_WORKER_RUNTIME_ENV.manifestSignerSpkiSha256]: spkiSha256,
    },
  };
}

/**
 * The production verifier rejects any signer path writable by a foreign
 * principal. Keep the fixture inside a deliberately operator-locked root so
 * the test exercises signature posture rather than the host Temp ACL.
 */
async function lockedSignerRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "goatcitadel-worker-signer-"));
  temporaryRoots.push(root);
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
    await chmod(root, 0o700);
  }
  return root;
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
