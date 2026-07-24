#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { removeDirectorySafely } from "../packaging/safe-cleanup.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

const args = parseArgs(process.argv.slice(2));
const version = normalizeVersion(args.version);
const tagName = normalizeTag(args.tag ?? process.env.GITHUB_REF_NAME ?? `v${version}`, version);
const releaseSourceRef = process.env.GITHUB_SHA ?? "main";
const artifactsDir = path.resolve(args.artifactsDir ?? path.join(repoRoot, "release-artifacts"));
const sbomFile = path.resolve(
  args.sbomFile ?? path.join(repoRoot, "artifacts", "release", `goatcitadel-${tagName}.cyclonedx.json`),
);
const outDir = path.resolve(args.outDir ?? path.join(repoRoot, "artifacts", "release", "package"));

if (!fs.existsSync(artifactsDir)) {
  throw new Error(`Artifacts directory does not exist: ${artifactsDir}`);
}
if (!fs.existsSync(sbomFile)) {
  throw new Error(`SBOM file does not exist: ${sbomFile}`);
}

const artifactFiles = listInstallerArtifacts(artifactsDir);
validateFixedSignedArtifactInventory(artifactFiles, artifactsDir, version);

const releaseDirName = `release-v${version}`;
const releaseRoot = path.join(outDir, releaseDirName);
const artifactOutDir = path.join(releaseRoot, "artifact");
const sbomOutDir = path.join(releaseRoot, "SBOM");
const docsOutDir = path.join(releaseRoot, "docs");
const provenanceOutDir = path.join(releaseRoot, "provenance");
const archivePath = path.join(outDir, `GoatCitadel-v${version}-release-package.zip`);

removeDirectorySafely(releaseRoot, {
  repoRoot,
  allowedRoot: outDir,
  cwd: process.cwd(),
});
fs.mkdirSync(artifactOutDir, { recursive: true });
fs.mkdirSync(sbomOutDir, { recursive: true });
fs.mkdirSync(docsOutDir, { recursive: true });
fs.mkdirSync(provenanceOutDir, { recursive: true });

const copiedArtifacts = await Promise.all(
  artifactFiles.map((artifactPath) => copyArtifactWithProofs(artifactPath, artifactOutDir, artifactsDir)),
);
const copiedSbomPath = path.join(sbomOutDir, path.basename(sbomFile));
fs.copyFileSync(sbomFile, copiedSbomPath);

copyDocs(docsOutDir);

const lockedInputs = await buildLockedInputRecords();
const buildMetadata = buildMetadataRecord({
  version,
  tagName,
  artifacts: copiedArtifacts,
  sbomPath: relativeToReleaseRoot(copiedSbomPath, releaseRoot),
  lockedInputs,
});
const buildMetadataPath = path.join(provenanceOutDir, "build-metadata.json");
fs.writeFileSync(buildMetadataPath, `${JSON.stringify(buildMetadata, null, 2)}\n`, "utf8");

const slsaAttestation = buildSlsaAttestation({
  version,
  tagName,
  artifacts: copiedArtifacts,
  lockedInputs,
});
const slsaPath = path.join(provenanceOutDir, "slsa-attestation.json");
fs.writeFileSync(slsaPath, `${JSON.stringify(slsaAttestation, null, 2)}\n`, "utf8");

const handoffPath = path.join(docsOutDir, "handoff.md");
fs.writeFileSync(
  handoffPath,
  `${renderHandoff({ version, tagName, artifacts: copiedArtifacts, buildMetadata })}\n`,
  "utf8",
);

fs.rmSync(archivePath, { force: true });
runZip(path.dirname(releaseRoot), archivePath, releaseDirName);

console.log(`Release package ready: ${releaseRoot}`);
console.log(`Release archive ready: ${archivePath}`);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--version") {
      parsed.version = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--tag") {
      parsed.tag = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--artifacts-dir") {
      parsed.artifactsDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--sbom-file") {
      parsed.sbomFile = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--out-dir") {
      parsed.outDir = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  if (!parsed.version) {
    throw new Error("Missing required argument: --version");
  }
  return parsed;
}

