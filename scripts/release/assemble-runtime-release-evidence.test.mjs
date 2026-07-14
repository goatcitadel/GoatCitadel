import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { assembleRuntimeReleaseEvidence } from "./assemble-runtime-release-evidence.mjs";

const SHA = "a".repeat(40);

test("assembles the exact certificate-bound files into the runtime evidence layout", async (t) => {
  const fixture = makeFixture(t);
  const result = await assembleRuntimeReleaseEvidence({ ...fixture, createArchives: false });

  assert.equal(
    fs.readFileSync(
      path.join(
        result.evidenceDir,
        "release-assets",
        "windows-x64-release-assets",
        "GoatCitadel-Setup-windows-x64.exe",
      ),
      "utf8",
    ),
    fixture.assetContent,
  );
  assert.ok(
    fs.existsSync(
      path.join(result.evidenceDir, "release-assets", "windows-x64-release-assets", "app", "release-manifest.json"),
    ),
  );
  assert.equal(
    fs.readFileSync(path.join(result.evidenceDir, "proof-bundle", "release-proof.zip"), "utf8"),
    fixture.proofContent,
  );
  assert.ok(fs.existsSync(path.join(result.evidenceDir, "release-certificate.json")));
  assert.equal(
    fs.readFileSync(path.join(result.evidenceDir, "release-certificate.sigstore.json"), "utf8"),
    fixture.attestationContent,
  );
});

test("requires the release certificate attestation", async (t) => {
  const fixture = makeFixture(t);
  fs.rmSync(fixture.attestationPath);

  await assert.rejects(
    assembleRuntimeReleaseEvidence({ ...fixture, createArchives: false }),
    /attestation must be an available bounded regular non-link file/i,
  );
});

test("refuses an attestation path that traverses a link", async (t) => {
  const fixture = makeFixture(t);
  const linkedParent = path.join(fixture.root, "linked-attestation-parent");
  fs.symlinkSync(
    path.dirname(fixture.attestationPath),
    linkedParent,
    process.platform === "win32" ? "junction" : "dir",
  );

  await assert.rejects(
    assembleRuntimeReleaseEvidence({
      ...fixture,
      attestationPath: path.join(linkedParent, path.basename(fixture.attestationPath)),
      createArchives: false,
    }),
    /attestation must be an available bounded regular non-link file/i,
  );
});

test("refuses an oversized release certificate attestation", async (t) => {
  const fixture = makeFixture(t);
  fs.writeFileSync(fixture.attestationPath, Buffer.alloc(4 * 1024 * 1024 + 1));

  await assert.rejects(
    assembleRuntimeReleaseEvidence({ ...fixture, createArchives: false }),
    /attestation must be a bounded regular non-link file/i,
  );
});

test("refuses hard-linked authenticated release inputs", async (t) => {
  const fixture = makeFixture(t);
  fs.linkSync(fixture.certificatePath, `${fixture.certificatePath}.hardlink`);

  await assert.rejects(
    assembleRuntimeReleaseEvidence({ ...fixture, createArchives: false }),
    /certificate must be a bounded regular non-link file/i,
  );
});

test("refuses a malformed release certificate attestation", async (t) => {
  const fixture = makeFixture(t);
  fs.writeFileSync(fixture.attestationPath, "not-json\n");

  await assert.rejects(
    assembleRuntimeReleaseEvidence({ ...fixture, createArchives: false }),
    /not a valid Sigstore JSON bundle/i,
  );
});

test("refuses an attestation swap between path validation and descriptor open", async (t) => {
  const fixture = makeFixture(t);
  const originalOpenSync = fs.openSync;
  let swapped = false;
  fs.openSync = function patchedOpenSync(filePath, flags, mode) {
    if (!swapped && path.resolve(String(filePath)) === path.resolve(fixture.attestationPath)) {
      swapped = true;
      fs.renameSync(fixture.attestationPath, `${fixture.attestationPath}.original`);
      fs.writeFileSync(fixture.attestationPath, fixture.attestationContent);
    }
    return originalOpenSync.call(fs, filePath, flags, mode);
  };
  try {
    await assert.rejects(
      assembleRuntimeReleaseEvidence({ ...fixture, createArchives: false }),
      /attestation changed while it was being opened/i,
    );
  } finally {
    fs.openSync = originalOpenSync;
  }
});

