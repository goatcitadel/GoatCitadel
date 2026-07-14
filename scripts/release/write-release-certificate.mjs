#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PACKAGING_TARGETS } from "../packaging/lib/packaging-targets.mjs";
import {
  RELEASE_DETACHED_METADATA_FILES,
  RELEASE_DETACHED_METADATA_TREES,
  RELEASE_PAYLOAD_LIMITS,
  RELEASE_PAYLOAD_ROOTS,
  validateReleaseManifest,
} from "../packaging/lib/package-renderers.mjs";
import { resolveLaneProof } from "./release-certificate-proof.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const EXPECTED_REPOSITORY = "goatcitadel/GoatCitadel";
const EXPECTED_RELEASE_WORKFLOW_NAME = "Release Installers and Bundles";
const EXPECTED_RELEASE_WORKFLOW_FILE = ".github/workflows/release-installers.yml";
const REQUIRED_RUNTIME_PAYLOAD_TARGETS = Object.freeze(["windows-x64", "windows-arm64"]);
const MAX_RELEASE_ASSETS = 256;
const MAX_RELEASE_ARTIFACT_DIRECTORIES = 1_024;
const MAX_RELEASE_ASSET_PATH_BYTES = 240;
const MAX_CERTIFICATE_BYTES = 2 * 1024 * 1024;
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

const RELEASE_PROOF_WORKFLOW_FILE = "verification-1-0-release-proof.yml";
const RELEASE_PROOF_COVERED_LANES = [
  "verify:runtime:truth",
  "verify:auth:matrix",
  "verify:desktop",
  "verify:code-mode:sandbox",
  "verify:code-mode:hostile-sandbox",
  "verify:agentic:governance",
  "verify:agentic:proof",
  "verify:orchestration:perf",
  "verify:channels:runtime",
  "verify:extensions:package",
  "verify:a2a:full",
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
  { name: "verify:runtime:truth", workflowFile: RELEASE_PROOF_WORKFLOW_FILE, required: true },
  { name: "verify:auth:matrix", workflowFile: RELEASE_PROOF_WORKFLOW_FILE, required: true },
  { name: "verify:desktop", workflowFile: RELEASE_PROOF_WORKFLOW_FILE, required: true },
  { name: "verify:code-mode:sandbox", workflowFile: RELEASE_PROOF_WORKFLOW_FILE, required: true },
  { name: "verify:code-mode:hostile-sandbox", workflowFile: RELEASE_PROOF_WORKFLOW_FILE, required: true },
  { name: "verify:agentic:governance", workflowFile: RELEASE_PROOF_WORKFLOW_FILE, required: true },
  { name: "verify:agentic:proof", workflowFile: RELEASE_PROOF_WORKFLOW_FILE, required: true },
  { name: "verify:orchestration:perf", workflowFile: RELEASE_PROOF_WORKFLOW_FILE, required: true },
  { name: "verify:channels:runtime", workflowFile: RELEASE_PROOF_WORKFLOW_FILE, required: true },
  { name: "verify:extensions:package", workflowFile: RELEASE_PROOF_WORKFLOW_FILE, required: true },
  { name: "verify:ui:parity", workflowFile: RELEASE_PROOF_WORKFLOW_FILE, required: true },
  { name: "verify:memory:truth", workflowFile: RELEASE_PROOF_WORKFLOW_FILE, required: true },
  { name: "verify:realtime:truth", workflowFile: RELEASE_PROOF_WORKFLOW_FILE, required: true },
  { name: "verify:architecture:metrics", workflowFile: RELEASE_PROOF_WORKFLOW_FILE, required: true },
  { name: "verify:operator:proof", workflowFile: RELEASE_PROOF_WORKFLOW_FILE, required: true },
  { name: "verify:durable:recovery", workflowFile: RELEASE_PROOF_WORKFLOW_FILE, required: true },
  { name: "verify:surface:regression", workflowFile: RELEASE_PROOF_WORKFLOW_FILE, required: true },
  { name: "verify:visual:regression", workflowFile: RELEASE_PROOF_WORKFLOW_FILE, required: true },
  { name: "verify:backup:roundtrip", workflowFile: RELEASE_PROOF_WORKFLOW_FILE, required: true },
  { name: "verify:catalog:parity", workflowFile: RELEASE_PROOF_WORKFLOW_FILE, required: true },
  { name: "verify:api:compat", workflowFile: RELEASE_PROOF_WORKFLOW_FILE, required: true },
  { name: "verify:a2a:full", workflowFile: RELEASE_PROOF_WORKFLOW_FILE, required: true },
  { name: "docs:check", workflowFile: "verification-fast.yml", required: true },
  { name: "security:trivy", workflowFile: "security-trivy.yml", required: true },
].map((spec) => ({
  ...spec,
  releaseProofCovered: RELEASE_PROOF_COVERED_LANE_NAMES.has(spec.name),
}));

