import type {
  RuntimeRepairDetectorId,
  RuntimeRepairDetectorStatus,
  RuntimeRepairFinding,
  RuntimeRepairProposedTier,
  RuntimeRepairSweepSnapshot,
} from "@goatcitadel/contracts";
import { formatDuration, plural } from "@goatcitadel/mission-control-shared/content/format";
import type { StatusPresentation } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import type { Metric } from "../../ui/MetricList";

/** Plain names for the sweep's checks; the detector ids stay in technical details. */
const CHECK_LABELS: Readonly<Record<RuntimeRepairDetectorId, string>> = {
  "approval.resolved-wait-not-woken": "Answered approvals whose run didn't continue",
  "approval.wait-orphaned": "Runs waiting on a missing approval",
  "approval.no-inbox": "Approvals no Inbox shows",
  "approval.expiry-lagging": "Approvals past their expiry",
  "durable.dead-letter": "Runs that stopped for good",
  "durable.reclaim-exhausted": "Runs that kept crashing",
};

export type RepairTierKind = RuntimeRepairProposedTier;

/** What a later version would do with a finding. Phase 0 never acts, so these describe, not promise. */
export const REPAIR_TIERS: Readonly<Record<RepairTierKind, StatusPresentation>> = {
  automatic: { label: "Can be fixed automatically later", tone: "neutral" },
  proposed: { label: "Will ask you first", tone: "waiting" },
  report: { label: "Needs you", tone: "waiting" },
};

export interface PresentedRepairFinding {
  findingId: string;
  summary: string;
  tierKind: RepairTierKind;
  tier: StatusPresentation;
  /** One short, plain line of facts, or an empty string. */
  detail: string;
  firstSeenAt: string;
  link: { href: string; label: string } | null;
  /** Raw ids and recorded text, shown only inside TechnicalDetails. */
  technical: Array<[string, string]>;
}

export interface PresentedRepairCheck {
  label: string;
  note: string;
  failed: boolean;
}

export interface RepairsPage {
  state: "first_check_pending" | "all_clear" | "findings";
  intro: string;
  metrics: Metric[];
  open: PresentedRepairFinding[];
  cleared: PresentedRepairFinding[];
  checks: PresentedRepairCheck[];
  lastTickAt?: string;
}

const minutes = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value * 60_000 : null);

function factLine(item: RuntimeRepairFinding): string {
  const facts = item.facts;
  switch (item.detectorId) {
    case "approval.resolved-wait-not-woken": {
      const ms = minutes(facts.minutesSinceResolved);
      return ms === null ? "" : `Answered ${formatDuration(ms)} ago`;
    }
    case "approval.wait-orphaned":
    case "approval.no-inbox": {
      const ms = minutes(facts.minutesWaiting ?? facts.minutesPending);
      return ms === null ? "" : `Waiting ${formatDuration(ms)}`;
    }
    case "approval.expiry-lagging": {
      const ms = minutes(facts.minutesPastExpiry);
      return ms === null ? "" : `${formatDuration(ms)} past its expiry`;
    }
    case "durable.dead-letter":
      return facts.transient === true ? "Stopped after a temporary failure" : "";
    case "durable.reclaim-exhausted":
      return typeof facts.restarts === "number" ? `Restarted ${plural(facts.restarts, "time")}` : "";
  }
}

function linkFor(item: RuntimeRepairFinding): PresentedRepairFinding["link"] {
  const approvalFirst = item.detectorId === "approval.no-inbox" || item.detectorId === "approval.expiry-lagging";
  const { runId, approvalId } = item.subject;
  if (approvalFirst && approvalId) {
    return { href: `/inbox?approvalId=${encodeURIComponent(approvalId)}`, label: "Review approval" };
  }
  if (runId) return { href: `/work/runs/${encodeURIComponent(runId)}`, label: "Open run" };
  if (approvalId) return { href: `/inbox?approvalId=${encodeURIComponent(approvalId)}`, label: "Review approval" };
  return null;
}

const TECHNICAL_SUBJECT_LABELS: ReadonlyArray<[keyof RuntimeRepairFinding["subject"], string]> = [
  ["runId", "Run"],
  ["approvalId", "Approval"],
  ["deadLetterId", "Dead letter"],
  ["sessionId", "Session"],
  ["workspaceId", "Workspace"],
];

export function presentRepairFinding(item: RuntimeRepairFinding): PresentedRepairFinding {
  const detail = [factLine(item), item.seenCount > 1 ? `seen ${plural(item.seenCount, "time")}` : ""]
    .filter(Boolean)
    .join(" · ");
  const technical: Array<[string, string]> = [["Check", item.detectorId]];
  for (const [key, label] of TECHNICAL_SUBJECT_LABELS) {
    const value = item.subject[key];
    if (value) technical.push([label, value]);
  }
  if (typeof item.facts.reason === "string" && item.facts.reason)
    technical.push(["Recorded reason", item.facts.reason]);
  return {
    findingId: item.findingId,
    summary: item.summary,
    tierKind: item.proposedTier,
    tier: REPAIR_TIERS[item.proposedTier],
    detail: detail ? detail[0]!.toUpperCase() + detail.slice(1) : "",
    firstSeenAt: item.firstSeenAt,
    link: linkFor(item),
    technical,
  };
}

export function presentRepairCheck(status: RuntimeRepairDetectorStatus): PresentedRepairCheck {
  const label = CHECK_LABELS[status.detectorId] ?? "Check";
  if (status.lastError) return { label, note: "Couldn't check this time", failed: true };
  if (!status.lastRunAt) return { label, note: "Not checked yet", failed: false };
  if (status.truncated) return { label, note: "Only the newest ones were checked", failed: false };
  return { label, note: "Checked", failed: false };
}

export function buildRepairsPage(snapshot: RuntimeRepairSweepSnapshot): RepairsPage {
  const checks = snapshot.detectors.map(presentRepairCheck);
  const open = snapshot.open.map(presentRepairFinding);
  const cleared = snapshot.recentlyCleared.map(presentRepairFinding);
  const failedChecks = checks.filter((check) => check.failed).length;
  const base = { open, cleared, checks, lastTickAt: snapshot.lastTickAt };
  const metrics: Metric[] = [
    { term: "Open", value: open.length.toLocaleString() },
    { term: "Cleared since this Gateway started", value: cleared.length.toLocaleString() },
  ];
  if (!snapshot.ready) return { ...base, state: "first_check_pending", intro: "", metrics };
  if (!open.length && !failedChecks) return { ...base, state: "all_clear", intro: "", metrics };
  const failedNote = failedChecks
    ? `${plural(failedChecks, "check")} couldn't run. Its problems would stay listed until it can check again.`
    : "";
  const intro = open.length
    ? [
        `${plural(open.length, "thing")} look${open.length === 1 ? "s" : ""} stuck as of the last check.`,
        failedNote || "GoatCitadel checks every 5 minutes.",
      ].join(" ")
    : `Nothing looked stuck, but ${failedNote}`;
  return { ...base, state: "findings", intro, metrics };
}
