import type { ReviewReadinessLane, ReviewReadinessSummary } from "@goatcitadel/contracts";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import type { StatusPresentation } from "@goatcitadel/mission-control-shared/content/status-vocabulary";

const LANE_STATUS: Readonly<Record<ReviewReadinessLane["status"], StatusPresentation>> = {
  current: { label: "Current", tone: "done" },
  stale: { label: "Stale", tone: "waiting" },
  missing: { label: "Missing", tone: "neutral" },
};

/** "verify:surface:regression" → "Surface regression"; the script name itself stays in technical details. */
function plainName(value: string): string {
  const words = value
    .replace(/^verify:/, "")
    .split(/[:_\-\s]+/)
    .filter(Boolean)
    .join(" ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Check";
}

const BUILD_KIND: Readonly<Record<ReviewReadinessSummary["runtimeIdentity"]["kind"], string>> = {
  development: "development build",
  source: "source checkout",
  packaged: "packaged build",
};

/** Release and review readiness in operator words: a status, one sentence, blockers and review checks. */
export function releaseReadinessSummary(summary: ReviewReadinessSummary): {
  status: StatusPresentation;
  sentence: string;
  blockers: { key: string; title: string; detail: string }[];
  checks: { key: string; title: string; status: StatusPresentation }[];
} {
  const identity = summary.runtimeIdentity;
  const release = identity.release;
  const status: StatusPresentation = release.verified
    ? { label: "Verified", tone: "done" }
    : release.certificateState === "absent"
      ? { label: "Not certified", tone: "neutral" }
      : { label: "Blocked", tone: "failed" };
  const proof = release.requiredProof;
  const sentence =
    `Version ${identity.version}, ${BUILD_KIND[identity.kind] ?? "build"}. ` +
    `${proof.passed} of ${proof.total} required checks passed; ` +
    `${plural(summary.openFindings, "open review finding")}.`;
  return {
    status,
    sentence,
    blockers: release.reasonCodes.map((code, index) => ({
      key: `${index}:${code}`,
      title: plainName(code),
      detail: release.reasons[index] ?? "No further detail was reported.",
    })),
    checks: summary.lanes.map((lane) => ({
      key: lane.lane,
      title: plainName(lane.lane),
      status: LANE_STATUS[lane.status] ?? { label: "Unknown", tone: "neutral" },
    })),
  };
}
