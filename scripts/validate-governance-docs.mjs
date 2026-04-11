import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const root = process.cwd();

const requiredFiles = [
  "README.md",
  "CHANGELOG.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs/1_0_CONTRACT.md",
  "docs/CANONICAL_RUNTIME_STATE_MODEL.md",
  "docs/ENGINEERING_HANDBOOK.md",
];

const requiredHeadings = {
  "CHANGELOG.md": ["# Changelog", "## [Unreleased]"],
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
};

const errors = [];

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

const runtimeStatePath = path.join(root, "docs", "CANONICAL_RUNTIME_STATE_MODEL.md");
const runtimeState = await readFile(runtimeStatePath, "utf8");
if (!/^Last updated:/m.test(runtimeState)) {
  errors.push("docs/CANONICAL_RUNTIME_STATE_MODEL.md must include a Last updated header.");
}
if (!/approval wait\/resume/i.test(runtimeState) || !/legacy traces without durable linkage/i.test(runtimeState)) {
  errors.push("docs/CANONICAL_RUNTIME_STATE_MODEL.md must name the durably owned chat/approval flows and remaining compatibility fallbacks.");
}
if (!/MemoryLifecycleService/.test(runtimeState)) {
  errors.push("docs/CANONICAL_RUNTIME_STATE_MODEL.md must name MemoryLifecycleService as the memory lifecycle owner.");
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
if (!/visible `beta` integrations in Mission Control now expose real operator actions backed by runtime handlers/i.test(readme)) {
  errors.push("README.md must describe visible beta integrations as real operator-action runtimes, not diagnostics-only shells.");
}
if (!/verify:visual:regression` compares checked-in shell and primary-surface baselines/i.test(readme)) {
  errors.push("README.md must describe verify:visual:regression as baseline comparison, not screenshot capture only.");
}
if (!/verify:backup:roundtrip` now restores and verifies the full minimum operator backup set/i.test(readme)) {
  errors.push("README.md must describe verify:backup:roundtrip as restoring the full minimum operator backup set.");
}

const installDoc = await readFile(path.join(root, "docs", "INSTALL_SETUP_TESTING.md"), "utf8");
if (!/optional experimental infrastructure/i.test(installDoc) || !/not part of the current `1\.0` readiness bar/i.test(installDoc)) {
  errors.push("docs/INSTALL_SETUP_TESTING.md must describe the NPU sidecar as optional experimental infrastructure outside the current 1.0 bar.");
}
if (!/docs\/1_0_CONTRACT\.md/.test(installDoc)) {
  errors.push("docs/INSTALL_SETUP_TESTING.md must point readers to docs/1_0_CONTRACT.md for the current 1.0 scope and release gates.");
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
if (!/backup operations include create, list, verify, and restore/i.test(contract)) {
  errors.push("docs/1_0_CONTRACT.md must describe the shipped backup create/list/verify/restore guarantee.");
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
if (!/mesh-core/i.test(contract) || !/smoke-only/i.test(contract)) {
  errors.push("docs/1_0_CONTRACT.md must keep mesh-core outside the readiness-bearing 1.0 story while it remains smoke-only.");
}
if (!/npu-sidecar/i.test(contract) || !/optional experimental infrastructure/i.test(contract)) {
  errors.push("docs/1_0_CONTRACT.md must keep the NPU sidecar outside the readiness-bearing 1.0 story while it remains experimental.");
}

if (errors.length > 0) {
  console.error("[docs:check] governance docs validation failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("[docs:check] governance docs validation passed.");
