import { createHash, randomUUID } from "node:crypto";
import type {
  CurationReviewProposal,
  CurationReviewReport,
  CurationTargetKind,
  CurationTrustState,
} from "@goatcitadel/contracts";

export interface CurationReviewCandidate {
  targetKind: CurationTargetKind;
  targetRef: string;
  title: string;
  summary?: string;
  source?: string;
  trustState?: CurationTrustState;
  signals?: string[];
}

export function buildCurationReviewReport(input: {
  candidates: CurationReviewCandidate[];
  now?: Date;
}): CurationReviewReport {
  const createdAt = (input.now ?? new Date()).toISOString();
  const proposals = input.candidates.map((candidate) => buildProposal(candidate));
  return {
    reportId: `curation_${createHash("sha256")
      .update(`${createdAt}:${proposals.map((item) => item.proposalId).join(",")}`)
      .digest("hex")
      .slice(0, 16)}`,
    createdAt,
    summary:
      proposals.length === 0
        ? "No curation candidates were reviewed."
        : `Reviewed ${proposals.length} curation candidate${proposals.length === 1 ? "" : "s"}. No mutations were applied.`,
    proposals,
    mutated: false,
  };
}

function buildProposal(candidate: CurationReviewCandidate): CurationReviewProposal {
  const signals = candidate.signals ?? [];
  const duplicate = signals.includes("duplicate");
  const drift = signals.includes("drift");
  const lowUse = signals.includes("low_use");
  const action = duplicate ? "merge" : drift ? "rewrite" : lowUse ? "prune" : "no_action";
  const proposalId = randomUUID();
  return {
    proposalId,
    targetKind: candidate.targetKind,
    targetRef: candidate.targetRef,
    action,
    summary: candidate.summary ?? candidate.title,
    reason:
      action === "no_action"
        ? "No strong mutation signal was found; keep this as a report-only observation."
        : `Signals suggest ${action.replace("_", " ")} should be reviewed before any change is made.`,
    confidence: action === "no_action" ? 0.35 : 0.72,
    trustState: candidate.trustState ?? "workspace_local",
    provenance: [candidate.source, candidate.targetRef].filter((item): item is string => Boolean(item)),
    affectedSurfaces: [candidate.targetKind === "skill" ? "Skills" : "Memory"],
    rollback: {
      available: action !== "no_action",
      summary:
        action === "no_action"
          ? "No rollback is required because no mutation is proposed."
          : "Capture the current target content before approval and restore it if the approved mutation needs to be reverted.",
      restoreRef: action === "no_action" ? undefined : candidate.targetRef,
    },
    requiresApproval: action !== "no_action",
  };
}
