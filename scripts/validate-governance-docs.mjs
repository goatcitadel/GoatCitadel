import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import {
  buildVisualBaselineFileName,
  RELEASE_SURFACE_MANIFEST,
  RELEASE_SURFACE_VARIANTS,
} from "./verification/lib/release-surface-manifest.mjs";

const root = process.cwd();

const requiredFiles = [
  "README.md",
  "CHANGELOG.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs/1_0_CONTRACT.md",
  "docs/1_0_RELEASE_EVIDENCE.md",
  "docs/CANONICAL_RUNTIME_STATE_MODEL.md",
  "docs/DURABLE_RUNS_REPLAY_FOUNDATION.md",
  "docs/ENGINEERING_HANDBOOK.md",
];

const requiredHeadings = {
  "CHANGELOG.md": ["# Changelog", "## [Unreleased]", "## [1.0.0]"],
  "AGENTS.md": ["# GoatCitadel Agent Conventions", "## Agent Roles", "## Safety Boundaries (Non-Overridable)"],
  "CONTRIBUTING.md": ["# Contributing to GoatCitadel", "## Quality Gates", "## Governance Docs Policy"],
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
};

const errors = [];

const workspacePackageFiles = [
  "package.json",
  "apps/gateway/package.json",
  "apps/mission-control/package.json",
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

const handbookPath = path.join(root, "docs", "ENGINEERING_HANDBOOK.md");
const handbook = await readFile(handbookPath, "utf8");
if (/as of February 2026/i.test(handbook)) {
  errors.push("docs/ENGINEERING_HANDBOOK.md contains a stale date claim.");
}
if (/F:\\code\\personal-ai/i.test(handbook)) {
  errors.push("docs/ENGINEERING_HANDBOOK.md contains a machine-specific repo path claim.");
}
if (/system truth/i.test(handbook)) {
  errors.push("docs/ENGINEERING_HANDBOOK.md must not claim repo-wide system truth.");
}
if (!/MemoryLifecycleService/.test(handbook)) {
  errors.push("docs/ENGINEERING_HANDBOOK.md must name MemoryLifecycleService as the memory lifecycle owner.");
}
if (!/mesh-core/i.test(handbook) || !/smoke-only/i.test(handbook)) {
  errors.push("docs/ENGINEERING_HANDBOOK.md must de-scope mesh-core from the current 1.0 bar.");
}
if (!/npu-sidecar/i.test(handbook) || !/not part of the current `1\.0` bar/i.test(handbook)) {
  errors.push("docs/ENGINEERING_HANDBOOK.md must de-scope the NPU sidecar from the current 1.0 bar.");
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
if (!/verify:catalog:parity` must execute real operator actions/i.test(handbook)) {
  errors.push("docs/ENGINEERING_HANDBOOK.md must describe catalog-parity as runtime action proof, not metadata-only checks.");
}
if (!/verify:api:compat` must snapshot REST schemas and realtime event envelopes/i.test(handbook)) {
  errors.push("docs/ENGINEERING_HANDBOOK.md must describe the REST/SSE additive-compatibility lane.");
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
if (!/default to `true`/i.test(durableFoundation) || !/Shipped Chat \/ Cowork \/ Code operator sends/i.test(durableFoundation)) {
  errors.push("docs/DURABLE_RUNS_REPLAY_FOUNDATION.md must match the shipped durable-by-default posture for Chat/Cowork/Code operator flows.");
}
if (/default:\s*`false`/i.test(durableFoundation) || /Next Step \(Activation Plan\)/i.test(durableFoundation) || /keep the feature disabled by default/i.test(durableFoundation)) {
  errors.push("docs/DURABLE_RUNS_REPLAY_FOUNDATION.md must not reintroduce stale default-off or activation-plan language.");
}

const readme = await readFile(path.join(root, "README.md"), "utf8");
if (!/mesh-core/i.test(readme) || !/smoke-only/i.test(readme)) {
  errors.push("README.md must describe mesh-core as smoke-only while it uses --passWithNoTests.");
}
if (!/NPU sidecar maturity or local-inference completeness as a `1\.0` signal/i.test(readme)) {
  errors.push("README.md must keep the NPU sidecar de-scoped from the 1.0 readiness bar.");
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
if (!/verify:visual:regression` compares checked-in shell and primary-surface baselines/i.test(readme)) {
  errors.push("README.md must describe verify:visual:regression as baseline comparison, not screenshot capture only.");
}
if (!/verify:backup:roundtrip` now restores and verifies the full minimum operator backup set/i.test(readme)) {
  errors.push("README.md must describe verify:backup:roundtrip as restoring the full minimum operator backup set.");
}
if (!/contractVerified/i.test(readme)) {
  errors.push("README.md must describe backup verify as reporting contractVerified minimum-set truth.");
}
if (/late beta/i.test(readme) || /release-0\.9/i.test(readme) || /before `1\.0`/i.test(readme)) {
  errors.push("README.md must not describe GoatCitadel as beta or pre-1.0.");
}
if (!/release-1\.0\.0/i.test(readme)) {
  errors.push("README.md must expose the 1.0.0 release badge.");
}
if (!/offline_restore_required/i.test(readme) || !/offline-only/i.test(readme)) {
  errors.push("README.md must describe filesystem-backed restore as offline-only and name the offline_restore_required live-route response.");
}
if (!/verify:catalog:parity` now executes real operator actions/i.test(readme)) {
  errors.push("README.md must describe verify:catalog:parity as runtime action proof.");
}
if (!/verify:api:compat` snapshots REST schemas and realtime event envelopes/i.test(readme)) {
  errors.push("README.md must describe the REST/SSE compatibility lane.");
}

const installDoc = await readFile(path.join(root, "docs", "INSTALL_SETUP_TESTING.md"), "utf8");
if (!/optional experimental infrastructure/i.test(installDoc) || !/not part of the current `1\.0` readiness bar/i.test(installDoc)) {
  errors.push("docs/INSTALL_SETUP_TESTING.md must describe the NPU sidecar as optional experimental infrastructure outside the current 1.0 bar.");
}
if (!/docs\/1_0_CONTRACT\.md/.test(installDoc)) {
  errors.push("docs/INSTALL_SETUP_TESTING.md must point readers to docs/1_0_CONTRACT.md for the current 1.0 scope and release gates.");
}
if (/Target release: `0\.9\.0-beta\.1`/i.test(installDoc) || /public beta testers/i.test(installDoc)) {
  errors.push("docs/INSTALL_SETUP_TESTING.md must not describe the target release as beta.");
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
if (!/local-first AI workbench/i.test(contract)) {
  errors.push("docs/1_0_CONTRACT.md must define GoatCitadel 1.0 as a local-first AI workbench.");
}
if (!/Work`: Chat, Cowork, Code, Tasks, Approvals/i.test(contract) || !/Observe`: Timeline, Health, Artifacts, Quality/i.test(contract) || !/Tune`: General, Runtime, Workspaces, Integrations, Tools, Agents/i.test(contract)) {
  errors.push("docs/1_0_CONTRACT.md must freeze the visible 1.0 footprint as Work / Observe / Tune.");
}
if (!/trusted-code surface/i.test(contract) || !/best-effort and fail-closed/i.test(contract)) {
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
if (!/verify:catalog:parity` is green and executes real runtime-backed operator actions/i.test(contract)) {
  errors.push("docs/1_0_CONTRACT.md must require catalog-parity runtime action proof.");
}
if (!/verify:api:compat` is green and fails on breaking REST route\/schema or realtime event-envelope diffs/i.test(contract)) {
  errors.push("docs/1_0_CONTRACT.md must require the REST/SSE additive-compatibility gate.");
}
if (!/mesh-core/i.test(contract) || !/smoke-only/i.test(contract)) {
  errors.push("docs/1_0_CONTRACT.md must keep mesh-core outside the readiness-bearing 1.0 story while it remains smoke-only.");
}
if (!/npu-sidecar/i.test(contract) || !/optional experimental infrastructure/i.test(contract)) {
  errors.push("docs/1_0_CONTRACT.md must keep the NPU sidecar outside the readiness-bearing 1.0 story while it remains experimental.");
}

const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
if (/semantic pre-release versions/i.test(changelog) || /public surface is still settling/i.test(changelog)) {
  errors.push("CHANGELOG.md must not keep stale pre-release boilerplate at the top of the file.");
}

const releaseEvidencePath = path.join(root, "docs", "1_0_RELEASE_EVIDENCE.md");
const releaseEvidence = await readFile(releaseEvidencePath, "utf8");
for (const [index, line] of releaseEvidence.split(/\r?\n/).entries()) {
  if (
    /\]\(\.\.\/apps\/mission-control\//.test(line) &&
    !/(compatibility-only|legacy|rollback|parity)/i.test(line)
  ) {
    errors.push(
      `docs/1_0_RELEASE_EVIDENCE.md:${index + 1} cites apps/mission-control without labeling it compatibility-only evidence.`,
    );
  }
}
for (const linkTarget of extractRelativeMarkdownLinks(releaseEvidence)) {
  const resolvedTarget = path.resolve(path.dirname(releaseEvidencePath), linkTarget);
  try {
    await access(resolvedTarget, constants.F_OK | constants.R_OK);
  } catch {
    errors.push(`docs/1_0_RELEASE_EVIDENCE.md points to a missing proof anchor: ${linkTarget}`);
  }
}

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
if (!/release-surface-manifest\.mjs/.test(scenariosSource) || !/RELEASE_SURFACE_MANIFEST/.test(scenariosSource)) {
  errors.push("scripts/verification/lib/scenarios.mjs must derive release-bearing route coverage from the shared release-surface manifest.");
}

if (RELEASE_SURFACE_MANIFEST.length !== 15) {
  errors.push("scripts/verification/lib/release-surface-manifest.mjs must freeze the 15 release-bearing primary surfaces.");
}

for (const route of RELEASE_SURFACE_MANIFEST) {
  for (const variant of RELEASE_SURFACE_VARIANTS) {
    const baselinePath = path.join(
      root,
      "scripts",
      "verification",
      "baselines",
      "visual",
      buildVisualBaselineFileName(route.slug, variant.slug),
    );
    try {
      await access(baselinePath, constants.F_OK | constants.R_OK);
    } catch {
      errors.push(`Missing required visual baseline: ${path.relative(root, baselinePath).replaceAll("\\", "/")}`);
    }
  }
}

for (const relPath of workspacePackageFiles) {
  const parsed = JSON.parse(await readFile(path.join(root, relPath), "utf8"));
  if (parsed.version !== "1.0.0") {
    errors.push(`${relPath} must declare version 1.0.0 for the GoatCitadel 1.0 release branch.`);
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
