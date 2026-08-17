import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import {
  buildVisualBaselineFileName,
  NEXT_RELEASE_SURFACE_MANIFEST,
  NEXT_VISUAL_REGRESSION_MANIFEST,
  NEXT_VISUAL_SCENARIO_MANIFEST,
  RELEASE_SURFACE_VARIANTS,
  resolveVisualBaselineNamespace,
} from "./verification/lib/release-surface-manifest.mjs";
import { collectVisualBaselineCoverage } from "./verification/lib/visual-baseline-coverage.mjs";

const root = process.cwd();
const VALID_RELEASE_SURFACE_STATUSES = new Set(["ship", "hide", "experimental", "needs_release_polish"]);

const requiredFiles = [
  "README.md",
  "CHANGELOG.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "LICENSE",
  "SECURITY.md",
  "docs/1_0_CONTRACT.md",
  "docs/1_0_RELEASE_EVIDENCE.md",
  "docs/CANONICAL_RUNTIME_STATE_MODEL.md",
  "docs/DEFENSIVE_PATTERNS.md",
  "docs/DURABLE_RUNS_REPLAY_FOUNDATION.md",
  "docs/ENGINEERING_HANDBOOK.md",
  "docs/security/findings-triage.md",
  "docs/PACKAGING.md",
  "docs/CAPABILITY_SYSTEM_V1.md",
  "docs/EVOLUTION_CONTROL_PLANE.md",
];

const requiredHeadings = {
  "CHANGELOG.md": ["# Changelog", "## [Unreleased]", "## [0.1.0-rc.1]", "## [1.0.0]"],
  "AGENTS.md": ["# AGENTS.md - GoatCitadel", "## Current Product Truth", "## Agent Roles", "## Safety Boundaries (Non-Overridable)"],
  "CONTRIBUTING.md": ["# Contributing to GoatCitadel", "## Quality Gates", "## Governance Docs Policy"],
  "CODE_OF_CONDUCT.md": ["# Contributor Covenant Code of Conduct", "## Enforcement", "## Attribution"],
  "SECURITY.md": ["# Security Policy", "## Reporting a Vulnerability", "## Security Invariants"],
  "docs/1_0_CONTRACT.md": [
    "# GoatCitadel 1.0 Contract",
    "## Product Promise",
    "## Visible 1.0 Footprint",
    "## Trust and Security Posture",
    "## Upgrade and Backup Guarantees",
    "## Release Gates",
  ],
  "docs/1_0_RELEASE_EVIDENCE.md": [
    "# GoatCitadel 1.0 Release Evidence",
    "## Recovery Truth",
    "## Backup Contract Evidence",
    "## Visible Surface Evidence",
  ],
  "docs/security/findings-triage.md": [
    "# GitHub Security Findings",
    "## 5. Dependabot Triage",
    "## 6. CodeQL `js/unhandled-error-in-stream-pipeline`",
  ],
  "docs/DEFENSIVE_PATTERNS.md": [
    "# Defensive Patterns",
    "## A pure read must not mutate state",
    "## Discriminate transient from permanent before destroying state",
    "## Never hand a child process the ambient environment",
    "## Redact before truncating",
  ],
  "docs/EVOLUTION_CONTROL_PLANE.md": [
    "# Evolution Control Plane",
    "## Authority Boundary",
    "## Canonical Change Plan",
    "## Operator Input and Secret Custody",
    "## Source and Packaged Updates",
    "## Rollout and Proof",
  ],
};

const errors = [];
const currentShellEvidencePatterns = [
  /apps\/mission-control-next\/src/i,
  /packages\/mission-control-shared\/src/i,
  /packages\/threaded-surface-core\/src/i,
  /pending current-shell proof/i,
  /compatibility-only/i,
  /compatibility evidence/i,
];

const workspacePackageFiles = [
  "package.json",
  "apps/gateway/package.json",
  "apps/mission-control-next/package.json",
  "apps/mission-control-desktop/package.json",
  "packages/contracts/package.json",
  "packages/extensions-sdk/package.json",
  "packages/gateway-core/package.json",
  "packages/memory-core/package.json",
  "packages/mesh-core/package.json",
  "packages/orchestration/package.json",
  "packages/policy-engine/package.json",
  "packages/skills/package.json",
  "packages/storage/package.json",
];

for (const relPath of requiredFiles) {
  const absPath = path.join(root, relPath);
  try {
    await access(absPath, constants.F_OK | constants.R_OK);
  } catch {
    errors.push(`Missing required file: ${relPath}`);
    continue;
  }
  const expectedHeadings = requiredHeadings[relPath];
  if (!expectedHeadings?.length) {
    continue;
  }
  const content = await readFile(absPath, "utf8");
  for (const heading of expectedHeadings) {
    if (!content.includes(heading)) {
      errors.push(`File ${relPath} missing required heading: ${heading}`);
    }
  }
}

const agentsGuide = await readFile(path.join(root, "AGENTS.md"), "utf8");
const securityGuide = await readFile(path.join(root, "SECURITY.md"), "utf8");
const securityTriageGuide = await readFile(path.join(root, "docs", "security", "findings-triage.md"), "utf8");
if (
  !/apps\/mission-control-next` is the canonical `1\.0` Mission Control shell/i.test(agentsGuide) ||
  !/apps\/mission-control` source .*archived from disk/i.test(agentsGuide)
) {
  errors.push("AGENTS.md must keep the canonical Mission Control Next and archived legacy shell guidance explicit.");
}
if (!/trusted-code capability/i.test(agentsGuide) || !/Do not claim hostile-code sandboxing/i.test(agentsGuide)) {
  errors.push("AGENTS.md must keep Code Mode guidance truthful and avoid hostile-code sandbox claims.");
}
if (!/js\/unhandled-error-in-stream-pipeline/.test(agentsGuide) || !/Dependabot/.test(agentsGuide)) {
  errors.push("AGENTS.md must keep GitHub Security triage guidance current for Dependabot and stream-pipeline CodeQL findings.");
}
if (
  !/\[.*?docs\/security\/findings-triage\.md.*?\]\(docs\/security\/findings-triage\.md\)/s.test(securityGuide) ||
  !/js\/unhandled-error-in-stream-pipeline/.test(securityGuide) ||
  !/js\/missing-rate-limiting/.test(securityGuide) ||
  !/Dependabot/.test(securityGuide)
) {
  errors.push(
    "SECURITY.md must link the GitHub Security findings triage guide and name the recurring CodeQL and Dependabot triage surfaces.",
  );
}
await validateRelativeMarkdownLinks("AGENTS.md", agentsGuide);
await validateRelativeMarkdownLinks("SECURITY.md", securityGuide);
await validateRelativeMarkdownLinks("docs/security/findings-triage.md", securityTriageGuide);
if (
  !/## Source of Truth Order[\s\S]*1\. current implementation under `apps\/` and `packages\/`[\s\S]*2\. `docs\/CANONICAL_RUNTIME_STATE_MODEL\.md`[\s\S]*3\. `docs\/1_0_CONTRACT\.md`[\s\S]*4\. `docs\/ENGINEERING_HANDBOOK\.md`/m.test(
    agentsGuide,
  )
) {
  errors.push("AGENTS.md must preserve the implementation-first source-of-truth order.");
}

