import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { resolveLaneProof } from "./release-certificate-proof.mjs";

const spec = {
  name: "verify:runtime:truth",
  workflowFile: "verification-1-0-release-proof.yml",
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
  assert.match(writer, /\{ name: "verify:fast", workflowFile: "verification-fast\.yml", required: true \}/);
});

test("release proof requires measured orchestration performance", () => {
  const writer = fs.readFileSync(new URL("./write-release-certificate.mjs", import.meta.url), "utf8");
  const workflow = fs.readFileSync(
    new URL("../../.github/workflows/verification-1-0-release-proof.yml", import.meta.url),
    "utf8",
  );
  assert.match(writer, /"verify:orchestration:perf"/);
  assert.match(
    writer,
    /\{ name: "verify:orchestration:perf", workflowFile: RELEASE_PROOF_WORKFLOW_FILE, required: true \}/,
  );
  assert.match(workflow, /laneScript:\s*verify:orchestration:perf/);
});

test("release certificate records additive exact-SHA summary fields", () => {
  const writer = fs.readFileSync(new URL("./write-release-certificate.mjs", import.meta.url), "utf8");
  assert.match(writer, /targetCommit:\s*commit/);
  assert.match(writer, /const exactShaStatus = summarizeRequiredLaneExactSha\(requiredLanes,\s*commit\)/);
  assert.match(writer, /exactShaStatus,/);
  assert.match(writer, /function summarizeRequiredLaneExactSha\(requiredLanes,\s*commit\)/);
  assert.match(writer, /status:\s*mismatched\.length === 0 && missingProof\.length === 0 \? "matched" : "incomplete"/);
});

