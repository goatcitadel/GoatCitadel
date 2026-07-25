import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

const MATERIAL_RELEASE_COMMAND_MARKERS = [
  "signtool sign /fd SHA256 /f <pfx>",
  "signtool verify /pa component-input/GoatCitadel-Mission-Control-Windows.exe",
  "pnpm package:bundle --target linux-x64 --skip-desktop",
  'tar -czf "<linux-tar>"',
  'sha256sum -c "<linux-tar>.sha256"',
  "codesign --verify --deep --strict --verbose=2",
  'xcrun stapler staple "$OUTPUT_DMG"',
  'xcrun stapler validate "$OUTPUT_DMG"',
  'hdiutil verify "$OUTPUT_DMG"',
  'shasum -a 256 "$OUTPUT_DMG" > "$OUTPUT_DMG.sha256"',
  "FETCH_LICENSE=false CDXGEN_FETCH_PKG_METADATA=false env -u NODE_PATH node node_modules/@cyclonedx/cdxgen/bin/cdxgen.js",
  "node scripts/release/assemble-release-package.mjs --version <version> --tag <tag>",
  "--workflow verification-fast.yml --timeout-ms 7200000",
  "--workflow security-trivy.yml --timeout-ms 7200000",
  "cosign sign-blob --yes --bundle artifacts/release/release-certificate.sigstore.json artifacts/release/release-certificate.json",
  "node scripts/release/assemble-runtime-release-evidence.mjs --certificate artifacts/release/release-certificate.json",
  "--attestation artifacts/release/release-certificate.sigstore.json",
  "--installer windows-x64=release-artifacts/windows-x64-release-assets/GoatCitadel-Setup-windows-x64.exe",
  "--installer windows-arm64=release-artifacts/windows-arm64-release-assets/GoatCitadel-Setup-windows-arm64.exe",
];

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
  const releaseDocs = fs.readFileSync(new URL("../../docs/reproducible-release.md", import.meta.url), "utf8");
  const releaseWorkflow = fs.readFileSync(
    new URL("../../.github/workflows/release-installers.yml", import.meta.url),
    "utf8",
  );
  assert.match(assembler, /lockedInputDigests/);
  assert.match(assembler, /const lockedInputs = await buildLockedInputRecords\(\)/);
  assert.match(assembler, /buildSlsaAttestation\(\{[\s\S]*lockedInputs/);
  assert.match(assembler, /scripts\/packaging/);
  assert.match(assembler, /scripts\/release/);
  assert.match(assembler, /wait-for-release-proof\.mjs --repository <owner\/repo> --commit <commit-sha>/);
  const certificateCommandPattern =
    /write-release-certificate\.mjs --version <version> --tag <tag> --artifacts-dir <(?:dir|artifact-dir)> --runtime-manifest windows-x64=<(?:dir|artifact-dir)>\/windows-x64-release-assets\/app\/release-manifest\.json --runtime-manifest windows-arm64=<(?:dir|artifact-dir)>\/windows-arm64-release-assets\/app\/release-manifest\.json --proof-zip <(?:zip|zip-path)> --out-file <(?:certificate|certificate-path)> --require-success/;
  assert.match(assembler, certificateCommandPattern);
  assert.match(releaseDocs, certificateCommandPattern);
  assert.match(
    assembler,
    /cosign sign-blob --yes --output-signature \$\{artifactPath\}\.sig --output-certificate \$\{artifactPath\}\.pem \$\{artifactPath\}/,
  );
  assert.match(
    assembler,
    /cosign verify-blob --signature \$\{artifactPath\}\.sig --certificate \$\{artifactPath\}\.pem --certificate-oidc-issuer https:\/\/token\.actions\.githubusercontent\.com --certificate-identity <workflow-ref>[\s\S]*?--certificate-github-workflow-trigger push \$\{artifactPath\}/,
  );
  assert.match(assembler, /fixedSignedArtifactPaths\(input\.version\)\.flatMap/);
  assert.doesNotMatch(assembler, /node scripts\/release\/sign-release-artifacts\.mjs --artifacts-dir <dir>/);
  assert.doesNotMatch(releaseDocs, /node scripts\/release\/sign-release-artifacts\.mjs/);
  assert.match(releaseDocs, /cosign sign-blob --yes --output-signature <fixed-release-asset>\.sig/);
  for (const marker of MATERIAL_RELEASE_COMMAND_MARKERS) {
    assert.ok(assembler.includes(marker), `release metadata is missing material command marker: ${marker}`);
    assert.ok(releaseDocs.includes(marker), `release docs are missing material command marker: ${marker}`);
  }
  assert.match(
    releaseDocs,
    /cosign verify-blob --signature <fixed-release-asset>\.sig[^\n]*--certificate-github-workflow-name "Release Installers and Bundles"[^\n]*--certificate-github-workflow-ref <tag-ref>[^\n]*--certificate-github-workflow-repository goatcitadel\/GoatCitadel[^\n]*--certificate-github-workflow-sha <commit-sha>[^\n]*--certificate-github-workflow-trigger push <fixed-release-asset>/,
  );
  assert.match(
    releaseDocs,
    /cosign verify-blob --bundle artifacts\/release\/release-certificate\.sigstore\.json[^\n]*--certificate-github-workflow-name "Release Installers and Bundles"[^\n]*--certificate-github-workflow-ref <tag-ref>[^\n]*--certificate-github-workflow-repository goatcitadel\/GoatCitadel[^\n]*--certificate-github-workflow-sha <commit-sha>[^\n]*--certificate-github-workflow-trigger push artifacts\/release\/release-certificate\.json/,
  );
  assert.match(
    releaseDocs,
    /Set `<workflow-ref>` to the full fixed identity `https:\/\/github\.com\/goatcitadel\/GoatCitadel\/\.github\/workflows\/release-installers\.yml@refs\/tags\/<tag>`/,
  );
  assert.match(
    releaseWorkflow,
    /FETCH_LICENSE: "false"[\s\S]*?CDXGEN_FETCH_PKG_METADATA: "false"[\s\S]*?env -u NODE_PATH node node_modules\/@cyclonedx\/cdxgen\/bin\/cdxgen\.js/,
  );
  assert.match(
    releaseWorkflow,
    /assemble-release-package\.mjs[\s\S]*?--version "\$RELEASE_TAG"[\s\S]*?--tag "\$RELEASE_TAG"/,
  );
  assert.match(
    releaseWorkflow,
    /IDENTITY="https:\/\/github\.com\/goatcitadel\/GoatCitadel\/\.github\/workflows\/release-installers\.yml@refs\/tags\/\$\{RELEASE_TAG\}"/,
  );
});