const handbookPath = path.join(root, "docs", "ENGINEERING_HANDBOOK.md");
const handbook = await readFile(handbookPath, "utf8");
const machineSpecificRepoPathPattern = new RegExp(["F:", "\\\\", "code", "\\\\", "personal-ai"].join(""), "i");
if (/as of February 2026/i.test(handbook)) {
  errors.push("docs/ENGINEERING_HANDBOOK.md contains a stale date claim.");
}
if (machineSpecificRepoPathPattern.test(handbook)) {
  errors.push("docs/ENGINEERING_HANDBOOK.md contains a machine-specific repo path claim.");
}
if (/system truth/i.test(handbook)) {
  errors.push("docs/ENGINEERING_HANDBOOK.md must not claim repo-wide system truth.");
}
if (
  !/When runtime ownership, lifecycle status, or operator truth matter, prefer these sources in order:[\s\S]*1\. current implementation under `apps\/` and `packages\/`[\s\S]*2\. `docs\/CANONICAL_RUNTIME_STATE_MODEL\.md`[\s\S]*3\. `docs\/1_0_CONTRACT\.md`[\s\S]*4\. this handbook for broader subsystem orientation/m.test(
    handbook,
  )
) {
  errors.push("docs/ENGINEERING_HANDBOOK.md must preserve the implementation-first source-of-truth order.");
}
if (!/MemoryLifecycleService/.test(handbook)) {
  errors.push("docs/ENGINEERING_HANDBOOK.md must name MemoryLifecycleService as the memory lifecycle owner.");
}
if (!/mesh-core/i.test(handbook) || !/verify:mesh:readiness/i.test(handbook) || !/Gateway diagnostics/i.test(handbook)) {
  errors.push("docs/ENGINEERING_HANDBOOK.md must gate mesh-core readiness on verify:mesh:readiness evidence.");
}
if (!/NPU sidecar path is retired/i.test(handbook) || !/real hardware proof/i.test(handbook)) {
  errors.push("docs/ENGINEERING_HANDBOOK.md must describe the NPU sidecar path as retired from shipped 1.0.");
}
if (!/docs\/1_0_CONTRACT\.md/.test(handbook)) {
  errors.push("docs/ENGINEERING_HANDBOOK.md must point readers to docs/1_0_CONTRACT.md for 1.0 scope and release-gate truth.");
}
if (!/Visible `beta` and `native` non-channel integrations derive their advertised capabilities from the operator-action runtime registry/i.test(handbook)) {
  errors.push("docs/ENGINEERING_HANDBOOK.md must describe visible beta/native non-channel integrations as runtime-backed operator-action surfaces.");
}
if (!/verify:backup:roundtrip` must seed, mutate, restore, and verify all four classes above/i.test(handbook)) {
  errors.push("docs/ENGINEERING_HANDBOOK.md must describe backup-roundtrip as proving the full minimum backup set.");
}
if (!/verify:visual:regression` must compare checked-in baselines/i.test(handbook)) {
  errors.push("docs/ENGINEERING_HANDBOOK.md must describe visual-regression as checked-in baseline comparison.");
}
if (/Remaining non-adopted chat flows/i.test(handbook)) {
  errors.push("docs/ENGINEERING_HANDBOOK.md must not describe shipped operator chat flows as remaining non-adopted.");
}
if (!/offline_restore_required/i.test(handbook) || !/offline-only/i.test(handbook)) {
  errors.push("docs/ENGINEERING_HANDBOOK.md must describe filesystem-backed restore as offline-only and name the offline_restore_required live-route response.");
}
if (!/verify:catalog:parity` must execute the runtime-backed operator action classes declared in its parity scenario/i.test(handbook)) {
  errors.push("docs/ENGINEERING_HANDBOOK.md must describe catalog-parity as scenario-backed runtime action proof, not blanket catalog coverage.");
}
if (
  !/Orchestration runs are durable-run backed and worktree-owned/i.test(handbook) ||
  !/release or reap orchestration worktrees/i.test(handbook)
) {
  errors.push("docs/ENGINEERING_HANDBOOK.md must describe orchestration as durable-run backed, worktree-owned, and covered by allocation/release/orphan cleanup truth.");
}
if (!/not hostile-code sandboxing or virtualization/i.test(handbook)) {
  errors.push("docs/ENGINEERING_HANDBOOK.md must avoid claiming worktree-backed orchestration is hostile-code sandboxing or virtualization.");
}
if (
  !/Multi-user RBAC is not shipped/i.test(handbook) ||
  !/auth remains gateway-level/i.test(handbook) ||
  !/Permission profiles/i.test(handbook)
) {
  errors.push("docs/ENGINEERING_HANDBOOK.md must say multi-user RBAC is not shipped while preserving permission-profile and tool-policy governance truth.");
}
if (!/verify:api:compat` must snapshot REST route\/status compatibility and realtime event envelopes/i.test(handbook)) {
  errors.push("docs/ENGINEERING_HANDBOOK.md must describe the REST/SSE additive-compatibility lane without claiming full response-schema diffs.");
}

