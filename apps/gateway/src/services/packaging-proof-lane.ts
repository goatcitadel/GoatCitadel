import type {
  FollowOnParityReport,
  FollowOnProofLaneStepRecord,
  PackagingProofLaneDraft,
} from "@goatcitadel/contracts";
import { GATEWAY_FOLLOW_ON_PROOF_LANE_SPECS } from "./follow-on-proof-lane-metadata.js";
import {
  buildProofLaneArtifactPath,
  formatProofLaneMarkdownHeader,
  formatProofLaneStepsSection,
  mergeProofLaneBlockingIssues,
} from "./proof-lane-helpers.js";

const PACKAGING_PROOF_LANE = GATEWAY_FOLLOW_ON_PROOF_LANE_SPECS.packaging;

export function buildPackagingProofLaneDraft(report: FollowOnParityReport): PackagingProofLaneDraft {
  const generatedAt = new Date().toISOString();
  const hardenedPostureConfigured =
    report.packaging.networkAllowlistCount > 0 && !report.packaging.allowLoopbackBypass && report.authMode !== "none";
  const hardenedReady = report.deploymentProfile === "remote_hardened" && hardenedPostureConfigured;
  const proofStatus = report.packaging.proofStatus ?? {
    hasArtifact: false,
    freshness: "missing" as const,
    matchedCurrentProfile: false,
  };
  const latestProofNote = !proofStatus.hasArtifact
    ? "No prior packaging proof artifact is recorded yet."
    : proofStatus.freshness === "stale"
      ? `Latest packaging proof artifact is ${proofStatus.ageDays ?? "an unknown number of"} day(s) old and should be refreshed.`
      : proofStatus.matchedCurrentProfile
        ? `Latest packaging proof artifact already matches ${report.deploymentProfile}.`
        : `Latest packaging proof artifact targets ${proofStatus.latestArtifactDeploymentProfile ?? "an unknown profile"}, not the current ${report.deploymentProfile} posture.`;
  const steps: FollowOnProofLaneStepRecord[] = [
    {
      stepId: "preflight",
      title: "Capture deployment posture",
      status: "ready",
      instructions: `Confirm the current deployment profile (${report.deploymentProfile}), auth mode (${report.authMode}), loopback bypass state, and allowlist count before running any install flow. ${latestProofNote}`,
      evidenceHint: "Record the System-page posture summary and current gateway settings snapshot.",
    },
    {
      stepId: "trusted-local",
      title: "Run a trusted-local install/startup pass",
      status: report.deploymentProfile === "local_dev" ? "ready" : "ready",
      instructions:
        "Run a clean installer or startup smoke path in the current environment and record the first successful operator path.",
      evidenceHint: "Capture startup notes, auth behavior, and the first usable operator screen.",
    },
    {
      stepId: "remote-hardened",
      title: "Run a remote_hardened proof pass",
      status: hardenedReady ? "ready" : "blocked",
      instructions: hardenedReady
        ? "Repeat the same clean install/startup path under remote_hardened and confirm policy/auth expectations hold."
        : report.deploymentProfile !== "remote_hardened"
          ? "Promote the current environment into remote_hardened before claiming hardened packaging proof."
          : "Set a non-empty network allowlist, disable loopback bypass, and use a non-none auth mode before claiming remote_hardened packaging proof.",
      evidenceHint: "Record the hardened startup path, auth proof, and any policy blockers or bypass exceptions.",
    },
    {
      stepId: "rollback",
      title: "Record rollback or recovery behavior",
      status: "ready",
      instructions:
        "Document the operator recovery path for a failed startup, broken auth posture, or misconfigured policy change.",
      evidenceHint: "Capture the exact rollback or recovery step and the operator-visible result.",
    },
    {
      stepId: "bundle",
      title: "Complete the packaging proof bundle",
      status: hardenedReady ? "ready" : "blocked",
      instructions: `Fill ${PACKAGING_PROOF_LANE.templatePath} using ${PACKAGING_PROOF_LANE.checklistPath}.`,
      evidenceHint: "Attach installer notes, hardened-run evidence, and recovery/rollback notes.",
    },
  ];

  const blockingIssues = mergeProofLaneBlockingIssues(report.packaging.blockingIssues, steps);
  const summary = hardenedReady
    ? `Packaging proof lane is ready with ${report.deploymentProfile}, ${report.authMode} auth, and ${report.packaging.networkAllowlistCount} allowlisted host(s).`
    : "Packaging proof lane is partially blocked until the runtime is operating in remote_hardened and the hardened posture is fully configured.";

  return {
    generatedAt,
    deploymentProfile: report.deploymentProfile,
    authMode: report.authMode,
    summary,
    checklistPath: PACKAGING_PROOF_LANE.checklistPath,
    templatePath: PACKAGING_PROOF_LANE.templatePath,
    blockingIssues,
    steps,
    markdown: buildPackagingProofLaneMarkdown(report, generatedAt, summary, steps),
  };
}

export function buildPackagingProofLaneArtifactPath(draft: PackagingProofLaneDraft): string {
  return buildProofLaneArtifactPath({
    spec: PACKAGING_PROOF_LANE,
    generatedAt: draft.generatedAt,
    deploymentProfile: draft.deploymentProfile,
    slug: "packaging-deployment-proof-bundle",
  });
}

function buildPackagingProofLaneMarkdown(
  report: FollowOnParityReport,
  generatedAt: string,
  summary: string,
  steps: FollowOnProofLaneStepRecord[],
): string {
  const proofStatus = report.packaging.proofStatus ?? {
    hasArtifact: false,
    freshness: "missing" as const,
    matchedCurrentProfile: false,
  };
  return [
    ...formatProofLaneMarkdownHeader({
      title: "Packaging And Deployment Proof Bundle Draft",
      generatedAt,
      deploymentProfile: report.deploymentProfile,
      authMode: report.authMode,
      spec: PACKAGING_PROOF_LANE,
      summary,
    }),
    "## Live Runtime Snapshot",
    `- Loopback bypass: ${report.packaging.allowLoopbackBypass ? "enabled" : "disabled"}`,
    `- Network allowlist count: ${report.packaging.networkAllowlistCount}`,
    `- Packaging posture: ${report.packaging.postureSummary}`,
    `- Latest proof artifact: ${proofStatus.hasArtifact ? `${proofStatus.freshness}${typeof proofStatus.ageDays === "number" ? ` (${proofStatus.ageDays} day(s) old)` : ""}` : "missing"}`,
    `- Latest proof profile match: ${proofStatus.hasArtifact ? (proofStatus.matchedCurrentProfile ? "matches current profile" : `mismatch (${proofStatus.latestArtifactDeploymentProfile ?? "unknown"})`) : "not recorded"}`,
    "",
    ...formatProofLaneStepsSection(steps),
  ].join("\n");
}
