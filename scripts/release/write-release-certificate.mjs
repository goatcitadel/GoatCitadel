#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveLaneProof } from "./release-certificate-proof.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");

const RELEASE_PROOF_WORKFLOW_FILE = "verification-1-0-release-proof.yml";
const RELEASE_PROOF_COVERED_LANES = [
  "verify:runtime:truth",
  "verify:auth:matrix",
  "verify:code-mode:sandbox",
  "verify:agentic:governance",
  "verify:agentic:proof",
  "verify:ui:parity",
  "verify:memory:truth",
  "verify:realtime:truth",
  "verify:architecture:metrics",
  "verify:operator:proof",
  "verify:durable:recovery",
  "verify:surface:regression",
  "verify:visual:regression",
  "verify:backup:roundtrip",
  "verify:catalog:parity",
  "verify:api:compat",
];
const RELEASE_PROOF_COVERED_LANE_NAMES = new Set(RELEASE_PROOF_COVERED_LANES);
const REQUIRED_LANE_SPECS = [
  { name: "verify:fast", workflowFile: "verification-fast.yml", required: true },
  { name: "verify:runtime:truth", workflowFile: "verification-truth-lanes.yml", required: true },
  { name: "verify:auth:matrix", workflowFile: "verification-truth-lanes.yml", required: true },
  { name: "verify:code-mode:sandbox", workflowFile: "verification-agentic-code-mode.yml", required: true },
  { name: "verify:agentic:governance", workflowFile: "verification-agentic-code-mode.yml", required: true },
  { name: "verify:agentic:proof", workflowFile: "verification-agentic-code-mode.yml", required: true },
  { name: "verify:ui:parity", workflowFile: "verification-truth-lanes.yml", required: true },
  { name: "verify:memory:truth", workflowFile: "verification-truth-lanes.yml", required: true },
  { name: "verify:realtime:truth", workflowFile: "verification-truth-lanes.yml", required: true },
  { name: "verify:architecture:metrics", workflowFile: "verification-truth-lanes.yml", required: true },
  { name: "verify:operator:proof", workflowFile: "verification-operator-proof.yml", required: true },
  { name: "verify:durable:recovery", workflowFile: "verification-durable-recovery.yml", required: true },
  { name: "verify:surface:regression", workflowFile: "verification-surface-regression.yml", required: true },
  { name: "verify:visual:regression", workflowFile: "verification-visual-regression.yml", required: true },
  { name: "verify:backup:roundtrip", workflowFile: "verification-backup-roundtrip.yml", required: true },
  { name: "verify:catalog:parity", workflowFile: "verification-catalog-parity.yml", required: true },
  { name: "verify:api:compat", workflowFile: "verification-api-compat.yml", required: true },
  { name: "docs:check", workflowFile: "verification-docs-check.yml", required: true },
  { name: "security:trivy", workflowFile: "security-trivy.yml", required: true },
].map((spec) => ({
  ...spec,
  releaseProofCovered: RELEASE_PROOF_COVERED_LANE_NAMES.has(spec.name),
}));

const args = parseArgs(process.argv.slice(2));
const version = normalizeVersion(args.version);
const tagName = args.tag ?? process.env.GITHUB_REF_NAME ?? `v${version}`;
const artifactsDir = path.resolve(args.artifactsDir ?? path.join(repoRoot, "release-artifacts"));
const proofZipPath = path.resolve(
  args.proofZip ??
    path.join(repoRoot, "artifacts", "release", "package", `GoatCitadel-v${version}-release-package.zip`),
);
const outFile = path.resolve(args.outFile ?? path.join(repoRoot, "artifacts", "release", "release-certificate.json"));

if (!fs.existsSync(artifactsDir)) {
  throw new Error(`Artifacts directory does not exist: ${artifactsDir}`);
}
if (!fs.existsSync(proofZipPath)) {
  throw new Error(`Release proof ZIP does not exist: ${proofZipPath}`);
}

const commit = process.env.GITHUB_SHA ?? args.commit ?? null;
const repository = process.env.GITHUB_REPOSITORY ?? args.repository ?? null;
const requiredLanes = await resolveRequiredLanes({ commit, repository });
const releaseAssets = listFiles(artifactsDir).map((filePath) => fileRecord(filePath, artifactsDir));
const proofBundle = fileRecord(proofZipPath, path.dirname(proofZipPath));