const runtimeStatePath = path.join(root, "docs", "CANONICAL_RUNTIME_STATE_MODEL.md");
const runtimeState = await readFile(runtimeStatePath, "utf8");
if (!/^Last updated:/m.test(runtimeState)) {
  errors.push("docs/CANONICAL_RUNTIME_STATE_MODEL.md must include a Last updated header.");
}
if (!/HTTP\/SSE send, retry, resume/i.test(runtimeState) || !/legacy traces without durable linkage/i.test(runtimeState)) {
  errors.push("docs/CANONICAL_RUNTIME_STATE_MODEL.md must name the durably owned shipped Chat/Cowork/Code flows and remaining compatibility fallbacks.");
}
if (!/MemoryLifecycleService/.test(runtimeState)) {
  errors.push("docs/CANONICAL_RUNTIME_STATE_MODEL.md must name MemoryLifecycleService as the memory lifecycle owner.");
}
if (/Execution-engine adoption: \*\*in progress\*\*/i.test(runtimeState) || /Remaining non-adopted chat flows/i.test(runtimeState)) {
  errors.push("docs/CANONICAL_RUNTIME_STATE_MODEL.md must not describe shipped durable operator paths as in-progress or non-adopted.");
}
if (!/memory item list\/edit\/forget\/history/i.test(runtimeState)) {
  errors.push("docs/CANONICAL_RUNTIME_STATE_MODEL.md must describe MemoryLifecycleService as the owner of memory item list/edit/forget/history.");
}
if (!/historical implementation background/i.test(runtimeState) || !/not the active rollout source of truth/i.test(runtimeState)) {
  errors.push("docs/CANONICAL_RUNTIME_STATE_MODEL.md must treat docs/DURABLE_RUNS_REPLAY_FOUNDATION.md as historical background, not active rollout truth.");
}

const durableFoundation = await readFile(path.join(root, "docs", "DURABLE_RUNS_REPLAY_FOUNDATION.md"), "utf8");
if (!/historical implementation background/i.test(durableFoundation) || !/not the active rollout source of truth/i.test(durableFoundation)) {
  errors.push("docs/DURABLE_RUNS_REPLAY_FOUNDATION.md must describe itself as historical implementation background rather than an active rollout plan.");
}
if (!/default to `true`/i.test(durableFoundation) || !/Shipped Chat operator sends/i.test(durableFoundation)) {
  errors.push("docs/DURABLE_RUNS_REPLAY_FOUNDATION.md must match the shipped durable-by-default posture for Chat operator flows.");
}
if (/default:\s*`false`/i.test(durableFoundation) || /Next Step \(Activation Plan\)/i.test(durableFoundation) || /keep the feature disabled by default/i.test(durableFoundation)) {
  errors.push("docs/DURABLE_RUNS_REPLAY_FOUNDATION.md must not reintroduce stale default-off or activation-plan language.");
}

const readme = await readFile(path.join(root, "README.md"), "utf8");
if (!/mesh-core/i.test(readme) || !/verify:mesh:readiness/i.test(readme) || !/evidence-gated/i.test(readme)) {
  errors.push("README.md must describe mesh-core readiness as evidence-gated by verify:mesh:readiness.");
}
if (
  !/NPU sidecar maturity or local-inference completeness as a `1\.0` signal/i.test(readme) ||
  !/retired from the shipped 1\.0 source and installer/i.test(readme)
) {
  errors.push("README.md must keep the NPU sidecar retired from the shipped 1.0 path.");
}
if (!/docs\/1_0_CONTRACT\.md/.test(readme)) {
  errors.push("README.md must point readers to docs/1_0_CONTRACT.md for the current 1.0 contract.");
}
if (!/docs\/1_0_RELEASE_EVIDENCE\.md/.test(readme)) {
  errors.push("README.md must point readers to docs/1_0_RELEASE_EVIDENCE.md for the current 1.0 proof map.");
}
if (!/visible `beta` integrations in Mission Control now expose real operator actions backed by runtime handlers/i.test(readme)) {
  errors.push("README.md must describe visible beta integrations as real operator-action runtimes, not diagnostics-only shells.");
}
if (!/verify:visual:regression` compares checked-in shell and route baselines/i.test(readme)) {
  errors.push("README.md must describe verify:visual:regression as baseline comparison, not screenshot capture only.");
}
if (!/verify:backup:roundtrip` now restores and verifies the full minimum operator backup set/i.test(readme)) {
  errors.push("README.md must describe verify:backup:roundtrip as restoring the full minimum operator backup set.");
}
if (!/contractVerified/i.test(readme)) {
  errors.push("README.md must describe backup verify as reporting contractVerified minimum-set truth.");
}
if (/late beta/i.test(readme) || /release-0\.9/i.test(readme) || /before `1\.0`/i.test(readme)) {
  errors.push("README.md must not describe GoatCitadel as late-beta or resurrect the retired 0.9 pre-release line.");
}
// The published product line is the 0.1.0 release candidate (single GitHub
// prerelease `GoatCitadel 0.1.0 RC`, tag 0.1.0-rc.1); the `1.0` contract docs
// remain the product-scope vocabulary. A deliberate release renumber must
// update the badge, the Release line row, and these assertions together.
if (!/release-0\.1\.0--rc\.1/i.test(readme)) {
  errors.push("README.md must expose the 0.1.0-rc.1 release-candidate badge.");
}
if (/release-1\.0\.0/i.test(readme) || /latest published release is `v1\.0\.0`/i.test(readme)) {
  errors.push("README.md must not claim v1.0.0 as the current published release line.");
}
if (!/published release line is the `0\.1\.0-rc\.1` release candidate/i.test(readme)) {
  errors.push("README.md must name the 0.1.0-rc.1 release candidate as the published release line.");
}
if (!/offline_restore_required/i.test(readme) || !/offline-only/i.test(readme)) {
  errors.push("README.md must describe filesystem-backed restore as offline-only and name the offline_restore_required live-route response.");
}
if (!/verify:catalog:parity` now executes the runtime-backed operator action classes declared in its parity scenario/i.test(readme)) {
  errors.push("README.md must describe verify:catalog:parity as runtime action proof.");
}
if (!/Proof-type shorthand/i.test(readme) || !/Architecture debt guard/i.test(readme)) {
  errors.push("README.md must label verification lanes by proof type, including the architecture debt guard.");
}
if (
  !/verify:catalog:parity` now executes the runtime-backed operator action classes declared in its parity scenario[\s\S]*it is a parity sample, not proof every future visible catalog entry has a live action/i.test(
    readme,
  )
) {
  errors.push("README.md must describe verify:catalog:parity as a parity sample, not complete product-wide proof.");
}
if (
  !/verify:agentic:proof` is targeted contract\/behavior proof/i.test(readme) ||
  !/not live end-to-end product proof/i.test(readme)
) {
  errors.push("README.md must describe verify:agentic:proof as targeted proof, not complete product-wide or live E2E proof.");
}
if (!/multi-user RBAC is not shipped/i.test(readme) || !/gateway auth is deployment-level/i.test(readme)) {
  errors.push("README.md must keep auth posture clear that multi-user RBAC is not shipped for 1.0.");
}
if (!/verify:api:compat` snapshots REST route\/status compatibility and realtime event envelopes/i.test(readme)) {
  errors.push("README.md must describe the REST/SSE compatibility lane.");
}