const PARITY_CLOSURE_CHECKS = [
  {
    key: "operatorProof",
    label: "Operator proof",
    lane: "verify:operator:proof",
    required: true,
  },
  {
    key: "durableRecovery",
    label: "Durable recovery",
    lane: "verify:durable:recovery",
    required: true,
  },
  {
    key: "runtimeTruth",
    label: "Runtime truth",
    lane: "verify:runtime:truth",
    required: true,
  },
  {
    key: "memoryTruth",
    label: "Memory truth",
    lane: "verify:memory:truth",
    required: true,
  },
  {
    key: "surfaceRegression",
    label: "Surface regression",
    lane: "verify:surface:regression",
    required: true,
  },
  {
    key: "desktopRuntime",
    label: "Desktop credential and SSE readiness",
    lane: "verify:desktop",
    required: true,
  },
  {
    key: "installSmoke",
    label: "Install smoke",
    lane: "verify:operator:proof",
    required: true,
    coveredCommand: "verify:install",
  },
  {
    key: "extensionsPackage",
    label: "Extensions package",
    lane: "verify:extensions:package",
    required: true,
  },
  {
    key: "channelRuntime",
    label: "Channel runtime delivery",
    lane: "verify:channels:runtime",
    required: true,
  },
];

const OPERATOR_TRUTH_PROOF_CHECKS = [
  {
    key: "capabilityCatalogDecisionEvidence",
    label: "Capability catalog snapshot and runtime decision evidence",
    lane: "verify:operator:proof",
    required: true,
    evidenceRefs: [
      "runtime_decision_traces.kind=capability_profile_frozen",
      "capability_catalog_snapshots",
      "Code Mode run capability profile UI",
    ],
  },
  {
    key: "librarySkillsDoctor",
    label: "Library Skills trust and doctor signals",
    lane: "verify:operator:proof",
    required: true,
    evidenceRefs: ["Library Skills trust doctor", "Library Skills provenance doctor", "Library Skills tool scope"],
  },
  {
    key: "memoryProvenanceSummary",
    label: "Memory provenance summary",
    lane: "verify:memory:truth",
    required: false,
    evidenceRefs: ["Library Memory provenance summary", "verify:memory:truth"],
    advisory: "Narrow provenance summary only; no new memory authority is claimed without fresh runtime proof.",
  },
  {
    key: "releasePackageProof",
    label: "Release certificate and package proof scripts",
    lane: "verify:operator:proof",
    required: true,
    evidenceRefs: [
      "scripts/release/write-release-certificate.mjs",
      "scripts/release/assemble-release-package.mjs",
      "scripts/release/release-certificate-proof.test.mjs",
    ],
  },
  {
    key: "providerMetadataRefresh",
    label: "Provider metadata refresh",
    lane: "verify:runtime:truth",
    required: false,
    evidenceRefs: ["runtime doctor unsupported gap"],
    unsupportedGap:
      "No same-day live provider metadata proof is attached; release evidence records this gap instead of adding a provider family.",
  },
];

const args = parseArgs(process.argv.slice(2));
const version = normalizeVersion(args.version);
const tagName = args.tag ?? process.env.GITHUB_REF_NAME ?? `v${version}`;
const artifactsDir = path.resolve(args.artifactsDir ?? path.join(repoRoot, "release-artifacts"));
const proofZipPath = path.resolve(
  args.proofZip ??
    path.join(repoRoot, "artifacts", "release", "package", `GoatCitadel-v${version}-release-package.zip`),
);
const outFile = path.resolve(args.outFile ?? path.join(repoRoot, "artifacts", "release", "release-certificate.json"));
const hostileSandboxProofPath = args.hostileSandboxProof
  ? path.resolve(args.hostileSandboxProof)
  : process.env.GOATCITADEL_HOSTILE_SANDBOX_PROOF
    ? path.resolve(process.env.GOATCITADEL_HOSTILE_SANDBOX_PROOF)
    : null;

if (!fs.existsSync(artifactsDir)) {
  throw new Error(`Artifacts directory does not exist: ${artifactsDir}`);
}
if (!fs.existsSync(proofZipPath)) {
  throw new Error(`Release proof ZIP does not exist: ${proofZipPath}`);
}

