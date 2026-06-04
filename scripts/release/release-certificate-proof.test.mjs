import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { resolveLaneProof } from "./release-certificate-proof.mjs";

const spec = {
  name: "verify:runtime:truth",
  workflowFile: "verification-truth-lanes.yml",
  required: true,
  releaseProofCovered: true,
};

const releaseProofRun = {
  status: "success",
  conclusion: "success",
  html_url: "https://example.test/release-proof",
  id: 10,
  head_sha: "abc123",
};

test("does not hide an exact-SHA direct lane failure behind umbrella release proof", () => {
  const lane = resolveLaneProof({
    spec,
    directRun: {
      status: "failure",
      conclusion: "failure",
      html_url: "https://example.test/direct-failure",
      id: 11,
      head_sha: "abc123",
    },
    releaseProofRun,
    releaseProofWorkflowFile: "verification-1-0-release-proof.yml",
    targetCommit: "abc123",
  });

  assert.equal(lane.status, "failure");
  assert.equal(lane.proofSource, "lane-workflow");
  assert.equal(lane.substitutedByReleaseProof, false);
  assert.equal(lane.directRun.workflowRunUrl, "https://example.test/direct-failure");
});

test("allows exact-SHA umbrella proof to cover an unavailable direct lane", () => {
  const lane = resolveLaneProof({
    spec,
    directRun: {
      status: "missing",
      conclusion: null,
      html_url: null,
      id: null,
      head_sha: null,
    },
    releaseProofRun,
    releaseProofWorkflowFile: "verification-1-0-release-proof.yml",
    targetCommit: "abc123",
  });

  assert.equal(lane.status, "success");
  assert.equal(lane.proofSource, "release-proof");
  assert.equal(lane.substitutedByReleaseProof, true);
  assert.equal(lane.releaseProofRun.workflowRunUrl, "https://example.test/release-proof");
});

test("does not use an umbrella proof from a different commit", () => {
  const lane = resolveLaneProof({
    spec,
    directRun: {
      status: "missing",
      conclusion: null,
      html_url: null,
      id: null,
      head_sha: null,
    },
    releaseProofRun: {
      ...releaseProofRun,
      head_sha: "other-sha",
    },
    releaseProofWorkflowFile: "verification-1-0-release-proof.yml",
    targetCommit: "abc123",
  });

  assert.equal(lane.status, "missing");
  assert.equal(lane.proofSource, "lane-workflow");
  assert.equal(lane.substitutedByReleaseProof, false);
});

test("keeps direct-only lanes on their direct workflow even when umbrella proof succeeded", () => {
  const lane = resolveLaneProof({
    spec: {
      name: "verify:fast",
      workflowFile: "verification-fast.yml",
      required: true,
      releaseProofCovered: false,
    },
    directRun: {
      status: "missing",
      conclusion: null,
      html_url: null,
      id: null,
      head_sha: null,
    },
    releaseProofRun,
    releaseProofWorkflowFile: "verification-1-0-release-proof.yml",
    targetCommit: "abc123",
  });

  assert.equal(lane.status, "missing");
  assert.equal(lane.proofSource, "lane-workflow");
  assert.equal(lane.substitutedByReleaseProof, false);
  assert.equal(lane.releaseProofRun, null);
});

test("release certificate treats verify:fast as direct-only proof", () => {
  const writer = fs.readFileSync(new URL("./write-release-certificate.mjs", import.meta.url), "utf8");
  const coveredBlock = writer.match(/const RELEASE_PROOF_COVERED_LANES = \[([\s\S]*?)\];/);
  assert.ok(coveredBlock, "release proof covered lane list should be present");
  assert.doesNotMatch(coveredBlock[1], /"verify:fast"/);
  assert.match(
    writer,
    /\{ name: "verify:fast", workflowFile: "verification-fast\.yml", required: true \}/,
  );
});

