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
  "verify:desktop",
  "verify:code-mode:sandbox",
  "verify:code-mode:hostile-sandbox",
  "verify:agentic:governance",
  "verify:agentic:proof",
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

const commit = process.env.GITHUB_SHA ?? args.commit ?? null;
const repository = process.env.GITHUB_REPOSITORY ?? args.repository ?? null;
const requiredLanes = await resolveRequiredLanes({ commit, repository });
const releaseAssets = await Promise.all(listFiles(artifactsDir).map((filePath) => fileRecord(filePath, artifactsDir)));
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
  schemaVersion: 1,
  product: "GoatCitadel",
  version,
  tag: tagName,
  commit,
  targetCommit: commit,
  repository,
  generatedAt: new Date().toISOString(),
  releaseWorkflow: {
    name: process.env.GITHUB_WORKFLOW ?? "Release Installers and Bundles",
    runId: process.env.GITHUB_RUN_ID ?? null,
    runNumber: process.env.GITHUB_RUN_NUMBER ?? null,
    runUrl:
      repository && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : null,
  },
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

async function fileRecord(filePath, rootDir) {
  return {
    fileName: path.basename(filePath),
    relativePath: path.relative(rootDir, filePath).replaceAll("\\", "/"),
    sha256: await sha256File(filePath),
    sizeBytes: fs.statSync(filePath).size,
  };
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}