const commit = normalizeCommit(process.env.GITHUB_SHA ?? args.commit);
const repository = validateRepository(process.env.GITHUB_REPOSITORY ?? args.repository);
const releaseWorkflow = validateReleaseWorkflowTruth({
  repository,
  tag: tagName,
  commit,
});
const requiredLanes = await resolveRequiredLanes({ commit, repository });
const releaseAssets = await Promise.all(listFiles(artifactsDir).map((filePath) => fileRecord(filePath, artifactsDir)));
validateFixedReleaseAssetInventory(releaseAssets, version);
const runtimePayloads = await resolveRuntimePayloads({
  mappings: args.runtimeManifests,
  artifactsDir,
  releaseAssets,
  version,
  commit,
});
const proofBundle = await fileRecord(proofZipPath, path.dirname(proofZipPath));
const hostileSandboxProof = hostileSandboxProofPath ? readOptionalJson(hostileSandboxProofPath) : null;
const exactShaStatus = summarizeRequiredLaneExactSha(requiredLanes, commit);
const hostileSandboxWindowsClaim = buildHostileSandboxWindowsClaim({
  commit,
  proof: hostileSandboxProof,
  proofPath: hostileSandboxProofPath,
  requiredLanes,
});

const certificate = {
  schemaVersion: 2,
  product: "GoatCitadel",
  version,
  tag: tagName,
  commit,
  targetCommit: commit,
  repository,
  generatedAt: new Date().toISOString(),
  releaseWorkflow,
  requiredLanes,
  exactShaStatus,
  releaseProofCoverage: {
    workflowFile: RELEASE_PROOF_WORKFLOW_FILE,
    coveredLanes: RELEASE_PROOF_COVERED_LANES,
    directOnlyLanes: REQUIRED_LANE_SPECS.filter((lane) => !lane.releaseProofCovered).map((lane) => lane.name),
  },
  operatorTruthProof: buildOperatorTruthProof({
    commit,
    requiredLanes,
    exactShaStatus,
    proofBundle,
  }),
  hostileSandboxWindowsClaim,
  parityClosure: buildParityClosureVerdict({
    commit,
    requiredLanes,
    exactShaStatus,
    releaseAssets,
    proofBundle,
    hostileSandboxWindowsClaim,
  }),
  trivyStatus: requiredLanes.find((lane) => lane.name === "security:trivy")?.status ?? "missing",
  acceptedFailures: [],
  runtimePayloads,
  releaseAssets,
  proofBundle,
};

const certificateBytes = Buffer.from(`${JSON.stringify(certificate, null, 2)}\n`, "utf8");
if (certificateBytes.length > MAX_CERTIFICATE_BYTES) {
  throw new Error(`Release certificate exceeds ${MAX_CERTIFICATE_BYTES} bytes.`);
}
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, certificateBytes);
console.log(`Release certificate ready: ${outFile}`);

if (args.requireSuccess) {
  const blocking = requiredLanes.filter((lane) => lane.required && lane.status !== "success");
  if (blocking.length > 0) {
    throw new Error(formatRequiredLaneFailure(blocking, commit));
  }
  // Exact-SHA backstop: a required lane that is green only on a stale SHA (its proof is not
  // bound to this release commit) must NOT satisfy --require-success. The certificate is
  // valid only when every required lane's proof is anchored to the exact release-candidate SHA.
  if (certificate.exactShaStatus.status !== "matched") {
    throw new Error(
      `Release certificate exact-SHA proof is "${certificate.exactShaStatus.status}" for ${commit}: ` +
        "one or more required lane proofs are not bound to the release SHA. Re-run the affected lane(s) " +
        "(or the umbrella release-proof workflow) on the exact commit, then regenerate the certificate.",
    );
  }
}

function parseArgs(argv) {
  const parsed = {
    requireSuccess: false,
    runtimeManifests: [],
  };
  let index = 0;
  const takeOptionValue = (flag) => {
    if (index + 1 >= argv.length) {
      throw new Error(`Missing value for argument: ${flag}`);
    }
    index += 1;
    return argv[index];
  };
  while (index < argv.length) {
    const value = argv[index];
    if (value === "--version") {
      parsed.version = takeOptionValue("--version");
      index += 1;
      continue;
    }
    if (value === "--tag") {
      parsed.tag = takeOptionValue("--tag");
      index += 1;
      continue;
    }
    if (value === "--commit") {
      parsed.commit = takeOptionValue("--commit");
      index += 1;
      continue;
    }
    if (value === "--repository") {
      parsed.repository = takeOptionValue("--repository");
      index += 1;
      continue;
    }
    if (value === "--artifacts-dir") {
      parsed.artifactsDir = takeOptionValue("--artifacts-dir");
      index += 1;
      continue;
    }
    if (value === "--proof-zip") {
      parsed.proofZip = takeOptionValue("--proof-zip");
      index += 1;
      continue;
    }
    if (value === "--out-file") {
      parsed.outFile = takeOptionValue("--out-file");
      index += 1;
      continue;
    }
    if (value === "--hostile-sandbox-proof") {
      parsed.hostileSandboxProof = takeOptionValue("--hostile-sandbox-proof");
      index += 1;
      continue;
    }
    if (value === "--runtime-manifest") {
      const mapping = takeOptionValue("--runtime-manifest");
      const separator = mapping.indexOf("=");
      if (separator <= 0 || separator === mapping.length - 1) {
        throw new Error("--runtime-manifest requires <target>=<path>.");
      }
      parsed.runtimeManifests.push({
        target: mapping.slice(0, separator),
        filePath: mapping.slice(separator + 1),
      });
      index += 1;
      continue;
    }
    if (value === "--require-success") {
      parsed.requireSuccess = true;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  if (!parsed.version) {
    throw new Error("Missing required argument: --version");
  }
  if (parsed.runtimeManifests.length === 0) {
    throw new Error("At least one --runtime-manifest <target>=<path> argument is required.");
  }
  return parsed;
}

function normalizeVersion(value) {
  const normalized = value.startsWith("v") ? value.slice(1) : value;
  if (!/^[0-9][0-9a-z.+-]{0,79}$/iu.test(normalized) || normalized.includes("..")) {
    throw new Error(`Invalid release version: ${value}`);
  }
  return normalized;
}

function normalizeCommit(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-f0-9]{40}$/u.test(normalized)) {
    throw new Error("Release certificate requires a full 40-character commit SHA.");
  }
  return normalized;
}