test("refuses a certificate whose asset digest does not match the source file", async (t) => {
  const fixture = makeFixture(t);
  fs.writeFileSync(fixture.installerPath, "tampered\n");

  await assert.rejects(
    assembleRuntimeReleaseEvidence({ ...fixture, createArchives: false }),
    /does not match its source file/,
  );
});

test("refuses release asset path escapes before copying evidence", async (t) => {
  const fixture = makeFixture(t);
  const certificate = JSON.parse(fs.readFileSync(fixture.certificatePath, "utf8"));
  certificate.releaseAssets[0].relativePath = "../outside.exe";
  fs.writeFileSync(fixture.certificatePath, JSON.stringify(certificate));

  await assert.rejects(
    assembleRuntimeReleaseEvidence({ ...fixture, createArchives: false }),
    /Unsafe release evidence path/,
  );
});

test("refuses portable case-colliding release asset identities", async (t) => {
  const fixture = makeFixture(t);
  const certificate = readCertificateFixture(fixture);
  certificate.releaseAssets.push({
    ...certificate.releaseAssets[0],
    relativePath: certificate.releaseAssets[0].relativePath.toUpperCase(),
  });
  writeCertificateFixture(fixture, certificate);

  await assert.rejects(
    assembleRuntimeReleaseEvidence({ ...fixture, createArchives: false }),
    /duplicate release asset path/i,
  );
});

test("refuses Windows-reserved release asset path segments", async (t) => {
  const fixture = makeFixture(t);
  const certificate = readCertificateFixture(fixture);
  certificate.releaseAssets[0].relativePath = "windows-x64-release-assets/CON.txt";
  writeCertificateFixture(fixture, certificate);

  await assert.rejects(
    assembleRuntimeReleaseEvidence({ ...fixture, createArchives: false }),
    /Unsafe release evidence path/i,
  );
});

test("refuses unsafe release tag and version identities", async (t) => {
  const fixture = makeFixture(t);
  const certificate = readCertificateFixture(fixture);
  certificate.version = "1..0";
  certificate.tag = "v1..0";
  writeCertificateFixture(fixture, certificate);

  await assert.rejects(
    assembleRuntimeReleaseEvidence({ ...fixture, createArchives: false }),
    /version is invalid|tag\/version is unsafe/i,
  );
});

test("refuses legacy release certificates without runtime payload bindings", async (t) => {
  const fixture = makeFixture(t);
  const certificate = readCertificateFixture(fixture);
  certificate.schemaVersion = 1;
  writeCertificateFixture(fixture, certificate);

  await assert.rejects(
    assembleRuntimeReleaseEvidence({ ...fixture, createArchives: false }),
    /does not match the supported GoatCitadel schema/i,
  );
});

test("refuses the legacy workflow field instead of releaseWorkflow identity", async (t) => {
  const fixture = makeFixture(t);
  const certificate = readCertificateFixture(fixture);
  certificate.workflow = certificate.releaseWorkflow;
  delete certificate.releaseWorkflow;
  writeCertificateFixture(fixture, certificate);

  await assert.rejects(
    assembleRuntimeReleaseEvidence({ ...fixture, createArchives: false }),
    /releaseWorkflow identity is invalid/i,
  );
});

test("refuses duplicate runtime payload targets", async (t) => {
  const fixture = makeFixture(t);
  const certificate = readCertificateFixture(fixture);
  certificate.runtimePayloads[1].target = "windows-x64";
  writeCertificateFixture(fixture, certificate);

  await assert.rejects(
    assembleRuntimeReleaseEvidence({ ...fixture, createArchives: false }),
    /duplicate runtime payload target: windows-x64/i,
  );
});