test("release package preserves six exact signed artifact identities without basename collisions", (t) => {
  const fixture = makeReleasePackageFixture(t);
  let result = runReleasePackageAssembler(fixture);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const releaseRoot = path.join(fixture.outDir, "release-v1.0.0");
  for (const relativePath of fixedSignedArtifactFixturePaths()) {
    const packagedPath = path.join(releaseRoot, "artifact", ...relativePath.split("/"));
    assert.equal(fs.readFileSync(packagedPath, "utf8"), `artifact:${relativePath}\n`);
    for (const suffix of [".sha256", ".sig", ".pem"]) {
      assert.ok(fs.existsSync(`${packagedPath}${suffix}`));
    }
  }
  const metadata = JSON.parse(fs.readFileSync(path.join(releaseRoot, "provenance", "build-metadata.json"), "utf8"));
  assert.equal(metadata.artifacts.length, 6);
  assert.equal(new Set(metadata.artifacts.map((record) => record.relativePath)).size, 6);
  assert.equal(
    metadata.buildCommands.filter((command) => command.startsWith("cosign sign-blob --yes --output-signature")).length,
    6,
  );
  const certificateCommand = metadata.buildCommands.find((command) =>
    command.startsWith("node scripts/release/write-release-certificate.mjs "),
  );
  assert.match(
    certificateCommand,
    /--runtime-manifest windows-x64=<dir>\/windows-x64-release-assets\/app\/release-manifest\.json/,
  );
  assert.match(
    certificateCommand,
    /--runtime-manifest windows-arm64=<dir>\/windows-arm64-release-assets\/app\/release-manifest\.json/,
  );
  const emittedCommands = metadata.buildCommands.join("\n");
  for (const marker of MATERIAL_RELEASE_COMMAND_MARKERS) {
    assert.ok(emittedCommands.includes(marker), `generated metadata is missing material command marker: ${marker}`);
  }

  fs.writeFileSync(path.join(fixture.artifactsDir, "rogue.exe"), "rogue\n");
  result = runReleasePackageAssembler({ ...fixture, outDir: path.join(fixture.root, "rogue-output") });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exactly the fixed signed artifact set/i);
});