function normalizeVersion(value) {
  const normalized = typeof value === "string" && value.startsWith("v") ? value.slice(1) : value;
  if (typeof normalized !== "string" || !/^[0-9][0-9a-z.+-]{0,79}$/iu.test(normalized) || normalized.includes("..")) {
    throw new Error(`Invalid release version: ${String(value)}`);
  }
  return normalized;
}

function normalizeTag(value, version) {
  if (value !== `v${version}`) {
    throw new Error(`Release tag ${String(value)} must exactly match version v${version}.`);
  }
  return value;
}

function listInstallerArtifacts(rootDir) {
  const files = [];
  const queue = [rootDir];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (
        entry.name.endsWith(".exe") ||
        entry.name.endsWith(".msix") ||
        entry.name.endsWith(".dmg") ||
        entry.name.endsWith(".pkg") ||
        entry.name.endsWith(".tar.gz")
      ) {
        files.push(absolutePath);
      }
    }
  }
  return files.sort((left, right) =>
    compareStrings(relativeArtifactPath(rootDir, left), relativeArtifactPath(rootDir, right)),
  );
}

async function copyArtifactWithProofs(artifactPath, destinationDir, artifactsRoot) {
  const basename = path.basename(artifactPath);
  const artifactRelativePath = relativeArtifactPath(artifactsRoot, artifactPath);
  const checksumPath = `${artifactPath}.sha256`;
  const signaturePath = `${artifactPath}.sig`;
  const certificatePath = `${artifactPath}.pem`;

  for (const requiredPath of [artifactPath, checksumPath, signaturePath, certificatePath]) {
    if (!isRegularSingleLinkFile(requiredPath)) {
      throw new Error(`Missing release proof file for ${basename}: ${requiredPath}`);
    }
  }

  const targetArtifactPath = path.join(destinationDir, ...artifactRelativePath.split("/"));
  fs.mkdirSync(path.dirname(targetArtifactPath), { recursive: true });
  fs.copyFileSync(artifactPath, targetArtifactPath);
  fs.copyFileSync(checksumPath, `${targetArtifactPath}.sha256`);
  fs.copyFileSync(signaturePath, `${targetArtifactPath}.sig`);
  fs.copyFileSync(certificatePath, `${targetArtifactPath}.pem`);

  return {
    fileName: basename,
    relativePath: `artifact/${artifactRelativePath}`,
    checksumSha256: await sha256File(artifactPath),
    sizeBytes: fs.statSync(artifactPath).size,
  };
}

function validateFixedSignedArtifactInventory(artifactFiles, rootDir, version) {
  const actual = artifactFiles.map((filePath) => relativeArtifactPath(rootDir, filePath)).sort(compareStrings);
  const expected = fixedSignedArtifactPaths(version);
  if (
    actual.length !== expected.length ||
    new Set(actual.map((item) => item.toLowerCase())).size !== actual.length ||
    actual.some((item, index) => item !== expected[index])
  ) {
    throw new Error(
      `Release package must contain exactly the fixed signed artifact set. Expected: ${expected.join(", ")}; received: ${actual.join(", ")}.`,
    );
  }
}

function fixedSignedArtifactPaths(version) {
  return [
    "windows-x64-release-assets/GoatCitadel-Setup-windows-x64.exe",
    "windows-x64-release-assets/GoatCitadel-Mission-Control-Windows-Identity.msix",
    "windows-arm64-release-assets/GoatCitadel-Setup-windows-arm64.exe",
    "windows-arm64-release-assets/GoatCitadel-Mission-Control-Windows-Identity.msix",
    `linux-x64-experimental-release-assets/GoatCitadel-${version}-linux-x64.tar.gz`,
    `macos-arm64-experimental-release-assets/GoatCitadel-${version}-macos-arm64.dmg`,
  ].sort(compareStrings);
}

