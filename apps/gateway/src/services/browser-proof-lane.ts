import type { BrowserProofLaneDraft, FollowOnParityReport, FollowOnProofLaneStepRecord } from "@goatcitadel/contracts";
import { GATEWAY_FOLLOW_ON_PROOF_LANE_SPECS } from "./follow-on-proof-lane-metadata.js";

const BROWSER_PROOF_LANE = GATEWAY_FOLLOW_ON_PROOF_LANE_SPECS.browser;

export function buildBrowserProofLaneDraft(report: FollowOnParityReport): BrowserProofLaneDraft {
  const generatedAt = new Date().toISOString();
  const interactionReady = !report.browser.blockingIssues.includes("No browser interaction tool is currently registered.");
  const browserCatalogReady = Boolean(
    report.browser.automationCatalog
    && report.browser.automationCatalog.maturity !== "planned"
    && report.browser.automationCatalog.maturity !== "disabled",
  );
  const browserReady = report.browser.readToolCount > 0
    && report.browser.controlToolCount > 0
    && interactionReady
    && browserCatalogReady;
  const blockedStateTools = report.browser.stateToolRuntime.blockedTools;
  const allowedStateTools = report.browser.stateToolRuntime.allowedTools;
  const stateToolRestrictionNote = blockedStateTools.length > 0
    ? `${blockedStateTools.join(", ")} are blocked in ${report.deploymentProfile} because browser state tools are restricted to ${report.browser.stateToolRuntime.restrictedToProfile}.`
    : allowedStateTools.length > 0
      ? `${allowedStateTools.join(", ")} are available in ${report.deploymentProfile} for same-session cookie/storage proof.`
      : "No browser cookie/storage state tools are currently registered.";
  const steps: FollowOnProofLaneStepRecord[] = [
    {
      stepId: "preflight",
      title: "Confirm live browser surface",
      status: browserReady ? "ready" : "blocked",
      instructions: browserReady
        ? `Confirm that the current runtime exposes ${report.browser.readToolCount} read tool(s) and ${report.browser.controlToolCount} control tool(s). ${stateToolRestrictionNote} Then start the operator pass from Mission Control or the tool surface.`
        : !browserCatalogReady
          ? "Promote the browser automation catalog entry to an operator-ready maturity before attempting the proof lane."
          : !interactionReady
            ? "Expose browser.interact before attempting the proof lane, because the operator pass requires click/input validation."
          : "Resolve missing browser read or control tools before attempting the proof lane.",
      evidenceHint: "Capture the current browser tool counts, catalog maturity, and deployment posture.",
    },
    {
      stepId: "read-path",
      title: "Run a read-only browser pass",
      status: report.browser.readToolCount > 0 ? "ready" : "blocked",
      instructions: "Navigate to a safe target, extract structured content, and capture one screenshot artifact.",
      evidenceHint: "Record the target URL, extracted result, and screenshot path.",
    },
    {
      stepId: "control-path",
      title: "Run a controlled interaction pass",
      status: report.browser.controlToolCount > 0 && interactionReady ? "ready" : "blocked",
      instructions: !interactionReady
        ? "browser.interact is not currently available, so the click/input proof step is blocked."
        : blockedStateTools.length > 0
          ? `Run one mutating interaction with verify-step and confirm-before-submit enabled when required, then explicitly record that ${blockedStateTools.join(", ")} are unavailable in ${report.deploymentProfile}.`
          : allowedStateTools.length > 0
            ? `Run one controlled interaction flow, then use ${allowedStateTools.join(", ")} to capture same-session cookie/storage proof without relying on undocumented local state.`
            : "Run one controlled interaction flow that proves input/click behavior without relying on undocumented local state.",
      evidenceHint: "Record the action path, guardrail settings, and resulting page state.",
    },
    {
      stepId: "bundle",
      title: "Complete the proof bundle",
      status: browserReady ? "ready" : "blocked",
      instructions: `Fill ${BROWSER_PROOF_LANE.templatePath} using the checklist in ${BROWSER_PROOF_LANE.checklistPath}.`,
      evidenceHint: "Attach screenshots, extracted output, operator notes, and any policy constraints or failures.",
    },
  ];

  const blockingIssues = [
    ...report.browser.blockingIssues,
    ...steps.filter((step) => step.status === "blocked").map((step) => `${step.title} is blocked.`),
  ];
  const summary = browserReady
    ? blockedStateTools.length > 0
      ? `Browser proof lane is ready for ${report.deploymentProfile} with ${report.browser.readToolCount} read tool(s), ${report.browser.controlToolCount} control tool(s), and ${blockedStateTools.length} state tool(s) intentionally blocked by profile guardrails.`
      : `Browser proof lane is ready for ${report.deploymentProfile} with ${report.browser.readToolCount} read tool(s), ${report.browser.controlToolCount} control tool(s), and live state-tool access for same-session proof.`
    : "Browser proof lane is blocked until read tools, browser.interact, and an operator-ready browser catalog are all available.";

  return {
    generatedAt,
    deploymentProfile: report.deploymentProfile,
    authMode: report.authMode,
    summary,
    checklistPath: BROWSER_PROOF_LANE.checklistPath,
    templatePath: BROWSER_PROOF_LANE.templatePath,
    blockingIssues: Array.from(new Set(blockingIssues)),
    steps,
    markdown: buildBrowserProofLaneMarkdown(report, generatedAt, summary, steps),
  };
}