test("refuses a runtime manifest that is not bound by releaseAssets", async (t) => {
  const fixture = makeFixture(t);
  const certificate = readCertificateFixture(fixture);
  certificate.releaseAssets = certificate.releaseAssets.filter(
    (record) => record.relativePath !== fixture.manifestRelativePaths["windows-x64"],
  );
  writeCertificateFixture(fixture, certificate);

  await assert.rejects(
    assembleRuntimeReleaseEvidence({ ...fixture, createArchives: false }),
    /must be bound by exactly one releaseAssets record/i,
  );
});

test("refuses a cryptographically bound runtime manifest produced from modified source", async (t) => {
  const fixture = makeFixture(t);
  const manifest = JSON.parse(fs.readFileSync(fixture.manifestPaths["windows-x64"], "utf8"));
  manifest.sourceModified = true;
  rewriteManifestBinding(fixture, "windows-x64", manifest);

  await assert.rejects(
    assembleRuntimeReleaseEvidence({ ...fixture, createArchives: false }),
    /produced from modified source/i,
  );
});

test("refuses a cryptographically bound runtime manifest for the wrong target", async (t) => {
  const fixture = makeFixture(t);
  const manifest = JSON.parse(fs.readFileSync(fixture.manifestPaths["windows-x64"], "utf8"));
  manifest.target = "windows-arm64";
  manifest.arch = "arm64";
  rewriteManifestBinding(fixture, "windows-x64", manifest);

  await assert.rejects(
    assembleRuntimeReleaseEvidence({ ...fixture, createArchives: false }),
    /does not match the requested target/i,
  );
});

test("refuses an evidence-directory swap between resolution and descriptor open", async (t) => {
  const fixture = makeFixture(t);
  const sourcePath = fixture.installerPath;
  const sourceDir = path.dirname(sourcePath);
  const outsideDir = path.join(path.dirname(fixture.artifactsDir), "outside-assets");
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, path.basename(sourcePath)), fixture.assetContent);
  const originalOpenSync = fs.openSync;
  let swapped = false;
  fs.openSync = function patchedOpenSync(filePath, flags, mode) {
    if (!swapped && path.resolve(String(filePath)) === path.resolve(sourcePath)) {
      swapped = true;
      fs.rmSync(sourceDir, { recursive: true, force: true });
      fs.symlinkSync(outsideDir, sourceDir, process.platform === "win32" ? "junction" : "dir");
    }
    return originalOpenSync.call(fs, filePath, flags, mode);
  };
  try {
    await assert.rejects(
      assembleRuntimeReleaseEvidence({ ...fixture, createArchives: false }),
      /symlink|junction|supported root|changed/i,
    );
  } finally {
    fs.openSync = originalOpenSync;
  }
});

test("refuses to label an installer as a different runtime payload target", async (t) => {
  const fixture = makeFixture(t);

  await assert.rejects(
    assembleRuntimeReleaseEvidence({
      ...fixture,
      installers: [{ target: "windows-arm64", path: fixture.installerPath }],
    }),
    /installer does not match runtime payload windows-arm64/i,
  );
});