function relativeArtifactPath(rootDir, filePath) {
  const relativePath = path.relative(path.resolve(rootDir), path.resolve(filePath)).replaceAll("\\", "/");
  const segments = relativePath.split("/");
  if (
    !relativePath ||
    Buffer.byteLength(relativePath, "utf8") > 240 ||
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        /[<>:"|?*\u0000-\u001f]/u.test(segment) ||
        /[. ]$/u.test(segment) ||
        WINDOWS_RESERVED_BASENAME.test(segment),
    )
  ) {
    throw new Error(`Unsafe release artifact path: ${relativePath}`);
  }
  return segments.join("/");
}

function isRegularSingleLinkFile(filePath) {
  try {
    const stats = fs.lstatSync(filePath);
    return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1;
  } catch {
    return false;
  }
}

function copyDocs(destinationDir) {
  const docSources = [
    { source: path.join(repoRoot, "CHANGELOG.md"), target: "CHANGELOG.md" },
    { source: path.join(repoRoot, "AGENTS.md"), target: "AGENTS.md" },
    {
      source: path.join(repoRoot, "SECURITY.md"),
      target: "SECURITY.md",
      rewrite: (content) => content.replaceAll("(docs/security/findings-triage.md)", "(security/findings-triage.md)"),
    },
    { source: path.join(repoRoot, "docs", "reproducible-release.md"), target: "reproducible-release.md" },
    { source: path.join(repoRoot, "docs", "supported-platforms.md"), target: "supported-platforms.md" },
    { source: path.join(repoRoot, "docs", "smoke-tests.md"), target: "smoke-tests.md" },
    { source: path.join(repoRoot, "docs", "dependency-policy.md"), target: "dependency-policy.md" },
    {
      source: path.join(repoRoot, "docs", "security", "findings-triage.md"),
      target: "security/findings-triage.md",
      rewrite: rewriteReleaseTriageLinks,
    },
  ];
  const codeownersPath = fs.existsSync(path.join(repoRoot, "CODEOWNERS"))
    ? path.join(repoRoot, "CODEOWNERS")
    : path.join(repoRoot, ".github", "CODEOWNERS");
  docSources.push({ source: codeownersPath, target: path.basename(codeownersPath) });

  const optionalSources = [path.join(repoRoot, "LICENSE"), path.join(repoRoot, "docs", "PACKAGING.md")];

  for (const { source: sourcePath, target, rewrite } of docSources) {
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Missing required release doc: ${sourcePath}`);
    }
    const targetPath = path.join(destinationDir, target);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    if (rewrite) {
      fs.writeFileSync(targetPath, rewrite(fs.readFileSync(sourcePath, "utf8")), "utf8");
      continue;
    }
    fs.copyFileSync(sourcePath, targetPath);
  }

  for (const sourcePath of optionalSources) {
    if (!fs.existsSync(sourcePath)) {
      continue;
    }
    fs.copyFileSync(sourcePath, path.join(destinationDir, path.basename(sourcePath)));
  }
}

function rewriteReleaseTriageLinks(content) {
  return content
    .replaceAll("(../../SECURITY.md)", "(../SECURITY.md)")
    .replaceAll("(../../AGENTS.md)", "(../AGENTS.md)")
    .replace(/\]\(\.\.\/\.\.\/([^)\s#]+)(#[^)]+)?\)/g, (_match, target, anchor = "") => {
      return `](https://github.com/goatcitadel/GoatCitadel/blob/${releaseSourceRef}/${target}${anchor})`;
    });
}