test("release artifact signing includes package identity, macOS DMGs, and Linux tarballs", () => {
  const signer = fs.readFileSync(new URL("./sign-release-artifacts.mjs", import.meta.url), "utf8");
  const assembler = fs.readFileSync(new URL("./assemble-release-package.mjs", import.meta.url), "utf8");
  assert.match(signer, /entry\.name\.endsWith\("\.msix"\)/);
  assert.match(signer, /entry\.name\.endsWith\("\.dmg"\)/);
  assert.match(signer, /entry\.name\.endsWith\("\.tar\.gz"\)/);
  assert.match(assembler, /entry\.name\.endsWith\("\.msix"\)/);
  assert.match(assembler, /package:windows-msix --allow-unsigned/);
  assert.match(assembler, /signtool sign \/fd SHA256[\s\S]*component-input\/GoatCitadel-Mission-Control-Windows\.exe/);
  assert.match(assembler, /signtool sign \/fd SHA256[\s\S]*installer-input\/GoatCitadel-Setup-<windows-target>\.exe/);
  assert.match(assembler, /codesign --force --deep --options runtime/);
  assert.match(assembler, /xcrun notarytool submit/);
  assert.match(signer, /!result\.error && result\.status === 0/);
});

test("release artifact hashes stream large files instead of buffering them", () => {
  const writer = fs.readFileSync(new URL("./write-release-certificate.mjs", import.meta.url), "utf8");
  const assembler = fs.readFileSync(new URL("./assemble-release-package.mjs", import.meta.url), "utf8");

  assert.match(
    writer,
    /for await \(const chunk of fs\.createReadStream\(candidate, \{ fd: handle, autoClose: false, start: 0 \}\)\)/,
  );
  assert.match(writer, /fs\.constants\.O_NOFOLLOW/);
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

test("runtime release identity validates the same required lane set as the certificate writer", () => {
  const writer = fs.readFileSync(new URL("./write-release-certificate.mjs", import.meta.url), "utf8");
  const runtimeIdentity = fs.readFileSync(
    new URL("../../apps/gateway/src/services/review-readiness-service.ts", import.meta.url),
    "utf8",
  );
  const writerBlock = writer.match(/const REQUIRED_LANE_SPECS = \[([\s\S]*?)\]\.map/)?.[1];
  const runtimeBlock = runtimeIdentity.match(
    /export const REQUIRED_RELEASE_PROOF_LANE_NAMES = \[([\s\S]*?)\] as const/,
  )?.[1];
  assert.ok(writerBlock, "certificate writer required-lane contract should be readable");
  assert.ok(runtimeBlock, "runtime identity required-lane contract should be readable");
  const writerNames = [...writerBlock.matchAll(/name:\s*"([^"]+)"/g)].map((match) => match[1]).sort();
  const runtimeNames = [...runtimeBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(runtimeNames, writerNames);
});

test("release workflow publishes target manifests in deterministic release-asset layouts", () => {
  const workflow = fs.readFileSync(new URL("../../.github/workflows/release-installers.yml", import.meta.url), "utf8");

  assert.match(workflow, /Stage Windows release assets with target manifest/);
  assert.match(
    workflow,
    /artifacts\/installers\/bundles\/GoatCitadel-\$packageVersion-\$\{\{ matrix\.target \}\}\/app\/release-manifest\.json/,
  );
  assert.match(
    workflow,
    /Copy-Item -LiteralPath \$bundleManifest -Destination "\$assetRoot\/app\/release-manifest\.json"/,
  );
  assert.match(workflow, /path: artifacts\/release-assets\/\$\{\{ matrix\.target \}\}\//);
  assert.match(workflow, /release-artifacts\/windows-x64-release-assets\/app\/release-manifest\.json/);
  assert.match(workflow, /release-artifacts\/windows-arm64-release-assets\/app\/release-manifest\.json/);
});

test("public release workflow gates the exact tag identity and verifies the certificate bundle", () => {
  const workflow = fs.readFileSync(new URL("../../.github/workflows/release-installers.yml", import.meta.url), "utf8");

  assert.match(workflow, /test "\$GITHUB_EVENT_NAME" = "push"/);
  assert.match(workflow, /test "\$GITHUB_REF" = "refs\/tags\/\$\{RELEASE_TAG\}"/);
  assert.match(workflow, /\^v\[0-9\]\[0-9A-Za-z\.\+-\]\{0,79\}\$/);
  assert.match(workflow, /"\$RELEASE_TAG" == \*"\.\."\*/);
  assert.match(workflow, /sigstore\/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6/);
  assert.match(
    workflow,
    /cosign sign-blob --yes[\s\\]*--bundle artifacts\/release\/release-certificate\.sigstore\.json[\s\\]*artifacts\/release\/release-certificate\.json/,
  );
  assert.match(workflow, /--certificate-oidc-issuer https:\/\/token\.actions\.githubusercontent\.com/);
  assert.match(
    workflow,
    /--certificate-identity "https:\/\/github\.com\/goatcitadel\/GoatCitadel\/\.github\/workflows\/release-installers\.yml@refs\/tags\/\$\{RELEASE_TAG\}"/,
  );
  for (const claim of [
    "certificate-github-workflow-name",
    "certificate-github-workflow-ref",
    "certificate-github-workflow-repository",
    "certificate-github-workflow-sha",
    "certificate-github-workflow-trigger",
  ]) {
    assert.match(workflow, new RegExp(`--${claim}`));
  }
  assert.match(
    workflow,
    /--certificate-github-workflow-trigger "push"[\s\\]*artifacts\/release\/release-certificate\.json/,
  );
});

test("release workflow publishes a non-circular attested evidence sidecar and verified installer layouts", () => {
  const workflow = fs.readFileSync(new URL("../../.github/workflows/release-installers.yml", import.meta.url), "utf8");
  const assembler = fs.readFileSync(new URL("./assemble-runtime-release-evidence.mjs", import.meta.url), "utf8");

  assert.match(workflow, /Write commit-bound release certificate[\s\S]*Assemble runtime release evidence/);
  assert.match(workflow, /assemble-runtime-release-evidence\.mjs/);
  assert.match(workflow, /--attestation artifacts\/release\/release-certificate\.sigstore\.json/);
  assert.match(
    workflow,
    /--installer "windows-x64=release-artifacts\/windows-x64-release-assets\/GoatCitadel-Setup-windows-x64\.exe"/,
  );
  assert.doesNotMatch(workflow, /artifacts\/release\/package\/\*\.zip/);
  for (const expectedArchive of [
    "release-package.zip",
    "release-evidence.zip",
    "windows-x64-verified.zip",
    "windows-arm64-verified.zip",
  ]) {
    assert.match(workflow, new RegExp(expectedArchive.replaceAll(".", "\\.")));
  }
  assert.match(workflow, /artifacts\/release\/release-certificate\.sigstore\.json/);
  assert.match(assembler, /release-evidence/);
  assert.match(assembler, /release-certificate\.sigstore\.json/);
  assert.match(assembler, /MAX_ATTESTATION_BYTES/);
  assert.match(assembler, /release-assets/);
  assert.match(assembler, /proof-bundle/);
  assert.match(assembler, /await verifyRecord\(sourcePath/);
  assert.match(assembler, /verifiedAssetPaths\.has\(installerPath\)/);
  assert.match(assembler, /writeInstalledReleaseEvidenceSidecar/);
  assert.doesNotMatch(assembler, /fs\.cpSync\(evidenceDir/);
});

test("release certificate schema v2 binds clean target manifests from the exact release asset paths", (t) => {
  const fixture = makeCertificateWriterFixture(t);
  const result = runCertificateWriter(fixture);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const certificate = JSON.parse(fs.readFileSync(fixture.outFile, "utf8"));
  assert.equal(certificate.schemaVersion, 2);
  assert.equal(certificate.releaseWorkflow.trustEligible, true);
  assert.equal(certificate.releaseWorkflow.workflowFile, ".github/workflows/release-installers.yml");
  assert.deepEqual(Object.keys(certificate.releaseWorkflow).sort(), [
    "eventName",
    "name",
    "ref",
    "sha",
    "trustEligible",
    "workflowFile",
    "workflowRef",
  ]);
  assert.deepEqual(
    certificate.runtimePayloads.map((payload) => payload.target),
    ["windows-arm64", "windows-x64"],
  );
  for (const payload of certificate.runtimePayloads) {
    assert.deepEqual(payload.immutableRoots, ["app", "bin"]);
    assert.deepEqual(payload.detachedMetadataFiles, ["app/release-manifest.json"]);
    assert.deepEqual(payload.detachedMetadataTrees, ["app/release-evidence"]);
    assert.equal(payload.manifest.installedPath, "app/release-manifest.json");
    assert.match(
      payload.manifest.relativePath,
      new RegExp(`^${payload.target}-release-assets/app/release-manifest\\.json$`),
    );
    const asset = certificate.releaseAssets.find((record) => record.relativePath === payload.manifest.relativePath);
    assert.equal(payload.manifest.sha256, asset.sha256);
    assert.equal(payload.manifest.sizeBytes, asset.sizeBytes);
  }
});

test("release certificate rejects duplicate targets, dirty manifests, and target metadata mismatches", (t) => {
  const duplicate = makeCertificateWriterFixture(t, "duplicate");
  let result = runCertificateWriter(duplicate, {
    runtimeManifests: [
      ["windows-x64", duplicate.manifests["windows-x64"]],
      ["windows-x64", duplicate.manifests["windows-x64"]],
      ["windows-arm64", duplicate.manifests["windows-arm64"]],
    ],
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Duplicate runtime manifest target/i);

  const dirty = makeCertificateWriterFixture(t, "dirty", { dirtyTarget: "windows-x64" });
  result = runCertificateWriter(dirty);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /modified source/i);

  const mismatch = makeCertificateWriterFixture(t, "mismatch", { platformMismatchTarget: "windows-arm64" });
  result = runCertificateWriter(mismatch);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /platform\/arch/i);
});

test("release certificate rejects non-push and wrong-workflow publisher contexts", (t) => {
  const fixture = makeCertificateWriterFixture(t);
  let result = runCertificateWriter(fixture, { env: { GITHUB_EVENT_NAME: "workflow_dispatch" } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GITHUB_EVENT_NAME=push/i);

  result = runCertificateWriter(fixture, { env: { GITHUB_WORKFLOW: "Untrusted Workflow" } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GITHUB_WORKFLOW=Release Installers and Bundles/i);
});

test("release certificate rejects hard-linked release assets", (t) => {
  const fixture = makeCertificateWriterFixture(t, "hardlink");
  fs.linkSync(fixture.manifests["windows-x64"], `${fixture.manifests["windows-x64"]}.hardlink`);

  const result = runCertificateWriter(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /hard-linked file|regular single-link file/i);
});

test("release certificate rejects files outside the fixed release inventory", (t) => {
  const fixture = makeCertificateWriterFixture(t, "extra-asset");
  fs.writeFileSync(path.join(fixture.artifactsDir, "rogue.bin"), "unexpected\n");

  const result = runCertificateWriter(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fixed closed-world inventory/i);
});

test("OIDC write is isolated to fixed-input artifact and certificate signers", () => {
  const workflow = fs.readFileSync(new URL("../../.github/workflows/release-installers.yml", import.meta.url), "utf8");
  assert.match(workflow, /permissions:\s*\n\s*actions: read\s*\n\s*contents: read\s*\n\s*id-token: none/);
  const artifactSignerBlock =
    workflow.match(/\n  release-artifact-sign:\n([\s\S]*?)(?=\n  release-assemble:\n)/)?.[1] ?? "";
  const certificateSignerBlock =
    workflow.match(/\n  release-certificate-sign:\n([\s\S]*?)(?=\n  release-finalize:\n)/)?.[1] ?? "";
  const allowedSignerActions = [
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    "sigstore/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6",
  ];
  for (const signerBlock of [artifactSignerBlock, certificateSignerBlock]) {
    assert.match(signerBlock, /permissions:\s*\n\s*actions: read\s*\n\s*contents: read\s*\n\s*id-token: write/);
    assert.doesNotMatch(signerBlock, /\bnode\b|\bpnpm\b|scripts\/|actions\/checkout|action-setup|setup-node/);
    assert.doesNotMatch(signerBlock, /\b(?:curl|wget|python|ruby|perl|eval|source|npx|npm|deno|bun)\b/);
    const usedActions = [...signerBlock.matchAll(/uses:\s*([^\s#]+)/g)].map((match) => match[1]);
    assert.ok(
      usedActions.every((action) => allowedSignerActions.includes(action)),
      usedActions.join(", "),
    );
    for (const action of allowedSignerActions) {
      assert.match(signerBlock, new RegExp(action.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  }
  for (const explicitArtifact of [
    "windows-x64-release-assets/GoatCitadel-Setup-windows-x64.exe",
    "windows-x64-release-assets/GoatCitadel-Mission-Control-Windows-Identity.msix",
    "windows-arm64-release-assets/GoatCitadel-Setup-windows-arm64.exe",
    "windows-arm64-release-assets/GoatCitadel-Mission-Control-Windows-Identity.msix",
    "linux-x64-experimental-release-assets/GoatCitadel-${PACKAGE_VERSION}-linux-x64.tar.gz",
    "macos-arm64-experimental-release-assets/GoatCitadel-${PACKAGE_VERSION}-macos-arm64.dmg",
  ]) {
    assert.match(artifactSignerBlock, new RegExp(explicitArtifact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.equal((artifactSignerBlock.match(/cosign sign-blob/g) ?? []).length, 6);
  assert.equal((artifactSignerBlock.match(/cosign verify-blob/g) ?? []).length, 6);
  assert.doesNotMatch(artifactSignerBlock, /\*\.(?:exe|msix|dmg)|find[^\n]*(?:-exec|xargs)[^\n]*cosign/);
  assert.match(artifactSignerBlock, /expected-release-assets-before\.txt[\s\S]*diff -u/);
  assert.match(artifactSignerBlock, /expected-release-assets-after\.txt[\s\S]*diff -u/);
  for (const claim of [
    "certificate-github-workflow-name",
    "certificate-github-workflow-ref",
    "certificate-github-workflow-repository",
    "certificate-github-workflow-sha",
    "certificate-github-workflow-trigger",
  ]) {
    assert.match(artifactSignerBlock, new RegExp(`--${claim}`));
    assert.match(certificateSignerBlock, new RegExp(`--${claim}`));
  }
  assert.match(certificateSignerBlock, /cosign sign-blob[\s\S]*release-certificate\.json/);
  assert.match(certificateSignerBlock, /release-certificate-signing-input-/);
  assert.doesNotMatch(certificateSignerBlock, /release-package-inputs-|cyclonedx|release-package\.zip/);
  assert.equal((workflow.match(/id-token: write/g) ?? []).length, 2);
  assert.match(workflow, /release-assemble:[\s\S]*?id-token: none[\s\S]*?write-release-certificate\.mjs/);
  assert.match(workflow, /release-finalize:[\s\S]*?id-token: none[\s\S]*?assemble-runtime-release-evidence\.mjs/);
  assert.match(workflow, /publish-release:[\s\S]*?contents: write[\s\S]*?id-token: none/);
});

test("reusable platform signing secrets are isolated from repository and dependency execution", () => {
  const workflow = fs.readFileSync(new URL("../../.github/workflows/release-installers.yml", import.meta.url), "utf8");
  const windowsComponentSigner = workflowJob(workflow, "windows-component-sign");
  const windowsInstallerSigner = workflowJob(workflow, "windows-installer-sign");
  const macSigner = workflowJob(workflow, "macos-sign-notarize");
  const forbiddenSecretJobExecution =
    /\b(?:node|pnpm|npm|npx|choco|rustup|cargo)\b|scripts\/|actions\/checkout|action-setup|setup-node|setup-dotnet/;

  for (const signerBlock of [windowsComponentSigner, windowsInstallerSigner]) {
    assert.match(signerBlock, /\$\{\{ secrets\.WINDOWS_SIGN_CERT_BASE64 \}\}/);
    assert.match(signerBlock, /\$\{\{ secrets\.WINDOWS_SIGN_CERT_PASSWORD \}\}/);
    assert.doesNotMatch(signerBlock, forbiddenSecretJobExecution);
    assert.deepEqual(usedActions(signerBlock).sort(), [
      "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    ]);
    assert.match(signerBlock, /Remove-Item -LiteralPath \$certPath -Force -ErrorAction SilentlyContinue/);
    assert.match(signerBlock, /bounded regular non-reparse file/);
    assert.doesNotMatch(
      signerBlock,
      /\*\.(?:exe|msix)|Get-ChildItem -LiteralPath (?:component-input|installer-input) -Recurse/,
    );
  }

  assert.match(macSigner, /\$\{\{ secrets\.MACOS_DEVELOPER_ID_CERT_BASE64 \}\}/);
  assert.match(macSigner, /\$\{\{ secrets\.APPLE_APP_SPECIFIC_PASSWORD \}\}/);
  assert.doesNotMatch(macSigner, forbiddenSecretJobExecution);
  assert.deepEqual(usedActions(macSigner).sort(), [
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
  ]);
  assert.match(macSigner, /if: \$\{\{ always\(\) \}\}[\s\S]*security delete-keychain/);
  assert.match(macSigner, /rm -rf[^\n]*goatcitadel-macos-cert\.p12/);
  assert.match(macSigner, /xcrun notarytool submit "\$OUTPUT_DMG"/);
  assert.match(macSigner, /stat -f %z "\$INPUT_DMG"/);

  for (const noReusableSecretJob of [
    "windows-build-inputs",
    "windows-assemble",
    "windows",
    "macos-build-inputs",
    "macos",
  ]) {
    assert.doesNotMatch(workflowJob(workflow, noReusableSecretJob), /secrets\.(?:WINDOWS_|MACOS_|APPLE_)/);
  }
  assert.equal((workflow.match(/secrets\.WINDOWS_SIGN_CERT_BASE64/g) ?? []).length, 2);
  assert.equal((workflow.match(/secrets\.MACOS_DEVELOPER_ID_CERT_BASE64/g) ?? []).length, 1);

  const windowsSmoke = workflowJob(workflow, "windows");
  assert.match(windowsSmoke, /Get-AuthenticodeSignature -LiteralPath \$signedFile/);
  assert.match(windowsSmoke, /Signed installer checksum mismatch/);
  assert.match(windowsSmoke, /Signed MSIX checksum mismatch/);
});

test("release workflow pins every action and keeps transfer and publish inventories closed", () => {
  const workflow = fs.readFileSync(new URL("../../.github/workflows/release-installers.yml", import.meta.url), "utf8");
  const allActions = usedActions(workflow);
  assert.ok(allActions.length > 0);
  for (const action of allActions) {
    assert.match(action, /^[^@\s]+@[a-f0-9]{40}$/u, action);
  }

  const publishBlock = workflowJob(workflow, "publish-release");
  assert.match(publishBlock, /Validate closed-world publish input/);
  assert.match(publishBlock, /\.releaseAssets \| length == 28/);
  assert.match(publishBlock, /expected-publish-files\.txt[\s\S]*diff -u/);
  assert.match(publishBlock, /fail_on_unmatched_files: true/);
  assert.doesNotMatch(publishBlock, /\*\.zip|\*\*|release-artifacts\/\*/);
  assert.match(publishBlock, /GoatCitadel-\$\{\{ env\.RELEASE_TAG \}\}-windows-x64-verified\.zip/);
  assert.match(publishBlock, /GoatCitadel-\$\{\{ env\.RELEASE_TAG \}\}-windows-arm64-verified\.zip/);

  const finalizerBlock = workflowJob(workflow, "release-finalize");
  assert.match(finalizerBlock, /RELEASE_ASSETS=\(/);
  assert.match(finalizerBlock, /RELEASE_OUTPUTS=\(/);
  assert.match(finalizerBlock, /\[\[ "\$FILE_COUNT" == "35" \]\]/);
  assert.doesNotMatch(finalizerBlock, /path:\s*artifacts\/release\/package\/\*/);

  const certificateSigner = workflowJob(workflow, "release-certificate-sign");
  assert.match(certificateSigner, /Admit exact bounded release certificate input/);
  assert.match(certificateSigner, /CERTIFICATE_SIZE[\s\S]*2097152/);
});

test("certificate and evidence readers enforce closed-world bounds and portable path identity", () => {
  const writer = fs.readFileSync(new URL("./write-release-certificate.mjs", import.meta.url), "utf8");
  const evidence = fs.readFileSync(new URL("./assemble-runtime-release-evidence.mjs", import.meta.url), "utf8");

  assert.match(writer, /MAX_RELEASE_ASSETS = 256/);
  assert.match(writer, /MAX_RELEASE_ARTIFACT_DIRECTORIES = 1_024/);
  assert.match(writer, /MAX_RELEASE_ASSET_PATH_BYTES = 240/);
  assert.match(writer, /MAX_CERTIFICATE_BYTES = 2 \* 1024 \* 1024/);
  assert.match(writer, /WINDOWS_RESERVED_BASENAME/);
  assert.match(writer, /item\.toLowerCase\(\)/);
  assert.match(evidence, /MAX_CERTIFICATE_BYTES/);
  assert.match(evidence, /MAX_ATTESTATION_BYTES/);
  assert.match(evidence, /relativePath\.toLowerCase\(\)/);
  assert.match(evidence, /WINDOWS_RESERVED_BASENAME/);
});

function makeReleasePackageFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goat-release-package-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifactsDir = path.join(root, "release-artifacts");
  const outDir = path.join(root, "output");
  const sbomFile = path.join(root, "goatcitadel-v1.0.0.cyclonedx.json");
  for (const relativePath of fixedSignedArtifactFixturePaths()) {
    const artifactPath = path.join(artifactsDir, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, `artifact:${relativePath}\n`);
    fs.writeFileSync(`${artifactPath}.sha256`, `${"a".repeat(64)} *${path.basename(artifactPath)}\n`);
    fs.writeFileSync(`${artifactPath}.sig`, `signature:${relativePath}\n`);
    fs.writeFileSync(`${artifactPath}.pem`, `certificate:${relativePath}\n`);
  }
  fs.writeFileSync(sbomFile, "{}\n");
  return { root, artifactsDir, outDir, sbomFile };
}

function runReleasePackageAssembler(fixture) {
  return spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./assemble-release-package.mjs", import.meta.url)),
      "--version",
      "1.0.0",
      "--tag",
      "v1.0.0",
      "--artifacts-dir",
      fixture.artifactsDir,
      "--sbom-file",
      fixture.sbomFile,
      "--out-dir",
      fixture.outDir,
    ],
    {
      cwd: fixture.root,
      env: {
        ...process.env,
        GITHUB_REF: "refs/tags/v1.0.0",
        GITHUB_REF_NAME: "v1.0.0",
        GITHUB_REPOSITORY: "goatcitadel/GoatCitadel",
        GITHUB_SHA: "a".repeat(40),
        GITHUB_WORKFLOW: "Release Installers and Bundles",
        GITHUB_WORKFLOW_REF: "goatcitadel/GoatCitadel/.github/workflows/release-installers.yml@refs/tags/v1.0.0",
      },
      encoding: "utf8",
    },
  );
}

function fixedSignedArtifactFixturePaths() {
  return [
    "windows-x64-release-assets/GoatCitadel-Setup-windows-x64.exe",
    "windows-x64-release-assets/GoatCitadel-Mission-Control-Windows-Identity.msix",
    "windows-arm64-release-assets/GoatCitadel-Setup-windows-arm64.exe",
    "windows-arm64-release-assets/GoatCitadel-Mission-Control-Windows-Identity.msix",
    "linux-x64-experimental-release-assets/GoatCitadel-1.0.0-linux-x64.tar.gz",
    "macos-arm64-experimental-release-assets/GoatCitadel-1.0.0-macos-arm64.dmg",
  ];
}

function makeCertificateWriterFixture(t, suffix = "default", options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `goat-release-certificate-${suffix}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifactsDir = path.join(root, "release-artifacts");
  const proofZip = path.join(root, "release-proof.zip");
  const outFile = path.join(root, "release-certificate.json");
  const manifests = {};
  for (const relativePath of fixedReleaseAssetFixturePaths()) {
    const filePath = path.join(artifactsDir, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `fixture:${relativePath}\n`);
  }
  for (const [target, arch] of [
    ["windows-x64", "x64"],
    ["windows-arm64", "arm64"],
  ]) {
    const manifestPath = path.join(artifactsDir, `${target}-release-assets`, "app", "release-manifest.json");
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    const payload = {
      schemaVersion: 2,
      product: "GoatCitadel",
      version: "1.0.0",
      sourceCommit: "a".repeat(40),
      sourceModified: options.dirtyTarget === target,
      target,
      platform: options.platformMismatchTarget === target ? "linux" : "windows",
      arch,
      components: [],
      payload: {
        algorithm: "sha256",
        roots: ["app", "bin"],
        detachedMetadataFiles: ["app/release-manifest.json"],
        detachedMetadataTrees: ["app/release-evidence"],
        fileCount: 1,
        totalBytes: 1,
        files: [{ path: "bin/goatcitadel.cmd", sha256: "b".repeat(64), sizeBytes: 1 }],
      },
      launcher: { command: "goatcitadel launch", windows: "bin/goatcitadel.cmd" },
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(payload, null, 2)}\n`);
    manifests[target] = manifestPath;
  }
  fs.writeFileSync(proofZip, "proof\n");
  return { root, artifactsDir, proofZip, outFile, manifests };
}

function fixedReleaseAssetFixturePaths() {
  const signedArtifacts = [
    "windows-x64-release-assets/GoatCitadel-Setup-windows-x64.exe",
    "windows-x64-release-assets/GoatCitadel-Mission-Control-Windows-Identity.msix",
    "windows-arm64-release-assets/GoatCitadel-Setup-windows-arm64.exe",
    "windows-arm64-release-assets/GoatCitadel-Mission-Control-Windows-Identity.msix",
    "linux-x64-experimental-release-assets/GoatCitadel-1.0.0-linux-x64.tar.gz",
    "macos-arm64-experimental-release-assets/GoatCitadel-1.0.0-macos-arm64.dmg",
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
    "linux-x64-experimental-release-assets/GoatCitadel-1.0.0-linux-x64.tar.gz.sha256",
    "macos-arm64-experimental-release-assets/GoatCitadel-1.0.0-macos-arm64.dmg.sha256",
  ];
}

function workflowJob(workflow, jobName) {
  const escapedName = jobName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = workflow.match(new RegExp(`\\n  ${escapedName}:\\n([\\s\\S]*?)(?=\\n  [a-z0-9][a-z0-9-]*:\\n|$)`))?.[1];
  assert.ok(block, `Workflow job ${jobName} should exist.`);
  return block;
}

function usedActions(workflowBlock) {
  return [...workflowBlock.matchAll(/uses:\s*([^\s#]+)/g)].map((match) => match[1]);
}

function runCertificateWriter(fixture, options = {}) {
  const runtimeManifests = options.runtimeManifests ?? Object.entries(fixture.manifests);
  const args = [
    fileURLToPath(new URL("./write-release-certificate.mjs", import.meta.url)),
    "--version",
    "1.0.0",
    "--tag",
    "v1.0.0",
    "--commit",
    "a".repeat(40),
    "--repository",
    "goatcitadel/GoatCitadel",
    "--artifacts-dir",
    fixture.artifactsDir,
    "--proof-zip",
    fixture.proofZip,
    "--out-file",
    fixture.outFile,
  ];
  for (const [target, manifestPath] of runtimeManifests) {
    args.push("--runtime-manifest", `${target}=${manifestPath}`);
  }
  const env = {
    ...process.env,
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/tags/v1.0.0",
    GITHUB_REF_NAME: "v1.0.0",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_REPOSITORY: "goatcitadel/GoatCitadel",
    GITHUB_WORKFLOW: "Release Installers and Bundles",
    GITHUB_WORKFLOW_REF: "goatcitadel/GoatCitadel/.github/workflows/release-installers.yml@refs/tags/v1.0.0",
    GITHUB_TOKEN: "",
    ...options.env,
  };
  return spawnSync(process.execPath, args, { cwd: fixture.root, env, encoding: "utf8" });
}