test("release certificate requires hostile sandbox proof from the exact-SHA release lane", () => {
  const writer = fs.readFileSync(new URL("./write-release-certificate.mjs", import.meta.url), "utf8");
  const coveredBlock = writer.match(/const RELEASE_PROOF_COVERED_LANES = \[([\s\S]*?)\];/);
  assert.ok(coveredBlock, "release proof covered lane list should be present");
  assert.match(coveredBlock[1], /"verify:code-mode:hostile-sandbox"/);
  assert.match(
    writer,
    /\{ name: "verify:code-mode:hostile-sandbox", workflowFile: "verification-agentic-code-mode\.yml", required: true \}/,
  );
  assert.match(writer, /--hostile-sandbox-proof/);
  assert.match(writer, /hostileSandboxWindowsClaim/);
  assert.match(writer, /platformClaims\?\.win32/);
  assert.match(writer, /exactShaMatched/);
});

test("release certificate requires direct exact-SHA A2A full proof", () => {
  const writer = fs.readFileSync(new URL("./write-release-certificate.mjs", import.meta.url), "utf8");
  const coveredBlock = writer.match(/const RELEASE_PROOF_COVERED_LANES = \[([\s\S]*?)\];/);
  assert.ok(coveredBlock, "release proof covered lane list should be present");
  assert.doesNotMatch(coveredBlock[1], /"verify:a2a:full"/);
  assert.match(
    writer,
    /\{ name: "verify:a2a:full", workflowFile: "verification-a2a-full\.yml", required: true \}/,
  );

  const workflow = fs.readFileSync(new URL("../../.github/workflows/verification-a2a-full.yml", import.meta.url), "utf8");
  assert.match(workflow, /name:\s*Verification A2A Full/);
  assert.match(workflow, /run:\s*pnpm verify:a2a:full/);
  assert.match(workflow, /if-no-files-found:\s*error/);

  const releaseWorkflow = fs.readFileSync(
    new URL("../../.github/workflows/release-installers.yml", import.meta.url),
    "utf8",
  );
  assert.match(releaseWorkflow, /--workflow verification-a2a-full\.yml/);
});

test("release package metadata locks release and packaging scripts with fail-closed commands", () => {
  const assembler = fs.readFileSync(new URL("./assemble-release-package.mjs", import.meta.url), "utf8");
  assert.match(assembler, /lockedInputDigests/);
  assert.match(assembler, /scripts\/packaging/);
  assert.match(assembler, /scripts\/release/);
  assert.match(assembler, /wait-for-release-proof\.mjs --repository <owner\/repo> --commit <commit-sha>/);
  assert.match(assembler, /write-release-certificate\.mjs --version <version> --tag <tag>[\s\S]*--require-success/);
});

test("release artifact signing includes macOS DMGs and Linux tarballs", () => {
  const signer = fs.readFileSync(new URL("./sign-release-artifacts.mjs", import.meta.url), "utf8");
  assert.match(signer, /entry\.name\.endsWith\("\.dmg"\)/);
  assert.match(signer, /entry\.name\.endsWith\("\.tar\.gz"\)/);
});

test("release package carries security triage docs with package-relative links", () => {
  const assembler = fs.readFileSync(new URL("./assemble-release-package.mjs", import.meta.url), "utf8");
  assert.match(assembler, /AGENTS\.md/);
  assert.match(assembler, /docs["']?,\s*["']security["']?,\s*["']findings-triage\.md/);
  assert.match(assembler, /security\/findings-triage\.md/);
  assert.match(assembler, /docs\/security\/findings-triage\.md/);
  assert.match(assembler, /\.\.\/SECURITY\.md/);
  assert.match(assembler, /\.\.\/AGENTS\.md/);
  assert.match(assembler, /github\.com\/goatcitadel\/GoatCitadel\/blob/);
});

test("verification workflows fail closed when proof artifacts are missing", () => {
  const workflowsDir = new URL("../../.github/workflows/", import.meta.url);
  const workflowFiles = fs
    .readdirSync(workflowsDir)
    .filter((entry) => /^verification-.*\.yml$/u.test(entry))
    .map((entry) => [entry, fs.readFileSync(new URL(entry, workflowsDir), "utf8")])
    .filter(([, content]) => /path:\s*artifacts\/verification/.test(content));

  assert.ok(workflowFiles.length > 0, "verification artifact workflows should be present");
  for (const [workflowFile, content] of workflowFiles) {
    assert.doesNotMatch(content, /if-no-files-found:\s*ignore/, workflowFile);
    assert.match(content, /if-no-files-found:\s*error/, workflowFile);
  }
});