function buildMetadataRecord(input) {
  const workflowRef =
    process.env.GITHUB_WORKFLOW_REF ??
    `${process.env.GITHUB_REPOSITORY ?? "local"}/.github/workflows/release-installers.yml@${process.env.GITHUB_SHA ?? "local"}`;
  const lockedInputs = input.lockedInputs;
  return {
    version: input.version,
    tag: input.tagName,
    commit: process.env.GITHUB_SHA ?? null,
    repository: process.env.GITHUB_REPOSITORY ?? null,
    workflow: {
      name: process.env.GITHUB_WORKFLOW ?? "Release Installers and Bundles",
      ref: workflowRef,
      runId: process.env.GITHUB_RUN_ID ?? null,
      runNumber: process.env.GITHUB_RUN_NUMBER ?? null,
      actor: process.env.GITHUB_ACTOR ?? null,
    },
    environment: {
      os: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
      pnpmVersion: readCommandVersion("pnpm", ["--version"]),
      zipVersion: readCommandVersion("zip", ["-v"]),
    },
    lockedInputs: lockedInputs.map((item) => item.path),
    lockedInputDigests: lockedInputs,
    buildCommands: [
      "pnpm install --frozen-lockfile",
      "pnpm package:windows-host --target <windows-target>",
      "pnpm package:windows-msix --allow-unsigned",
      "signtool sign /fd SHA256 /f <pfx> /p <password> /tr http://timestamp.digicert.com /td SHA256 component-input/GoatCitadel-Mission-Control-Windows.exe",
      "signtool verify /pa component-input/GoatCitadel-Mission-Control-Windows.exe",
      "signtool sign /fd SHA256 /f <pfx> /p <password> /tr http://timestamp.digicert.com /td SHA256 component-input/GoatCitadel-Mission-Control-Windows-Identity.msix",
      "signtool verify /pa component-input/GoatCitadel-Mission-Control-Windows-Identity.msix",
      "pnpm package:bundle --target <windows-target>",
      "pnpm package:windows --target <windows-target>",
      "signtool sign /fd SHA256 /f <pfx> /p <password> /tr http://timestamp.digicert.com /td SHA256 installer-input/GoatCitadel-Setup-<windows-target>.exe",
      "signtool verify /pa installer-input/GoatCitadel-Setup-<windows-target>.exe",
      "pnpm package:bundle --target linux-x64 --skip-desktop",
      'tar -czf "<linux-tar>" -C "<bundle-parent>" "<bundle-directory>"',
      'sha256sum "<linux-tar>" > "<linux-tar>.sha256"',
      'tar -xzf "<linux-tar>" -C "<smoke-dir>"',
      'sha256sum -c "<linux-tar>.sha256"',
      "pnpm package:macos --target macos-arm64",
      'codesign --force --deep --options runtime --timestamp --sign <developer-id> "$WORK/dmg-root/GoatCitadel Mission Control.app"',
      'codesign --verify --deep --strict --verbose=2 "$WORK/dmg-root/GoatCitadel Mission Control.app"',
      'hdiutil create -volname "GoatCitadel Mission Control" -srcfolder "$WORK/dmg-root" -ov -format UDZO "$OUTPUT_DMG"',
      'xcrun notarytool submit "$OUTPUT_DMG" --apple-id <apple-id> --team-id <team-id> --password <app-password> --wait',
      'xcrun stapler staple "$OUTPUT_DMG"',
      'xcrun stapler validate "$OUTPUT_DMG"',
      'hdiutil verify "$OUTPUT_DMG"',
      'shasum -a 256 "$OUTPUT_DMG" > "$OUTPUT_DMG.sha256"',
      "FETCH_LICENSE=false CDXGEN_FETCH_PKG_METADATA=false env -u NODE_PATH node node_modules/@cyclonedx/cdxgen/bin/cdxgen.js . --type js --spec-version 1.6 --no-install-deps --fail-on-error --no-babel --no-recurse --validate --output <sbom>",
      "env -u NODE_PATH node scripts/release/validate-pnpm-sbom.mjs --repo-root <repo-root> --sbom-file <sbom>",
      ...fixedSignedArtifactPaths(input.version).flatMap((relativePath) => {
        const artifactPath = `release-artifacts/${relativePath}`;
        return [
          `cosign sign-blob --yes --output-signature ${artifactPath}.sig --output-certificate ${artifactPath}.pem ${artifactPath}`,
          `cosign verify-blob --signature ${artifactPath}.sig --certificate ${artifactPath}.pem --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-identity <workflow-ref> --certificate-github-workflow-name "Release Installers and Bundles" --certificate-github-workflow-ref <tag-ref> --certificate-github-workflow-repository goatcitadel/GoatCitadel --certificate-github-workflow-sha <commit-sha> --certificate-github-workflow-trigger push ${artifactPath}`,
        ];
      }),
      "node scripts/release/assemble-release-package.mjs --version <version> --tag <tag> --artifacts-dir <dir> --sbom-file <sbom>",
      "node scripts/release/wait-for-release-proof.mjs --repository <owner/repo> --commit <commit-sha> --timeout-ms 14400000",
      "node scripts/release/wait-for-release-proof.mjs --repository <owner/repo> --commit <commit-sha> --workflow verification-fast.yml --timeout-ms 7200000",
      "node scripts/release/wait-for-release-proof.mjs --repository <owner/repo> --commit <commit-sha> --workflow security-trivy.yml --timeout-ms 7200000",
      "node scripts/release/write-release-certificate.mjs --version <version> --tag <tag> --artifacts-dir <dir> --runtime-manifest windows-x64=<dir>/windows-x64-release-assets/app/release-manifest.json --runtime-manifest windows-arm64=<dir>/windows-arm64-release-assets/app/release-manifest.json --proof-zip <zip> --out-file <certificate> --require-success",
      "cosign sign-blob --yes --bundle artifacts/release/release-certificate.sigstore.json artifacts/release/release-certificate.json",
      'cosign verify-blob --bundle artifacts/release/release-certificate.sigstore.json --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-identity <workflow-ref> --certificate-github-workflow-name "Release Installers and Bundles" --certificate-github-workflow-ref <tag-ref> --certificate-github-workflow-repository goatcitadel/GoatCitadel --certificate-github-workflow-sha <commit-sha> --certificate-github-workflow-trigger push artifacts/release/release-certificate.json',
      "node scripts/release/assemble-runtime-release-evidence.mjs --certificate artifacts/release/release-certificate.json --attestation artifacts/release/release-certificate.sigstore.json --artifacts-dir release-artifacts --proof-zip <release-proof-zip> --output-dir artifacts/release/runtime-evidence --archive-dir artifacts/release/package --installer windows-x64=release-artifacts/windows-x64-release-assets/GoatCitadel-Setup-windows-x64.exe --installer windows-arm64=release-artifacts/windows-arm64-release-assets/GoatCitadel-Setup-windows-arm64.exe",
    ],
    artifacts: input.artifacts,
    sbom: input.sbomPath,
    generatedAt: new Date().toISOString(),
  };
}