const installDoc = await readFile(path.join(root, "docs", "INSTALL_SETUP_TESTING.md"), "utf8");
if (!/Retired: NPU Sidecar/i.test(installDoc) || !/retired from the shipped `1\.0` source and installer/i.test(installDoc)) {
  errors.push("docs/INSTALL_SETUP_TESTING.md must describe the NPU sidecar as retired from the shipped 1.0 path.");
}
if (!/docs\/1_0_CONTRACT\.md/.test(installDoc)) {
  errors.push("docs/INSTALL_SETUP_TESTING.md must point readers to docs/1_0_CONTRACT.md for the current 1.0 scope and release gates.");
}
if (/Target release: `0\.9\.0-beta\.1`/i.test(installDoc) || /public beta testers/i.test(installDoc)) {
  errors.push("docs/INSTALL_SETUP_TESTING.md must not describe the target release as beta.");
}

const reproducibleReleaseDoc = await readFile(path.join(root, "docs", "reproducible-release.md"), "utf8");
if (!/Node `22\.x` in GitHub Actions/i.test(reproducibleReleaseDoc)) {
  errors.push("docs/reproducible-release.md must match the Node 22 release installer workflow.");
}
if (/Node `24\.x`/i.test(reproducibleReleaseDoc)) {
  errors.push("docs/reproducible-release.md must not reintroduce stale Node 24 release tooling claims.");
}

const smokeTestsDoc = await readFile(path.join(root, "docs", "smoke-tests.md"), "utf8");
if (!/Windows x64 and Windows arm64 installer packages are built in CI/i.test(smokeTestsDoc)) {
  errors.push("docs/smoke-tests.md must scope installer CI smoke expectations to the shipped Windows installer targets.");
}
if (!/Unsigned workflow-dispatch artifacts are development packaging smoke only/i.test(smokeTestsDoc)) {
  errors.push("docs/smoke-tests.md must distinguish signed public releases from unsigned workflow-dispatch artifacts.");
}
if (/Installer packages are built in CI for every supported target/i.test(smokeTestsDoc)) {
  errors.push("docs/smoke-tests.md must not claim every supported platform has installer CI packages.");
}

const dependencyPolicyDoc = await readFile(path.join(root, "docs", "dependency-policy.md"), "utf8");
if (!/Windows x64 and arm64 installers are the current CI-built release installer surfaces/i.test(dependencyPolicyDoc)) {
  errors.push("docs/dependency-policy.md must scope release installer support to current Windows installer surfaces.");
}
if (/macOS x64 and arm64 installers/i.test(dependencyPolicyDoc) || /Linux x64 tarball installer/i.test(dependencyPolicyDoc)) {
  errors.push("docs/dependency-policy.md must not claim macOS/Linux native installers until release proof exists.");
}

const channelGuide = await readFile(path.join(root, "docs", "COMMUNICATION_CHANNEL_SETUP_GUIDE.md"), "utf8");
if (/runnable-planned/i.test(channelGuide) || /planned channels/i.test(channelGuide) || /parity-incomplete/i.test(channelGuide)) {
  errors.push("docs/COMMUNICATION_CHANNEL_SETUP_GUIDE.md must not describe visible built-in channels as planned, runnable-planned, or parity-incomplete.");
}
if (!/visible built-in channels no longer use legacy planned-state treatment/i.test(channelGuide)) {
  errors.push("docs/COMMUNICATION_CHANNEL_SETUP_GUIDE.md must state that visible built-in channels no longer use legacy planned-state treatment.");
}

const pluginSdkDoc = await readFile(path.join(root, "docs", "PLUGIN_SDK_CONTRACT.md"), "utf8");
if (/public SDK story is still partial/i.test(pluginSdkDoc) || /no published TypeScript SDK package/i.test(pluginSdkDoc)) {
  errors.push("docs/PLUGIN_SDK_CONTRACT.md must treat @goatcitadel/extensions-sdk as the published public author contract.");
}
if (!/@goatcitadel\/extensions-sdk/.test(pluginSdkDoc)) {
  errors.push("docs/PLUGIN_SDK_CONTRACT.md must name @goatcitadel/extensions-sdk explicitly.");
}
if (!/@goatcitadel\/extensions-sdk@1\.0\.0/.test(pluginSdkDoc)) {
  errors.push("docs/PLUGIN_SDK_CONTRACT.md must describe the stable published 1.0.0 SDK package boundary.");
}