function validateRepository(value) {
  if (value !== EXPECTED_REPOSITORY) {
    throw new Error(`Release certificate repository must be ${EXPECTED_REPOSITORY}.`);
  }
  return value;
}

function validateFixedReleaseAssetInventory(releaseAssets, version) {
  const actual = releaseAssets.map((record) => record.relativePath).sort(compareStrings);
  const expected = fixedReleaseAssetPaths(version);
  if (
    actual.length !== expected.length ||
    new Set(actual.map((item) => item.toLowerCase())).size !== actual.length ||
    actual.some((item, index) => item !== expected[index])
  ) {
    throw new Error(
      `Release assets must match the fixed closed-world inventory. Expected: ${expected.join(", ")}; received: ${actual.join(", ")}.`,
    );
  }
}

function fixedReleaseAssetPaths(version) {
  const signedArtifacts = [
    "windows-x64-release-assets/GoatCitadel-Setup-windows-x64.exe",
    "windows-x64-release-assets/GoatCitadel-Mission-Control-Windows-Identity.msix",
    "windows-arm64-release-assets/GoatCitadel-Setup-windows-arm64.exe",
    "windows-arm64-release-assets/GoatCitadel-Mission-Control-Windows-Identity.msix",
    `linux-x64-experimental-release-assets/GoatCitadel-${version}-linux-x64.tar.gz`,
    `macos-arm64-experimental-release-assets/GoatCitadel-${version}-macos-arm64.dmg`,
  ];
  return [
    ...signedArtifacts,
    ...signedArtifacts.flatMap((artifactPath) => [`${artifactPath}.sig`, `${artifactPath}.pem`]),
    "windows-x64-release-assets/GoatCitadel-Setup-windows-x64.exe.sha256",
    "windows-x64-release-assets/GoatCitadel-Mission-Control-Windows-Identity.msix.sha256",
    "windows-x64-release-assets/identity-manifest.json",
    "windows-x64-release-assets/app/release-manifest.json",
    "windows-arm64-release-assets/GoatCitadel-Setup-windows-arm64.exe.sha256",
    "windows-arm64-release-assets/GoatCitadel-Mission-Control-Windows-Identity.msix.sha256",
    "windows-arm64-release-assets/identity-manifest.json",
    "windows-arm64-release-assets/app/release-manifest.json",
    `linux-x64-experimental-release-assets/GoatCitadel-${version}-linux-x64.tar.gz.sha256`,
    `macos-arm64-experimental-release-assets/GoatCitadel-${version}-macos-arm64.dmg.sha256`,
  ].sort(compareStrings);
}

function validateReleaseWorkflowTruth({ repository, tag, commit }) {
  if (tag !== `v${version}`) {
    throw new Error(`Release tag ${tag} must exactly match version v${version}.`);
  }
  const expectedRef = `refs/tags/${tag}`;
  const expectedWorkflowRef = `${repository}/${EXPECTED_RELEASE_WORKFLOW_FILE}@${expectedRef}`;
  const checks = [
    ["GITHUB_ACTIONS", process.env.GITHUB_ACTIONS, "true"],
    ["GITHUB_EVENT_NAME", process.env.GITHUB_EVENT_NAME, "push"],
    ["GITHUB_REF", process.env.GITHUB_REF, expectedRef],
    ["GITHUB_REF_NAME", process.env.GITHUB_REF_NAME, tag],
    ["GITHUB_SHA", process.env.GITHUB_SHA?.toLowerCase(), commit],
    ["GITHUB_WORKFLOW", process.env.GITHUB_WORKFLOW, EXPECTED_RELEASE_WORKFLOW_NAME],
    ["GITHUB_WORKFLOW_REF", process.env.GITHUB_WORKFLOW_REF, expectedWorkflowRef],
  ];
  for (const [name, actual, expected] of checks) {
    if (actual !== expected) {
      throw new Error(`Release certificate requires ${name}=${expected}; received ${String(actual)}.`);
    }
  }
  return {
    name: EXPECTED_RELEASE_WORKFLOW_NAME,
    workflowFile: EXPECTED_RELEASE_WORKFLOW_FILE,
    eventName: "push",
    ref: expectedRef,
    sha: commit,
    workflowRef: expectedWorkflowRef,
    trustEligible: true,
  };
}