function buildSlsaAttestation(input) {
  const lockedInputs = input.lockedInputs;
  return {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: input.artifacts.map((artifact) => ({
      name: artifact.relativePath,
      digest: {
        sha256: artifact.checksumSha256,
      },
    })),
    predicate: {
      buildDefinition: {
        buildType: "https://github.com/Actions",
        externalParameters: {
          version: input.version,
          tag: input.tagName,
          workflow: process.env.GITHUB_WORKFLOW ?? "Release Installers and Bundles",
        },
        internalParameters: {
          repository: process.env.GITHUB_REPOSITORY ?? "local",
          ref: process.env.GITHUB_REF ?? null,
          sha: process.env.GITHUB_SHA ?? null,
        },
        resolvedDependencies: [
          {
            uri: "pkg:npm/goatcitadel",
            digest: {
              sha1: process.env.GITHUB_SHA ?? "local",
            },
          },
          ...lockedInputs.map((lockedInput) => ({
            uri: `file://${lockedInput.path}`,
            digest: {
              sha256: lockedInput.sha256,
            },
          })),
        ],
      },
      runDetails: {
        builder: {
          id:
            process.env.GITHUB_WORKFLOW_REF ??
            `${process.env.GITHUB_REPOSITORY ?? "local"}/.github/workflows/release-installers.yml@${process.env.GITHUB_SHA ?? "local"}`,
        },
        metadata: {
          invocationId: process.env.GITHUB_RUN_ID ?? null,
          startedOn: process.env.GITHUB_RUN_STARTED_AT ?? null,
          finishedOn: new Date().toISOString(),
        },
      },
    },
    note: "This provenance statement is generated from the GitHub Actions release context and shipped inside the release package for offline inspection.",
  };
}

async function buildLockedInputRecords() {
  return await Promise.all(
    listReleaseLockedInputs().map(async (filePath) => ({
      path: filePath,
      sha256: await sha256File(path.join(repoRoot, filePath)),
    })),
  );
}