test("verified Windows distributions contain the exact installer and release-evidence sidecar", async (t) => {
  const fixture = makeFixture(t);
  const archiveDir = path.join(path.dirname(fixture.outputDir), "package");
  const installerPath = fixture.installerPath;
  const result = await assembleRuntimeReleaseEvidence({
    ...fixture,
    archiveDir,
    installers: [{ target: "windows-x64", path: installerPath }],
  });
  assert.equal(result.verifiedDistributions.length, 1);

  const extractionDir = path.join(path.dirname(fixture.outputDir), "extracted-verified");
  fs.mkdirSync(extractionDir, { recursive: true });
  extractZip(result.verifiedDistributions[0].archivePath, extractionDir);
  assert.equal(
    fs.readFileSync(path.join(extractionDir, "GoatCitadel-Setup-windows-x64.exe"), "utf8"),
    fixture.assetContent,
  );
  const installedEvidenceDir = path.join(extractionDir, "release-evidence");
  assert.deepEqual(fs.readdirSync(installedEvidenceDir).sort(), [
    "release-certificate.json",
    "release-certificate.sigstore.json",
  ]);
  assert.equal(fs.existsSync(path.join(installedEvidenceDir, "release-assets")), false);
  assert.equal(fs.existsSync(path.join(installedEvidenceDir, "proof-bundle")), false);
  assert.equal(
    fs.readFileSync(path.join(installedEvidenceDir, "release-certificate.json"), "utf8"),
    fixture.certificateContent,
  );
  assert.equal(
    fs.readFileSync(path.join(installedEvidenceDir, "release-certificate.sigstore.json"), "utf8"),
    fixture.attestationContent,
  );
});

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goat-runtime-evidence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifactsDir = path.join(root, "release-artifacts");
  const releaseDir = path.join(root, "artifacts", "release");
  const proofZipPath = path.join(releaseDir, "package", "release-proof.zip");
  const certificatePath = path.join(releaseDir, "release-certificate.json");
  const attestationPath = path.join(releaseDir, "release-certificate.sigstore.json");
  const outputDir = path.join(releaseDir, "runtime-evidence");
  const assetContent = "signed installer\n";
  const proofContent = "proof bundle\n";
  const attestationContent = `${JSON.stringify({ mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json" })}\n`;
  const installerRelativePath = "windows-x64-release-assets/GoatCitadel-Setup-windows-x64.exe";
  const installerPath = path.join(artifactsDir, ...installerRelativePath.split("/"));
  const manifestRelativePaths = {
    "windows-x64": "windows-x64-release-assets/app/release-manifest.json",
    "windows-arm64": "windows-arm64-release-assets/app/release-manifest.json",
  };
  const manifestPaths = Object.fromEntries(
    Object.entries(manifestRelativePaths).map(([target, relativePath]) => [
      target,
      path.join(artifactsDir, ...relativePath.split("/")),
    ]),
  );
  fs.mkdirSync(path.dirname(installerPath), { recursive: true });
  fs.mkdirSync(path.dirname(manifestPaths["windows-x64"]), { recursive: true });
  fs.mkdirSync(path.dirname(manifestPaths["windows-arm64"]), { recursive: true });
  fs.mkdirSync(path.dirname(proofZipPath), { recursive: true });
  fs.writeFileSync(installerPath, assetContent);
  const manifestRaw = {
    "windows-x64": `${JSON.stringify(buildManifest("windows-x64", "x64"))}\n`,
    "windows-arm64": `${JSON.stringify(buildManifest("windows-arm64", "arm64"))}\n`,
  };
  fs.writeFileSync(manifestPaths["windows-x64"], manifestRaw["windows-x64"]);
  fs.writeFileSync(manifestPaths["windows-arm64"], manifestRaw["windows-arm64"]);
  fs.writeFileSync(proofZipPath, proofContent);
  fs.writeFileSync(attestationPath, attestationContent);
  const releaseAssets = [
    fileRecord(installerRelativePath, assetContent),
    fileRecord(manifestRelativePaths["windows-x64"], manifestRaw["windows-x64"]),
    fileRecord(manifestRelativePaths["windows-arm64"], manifestRaw["windows-arm64"]),
  ];
  const certificateContent = JSON.stringify({
    schemaVersion: 2,
    product: "GoatCitadel",
    version: "1.0.0",
    tag: "v1.0.0",
    commit: SHA,
    targetCommit: SHA,
    repository: "goatcitadel/GoatCitadel",
    releaseWorkflow: {
      name: "Release Installers and Bundles",
      workflowFile: ".github/workflows/release-installers.yml",
      eventName: "push",
      ref: "refs/tags/v1.0.0",
      sha: SHA,
      workflowRef: "goatcitadel/GoatCitadel/.github/workflows/release-installers.yml@refs/tags/v1.0.0",
      trustEligible: true,
    },
    runtimePayloads: [
      runtimePayloadRecord("windows-x64", "x64", manifestRelativePaths["windows-x64"], manifestRaw["windows-x64"]),
      runtimePayloadRecord(
        "windows-arm64",
        "arm64",
        manifestRelativePaths["windows-arm64"],
        manifestRaw["windows-arm64"],
      ),
    ],
    releaseAssets,
    proofBundle: {
      relativePath: "release-proof.zip",
      sizeBytes: Buffer.byteLength(proofContent),
      sha256: digest(proofContent),
    },
  });
  fs.writeFileSync(certificatePath, certificateContent);
  return {
    root,
    certificatePath,
    attestationPath,
    artifactsDir,
    proofZipPath,
    outputDir,
    installerPath,
    manifestPaths,
    manifestRelativePaths,
    certificateContent,
    assetContent,
    proofContent,
    attestationContent,
  };
}

