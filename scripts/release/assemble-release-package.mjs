#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");

const args = parseArgs(process.argv.slice(2));
const version = normalizeVersion(args.version);
const tagName = args.tag ?? process.env.GITHUB_REF_NAME ?? `v${version}`;
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
if (artifactFiles.length === 0) {
  throw new Error(`No installer artifacts were found in ${artifactsDir}`);
}

const releaseDirName = `release-v${version}`;
const releaseRoot = path.join(outDir, releaseDirName);
const artifactOutDir = path.join(releaseRoot, "artifact");
const sbomOutDir = path.join(releaseRoot, "SBOM");
const docsOutDir = path.join(releaseRoot, "docs");
const provenanceOutDir = path.join(releaseRoot, "provenance");
const archivePath = path.join(outDir, `GoatCitadel-v${version}-release-package.zip`);

fs.rmSync(releaseRoot, { recursive: true, force: true });
fs.mkdirSync(artifactOutDir, { recursive: true });
fs.mkdirSync(sbomOutDir, { recursive: true });
fs.mkdirSync(docsOutDir, { recursive: true });
fs.mkdirSync(provenanceOutDir, { recursive: true });

const copiedArtifacts = artifactFiles.map((artifactPath) => copyArtifactWithProofs(artifactPath, artifactOutDir));
const copiedSbomPath = path.join(sbomOutDir, path.basename(sbomFile));
fs.copyFileSync(sbomFile, copiedSbomPath);

copyDocs(docsOutDir);

const buildMetadata = buildMetadataRecord({
  version,
  tagName,
  artifacts: copiedArtifacts,
  sbomPath: relativeToReleaseRoot(copiedSbomPath, releaseRoot),
});
const buildMetadataPath = path.join(provenanceOutDir, "build-metadata.json");
fs.writeFileSync(buildMetadataPath, `${JSON.stringify(buildMetadata, null, 2)}\n`, "utf8");

const slsaAttestation = buildSlsaAttestation({
  version,
  tagName,
  artifacts: copiedArtifacts,
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
  return value.startsWith("v") ? value.slice(1) : value;
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
      if (entry.name.endsWith(".exe") || entry.name.endsWith(".pkg") || entry.name.endsWith(".tar.gz")) {
        files.push(absolutePath);
      }
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function copyArtifactWithProofs(artifactPath, destinationDir) {
  const basename = path.basename(artifactPath);
  const checksumPath = `${artifactPath}.sha256`;
  const signaturePath = `${artifactPath}.sig`;
  const certificatePath = `${artifactPath}.pem`;

  for (const requiredPath of [checksumPath, signaturePath, certificatePath]) {
    if (!fs.existsSync(requiredPath)) {
      throw new Error(`Missing release proof file for ${basename}: ${requiredPath}`);
    }
  }

  const targetArtifactPath = path.join(destinationDir, basename);
  fs.copyFileSync(artifactPath, targetArtifactPath);
  fs.copyFileSync(checksumPath, path.join(destinationDir, `${basename}.sha256`));
  fs.copyFileSync(signaturePath, path.join(destinationDir, `${basename}.sig`));
  fs.copyFileSync(certificatePath, path.join(destinationDir, `${basename}.pem`));

  return {
    fileName: basename,
    relativePath: `artifact/${basename}`,
    checksumSha256: sha256File(artifactPath),
    sizeBytes: fs.statSync(artifactPath).size,
  };
}

function copyDocs(destinationDir) {
  const docSources = [
    path.join(repoRoot, "CHANGELOG.md"),
    path.join(repoRoot, "SECURITY.md"),
    path.join(repoRoot, "docs", "reproducible-release.md"),
    path.join(repoRoot, "docs", "supported-platforms.md"),
    path.join(repoRoot, "docs", "smoke-tests.md"),
    path.join(repoRoot, "docs", "dependency-policy.md"),
  ];
  const codeownersPath = fs.existsSync(path.join(repoRoot, "CODEOWNERS"))
    ? path.join(repoRoot, "CODEOWNERS")
    : path.join(repoRoot, ".github", "CODEOWNERS");
  docSources.push(codeownersPath);

  const optionalSources = [path.join(repoRoot, "LICENSE"), path.join(repoRoot, "docs", "PACKAGING.md")];

  for (const sourcePath of docSources) {
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Missing required release doc: ${sourcePath}`);
    }
    const targetName = path.basename(sourcePath);
    fs.copyFileSync(sourcePath, path.join(destinationDir, targetName));
  }

  for (const sourcePath of optionalSources) {
    if (!fs.existsSync(sourcePath)) {
      continue;
    }
    fs.copyFileSync(sourcePath, path.join(destinationDir, path.basename(sourcePath)));
  }
}

function buildMetadataRecord(input) {
  const workflowRef =
    process.env.GITHUB_WORKFLOW_REF ??
    `${process.env.GITHUB_REPOSITORY ?? "local"}/.github/workflows/release-installers.yml@${process.env.GITHUB_SHA ?? "local"}`;
  return {
    version: input.version,
    tag: input.tagName,
    commit: process.env.GITHUB_SHA ?? null,
    repository: process.env.GITHUB_REPOSITORY ?? null,
    workflow: {
      name: process.env.GITHUB_WORKFLOW ?? "Release Installers",
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
    lockedInputs: [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "Dockerfile",
      ".github/workflows/release-installers.yml",
    ],
    buildCommands: [
      "pnpm install --frozen-lockfile",
      "pnpm package:bundle --target <target>",
      "pnpm package:windows --target <target>",
      "pnpm dlx @cyclonedx/cyclonedx-npm --output-format json --output-file <sbom>",
      "node scripts/release/sign-release-artifacts.mjs --artifacts-dir <dir>",
      "node scripts/release/assemble-release-package.mjs --version <version> --artifacts-dir <dir> --sbom-file <sbom>",
      "node scripts/release/write-release-certificate.mjs --version <version> --artifacts-dir <dir> --proof-zip <zip>",
    ],
    artifacts: input.artifacts,
    sbom: input.sbomPath,
    generatedAt: new Date().toISOString(),
  };
}

function buildSlsaAttestation(input) {
  return {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: input.artifacts.map((artifact) => ({
      name: artifact.fileName,
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
          workflow: process.env.GITHUB_WORKFLOW ?? "Release Installers",
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
          ...["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "Dockerfile"].map((filePath) => ({
            uri: `file://${filePath}`,
            digest: {
              sha256: sha256File(path.join(repoRoot, filePath)),
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

function renderHandoff(input) {
  const primaryArtifact = input.artifacts[0];
  return [
    `# Handoff - ${input.tagName}`,
    ``,
    `**Owners:** @goatcitadel/maintainers`,
    `**Release date:** ${new Date().toISOString().slice(0, 10)}`,
    `**Primary artifact:** artifact/${primaryArtifact.fileName}`,
    `**Checksum:** artifact/${primaryArtifact.fileName}.sha256`,
    `**Signature:** artifact/${primaryArtifact.fileName}.sig (certificate: artifact/${primaryArtifact.fileName}.pem)`,
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
      (artifact) => `- ${artifact.fileName} | sha256=${artifact.checksumSha256} | size=${artifact.sizeBytes} bytes`,
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

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}