async function resolveRuntimePayloads({ mappings, artifactsDir, releaseAssets, version, commit }) {
  const artifactsRoot = path.resolve(artifactsDir);
  const seenTargets = new Set();
  const seenManifestPaths = new Set();
  const records = [];
  for (const mapping of mappings) {
    const targetInfo = PACKAGING_TARGETS[mapping.target];
    if (!targetInfo) {
      throw new Error(`Unsupported runtime manifest target: ${mapping.target}`);
    }
    if (seenTargets.has(mapping.target)) {
      throw new Error(`Duplicate runtime manifest target: ${mapping.target}`);
    }
    seenTargets.add(mapping.target);
    const manifestPath = path.resolve(mapping.filePath);
    assertChildPath(artifactsRoot, manifestPath, `runtime manifest ${mapping.target}`);
    const manifestRelativePath = path.relative(artifactsRoot, manifestPath).replaceAll("\\", "/");
    if (seenManifestPaths.has(manifestRelativePath)) {
      throw new Error(`Runtime manifest path is assigned to multiple targets: ${manifestRelativePath}`);
    }
    seenManifestPaths.add(manifestRelativePath);
    const rawManifest = readBoundedRegularFile(manifestPath, {
      rootDir: artifactsRoot,
      maxBytes: RELEASE_PAYLOAD_LIMITS.maxManifestBytes,
      label: `runtime manifest ${mapping.target}`,
    });
    let manifest;
    try {
      manifest = JSON.parse(rawManifest.toString("utf8"));
    } catch (error) {
      throw new Error(`Runtime manifest ${mapping.target} is not valid JSON.`, { cause: error });
    }
    validateReleaseManifest(manifest, {
      targetInfo,
      expectedVersion: version,
      expectedCommit: commit,
      requireCleanSource: true,
    });
    const assetRecord = releaseAssets.find((asset) => asset.relativePath === manifestRelativePath);
    if (!assetRecord) {
      throw new Error(`Runtime manifest is not included in releaseAssets: ${manifestRelativePath}`);
    }
    const manifestSha256 = createHash("sha256").update(rawManifest).digest("hex");
    if (assetRecord.sha256 !== manifestSha256 || assetRecord.sizeBytes !== rawManifest.length) {
      throw new Error(
        `Runtime manifest releaseAssets record changed during certificate assembly: ${manifestRelativePath}`,
      );
    }
    records.push({
      target: targetInfo.target,
      platform: targetInfo.platform,
      arch: targetInfo.arch,
      installLayout: "goatcitadel-bundle-v1",
      immutableRoots: [...RELEASE_PAYLOAD_ROOTS],
      detachedMetadataFiles: [...RELEASE_DETACHED_METADATA_FILES],
      detachedMetadataTrees: [...RELEASE_DETACHED_METADATA_TREES],
      manifest: {
        relativePath: manifestRelativePath,
        installedPath: "app/release-manifest.json",
        sha256: manifestSha256,
        sizeBytes: rawManifest.length,
      },
    });
  }
  const missingTargets = REQUIRED_RUNTIME_PAYLOAD_TARGETS.filter((target) => !seenTargets.has(target));
  if (missingTargets.length > 0) {
    throw new Error(
      `Release certificate is missing required runtime manifest target(s): ${missingTargets.join(", ")}.`,
    );
  }
  return records.sort((left, right) => compareStrings(left.target, right.target));
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
    return createWorkflowRunResult("unavailable");
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
      return createWorkflowRunResult(`github-api-${response.status}`);
    }
    const payload = await response.json();
    const run = payload.workflow_runs?.[0];
    if (!run) {
      return createWorkflowRunResult("missing");
    }
    return createWorkflowRunResult(run.conclusion ?? run.status ?? "unknown", {
      conclusion: run.conclusion ?? null,
      html_url: run.html_url ?? null,
      id: run.id ?? null,
      head_sha: run.head_sha ?? null,
    });
  } catch (error) {
    return createWorkflowRunResult(`github-api-error:${error instanceof Error ? error.message : "unknown"}`);
  }
}