function listReleaseLockedInputs() {
  const fixedInputs = [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "Dockerfile",
    ".github/workflows/release-installers.yml",
  ];
  return [
    ...fixedInputs,
    ...listRelativeFiles(path.join(repoRoot, "scripts", "packaging"), "scripts/packaging"),
    ...listRelativeFiles(path.join(repoRoot, "scripts", "release"), "scripts/release"),
  ].sort((left, right) => left.localeCompare(right));
}

function listRelativeFiles(rootDir, relativeRoot) {
  const files = [];
  const queue = [rootDir];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      files.push(path.join(relativeRoot, path.relative(rootDir, absolutePath)).replace(/\\/g, "/"));
    }
  }
  return files;
}

function renderHandoff(input) {
  const primaryArtifact = input.artifacts[0];
  return [
    `# Handoff - ${input.tagName}`,
    ``,
    `**Owners:** @goatcitadel/maintainers`,
    `**Release date:** ${new Date().toISOString().slice(0, 10)}`,
    `**Primary artifact:** ${primaryArtifact.relativePath}`,
    `**Checksum:** ${primaryArtifact.relativePath}.sha256`,
    `**Signature:** ${primaryArtifact.relativePath}.sig (certificate: ${primaryArtifact.relativePath}.pem)`,
    ``,
    `**CI job:** ${input.buildMetadata.workflow.name} (run ${input.buildMetadata.workflow.runId ?? "local"})`,
    `**Commit/tag:** ${input.tagName} (commit ${input.buildMetadata.commit ?? "local"})`,
    `**Provenance:** provenance/slsa-attestation.json, provenance/build-metadata.json`,
    `**SBOM:** SBOM/${path.basename(input.buildMetadata.sbom)}`,
    ``,
    `## What changed`,
    `See docs/CHANGELOG.md and the ${input.tagName} section.`,
    ``,
    `## Reproduce the build`,
    `See docs/reproducible-release.md for the pinned toolchain, commands, and verification steps.`,
    ``,
    `## Supported platforms and smoke tests`,
    `See docs/supported-platforms.md and docs/smoke-tests.md.`,
    ``,
    `## Rollback steps`,
    `1. Remove ${input.tagName} from the stable release channel and point operators to the prior tag.`,
    `2. Redeploy the previous installer or bundle using its published checksum and signature.`,
    `3. Post the rollback note in the release thread with the failing artifact name and checksum.`,
    ``,
    `## Security and support`,
    `- Report issues: see docs/SECURITY.md`,
    `- CODEOWNERS: docs/CODEOWNERS`,
    ``,
    `## Artifact manifest`,
    ...input.artifacts.map(
      (artifact) => `- ${artifact.relativePath} | sha256=${artifact.checksumSha256} | size=${artifact.sizeBytes} bytes`,
    ),
  ].join("\n");
}

function relativeToReleaseRoot(targetPath, releaseRootPath) {
  return path.relative(releaseRootPath, targetPath).replaceAll("\\", "/");
}

function readCommandVersion(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  return result.stdout.trim().split(/\r?\n/)[0] ?? null;
}

function runZip(cwd, destinationPath, targetName) {
  const result = spawnSync("zip", ["-r", destinationPath, targetName], {
    cwd,
    stdio: "inherit",
  });
  if (!result.error && result.status === 0) {
    return;
  }
  if (process.platform === "win32") {
    const sourcePath = path.join(cwd, targetName);
    const escapedSourcePath = sourcePath.replaceAll("'", "''");
    const escapedDestinationPath = destinationPath.replaceAll("'", "''");
    const powershellResult = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Compress-Archive -Path '${escapedSourcePath}' -DestinationPath '${escapedDestinationPath}' -Force`,
      ],
      {
        cwd,
        stdio: "inherit",
      },
    );
    if (powershellResult.error) {
      throw powershellResult.error;
    }
    if (powershellResult.status !== 0) {
      throw new Error(`Compress-Archive exited with code ${powershellResult.status}`);
    }
    return;
  }
  if (result.error) {
    throw result.error;
  }
  throw new Error(`zip exited with code ${result.status}`);
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function compareStrings(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