const contract = await readFile(path.join(root, "docs", "1_0_CONTRACT.md"), "utf8");
if (!/^Last updated: 2026-08-14$/m.test(contract)) {
  errors.push("docs/1_0_CONTRACT.md must carry the current 2026-08-14 freshness header.");
}
if (
  !/## Source of Truth Order[\s\S]*1\. current implementation under `apps\/` and `packages\/`[\s\S]*2\. \[docs\/CANONICAL_RUNTIME_STATE_MODEL\.md\]\(\.\/CANONICAL_RUNTIME_STATE_MODEL\.md\)[\s\S]*3\. this contract for `1\.0` promise and release-scope truth[\s\S]*4\. \[docs\/ENGINEERING_HANDBOOK\.md\]\(\.\/ENGINEERING_HANDBOOK\.md\)/m.test(
    contract,
  )
) {
  errors.push("docs/1_0_CONTRACT.md must preserve the implementation-first source-of-truth order.");
}
if (!/local-first AI workbench/i.test(contract)) {
  errors.push("docs/1_0_CONTRACT.md must define GoatCitadel 1.0 as a local-first AI workbench.");
}
if (
  !/Work \/ Projects \/ Library \/ Ops \/ Settings/i.test(contract) ||
  !/single Chat surface/i.test(contract) ||
  !/Work \/ Observe \/ Tune.*legacy release taxonomy/i.test(contract)
) {
  errors.push("docs/1_0_CONTRACT.md must define the current Mission Control Next IA and demote Work / Observe / Tune to release taxonomy.");
}
if (!/trusted-code capability/i.test(contract) || !/best-effort and fail-closed/i.test(contract)) {
  errors.push("docs/1_0_CONTRACT.md must keep the Code Mode security posture narrow and explicit.");
}
if (!/Backup create, list, and verify are shipped through the admin API\/CLI surface/i.test(contract)) {
  errors.push("docs/1_0_CONTRACT.md must describe the shipped backup create/list/verify guarantee.");
}
if (!/no visible `beta` or `native` non-channel integration may advertise .* matching operator actions/i.test(contract)) {
  errors.push("docs/1_0_CONTRACT.md must require visible non-channel beta/native integrations to advertise only capabilities backed by shipped operator actions.");
}
if (!/stack-backed restart\/recovery proof/i.test(contract)) {
  errors.push("docs/1_0_CONTRACT.md must require stack-backed durable recovery proof as a release gate.");
}
if (!/verify:visual:regression` is green and compares checked-in dark\/light desktop\/mobile baselines/i.test(contract)) {
  errors.push("docs/1_0_CONTRACT.md must require visual-regression baseline comparison as a release gate.");
}
if (!/verify:backup:roundtrip` is green and restores the full minimum operator backup set/i.test(contract)) {
  errors.push("docs/1_0_CONTRACT.md must require backup-roundtrip proof for the full minimum backup set.");
}
if (!/offline CLI-only/i.test(contract) || !/offline_restore_required/i.test(contract)) {
  errors.push("docs/1_0_CONTRACT.md must describe filesystem-backed restore as offline CLI-only and name the blocked live-route response.");
}
if (!/contractVerified/i.test(contract)) {
  errors.push("docs/1_0_CONTRACT.md must describe backup verify as reporting contractVerified minimum-set truth.");
}
if (!/verify:catalog:parity` is green and executes the runtime-backed operator action classes declared in its parity scenario/i.test(contract)) {
  errors.push("docs/1_0_CONTRACT.md must require catalog-parity runtime action proof.");
}
if (
  !/verify:api:compat` is green and fails on removed REST routes, removed methods\/statuses, or realtime event-envelope regressions covered by its captured compatibility scenario/i.test(contract)
) {
  errors.push("docs/1_0_CONTRACT.md must require the REST/SSE additive-compatibility gate.");
}
if (!/mesh-core/i.test(contract) || !/verify:mesh:readiness/i.test(contract) || !/join-token lifecycle/i.test(contract)) {
  errors.push("docs/1_0_CONTRACT.md must gate mesh-core readiness on verify:mesh:readiness.");
}
if (!/NPU sidecar maturity/i.test(contract) || !/retired from the shipped source and installer/i.test(contract)) {
  errors.push("docs/1_0_CONTRACT.md must keep the NPU sidecar retired from the readiness-bearing 1.0 story.");
}
if (!/Evolution Control Plane/i.test(contract) || !/verify:chat-evolution/i.test(contract)) {
  errors.push("docs/1_0_CONTRACT.md must name the Evolution Control Plane and its held-claim verification lane.");
}

const evolutionControlPlaneDoc = await readFile(path.join(root, "docs", "EVOLUTION_CONTROL_PLANE.md"), "utf8");
await validateRelativeMarkdownLinks("docs/EVOLUTION_CONTROL_PLANE.md", evolutionControlPlaneDoc);
if (!/^Last updated: 2026-08-14$/m.test(evolutionControlPlaneDoc)) {
  errors.push("docs/EVOLUTION_CONTROL_PLANE.md must carry the current 2026-08-14 freshness header.");
}
if (!/`change\.request`[\s\S]*cannot confirm or apply/m.test(evolutionControlPlaneDoc)) {
  errors.push("docs/EVOLUTION_CONTROL_PLANE.md must keep the model tool plan-only boundary explicit.");
}
if (!/Packaged installs reject Chat-generated patches/i.test(evolutionControlPlaneDoc)) {
  errors.push("docs/EVOLUTION_CONTROL_PLANE.md must keep generated patches outside packaged installs.");
}
if (!/foundation_only/i.test(evolutionControlPlaneDoc) || !/remain held/i.test(evolutionControlPlaneDoc)) {
  errors.push("docs/EVOLUTION_CONTROL_PLANE.md must keep live-runtime and signing claims held.");
}

const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
if (/semantic pre-release versions/i.test(changelog) || /public surface is still settling/i.test(changelog)) {
  errors.push("CHANGELOG.md must not keep stale pre-release boilerplate at the top of the file.");
}

