#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");

export function buildReleaseProofSummary(certificate) {
  const releaseAssets = Array.isArray(certificate?.releaseAssets) ? certificate.releaseAssets : [];
  const requiredLanes = Array.isArray(certificate?.requiredLanes) ? certificate.requiredLanes : [];
  const acceptedFailures = Array.isArray(certificate?.acceptedFailures) ? certificate.acceptedFailures : [];
  return {
    schemaVersion: 1,
    product: certificate?.product ?? "GoatCitadel",
    version: certificate?.version ?? "unknown",
    tag: certificate?.tag ?? null,
    commit: certificate?.commit ?? null,
    generatedAt: new Date().toISOString(),
    sourceCertificate: "release-certificate.json",
    releaseWorkflow: certificate?.releaseWorkflow ?? null,
    exactShaStatus: summarizeExactShaStatus(requiredLanes, certificate?.commit),
    acceptedCaveats: acceptedFailures.map((item) => String(item)),
    artifacts: releaseAssets.map((asset) =>
      buildArtifactProofRow(asset, certificate, requiredLanes, acceptedFailures, releaseAssets),
    ),
  };
}

export function renderReleaseProofSummaryMarkdown(summary) {
  const lines = [
    `# ${summary.product} ${summary.version} Release Proof`,
    "",
    `- Source certificate: ${summary.sourceCertificate}`,
    `- Commit: ${summary.commit ?? "unknown"}`,
    `- Exact-SHA status: ${summary.exactShaStatus.status}`,
    `- Generated: ${summary.generatedAt}`,
    "",
    "| Artifact | Platform/arch | Status | SHA-256 | Size | Source workflow | Exact SHA | Certificate | Caveats |",
    "|---|---|---|---|---:|---|---|---|---|",
  ];
  for (const artifact of summary.artifacts) {
    lines.push(
      [
        artifact.name,
        artifact.platformArch,
        artifact.signatureStatus,
        artifact.sha256,
        String(artifact.sizeBytes),
        artifact.sourceWorkflow,
        artifact.exactShaStatus,
        artifact.certificateInclusion,
        artifact.acceptedCaveats.length > 0 ? artifact.acceptedCaveats.join("; ") : "none",
      ]
        .map(escapeMarkdownCell)
        .join("|")
        .replace(/^/, "|")
        .replace(/$/, "|"),
    );
  }
  return `${lines.join("\n")}\n`;
}

function buildArtifactProofRow(asset, certificate, requiredLanes, acceptedFailures, allAssets) {
  const name = String(asset?.name ?? asset?.fileName ?? asset?.relativePath ?? asset?.path ?? "unknown");
  return {
    name,
    platformArch: inferPlatformArch(name),
    signatureStatus: inferSignatureStatus(asset, allAssets),
    sha256: String(asset?.sha256 ?? asset?.digestSha256 ?? asset?.hash ?? "missing"),
    sizeBytes: Number.isFinite(asset?.sizeBytes) ? asset.sizeBytes : Number.isFinite(asset?.size) ? asset.size : 0,
    sourceWorkflow: certificate?.releaseWorkflow?.name ?? "unknown",
    exactShaStatus: summarizeExactShaStatus(requiredLanes, certificate?.commit).status,
    certificateInclusion: "included",
    acceptedCaveats: acceptedFailures.map((item) => String(item)),
  };
}

function summarizeExactShaStatus(requiredLanes, commit) {
  if (!commit) {
    return { status: "unknown", matching: 0, total: requiredLanes.length };
  }
  const total = requiredLanes.length;
  const matching = requiredLanes.filter((lane) => {
    const directSha = lane?.directRun?.headSha ?? lane?.directRun?.head_sha;
    const proofSha = lane?.releaseProofRun?.headSha ?? lane?.releaseProofRun?.head_sha;
    return directSha === commit || proofSha === commit;
  }).length;
  return {
    status: total === 0 ? "unknown" : matching === total ? "exact" : matching > 0 ? "partial" : "missing",
    matching,
    total,
  };
}

function inferSignatureStatus(asset, allAssets) {
  if (asset?.signature || asset?.signaturePath || asset?.certificatePath) {
    return "signed";
  }
  const name = String(asset?.name ?? "");
  const fileName = String(asset?.fileName ?? asset?.relativePath ?? name);
  if (fileName.endsWith(".sig") || fileName.endsWith(".pem")) {
    return "signed";
  }
  const siblingNames = new Set(
    (Array.isArray(allAssets) ? allAssets : []).map((item) =>
      String(item?.name ?? item?.fileName ?? item?.relativePath ?? item?.path ?? ""),
    ),
  );
  if (siblingNames.has(`${fileName}.sig`) || siblingNames.has(`${fileName}.pem`) || siblingNames.has(`${fileName}.cert.pem`)) {
    return "signed";
  }
  if (/experimental|preview/i.test(name)) {
    return "experimental";
  }
  return "unsigned";
}

function inferPlatformArch(name) {
  const lower = name.toLowerCase();
  const platform = lower.includes("win")
    ? "windows"
    : lower.includes("mac") || lower.includes("darwin") || lower.endsWith(".dmg")
      ? "macos"
      : lower.includes("linux") || lower.endsWith(".tar.gz")
        ? "linux"
        : "unknown";
  const arch = lower.includes("arm64") || lower.includes("aarch64") ? "arm64" : lower.includes("x64") || lower.includes("amd64") ? "x64" : "unknown";
  return `${platform}/${arch}`;
}

function escapeMarkdownCell(value) {
  return String(value).replaceAll("|", "\\|");
}

function parseArgs(argv) {
  const parsed = {
    format: "json",
    certificate: path.join(repoRoot, "artifacts", "release", "release-certificate.json"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--certificate") {
      parsed.certificate = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--format") {
      parsed.format = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  return parsed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const certificate = JSON.parse(fs.readFileSync(path.resolve(args.certificate), "utf8"));
  const summary = buildReleaseProofSummary(certificate);
  process.stdout.write(args.format === "markdown" ? renderReleaseProofSummaryMarkdown(summary) : `${JSON.stringify(summary, null, 2)}\n`);
}
