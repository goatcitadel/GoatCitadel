import type { ExtensionSdkBriefDraft, FollowOnParityReport } from "@goatcitadel/contracts";

const EXTENSION_CONTRACT_PATH = "docs/PLUGIN_SDK_CONTRACT.md";
const EXTENSION_SDK_PACKAGE_PATH = "packages/extensions-sdk";
const EXTENSION_TEMPLATE_PATH = "templates/verification/extension-sdk-brief.md";
const EXTENSION_ARTIFACT_ROOT = "artifacts/follow-on-parity/extensions";

export function buildExtensionSdkBrief(report: FollowOnParityReport): ExtensionSdkBriefDraft {
  const generatedAt = new Date().toISOString();
  const summary = `${report.plugins.sdkSummary} The next safe public artifact is now a published SDK package or broader runtime-contract decision, not a broad runtime promise.`;

  return {
    generatedAt,
    summary,
    markdown: [
      "# Extension SDK Brief",
      "",
      `Generated: ${generatedAt}`,
      `Deployment profile: ${report.deploymentProfile}`,
      `Auth mode: ${report.authMode}`,
      `Contract doc: ${EXTENSION_CONTRACT_PATH}`,
      `Workspace SDK package: ${EXTENSION_SDK_PACKAGE_PATH}`,
      `Template baseline: ${EXTENSION_TEMPLATE_PATH}`,
      "",
      "## Summary",
      summary,
      "",
      "## Live Extension Snapshot",
      `- Add-on catalog count: ${report.addons.catalogCount}`,
      `- Installed add-ons: ${report.addons.installedCount}`,
      `- Running add-ons: ${report.addons.runningCount}`,
      `- Registered integration plugins: ${report.plugins.totalCount}`,
      `- Enabled integration plugins: ${report.plugins.enabledCount}`,
      "",
      "## Current Contract Boundary",
      `- SDK summary: ${report.plugins.sdkSummary}`,
      `- Reference plugin present: ${report.plugins.referenceLifecycle.present ? "yes" : "no"}`,
      `- Reference plugin enabled: ${report.plugins.referenceLifecycle.enabled ? "yes" : "no"}`,
      `- Reference plugin source aligned: ${report.plugins.referenceLifecycle.matchesReferenceSource ? "yes" : "no"}`,
      `- Reference plugin capabilities: ${report.plugins.referenceLifecycle.capabilities.length > 0 ? report.plugins.referenceLifecycle.capabilities.join(", ") : "none recorded"}`,
      `- Blocking issues: ${report.plugins.blockingIssues.length > 0 ? report.plugins.blockingIssues.join(" | ") : "none"}`,
      "",
      "## Authoring Baseline",
      "- Keep add-on authoring aligned to the documented add-on contract baseline.",
      `- Use ${EXTENSION_SDK_PACKAGE_PATH} as the local author SDK baseline while external publication is pending.`,
      "- Keep integration plugin authoring aligned to the manifest and lifecycle baseline.",
      "- Use the local reference integration plugin scaffold as the repeatable smoke path.",
      "",
      "## Next Actions",
      ...report.plugins.recommendedActions.map((action, index) => `${index + 1}. ${action}`),
      "",
      "## Decision Gate",
      "1. Decide whether the next public artifact is a published SDK package, a broader runtime contract, or both.",
      "2. Keep the starter-pack export plus the reference integration-plugin install and enable/disable path green while that decision is pending.",
      "",
    ].join("\n"),
  };
}

export function buildExtensionSdkArtifactPath(draft: ExtensionSdkBriefDraft): string {
  const day = draft.generatedAt.slice(0, 10);
  const timestamp = draft.generatedAt
    .replaceAll(":", "-")
    .replaceAll(".", "-");
  return `${EXTENSION_ARTIFACT_ROOT}/${day}/extension-sdk-brief-${timestamp}.md`;
}