const certificate = {
  schemaVersion: 1,
  product: "GoatCitadel",
  version,
  tag: tagName,
  commit,
  repository,
  generatedAt: new Date().toISOString(),
  releaseWorkflow: {
    name: process.env.GITHUB_WORKFLOW ?? "Release Windows Installers",
    runId: process.env.GITHUB_RUN_ID ?? null,
    runNumber: process.env.GITHUB_RUN_NUMBER ?? null,
    runUrl:
      repository && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : null,
  },
  requiredLanes,
  releaseProofCoverage: {
    workflowFile: RELEASE_PROOF_WORKFLOW_FILE,
    coveredLanes: RELEASE_PROOF_COVERED_LANES,
    directOnlyLanes: REQUIRED_LANE_SPECS.filter((lane) => !lane.releaseProofCovered).map((lane) => lane.name),
  },
  trivyStatus: requiredLanes.find((lane) => lane.name === "security:trivy")?.status ?? "missing",
  acceptedFailures: [],
  releaseAssets,
  proofBundle,
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(certificate, null, 2)}\n`, "utf8");
console.log(`Release certificate ready: ${outFile}`);

if (args.requireSuccess) {
  const blocking = requiredLanes.filter((lane) => lane.required && lane.status !== "success");
  if (blocking.length > 0) {
    throw new Error(formatRequiredLaneFailure(blocking, commit));
  }
}

function parseArgs(argv) {
  const parsed = {
    requireSuccess: false,
  };
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
    if (value === "--commit") {
      parsed.commit = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--repository") {
      parsed.repository = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--artifacts-dir") {
      parsed.artifactsDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--proof-zip") {
      parsed.proofZip = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--out-file") {
      parsed.outFile = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--require-success") {
      parsed.requireSuccess = true;
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

async function resolveRequiredLanes({ commit, repository }) {
  const releaseProofRun = await fetchLatestWorkflowRun({
    repository,
    commit,
    workflowFile: RELEASE_PROOF_WORKFLOW_FILE,
  });

  return Promise.all(
    REQUIRED_LANE_SPECS.map(async (spec) => {
      const directRun = await fetchLatestWorkflowRun({ repository, commit, workflowFile: spec.workflowFile });
      return {
        ...resolveLaneProof({
          spec,
          directRun,
          releaseProofRun,
          releaseProofWorkflowFile: RELEASE_PROOF_WORKFLOW_FILE,
          targetCommit: commit,
        }),
        checkedAt: new Date().toISOString(),
      };
    }),
  );
}

async function fetchLatestWorkflowRun({ repository, commit, workflowFile }) {
  if (!repository || !commit || !process.env.GITHUB_TOKEN) {
    return {
      status: "unavailable",
      conclusion: null,
      html_url: null,
      id: null,
      head_sha: null,
    };
  }
  const encodedWorkflow = encodeURIComponent(workflowFile);
  const url = `https://api.github.com/repos/${repository}/actions/workflows/${encodedWorkflow}/runs?head_sha=${commit}&per_page=10`;
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) {
      return {
        status: `github-api-${response.status}`,
        conclusion: null,
        html_url: null,
        id: null,
        head_sha: null,
      };
    }
    const payload = await response.json();
    const run = payload.workflow_runs?.[0];
    if (!run) {
      return {
        status: "missing",
        conclusion: null,
        html_url: null,
        id: null,
        head_sha: null,
      };
    }
    return {
      status: run.conclusion ?? run.status ?? "unknown",
      conclusion: run.conclusion ?? null,
      html_url: run.html_url ?? null,
      id: run.id ?? null,
      head_sha: run.head_sha ?? null,
    };
  } catch (error) {
    return {
      status: `github-api-error:${error instanceof Error ? error.message : "unknown"}`,
      conclusion: null,
      html_url: null,
      id: null,
      head_sha: null,
    };
  }
}

function formatRequiredLaneFailure(blocking, commit) {
  const sections = new Map([
    ["missing", []],
    ["unavailable", []],
    ["failed", []],
  ]);
  for (const lane of blocking) {
    const bucket =
      lane.status === "missing"
        ? "missing"
        : lane.status === "unavailable" || String(lane.status).startsWith("github-api")
          ? "unavailable"
          : "failed";
    sections.get(bucket).push(formatLaneFailure(lane));
  }
  const lines = [`Required release lanes are not green for ${commit ?? "unknown commit"}.`];
  for (const [label, entries] of sections) {
    if (entries.length === 0) {
      continue;
    }
    lines.push(`${label}: ${entries.join("; ")}`);
  }
  lines.push(
    "Run the missing direct-only lane workflow(s) and, for umbrella-covered lanes only, either the direct lane workflow or the umbrella Verification 1.0 Release Proof workflow on the exact release-candidate SHA, then rerun release certificate generation.",
  );
  return lines.join(" ");
}

function formatLaneFailure(lane) {
  const workflow = lane.proofWorkflowFile ?? lane.workflowFile;
  const url = lane.workflowRunUrl ? ` ${lane.workflowRunUrl}` : "";
  return `${lane.name}=${lane.status} via ${workflow}${url}`;
}

function listFiles(rootDir) {
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
      if (entry.isFile()) {
        files.push(absolutePath);
      }
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function fileRecord(filePath, rootDir) {
  return {
    fileName: path.basename(filePath),
    relativePath: path.relative(rootDir, filePath).replaceAll("\\", "/"),
    sha256: sha256File(filePath),
    sizeBytes: fs.statSync(filePath).size,
  };
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}