function createWorkflowRunResult(status, overrides = {}) {
  return {
    status,
    conclusion: null,
    html_url: null,
    id: null,
    head_sha: null,
    ...overrides,
  };
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

function summarizeRequiredLaneExactSha(requiredLanes, commit) {
  if (!commit) {
    return {
      status: "unknown",
      targetCommit: null,
      matched: 0,
      checked: 0,
      mismatched: [],
      missingProof: requiredLanes.map((lane) => lane.name),
    };
  }
  const mismatched = [];
  const missingProof = [];
  let matched = 0;
  let checked = 0;
  for (const lane of requiredLanes) {
    const proofRun = selectProofRun(lane);
    const headSha = proofRun?.headSha ?? null;
    if (!headSha) {
      missingProof.push(lane.name);
      continue;
    }
    checked += 1;
    if (headSha === commit) {
      matched += 1;
      continue;
    }
    mismatched.push({
      name: lane.name,
      proofWorkflowFile: lane.proofWorkflowFile ?? lane.workflowFile,
      proofSource: lane.proofSource,
      headSha,
    });
  }
  return {
    status: mismatched.length === 0 && missingProof.length === 0 ? "matched" : "incomplete",
    targetCommit: commit,
    matched,
    checked,
    mismatched,
    missingProof,
  };
}

function selectProofRun(lane) {
  return lane.substitutedByReleaseProof ? lane.releaseProofRun : lane.directRun;
}

function buildParityClosureVerdict({
  commit,
  requiredLanes,
  exactShaStatus,
  releaseAssets,
  proofBundle,
  hostileSandboxWindowsClaim,
}) {
  const checks = PARITY_CLOSURE_CHECKS.map((check) => {
    const lane = requiredLanes.find((item) => item.name === check.lane);
    const proofRun = lane ? selectProofRun(lane) : null;
    const exactShaMatched = Boolean(commit && proofRun?.headSha === commit);
    const status = lane?.status === "success" && exactShaMatched ? "passed" : lane ? "blocked" : "missing";
    return {
      ...check,
      status,
      laneStatus: lane?.status ?? "missing",
      workflowRunUrl: lane?.workflowRunUrl ?? null,
      proofWorkflowFile: lane?.proofWorkflowFile ?? lane?.workflowFile ?? null,
      proofSource: lane?.proofSource ?? null,
      exactShaMatched,
      proofHeadSha: proofRun?.headSha ?? null,
    };
  });
  const blockers = checks
    .filter((check) => check.required && check.status !== "passed")
    .map((check) => `${check.label}: ${check.laneStatus}`);
  if (!releaseAssets.length) {
    blockers.push("Release assets: missing");
  }
  if (!proofBundle?.sha256) {
    blockers.push("Proof bundle: missing");
  }
  if (exactShaStatus.status !== "matched") {
    blockers.push(`Exact-SHA proof: ${exactShaStatus.status}`);
  }
  if (!hostileSandboxWindowsClaim.publicClaimAllowed) {
    blockers.push("Windows hostile-sandbox public claim: not proved");
  }
  return {
    verdict: blockers.length === 0 ? "parity-ready" : "not parity-ready",
    targetCommit: commit,
    generatedFrom: "release-certificate",
    checks,
    assetCount: releaseAssets.length,
    proofBundleSha256: proofBundle?.sha256 ?? null,
    blockers,
  };
}

function buildOperatorTruthProof({ commit, requiredLanes, exactShaStatus, proofBundle }) {
  const checks = OPERATOR_TRUTH_PROOF_CHECKS.map((check) => {
    const lane = requiredLanes.find((item) => item.name === check.lane);
    const proofRun = lane ? selectProofRun(lane) : null;
    const exactShaMatched = Boolean(commit && proofRun?.headSha === commit);
    const lanePassed = lane?.status === "success" && exactShaMatched;
    const status = check.unsupportedGap ? "unsupported_gap" : lanePassed ? "passed" : lane ? "blocked" : "missing";
    return {
      ...check,
      status,
      laneStatus: lane?.status ?? "missing",
      workflowRunUrl: lane?.workflowRunUrl ?? null,
      proofWorkflowFile: lane?.proofWorkflowFile ?? lane?.workflowFile ?? null,
      proofSource: lane?.proofSource ?? null,
      exactShaMatched,
      proofHeadSha: proofRun?.headSha ?? null,
    };
  });
  const blockers = checks
    .filter((check) => check.required && check.status !== "passed")
    .map((check) => `${check.label}: ${check.laneStatus}`);
  if (exactShaStatus.status !== "matched") {
    blockers.push(`Exact-SHA proof: ${exactShaStatus.status}`);
  }
  if (!proofBundle?.sha256) {
    blockers.push("Release proof package: missing");
  }
  return {
    verdict: blockers.length === 0 ? "operator-proof-ready" : "operator-proof-blocked",
    targetCommit: commit,
    generatedFrom: "release-certificate",
    checks,
    unsupportedGaps: checks
      .filter((check) => check.status === "unsupported_gap")
      .map((check) => ({ key: check.key, label: check.label, unsupportedGap: check.unsupportedGap })),
    advisories: checks
      .filter((check) => check.advisory)
      .map((check) => ({ key: check.key, label: check.label, advisory: check.advisory })),
    proofBundleSha256: proofBundle?.sha256 ?? null,
    exactShaStatus: exactShaStatus.status,
    blockers,
  };
}

function buildHostileSandboxWindowsClaim({ commit, proof, proofPath, requiredLanes }) {
  const lane = requiredLanes.find((item) => item.name === "verify:code-mode:hostile-sandbox");
  const proofRun = lane?.substitutedByReleaseProof ? lane.releaseProofRun : lane?.directRun;
  const proofHeadSha = proofRun?.headSha ?? null;
  const exactShaMatched = Boolean(commit && proofHeadSha === commit);
  const win32Claim = proof?.claim?.platformClaims?.win32 ?? null;
  const fallbackWin32Proof = Array.isArray(proof?.claim?.platformProof)
    ? proof.claim.platformProof.find((item) => item?.platform === "win32")
    : null;
  const win32Proof = win32Claim?.proof ?? fallbackWin32Proof ?? null;
  const laneGreen = lane?.status === "success";
  const proofAllowsWindowsClaim = Boolean(win32Claim?.publicClaimAllowed);
  return {
    claimScope: "windows_appcontainer",
    aggregatePublicClaimAllowed: Boolean(proof?.claim?.publicClaimAllowed),
    publicClaimAllowed: Boolean(laneGreen && exactShaMatched && proofAllowsWindowsClaim),
    laneStatus: lane?.status ?? "missing",
    workflowRunUrl: lane?.workflowRunUrl ?? null,
    proofWorkflowFile: lane?.proofWorkflowFile ?? RELEASE_PROOF_WORKFLOW_FILE,
    proofSource: lane?.proofSource ?? "lane-workflow",
    exactSha: commit,
    proofHeadSha,
    exactShaMatched,
    proofRef: proofPath ? path.relative(repoRoot, proofPath).replaceAll("\\", "/") : null,
    currentPlatform: proof?.platform ?? null,
    currentPlatformProofStatus: proof?.currentPlatformProof?.status ?? null,
    windowsPlatformProofStatus: win32Proof?.status ?? "missing",
    checksPassed: Array.isArray(win32Proof?.checksPassed) ? win32Proof.checksPassed : [],
    checksFailed: Array.isArray(win32Proof?.checksFailed) ? win32Proof.checksFailed : [],
    blockers: win32Claim?.blockers ?? ["Windows AppContainer hostile sandbox proof artifact was not provided."],
  };
}

function readOptionalJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function listFiles(rootDir) {
  const root = path.resolve(rootDir);
  const rootStats = fs.lstatSync(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`Release artifacts root must be a regular non-link directory: ${root}`);
  }
  const canonicalRoot = fs.realpathSync.native(root);
  const files = [];
  const caseFoldedPaths = new Set();
  const queue = [root];
  let directoryCount = 0;
  while (queue.length > 0) {
    const current = queue.pop();
    directoryCount += 1;
    if (directoryCount > MAX_RELEASE_ARTIFACT_DIRECTORIES) {
      throw new Error(`Release artifacts exceed ${MAX_RELEASE_ARTIFACT_DIRECTORIES} directories.`);
    }
    assertChildOrSamePath(canonicalRoot, fs.realpathSync.native(current), "release artifacts directory");
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((left, right) => compareStrings(left.name, right.name))) {
      const absolutePath = path.join(current, entry.name);
      const stats = fs.lstatSync(absolutePath);
      const relativePath = validateReleaseAssetRelativePath(path.relative(root, absolutePath).replaceAll("\\", "/"));
      if (stats.isSymbolicLink()) {
        throw new Error(`Release artifacts cannot contain a symlink or junction: ${relativePath}`);
      }
      assertChildPath(canonicalRoot, fs.realpathSync.native(absolutePath), `release artifact ${relativePath}`);
      if (stats.isDirectory()) {
        queue.push(absolutePath);
        continue;
      }
      if (stats.isFile()) {
        if (stats.nlink !== 1) {
          throw new Error(`Release artifacts cannot contain a hard-linked file: ${relativePath}`);
        }
        const caseFoldedPath = relativePath.toLowerCase();
        if (caseFoldedPaths.has(caseFoldedPath)) {
          throw new Error(`Release artifacts contain a Windows case-fold collision: ${relativePath}`);
        }
        if (files.length >= MAX_RELEASE_ASSETS) {
          throw new Error(`Release artifacts exceed ${MAX_RELEASE_ASSETS} files.`);
        }
        caseFoldedPaths.add(caseFoldedPath);
        files.push(absolutePath);
        continue;
      }
      throw new Error(`Release artifacts cannot contain a special filesystem entry: ${relativePath}`);
    }
  }
  return files.sort((left, right) =>
    compareStrings(path.relative(root, left).replaceAll("\\", "/"), path.relative(root, right).replaceAll("\\", "/")),
  );
}