function buildManifest(target, arch) {
  return {
    schemaVersion: 2,
    product: "GoatCitadel",
    version: "1.0.0",
    sourceCommit: SHA,
    sourceModified: false,
    platform: "windows",
    arch,
    target,
    components: [],
    payload: {
      algorithm: "sha256",
      roots: ["app", "bin"],
      detachedMetadataFiles: ["app/release-manifest.json"],
      detachedMetadataTrees: ["app/release-evidence"],
      fileCount: 1,
      totalBytes: 0,
      files: [{ path: "bin/goatcitadel.cmd", sha256: digest(""), sizeBytes: 0 }],
    },
    launcher: { command: "goatcitadel launch", windows: "bin/goatcitadel.cmd" },
  };
}

function runtimePayloadRecord(target, arch, relativePath, rawManifest) {
  return {
    target,
    platform: "windows",
    arch,
    installLayout: "goatcitadel-bundle-v1",
    immutableRoots: ["app", "bin"],
    detachedMetadataFiles: ["app/release-manifest.json"],
    detachedMetadataTrees: ["app/release-evidence"],
    manifest: {
      relativePath,
      installedPath: "app/release-manifest.json",
      sha256: digest(rawManifest),
      sizeBytes: Buffer.byteLength(rawManifest),
    },
  };
}

function fileRecord(relativePath, content) {
  return {
    relativePath,
    sizeBytes: Buffer.byteLength(content),
    sha256: digest(content),
  };
}

function readCertificateFixture(fixture) {
  return JSON.parse(fs.readFileSync(fixture.certificatePath, "utf8"));
}

function writeCertificateFixture(fixture, certificate) {
  fs.writeFileSync(fixture.certificatePath, JSON.stringify(certificate));
}

function rewriteManifestBinding(fixture, target, manifest) {
  const rawManifest = `${JSON.stringify(manifest)}\n`;
  fs.writeFileSync(fixture.manifestPaths[target], rawManifest);
  const certificate = readCertificateFixture(fixture);
  const relativePath = fixture.manifestRelativePaths[target];
  const assetRecord = certificate.releaseAssets.find((record) => record.relativePath === relativePath);
  const runtimePayload = certificate.runtimePayloads.find((record) => record.target === target);
  Object.assign(assetRecord, fileRecord(relativePath, rawManifest));
  runtimePayload.manifest.sha256 = digest(rawManifest);
  runtimePayload.manifest.sizeBytes = Buffer.byteLength(rawManifest);
  writeCertificateFixture(fixture, certificate);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function extractZip(archivePath, destinationDir) {
  const command = process.platform === "win32" ? "tar.exe" : "unzip";
  const args =
    process.platform === "win32"
      ? ["-xf", archivePath, "-C", destinationDir]
      : ["-q", archivePath, "-d", destinationDir];
  const result = spawnSync(command, args, { stdio: "pipe", encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout || `${command} failed`);
}