const releaseEvidencePath = path.join(root, "docs", "1_0_RELEASE_EVIDENCE.md");
const releaseEvidence = await readFile(releaseEvidencePath, "utf8");
if (!/^Last updated: 2026-06-01$/m.test(releaseEvidence)) {
  errors.push("docs/1_0_RELEASE_EVIDENCE.md must carry the current 2026-06-01 freshness header.");
}
if (!/large-service debt/i.test(releaseEvidence) || !/not proof that broad GatewayService decomposition is complete/i.test(releaseEvidence)) {
  errors.push("docs/1_0_RELEASE_EVIDENCE.md must keep architecture metrics framed as a large-service debt guard, not decomposition proof.");
}
if (!/Permission Profiles and Override Evidence/i.test(releaseEvidence)) {
  errors.push("docs/1_0_RELEASE_EVIDENCE.md must map Permission Profiles and Local Operator Override evidence.");
}
for (const [index, line] of releaseEvidence.split(/\r?\n/).entries()) {
  if (
    /\]\(\.\.\/apps\/mission-control\//.test(line) &&
    !/(archived|legacy|retired|compatibility-only|rollback|parity)/i.test(line)
  ) {
    errors.push(
      `docs/1_0_RELEASE_EVIDENCE.md:${index + 1} cites apps/mission-control without labeling it archived or legacy evidence.`,
    );
  }
  if (
    /apps\/mission-control\/src/i.test(line) &&
    !currentShellEvidencePatterns.some((pattern) => pattern.test(line))
  ) {
    errors.push(
      `docs/1_0_RELEASE_EVIDENCE.md:${index + 1} cites legacy Mission Control evidence without current-shell/shared-package proof or an explicit compatibility/pending-current-shell label.`,
    );
  }
}
// Generalized archived-shell citation guard: the retired `apps/mission-control/src` shell must not be
// cited as current implementation in ANY governance doc (not just release evidence). A citation is allowed
// only when the same line also carries a current-shell path or an explicit archived/legacy/compatibility label.
const archivedShellScanDocs = [
  "README.md",
  "AGENTS.md",
  "docs/PACKAGING.md",
  "docs/CAPABILITY_SYSTEM_V1.md",
  "docs/1_0_CONTRACT.md",
  "docs/CANONICAL_RUNTIME_STATE_MODEL.md",
];
for (const relDoc of archivedShellScanDocs) {
  let docSource;
  try {
    docSource = await readFile(path.join(root, relDoc), "utf8");
  } catch {
    continue;
  }
  for (const [index, line] of docSource.split(/\r?\n/).entries()) {
    if (
      /apps\/mission-control\/src/i.test(line) &&
      !currentShellEvidencePatterns.some((pattern) => pattern.test(line)) &&
      !/(archived|legacy|retired|compatibility-only|rollback|parity)/i.test(line)
    ) {
      errors.push(
        `${relDoc}:${index + 1} cites archived apps/mission-control/src without a current-shell path or an archived/legacy label.`,
      );
    }
  }
}

await validateRelativeMarkdownLinks("docs/1_0_RELEASE_EVIDENCE.md", releaseEvidence, "proof anchor");