function validateReleaseAssetRelativePath(relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    Buffer.byteLength(relativePath, "utf8") > MAX_RELEASE_ASSET_PATH_BYTES ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath)
  ) {
    throw new Error(`Release artifact path is unsafe: ${String(relativePath)}`);
  }
  const segments = relativePath.split("/");
  if (
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
    throw new Error(`Release artifact path is not portable to Windows: ${relativePath}`);
  }
  return segments.join("/");
}

async function fileRecord(filePath, rootDir) {
  const stable = await hashStableRegularFile(filePath, rootDir, `release file ${path.basename(filePath)}`);
  return {
    fileName: path.basename(filePath),
    relativePath: path.relative(rootDir, filePath).replaceAll("\\", "/"),
    sha256: stable.sha256,
    sizeBytes: stable.sizeBytes,
  };
}

async function hashStableRegularFile(filePath, rootDir, label) {
  const root = path.resolve(rootDir);
  const candidate = path.resolve(filePath);
  assertAnchoredRegularFile(root, candidate, label);
  const beforePathStats = fs.lstatSync(candidate);
  const handle = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const openedStats = fs.fstatSync(handle);
    const currentPathStats = fs.lstatSync(candidate);
    assertAnchoredRegularFile(root, candidate, label);
    if (!sameFileIdentity(beforePathStats, openedStats) || !sameFileIdentity(openedStats, currentPathStats)) {
      throw new Error(`${label} changed while it was opened.`);
    }
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(candidate, { fd: handle, autoClose: false, start: 0 })) {
      hash.update(chunk);
    }
    const finalOpenedStats = fs.fstatSync(handle);
    const finalPathStats = fs.lstatSync(candidate);
    assertAnchoredRegularFile(root, candidate, label);
    if (!sameFileIdentity(openedStats, finalOpenedStats) || !sameFileIdentity(finalOpenedStats, finalPathStats)) {
      throw new Error(`${label} changed while it was hashed.`);
    }
    return { sha256: hash.digest("hex"), sizeBytes: openedStats.size };
  } finally {
    fs.closeSync(handle);
  }
}

