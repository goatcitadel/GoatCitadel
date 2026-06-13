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
    publicRelease: buildPublicReleaseProof(certificate, releaseAssets, acceptedFailures),
    acceptedCaveats: acceptedFailures.map((item) => String(item)),
    acceptedCaveatClassifications: acceptedFailures.map(classifyAcceptedCaveat),
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
    `- Public release: ${summary.publicRelease.publicationStatus}`,
    `- Release URL: ${summary.publicRelease.releaseUrl ?? "not published"}`,
    `- Workflow/action URL: ${summary.publicRelease.actionUrl ?? "not captured"}`,
    `- Generated: ${summary.generatedAt}`,
    "",
    "| Artifact | Platform/arch | Status | SHA-256 | Checksum ref | Size | Source workflow | Action run | Exact SHA | Certificate | Caveats |",
    "|---|---|---|---|---|---:|---|---|---|---|---|",
  ];
  for (const artifact of summary.artifacts) {
    lines.push(
      [
        artifact.name,
        artifact.platformArch,
        artifact.signatureStatus,
        artifact.sha256,
        artifact.checksumRef,
        String(artifact.sizeBytes),
        artifact.sourceWorkflow,
        artifact.actionUrl,
        artifact.exactShaStatus,
        artifact.certificateInclusion,
        artifact.acceptedCaveatClassifications.length > 0
          ? artifact.acceptedCaveatClassifications.map((item) => `${item.classification}: ${item.detail}`).join("; ")
          : "none",
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
  const workflowUrl = extractWorkflowUrl(certificate?.releaseWorkflow);
  return {
    name,
    platformArch: inferPlatformArch(name),
    signatureStatus: inferSignatureStatus(asset, allAssets),
    sha256: String(asset?.sha256 ?? asset?.digestSha256 ?? asset?.hash ?? "missing"),
    publicUrl: extractAssetPublicUrl(asset),
    checksumRef: extractChecksumRef(asset, name, allAssets),
    sizeBytes: Number.isFinite(asset?.sizeBytes) ? asset.sizeBytes : Number.isFinite(asset?.size) ? asset.size : 0,
    sourceWorkflow: certificate?.releaseWorkflow?.name ?? "unknown",
    actionUrl: workflowUrl ?? "not captured",
    exactShaStatus: summarizeExactShaStatus(requiredLanes, certificate?.commit).status,
    certificateInclusion: "included",
    acceptedCaveats: acceptedFailures.map((item) => String(item)),
    acceptedCaveatClassifications: acceptedFailures.map(classifyAcceptedCaveat),
  };
}

function buildPublicReleaseProof(certificate, releaseAssets, acceptedFailures) {
  const releaseUrl = extractReleaseUrl(certificate);
  return {
    publicationStatus: releaseUrl ? "published_or_draft" : "local_proof_only",
    releaseUrl,
    actionUrl: extractWorkflowUrl(certificate?.releaseWorkflow),
    artifactCount: releaseAssets.length,
    checksumCount: releaseAssets.filter((asset) => extractChecksumRef(asset, undefined, releaseAssets) !== "missing").length,
    caveatCount: acceptedFailures.length,
    caveats: acceptedFailures.map(classifyAcceptedCaveat),
  };
}

function extractReleaseUrl(certificate) {
  return (
    asOptionalString(certificate?.releaseUrl) ??
    asOptionalString(certificate?.githubRelease?.htmlUrl) ??
    asOptionalString(certificate?.githubRelease?.html_url) ??
    asOptionalString(certificate?.release?.htmlUrl) ??
    asOptionalString(certificate?.release?.html_url) ??
    null
  );
}

function extractWorkflowUrl(workflow) {
  return (
    asOptionalString(workflow?.url) ??
    asOptionalString(workflow?.htmlUrl) ??
    asOptionalString(workflow?.html_url) ??
    asOptionalString(workflow?.runUrl) ??
    asOptionalString(workflow?.run_url) ??
    null
  );
}

function extractAssetPublicUrl(asset) {
  return (
    asOptionalString(asset?.browser_download_url) ??
    asOptionalString(asset?.downloadUrl) ??
    asOptionalString(asset?.download_url) ??
    asOptionalString(asset?.url) ??
    null
  );
}

function extractChecksumRef(asset, name, allAssets) {
  const direct =
    asOptionalString(asset?.checksumRef) ??
    asOptionalString(asset?.checksumPath) ??
    asOptionalString(asset?.sha256Path) ??
    asOptionalString(asset?.sha256File);
  if (direct) {
    return direct;
  }
  const assetName = name ?? String(asset?.name ?? asset?.fileName ?? asset?.relativePath ?? asset?.path ?? "");
  const sibling = (Array.isArray(allAssets) ? allAssets : []).find((item) => {
    const siblingName = String(item?.name ?? item?.fileName ?? item?.relativePath ?? item?.path ?? "");
    return siblingName === `${assetName}.sha256` || siblingName === `${assetName}.sha256sum`;
  });
  if (sibling) {
    return String(sibling?.name ?? sibling?.fileName ?? sibling?.relativePath ?? sibling?.path);
  }
  return "missing";
}

function classifyAcceptedCaveat(item) {
  const detail = String(item);
  const lower = detail.toLowerCase();
  const classification = lower.includes("unsigned") || lower.includes("sign")
    ? "signing"
    : lower.includes("publish") || lower.includes("release")
      ? "publication"
      : lower.includes("workflow") || lower.includes("ci") || lower.includes("action")
        ? "automation"
        : lower.includes("manual")
          ? "manual_verification"
          : "general";
  return { classification, detail };
}

function asOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