const adminRouteSource = await readFile(path.join(root, "apps", "gateway", "src", "routes", "admin.ts"), "utf8");
if (!/buildOfflineRestoreRequiredResponse/.test(adminRouteSource)) {
  errors.push("apps/gateway/src/routes/admin.ts must use the shared offline restore blocker helper.");
}
if (/gateway\.restoreBackup\(/.test(adminRouteSource)) {
  errors.push("apps/gateway/src/routes/admin.ts must not call gateway.restoreBackup from the live admin route.");
}

const backupVerifySource = await readFile(
  path.join(root, "apps", "gateway", "src", "services", "gateway", "backup-verify.ts"),
  "utf8",
);
if (!/contractVerified/.test(backupVerifySource) || !/contractCoverage/.test(backupVerifySource)) {
  errors.push("apps/gateway/src/services/gateway/backup-verify.ts must expose contractVerified and contractCoverage.");
}

const scenariosSource = await readFile(path.join(root, "scripts", "verification", "lib", "scenarios.mjs"), "utf8");
if (!/release-surface-manifest\.mjs/.test(scenariosSource) || !/NEXT_RELEASE_SURFACE_MANIFEST/.test(scenariosSource)) {
  errors.push("scripts/verification/lib/scenarios.mjs must derive release-bearing route coverage from the canonical Mission Control Next release-surface manifest.");
}

const nextRouteModelSource = await readFile(
  path.join(root, "apps", "mission-control-next", "src", "app", "route-model.ts"),
  "utf8",
);
const declaredNextRouteKeys = new Set(deriveMissionControlNextRouteKeys(nextRouteModelSource));
const routeReleaseScopes = deriveMissionControlNextRouteScopes(nextRouteModelSource);
const routeReleaseScopeByKey = new Map(routeReleaseScopes.map((scope) => [nextReleaseRouteKey(scope), scope]));
for (const key of declaredNextRouteKeys) {
  if (!routeReleaseScopeByKey.has(key)) {
    errors.push(`apps/mission-control-next/src/app/route-model.ts release scope is missing canonical route ${key}.`);
  }
}
for (const scope of routeReleaseScopes) {
  const key = nextReleaseRouteKey(scope);
  if (!declaredNextRouteKeys.has(key)) {
    errors.push(`apps/mission-control-next/src/app/route-model.ts release scope includes unknown route ${key}.`);
  }
  if (!VALID_RELEASE_SURFACE_STATUSES.has(scope.status)) {
    errors.push(`Mission Control Next release scope ${key} uses unknown status ${scope.status}.`);
  }
  if (!scope.releaseAction || !scope.verification || !scope.note) {
    errors.push(`Mission Control Next release scope ${key} must include action, verification, and note copy.`);
  }
}
const canonicalNextReleaseRoutes = routeReleaseScopes.filter((scope) => scope.status !== "hide");
const manifestRouteKeys = new Set(NEXT_RELEASE_SURFACE_MANIFEST.map(nextReleaseRouteKey));
const canonicalRouteKeys = new Set(canonicalNextReleaseRoutes.map(nextReleaseRouteKey));
const releaseScopeDoc = await readFile(path.join(root, "docs", "1_0_RELEASE_SURFACE_SCOPE.md"), "utf8");
const releaseEvidenceDoc = await readFile(path.join(root, "docs", "1_0_RELEASE_EVIDENCE.md"), "utf8");
validateReleaseSurfaceScopeDoc(releaseScopeDoc, canonicalNextReleaseRoutes);
validateReleaseEvidenceCounts(releaseEvidenceDoc, canonicalNextReleaseRoutes);
validateReadmeRouteCounts(readme, canonicalNextReleaseRoutes);
if (NEXT_RELEASE_SURFACE_MANIFEST.length !== canonicalNextReleaseRoutes.length) {
  errors.push(
    `scripts/verification/lib/release-surface-manifest.mjs must cover the ${canonicalNextReleaseRoutes.length} canonical Mission Control Next release-surface routes.`,
  );
}
for (const route of canonicalNextReleaseRoutes) {
  const key = nextReleaseRouteKey(route);
  if (!manifestRouteKeys.has(key)) {
    errors.push(
      `Mission Control Next release-surface manifest is missing canonical route ${route.expectedArea}/${route.expectedSection}.`,
    );
  }
}
for (const route of NEXT_RELEASE_SURFACE_MANIFEST) {
  const key = nextReleaseRouteKey(route);
  if (!canonicalRouteKeys.has(key)) {
    errors.push(`Mission Control Next release-surface manifest includes non-canonical route ${route.slug} (${key}).`);
    continue;
  }
  const scopedRoute = routeReleaseScopeByKey.get(key);
  if (!route.releaseStatus || route.releaseStatus !== scopedRoute?.status) {
    errors.push(
      `Mission Control Next release-surface manifest route ${route.slug} must carry releaseStatus=${scopedRoute?.status}.`,
    );
  }
  if (route.releaseStatus === "hide") {
    errors.push(`Mission Control Next hidden route ${route.slug} must not appear in the release-surface manifest.`);
  }
}

if (
  NEXT_VISUAL_REGRESSION_MANIFEST.length !==
  NEXT_RELEASE_SURFACE_MANIFEST.length + NEXT_VISUAL_SCENARIO_MANIFEST.length
) {
  errors.push(
    "scripts/verification/lib/release-surface-manifest.mjs must visually cover every release-surface route plus its scenario variants.",
  );
}
const visualManifestSlugs = new Set(NEXT_VISUAL_REGRESSION_MANIFEST.map((route) => route.slug));
for (const route of NEXT_RELEASE_SURFACE_MANIFEST) {
  if (!visualManifestSlugs.has(route.slug)) {
    errors.push(`Mission Control Next visual-regression manifest is missing canonical route ${route.slug}.`);
  }
}
for (const route of NEXT_VISUAL_SCENARIO_MANIFEST) {
  const key = nextReleaseRouteKey(route);
  if (!canonicalRouteKeys.has(key)) {
    errors.push(
      `Mission Control Next visual scenario ${route.slug} targets unknown canonical route ${key}.`,
    );
  }
}

for (const route of NEXT_RELEASE_SURFACE_MANIFEST) {
  if (route.expectedArea && !nextRouteModelSource.includes(`"${route.expectedArea}"`)) {
    errors.push(`Mission Control Next release-surface route ${route.slug} references unknown area ${route.expectedArea}.`);
  }
  if (
    route.expectedSection &&
    route.expectedSection !== "root" &&
    !nextRouteModelSource.includes(`"${route.expectedSection}"`)
  ) {
    errors.push(
      `Mission Control Next release-surface route ${route.slug} references unknown section ${route.expectedSection}.`,
    );
  }
}

const visualBaselineDirectory = path.join(
  root,
  "scripts",
  "verification",
  "baselines",
  "visual",
  resolveVisualBaselineNamespace("@goatcitadel/mission-control-next"),
);
const expectedVisualBaselineFiles = NEXT_VISUAL_REGRESSION_MANIFEST.flatMap((route) =>
  RELEASE_SURFACE_VARIANTS.map((variant) => buildVisualBaselineFileName(route.slug, variant.slug)),
);
const visualBaselineCoverage = await collectVisualBaselineCoverage(
  visualBaselineDirectory,
  expectedVisualBaselineFiles,
);
for (const fileName of visualBaselineCoverage.missingFiles) {
  errors.push(
    `Missing required visual baseline: ${path
      .relative(root, path.join(visualBaselineDirectory, fileName))
      .replaceAll("\\", "/")}`,
  );
}
for (const fileName of visualBaselineCoverage.unexpectedFiles) {
  errors.push(
    `Unexpected visual baseline outside the canonical manifest: ${path
      .relative(root, path.join(visualBaselineDirectory, fileName))
      .replaceAll("\\", "/")}`,
  );
}

// The root package carries the released product-line version (0.1.0 RC since
// 2026-07-04); workspace packages stay on their independently published 1.0.0
// line. A deliberate version bump must update this pin in the same change.
const expectedPackageVersions = { "package.json": "0.1.0-rc.1" };

for (const relPath of workspacePackageFiles) {
  const parsed = JSON.parse(await readFile(path.join(root, relPath), "utf8"));
  const expectedVersion = expectedPackageVersions[relPath] ?? "1.0.0";
  if (parsed.version !== expectedVersion) {
    errors.push(`${relPath} must declare version ${expectedVersion} for the GoatCitadel release line.`);
  }
  if (/--passWithNoTests/.test(JSON.stringify(parsed.scripts ?? {}))) {
    errors.push(`${relPath} must not use --passWithNoTests in release-bearing package test scripts.`);
  }
}

if (errors.length > 0) {
  console.error("[docs:check] governance docs validation failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("[docs:check] governance docs validation passed.");

function extractRelativeMarkdownLinks(content) {
  const matches = content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g);
  const links = [];
  for (const match of matches) {
    const target = match[1]?.trim();
    if (!target || target.startsWith("http://") || target.startsWith("https://") || target.startsWith("#")) {
      continue;
    }
    links.push(target);
  }
  return links;
}

async function validateRelativeMarkdownLinks(relPath, content, label = "relative link") {
  const sourceDir = path.dirname(path.join(root, relPath));
  for (const linkTarget of extractRelativeMarkdownLinks(content)) {
    const targetPath = linkTarget.split("#")[0];
    if (!targetPath) {
      continue;
    }
    const resolvedTarget = path.resolve(sourceDir, targetPath);
    try {
      await access(resolvedTarget, constants.F_OK | constants.R_OK);
    } catch {
      errors.push(`${relPath} points to a missing ${label}: ${linkTarget}`);
    }
  }
}

function deriveMissionControlNextRouteKeys(source) {
  const coworkSections = extractTypeUnionLiterals(source, "CoworkSection");
  const librarySections = extractTypeUnionLiterals(source, "LibrarySection");
  const opsSections = extractTypeUnionLiterals(source, "OpsSection");
  const settingsSections = extractTypeUnionLiterals(source, "SettingsSection");
  return [
    "chat/root",
    ...coworkSections.map((section) => `cowork/${section}`),
    "code/root",
    "projects/root",
    ...librarySections.map((section) => `library/${section}`),
    ...opsSections.map((section) => `ops/${section}`),
    ...settingsSections.map((section) => `settings/${section}`),
  ];
}

function deriveMissionControlNextRouteScopes(source) {
  const match = source.match(/export const ROUTE_RELEASE_SCOPE = \[([\s\S]*?)\] as const satisfies/);
  if (!match) {
    errors.push("apps/mission-control-next/src/app/route-model.ts must export ROUTE_RELEASE_SCOPE.");
    return [];
  }
  const entries = [];
  // Use `:\s*"` (not `: "`) so the parser tolerates Prettier wrapping a long
  // string value onto the next line (e.g. `releaseAction:\n  "..."`).
  for (const item of match[1].matchAll(
    /\{\s*area:\s*"([^"]+)",\s*section:\s*"([^"]+)",\s*status:\s*"([^"]+)",\s*releaseAction:\s*"([^"]+)",\s*verification:\s*"([^"]+)",\s*note:\s*"([^"]+)",\s*\}/g,
  )) {
    entries.push({
      expectedArea: item[1],
      expectedSection: item[2],
      status: item[3],
      releaseAction: item[4],
      verification: item[5],
      note: item[6],
    });
  }
  if (entries.length === 0) {
    errors.push("apps/mission-control-next/src/app/route-model.ts ROUTE_RELEASE_SCOPE must be parseable.");
  }
  return entries;
}

function extractTypeUnionLiterals(source, typeName) {
  const match = source.match(new RegExp(`export type ${typeName} =([\\s\\S]*?);`));
  if (!match) {
    errors.push(`apps/mission-control-next/src/app/route-model.ts is missing ${typeName}.`);
    return [];
  }
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

function nextReleaseRouteKey(route) {
  return `${route.canonicalArea ?? route.expectedArea}/${route.canonicalSection ?? route.expectedSection ?? "root"}`;
}

function validateReleaseSurfaceScopeDoc(source, canonicalRoutes) {
  const documentedRows = parseReleaseSurfaceScopeRows(source);
  const documentedByRoute = new Map();
  for (const row of documentedRows) {
    if (documentedByRoute.has(row.route)) {
      errors.push(`docs/1_0_RELEASE_SURFACE_SCOPE.md repeats route ${row.route}.`);
      continue;
    }
    if (!VALID_RELEASE_SURFACE_STATUSES.has(row.status)) {
      errors.push(`docs/1_0_RELEASE_SURFACE_SCOPE.md route ${row.route} uses unknown status ${row.status}.`);
    }
    documentedByRoute.set(row.route, row);
  }

  const canonicalByRoute = new Map(canonicalRoutes.map((route) => [releaseScopeDocRoutePath(route), route]));
  for (const [routePath, route] of canonicalByRoute) {
    const documented = documentedByRoute.get(routePath);
    if (!documented) {
      errors.push(`docs/1_0_RELEASE_SURFACE_SCOPE.md is missing canonical route ${routePath}.`);
      continue;
    }
    if (documented.status !== route.status) {
      errors.push(
        `docs/1_0_RELEASE_SURFACE_SCOPE.md route ${routePath} must use status ${route.status}, not ${documented.status}.`,
      );
    }
  }

  for (const routePath of documentedByRoute.keys()) {
    if (!canonicalByRoute.has(routePath)) {
      errors.push(`docs/1_0_RELEASE_SURFACE_SCOPE.md includes non-canonical route ${routePath}.`);
    }
  }
}

function parseReleaseSurfaceScopeRows(source) {
  const rows = [];
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/);
    if (!match) {
      continue;
    }
    rows.push({ route: match[1], status: match[2] });
  }
  return rows;
}

function validateReleaseEvidenceCounts(source, canonicalRoutes) {
  const expectedCounts = countReleaseStatuses(canonicalRoutes);
  const match = source.match(
    /current `1\.0` surface is (\d+) visible routes: (\d+) `ship`, (\d+) `needs_release_polish`, and (\d+) `experimental`/i,
  );
  if (!match) {
    errors.push("docs/1_0_RELEASE_EVIDENCE.md must declare the current visible route status counts.");
    return;
  }

  const actual = {
    total: Number(match[1]),
    ship: Number(match[2]),
    needs_release_polish: Number(match[3]),
    experimental: Number(match[4]),
  };
  const expected = {
    total: canonicalRoutes.length,
    ship: expectedCounts.ship,
    needs_release_polish: expectedCounts.needs_release_polish,
    experimental: expectedCounts.experimental,
  };
  for (const key of Object.keys(expected)) {
    if (actual[key] !== expected[key]) {
      errors.push(`docs/1_0_RELEASE_EVIDENCE.md route count ${key} must be ${expected[key]}, not ${actual[key]}.`);
    }
  }
}

function validateReadmeRouteCounts(source, canonicalRoutes) {
  const expectedCounts = countReleaseStatuses(canonicalRoutes);
  const match = source.match(
    /current visible route surface is (\d+) routes: (\d+) `ship`, (\d+) `needs_release_polish`, and (\d+) `experimental`/i,
  );
  if (!match) {
    errors.push("README.md must declare the current visible route status counts in the Current Release Truth table.");
    return;
  }
  const actual = {
    total: Number(match[1]),
    ship: Number(match[2]),
    needs_release_polish: Number(match[3]),
    experimental: Number(match[4]),
  };
  const expected = {
    total: canonicalRoutes.length,
    ship: expectedCounts.ship,
    needs_release_polish: expectedCounts.needs_release_polish,
    experimental: expectedCounts.experimental,
  };
  for (const key of Object.keys(expected)) {
    if (actual[key] !== expected[key]) {
      errors.push(`README.md route count ${key} must be ${expected[key]}, not ${actual[key]}.`);
    }
  }
}

function countReleaseStatuses(routes) {
  const counts = {
    ship: 0,
    needs_release_polish: 0,
    experimental: 0,
  };
  for (const route of routes) {
    if (route.status in counts) {
      counts[route.status] += 1;
    }
  }
  return counts;
}

function releaseScopeDocRoutePath(route) {
  if (route.expectedArea === "cowork" && route.expectedSection === "workspace") {
    return "/cowork";
  }
  if (route.expectedSection === "root") {
    return `/${route.expectedArea}`;
  }
  return `/${route.expectedArea}/${route.expectedSection}`;
}