function readBoundedRegularFile(filePath, { rootDir, maxBytes, label }) {
  const root = path.resolve(rootDir);
  const candidate = path.resolve(filePath);
  assertAnchoredRegularFile(root, candidate, label);
  const beforePathStats = fs.lstatSync(candidate);
  if (beforePathStats.size <= 0 || beforePathStats.size > maxBytes) {
    throw new Error(`${label} must be between 1 and ${maxBytes} bytes.`);
  }
  const handle = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const openedStats = fs.fstatSync(handle);
    const currentPathStats = fs.lstatSync(candidate);
    assertAnchoredRegularFile(root, candidate, label);
    if (!sameFileIdentity(beforePathStats, openedStats) || !sameFileIdentity(openedStats, currentPathStats)) {
      throw new Error(`${label} changed while it was opened.`);
    }
    const raw = fs.readFileSync(handle);
    const finalOpenedStats = fs.fstatSync(handle);
    const finalPathStats = fs.lstatSync(candidate);
    assertAnchoredRegularFile(root, candidate, label);
    if (!sameFileIdentity(openedStats, finalOpenedStats) || !sameFileIdentity(finalOpenedStats, finalPathStats)) {
      throw new Error(`${label} changed while it was read.`);
    }
    return raw;
  } finally {
    fs.closeSync(handle);
  }
}

function assertAnchoredRegularFile(rootDir, filePath, label) {
  const root = path.resolve(rootDir);
  const candidate = path.resolve(filePath);
  const rootStats = fs.lstatSync(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`${label} root must be a regular non-link directory.`);
  }
  assertChildPath(root, candidate, label);
  let cursor = root;
  for (const segment of path.relative(root, candidate).split(path.sep)) {
    cursor = path.join(cursor, segment);
    const stats = fs.lstatSync(cursor);
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} traverses a symlink or junction.`);
    }
    if (cursor !== candidate && !stats.isDirectory()) {
      throw new Error(`${label} traverses a non-directory path component.`);
    }
  }
  const candidateStats = fs.lstatSync(candidate);
  if (!candidateStats.isFile() || candidateStats.isSymbolicLink() || candidateStats.nlink !== 1) {
    throw new Error(`${label} must be a regular single-link file.`);
  }
  assertChildPath(fs.realpathSync.native(root), fs.realpathSync.native(candidate), label);
}

function assertChildPath(rootDir, candidate, label) {
  const relative = path.relative(path.resolve(rootDir), path.resolve(candidate));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its supported root.`);
  }
}

function assertChildOrSamePath(rootDir, candidate, label) {
  const relative = path.relative(path.resolve(rootDir), path.resolve(candidate));
  if (relative === "") return;
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its supported root.`);
  }
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function compareStrings(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