test("release certificate records parity closure gates for top 1.0 parity gaps", () => {
  const writer = fs.readFileSync(new URL("./write-release-certificate.mjs", import.meta.url), "utf8");
  const coveredBlock = writer.match(/const RELEASE_PROOF_COVERED_LANES = \[([\s\S]*?)\];/);
  assert.ok(coveredBlock, "release proof covered lane list should be present");
  for (const lane of [
    "verify:desktop",
    "verify:channels:runtime",
    "verify:extensions:package",
    "verify:operator:proof",
    "verify:durable:recovery",
    "verify:runtime:truth",
    "verify:memory:truth",
    "verify:surface:regression",
  ]) {
    assert.match(writer, new RegExp(`lane: "${lane}"`));
  }
  assert.match(coveredBlock[1], /"verify:desktop"/);
  assert.match(coveredBlock[1], /"verify:channels:runtime"/);
  assert.match(coveredBlock[1], /"verify:extensions:package"/);
  assert.match(writer, /parityClosure:\s*buildParityClosureVerdict/);
  assert.match(writer, /coveredCommand:\s*"verify:install"/);
  assert.match(writer, /verdict:\s*blockers\.length === 0 \? "parity-ready" : "not parity-ready"/);

  const workflow = fs.readFileSync(
    new URL("../../.github/workflows/verification-1-0-release-proof.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /laneScript:\s*verify:desktop/);
  assert.match(workflow, /laneScript:\s*verify:channels:runtime/);
  assert.match(workflow, /laneScript:\s*verify:extensions:package/);
});

test("every release-proof matrix lane produces verification-context artifacts", () => {
  const workflow = fs.readFileSync(
    new URL("../../.github/workflows/verification-1-0-release-proof.yml", import.meta.url),
    "utf8",
  );
  const packageJson = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const laneScripts = [...workflow.matchAll(/laneScript:\s*([^\s#]+)/g)].map((match) => match[1]);

  assert.ok(laneScripts.length > 0, "release-proof matrix should declare lane scripts");
  for (const laneScript of laneScripts) {
    const command = packageJson.scripts?.[laneScript];
    assert.equal(typeof command, "string", `${laneScript} should exist in package.json`);
    assert.match(
      command,
      /scripts\/verification\/run\.mjs/,
      `${laneScript} must create a verification manifest before review and artifact upload`,
    );
  }
});

test("repository hygiene discovers every tracked script test", () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.match(packageJson.scripts["verify:repo:hygiene"], /scripts\/\*\*\/\*\.test\.mjs/);
});

test("eslint audits verification, packaging, and release modules", () => {
  const config = fs.readFileSync(new URL("../../eslint.config.mjs", import.meta.url), "utf8");
  const ignores = config.match(/ignores:\s*\[([\s\S]*?)\]/)?.[1] ?? "";
  assert.doesNotMatch(ignores, /"\*\*\/\*\.mjs"/);
  assert.doesNotMatch(ignores, /"\*\*\/\*\.cjs"/);
  assert.match(config, /files:\s*\["\*\*\/\*\.mjs", "\*\*\/\*\.cjs"\]/);
  assert.match(config, /"@typescript-eslint\/no-unused-vars": \[\s*"error"/);
  assert.match(config, /"scripts\/verification\/lib\/scenarios\/\*\*\/\*\.mjs"/);
});

test("release certificate records operator truth proof and provider metadata gaps", () => {
  const writer = fs.readFileSync(new URL("./write-release-certificate.mjs", import.meta.url), "utf8");
  assert.match(writer, /const OPERATOR_TRUTH_PROOF_CHECKS = \[/);
  assert.match(writer, /runtime_decision_traces\.kind=capability_profile_frozen/);
  assert.match(writer, /Capability catalog snapshot and runtime decision evidence/);
  assert.match(writer, /Library Skills trust and doctor signals/);
  assert.match(writer, /Memory provenance summary/);
  assert.match(writer, /Release certificate and package proof scripts/);
  assert.match(writer, /Provider metadata refresh/);
  assert.match(writer, /unsupportedGap:/);
  assert.match(writer, /instead of adding a provider family/);
  assert.match(writer, /operatorTruthProof:\s*buildOperatorTruthProof/);
  assert.match(writer, /verdict:\s*blockers\.length === 0 \? "operator-proof-ready" : "operator-proof-blocked"/);
});

test("release certificate requires hostile sandbox proof from the exact-SHA release lane", () => {
  const writer = fs.readFileSync(new URL("./write-release-certificate.mjs", import.meta.url), "utf8");
  const coveredBlock = writer.match(/const RELEASE_PROOF_COVERED_LANES = \[([\s\S]*?)\];/);
  assert.ok(coveredBlock, "release proof covered lane list should be present");
  assert.match(coveredBlock[1], /"verify:code-mode:hostile-sandbox"/);
  assert.match(
    writer,
    /\{ name: "verify:code-mode:hostile-sandbox", workflowFile: RELEASE_PROOF_WORKFLOW_FILE, required: true \}/,
  );
  assert.match(writer, /--hostile-sandbox-proof/);
  assert.match(writer, /hostileSandboxWindowsClaim/);
  assert.match(writer, /platformClaims\?\.win32/);
  assert.match(writer, /exactShaMatched/);
});

test("release certificate covers A2A full through the umbrella release proof", () => {
  const writer = fs.readFileSync(new URL("./write-release-certificate.mjs", import.meta.url), "utf8");
  const coveredBlock = writer.match(/const RELEASE_PROOF_COVERED_LANES = \[([\s\S]*?)\];/);
  assert.ok(coveredBlock, "release proof covered lane list should be present");
  assert.match(coveredBlock[1], /"verify:a2a:full"/);
  assert.match(writer, /\{ name: "verify:a2a:full", workflowFile: RELEASE_PROOF_WORKFLOW_FILE, required: true \}/);

  const workflow = fs.readFileSync(
    new URL("../../.github/workflows/verification-1-0-release-proof.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /name:\s*Verification 1\.0 Release Proof/);
  assert.match(workflow, /laneScript:\s*verify:a2a:full/);
  assert.match(workflow, /if-no-files-found:\s*error/);

  const releaseWorkflow = fs.readFileSync(
    new URL("../../.github/workflows/release-installers.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(releaseWorkflow, /--workflow verification-a2a-full\.yml/);
  assert.match(releaseWorkflow, /--workflow verification-fast\.yml/);
  assert.match(releaseWorkflow, /--workflow security-trivy\.yml/);
});

test("release package metadata locks release and packaging scripts with fail-closed commands", () => {
  const assembler = fs.readFileSync(new URL("./assemble-release-package.mjs", import.meta.url), "utf8");
  assert.match(assembler, /lockedInputDigests/);
  assert.match(assembler, /const lockedInputs = await buildLockedInputRecords\(\)/);
  assert.match(assembler, /buildSlsaAttestation\(\{[\s\S]*lockedInputs/);
  assert.match(assembler, /scripts\/packaging/);
  assert.match(assembler, /scripts\/release/);
  assert.match(assembler, /wait-for-release-proof\.mjs --repository <owner\/repo> --commit <commit-sha>/);
  assert.match(assembler, /write-release-certificate\.mjs --version <version> --tag <tag>[\s\S]*--require-success/);
});

test("release artifact signing includes package identity, macOS DMGs, and Linux tarballs", () => {
  const signer = fs.readFileSync(new URL("./sign-release-artifacts.mjs", import.meta.url), "utf8");
  const assembler = fs.readFileSync(new URL("./assemble-release-package.mjs", import.meta.url), "utf8");
  assert.match(signer, /entry\.name\.endsWith\("\.msix"\)/);
  assert.match(signer, /entry\.name\.endsWith\("\.dmg"\)/);
  assert.match(signer, /entry\.name\.endsWith\("\.tar\.gz"\)/);
  assert.match(assembler, /entry\.name\.endsWith\("\.msix"\)/);
  assert.match(assembler, /package:windows-msix --cert-path <pfx> --cert-password <password>/);
  assert.match(signer, /!result\.error && result\.status === 0/);
});

test("release artifact hashes stream large files instead of buffering them", () => {
  const writer = fs.readFileSync(new URL("./write-release-certificate.mjs", import.meta.url), "utf8");
  const assembler = fs.readFileSync(new URL("./assemble-release-package.mjs", import.meta.url), "utf8");

  assert.match(writer, /for await \(const chunk of fs\.createReadStream\(filePath\)\)/);
  assert.match(assembler, /for await \(const chunk of fs\.createReadStream\(filePath\)\)/);
  assert.doesNotMatch(writer, /createHash\("sha256"\)\.update\(fs\.readFileSync\(filePath\)\)/);
  assert.doesNotMatch(assembler, /createHash\("sha256"\)\.update\(fs\.readFileSync\(filePath\)\)/);
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
