import type { A2UIProofLaneDraft, FollowOnParityReport, FollowOnProofLaneStepRecord } from "@goatcitadel/contracts";
import { GATEWAY_FOLLOW_ON_PROOF_LANE_SPECS } from "./follow-on-proof-lane-metadata.js";

const A2UI_PROOF_LANE = GATEWAY_FOLLOW_ON_PROOF_LANE_SPECS.a2ui;

export function buildA2UIProofLaneDraft(report: FollowOnParityReport): A2UIProofLaneDraft {
  const generatedAt = new Date().toISOString();
  const contract = report.canvas.contract;
  const canvasCatalogReady = Boolean(
    report.canvas.automationCatalog
    && report.canvas.automationCatalog.maturity !== "planned"
    && report.canvas.automationCatalog.maturity !== "disabled",
  );
  const missionControlReady = (contract?.scopes.includes("ui_canvas") ?? false) && canvasCatalogReady;
  const companionDeclared = report.canvas.platformTargets.length > 0;
  const proofCurrent = report.canvas.artifactStatus.hasArtifact
    && report.canvas.artifactStatus.freshness === "current"
    && report.canvas.artifactStatus.matchedCurrentProfile;
  const steps: FollowOnProofLaneStepRecord[] = [
    {
      stepId: "preflight",
      title: "Capture live A2UI contract state",
      status: contract ? "ready" : "blocked",
      instructions: contract
        ? `Confirm ${contract.contractId}, scopes (${contract.scopes.join(", ")}), transports (${contract.transports.join(", ")}), and the current canvas summary from System before starting operator proof.`
        : "Resolve the missing A2UI contract before attempting any proof-lane claim.",
      evidenceHint: "Capture the System-page contract summary, parity summary, and current canvas/companion target list.",
    },
    {
      stepId: "mission-control",
      title: "Run the Office Lab handoff and directed-move proof",
      status: missionControlReady ? "ready" : "blocked",
      instructions: missionControlReady
        ? "Open Office Lab, capture the zone-level canvas state first, then select an agent from the canvas or deck controls and confirm both the Citadel One readout and Inspector panel switch from zone context to agent context. After that, direct the selected agent to a seat or tile and confirm the readout plus Inspector canvas-command field reflect the movement instruction."
        : !canvasCatalogReady
          ? "Canvas + A2UI is still marked below an operator-ready catalog maturity, so the Mission Control proof lane should stay blocked."
          : "Mission Control canvas scope is not currently resolved in the contract.",
      evidenceHint: "Capture before/after screenshots or notes showing the zone-to-agent handoff, then the directed seat/tile command appearing in the readout and Inspector canvas-command field.",
    },
    {
      stepId: "boundary",
      title: "Record companion-session boundary honestly",
      status: companionDeclared ? "ready" : "blocked",
      instructions: companionDeclared
        ? proofCurrent
          ? "Document that companion-session scope is declared in a2ui.v1 and that Android-resident companion proof is now on file for the current deployment profile."
          : "Document that companion-session scope is declared in a2ui.v1 but still lacks an end-to-end companion.android.v1 proof run, and confirm the current proof claim stays Mission-Control-first."
        : "No companion-capable platform targets are declared, so platform boundary proof cannot be recorded yet.",
      evidenceHint: proofCurrent
        ? "Capture the declared platform targets together with the Android proof bundle and confirm the companion-backed Canvas lane matches the current contract."
        : "Capture the declared platform targets and a note that the existing mobile lane is not yet proven for companion-session A2UI work.",
    },
    {
      stepId: "bundle",
      title: "Complete the A2UI proof bundle",
      status: contract && missionControlReady ? "ready" : "blocked",
      instructions: `Fill ${A2UI_PROOF_LANE.templatePath} using ${A2UI_PROOF_LANE.checklistPath}.`,
      evidenceHint: "Attach System-page notes, canvas screenshots, operator notes, and any blocked companion-session expectations.",
    },
  ];

  const blockingIssues = [
    ...report.canvas.blockingIssues,
    ...steps.filter((step) => step.status === "blocked").map((step) => `${step.title} is blocked.`),
  ];
  const summary = contract && missionControlReady
    ? proofCurrent
      ? `A2UI proof lane is current for ${contract.contractId}; Android Canvas proof is on file for the active deployment profile and should only be rerun when runtime truth changes.`
      : `A2UI proof lane is ready for a Mission-Control-first Office Lab handoff and directed-move pass with ${contract.contractId}; companion-session expansion remains unproven.`
    : "A2UI proof lane is blocked until the live contract, Mission Control canvas scope, and an operator-ready canvas catalog entry are all available.";

  return {
    generatedAt,
    deploymentProfile: report.deploymentProfile,
    authMode: report.authMode,
    summary,
    checklistPath: A2UI_PROOF_LANE.checklistPath,
    templatePath: A2UI_PROOF_LANE.templatePath,
    blockingIssues: Array.from(new Set(blockingIssues)),
    steps,
    markdown: buildA2UIProofLaneMarkdown(report, generatedAt, summary, steps),
  };
}

export function buildA2UIProofLaneArtifactPath(draft: A2UIProofLaneDraft): string {
  const day = draft.generatedAt.slice(0, 10);
  const timestamp = draft.generatedAt
    .replaceAll(":", "-")
    .replaceAll(".", "-");
  return `${A2UI_PROOF_LANE.artifactRoot}/${day}/a2ui-proof-bundle-${draft.deploymentProfile}-${timestamp}.md`;
}

function buildA2UIProofLaneMarkdown(
  report: FollowOnParityReport,
  generatedAt: string,
  summary: string,
  steps: FollowOnProofLaneStepRecord[],
): string {
  const contract = report.canvas.contract;
  return [
    "# A2UI Proof Bundle Draft",
    "",
    `Generated: ${generatedAt}`,
    `Deployment profile: ${report.deploymentProfile}`,
    `Auth mode: ${report.authMode}`,
    `Checklist: ${A2UI_PROOF_LANE.checklistPath}`,
    `Template: ${A2UI_PROOF_LANE.templatePath}`,
    "",
    "## Summary",
    summary,
    "",
    "## Live Runtime Snapshot",
    `- Contract: ${contract?.contractId ?? "missing"}`,
    `- Operator surface: ${contract?.operatorSurface ?? "missing"}`,
    `- Scopes: ${contract?.scopes.join(", ") ?? "missing"}`,
    `- Transports: ${contract?.transports.join(", ") ?? "missing"}`,
    `- Canvas summary: ${report.canvas.paritySummary}`,
    `- Platform targets: ${report.canvas.platformTargets.length}`,
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
