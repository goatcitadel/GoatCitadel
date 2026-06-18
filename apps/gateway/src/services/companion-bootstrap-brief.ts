import type { FollowOnParityReport } from "@goatcitadel/contracts";

const COMPANION_CONTRACT_PATH = "docs/COMPANION_CONTRACT.md";
const COMPANION_TEMPLATE_PATH = "templates/verification/companion-bootstrap-brief.md";
const COMPANION_ARTIFACT_ROOT = "artifacts/follow-on-parity/companion";

export interface CompanionBootstrapBriefDraft {
  generatedAt: string;
  summary: string;
  markdown: string;
}

export function buildCompanionBootstrapBrief(report: FollowOnParityReport): CompanionBootstrapBriefDraft {
  const generatedAt = new Date().toISOString();
  const contract = report.companion.contract;
  const proofCurrent =
    report.companion.artifactStatus.hasArtifact && report.companion.artifactStatus.freshness === "current";
  const summary = contract
    ? proofCurrent
      ? `${contract.contractId} now has current Android runtime/UI proof recorded for the separate mobile repo, and the gateway/session lane remains aligned to that proof.`
      : `${contract.contractId} is ready for separate-repo bootstrap planning, and live gateway session proof is complete; the remaining proof gap is the Android runtime/UI bundle.`
    : "Companion bootstrap is blocked until the live companion contract is resolved in the parity report.";

  return {
    generatedAt,
    summary,
    markdown: [
      "# Companion Bootstrap Brief",
      "",
      `Generated: ${generatedAt}`,
      `Deployment profile: ${report.deploymentProfile}`,
      `Auth mode: ${report.authMode}`,
      `Contract doc: ${COMPANION_CONTRACT_PATH}`,
      `Template baseline: ${COMPANION_TEMPLATE_PATH}`,
      "",
      "## Summary",
      summary,
      "",
      "## Live Companion Snapshot",
      `- Companion summary: ${report.companion.paritySummary}`,
      `- Platform targets: ${report.companion.platformTargets.map((target) => `${target.label} (${target.maturity})`).join(", ") || "none"}`,
      `- Blocking issues: ${report.companion.blockingIssues.length > 0 ? report.companion.blockingIssues.join(" | ") : "none"}`,
      "",
      "## Contract Baseline",
      `- Contract id: ${contract?.contractId ?? "missing"}`,
      `- Primary target: ${contract?.primaryTarget ?? "missing"}`,
      `- Bootstrap repo: ${contract?.bootstrapRepo ?? "missing"}`,
      `- Repo strategy: ${contract?.repoStrategy ?? "missing"}`,
      `- Bootstrap status: ${contract?.bootstrapStatus ?? "missing"}`,
      `- Transport lanes: ${contract?.transportLanes.join(", ") ?? "missing"}`,
      `- Bootstrap features: ${contract?.bootstrapFeatures.join(", ") ?? "missing"}`,
      "",
      "## Auth Readiness",
      ...report.companion.authReadiness.map((item) => `- ${item.label}: ${item.state} · ${item.note}`),
      "",
      "## Server Prerequisites",
      ...report.companion.prerequisiteReadiness.map((item) => `- ${item.label}: ${item.state} · ${item.note}`),
      "",
      "## Next Actions",
      ...report.companion.recommendedActions.map((action, index) => `${index + 1}. ${action}`),
      "",
      proofCurrent ? "## Current Proof Focus" : "## Expected First Proof",
      ...(proofCurrent
        ? [
            "1. Keep the Android approval/bootstrap/runtime evidence current when the bootstrap contract, session semantics, or deployment posture changes.",
            "2. Re-run the Android-resident proof lane when signed mutation, SSE resume, or refresh rotation behavior changes.",
            "3. Use this brief plus the attached mobile evidence bundle as the operator handoff instead of re-proving the gateway in isolation.",
          ]
        : [
            "1. Align the separate `GoatCitadel-mobile` repo to the current companion bootstrap template and contract baseline.",
            "2. Reuse the proved gateway exchange/refresh/signed-session path from the Android runtime instead of re-proving the server in isolation.",
            "3. Capture Android-resident UI/runtime evidence for approvals, signed session creation, SSE resume, and refresh rotation before broadening feature scope.",
          ]),
      "",
    ].join("\n"),
  };
}

export function buildCompanionBootstrapArtifactPath(draft: CompanionBootstrapBriefDraft): string {
  const day = draft.generatedAt.slice(0, 10);
  const timestamp = draft.generatedAt.replaceAll(":", "-").replaceAll(".", "-");
  return `${COMPANION_ARTIFACT_ROOT}/${day}/companion-bootstrap-brief-${timestamp}.md`;
}