export function buildBrowserProofLaneArtifactPath(draft: BrowserProofLaneDraft): string {
  const day = draft.generatedAt.slice(0, 10);
  const timestamp = draft.generatedAt
    .replaceAll(":", "-")
    .replaceAll(".", "-");
  return `${BROWSER_PROOF_LANE.artifactRoot}/${day}/browser-control-proof-bundle-${draft.deploymentProfile}-${timestamp}.md`;
}

function buildBrowserProofLaneMarkdown(
  report: FollowOnParityReport,
  generatedAt: string,
  summary: string,
  steps: FollowOnProofLaneStepRecord[],
): string {
  return [
    "# Browser Control Proof Bundle Draft",
    "",
    `Generated: ${generatedAt}`,
    `Deployment profile: ${report.deploymentProfile}`,
    `Auth mode: ${report.authMode}`,
    `Checklist: ${BROWSER_PROOF_LANE.checklistPath}`,
    `Template: ${BROWSER_PROOF_LANE.templatePath}`,
    "",
    "## Summary",
    summary,
    "",
    "## Live Runtime Snapshot",
    `- Browser tools: ${report.browser.totalToolCount} total`,
    `- Read tools: ${report.browser.readToolCount}`,
    `- Control tools: ${report.browser.controlToolCount}`,
    `- Catalog maturity: ${report.browser.automationCatalog?.maturity ?? "missing"}`,
    `- Guardrail summary: ${report.browser.guardrailSummary}`,
    `- State tools registered: ${report.browser.stateToolRuntime.registeredTools.length > 0 ? report.browser.stateToolRuntime.registeredTools.join(", ") : "none"}`,
    `- State tools allowed in ${report.deploymentProfile}: ${report.browser.stateToolRuntime.allowedTools.length > 0 ? report.browser.stateToolRuntime.allowedTools.join(", ") : "none"}`,
    `- State tools blocked in ${report.deploymentProfile}: ${report.browser.stateToolRuntime.blockedTools.length > 0 ? report.browser.stateToolRuntime.blockedTools.join(", ") : "none"}`,
    "",
    "## Lane Steps",
    ...steps.flatMap((step, index) => [
      `${index + 1}. ${step.title} [${step.status}]`,
      `Instructions: ${step.instructions}`,
      `Evidence: ${step.evidenceHint}`,
      "",
    ]),
  ].join("\n");
}
