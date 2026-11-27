/**
 * Runtime Repair Sweep detectors (Phase 0: detect-only).
 *
 * Every detector is a pure function over an observation that the sweep service
 * has already read through bounded owner queries. Detectors never read storage,
 * never act, and never copy payloads: a finding carries typed subject IDs and a
 * few small, secret-free facts. See docs/RUNTIME_REPAIR_SWEEP.md.
 */
import {
  redactSecretText,
  type ApprovalRequest,
  type DurableDeadLetterRecord,
  type DurableRunRecord,
  type RuntimeRepairDetectorId,
  type RuntimeRepairProposedTier,
  type RuntimeRepairSubject,
} from "@goatcitadel/contracts";

export const RUNTIME_REPAIR_DETECTOR_VERSION = 1;

export const RUNTIME_REPAIR_THRESHOLDS = {
  /** A resolved approval normally wakes its wait run within seconds. */
  resolvedWaitGraceMs: 2 * 60_000,
  /** A wait run is created just before its approval row is linked; give that time to finish. */
  orphanedWaitGraceMs: 2 * 60_000,
  /** Approval linkage can be merged shortly after creation. */
  noInboxGraceMs: 60_000,
  /** The approval expiry owner reconciles about every second. */
  expiryLagMs: 60_000,
  reasonCharacters: 200,
} as const;

export interface RuntimeRepairApprovalWait {
  run: DurableRunRecord;
  approvalId: string | undefined;
  /** `null` when the approval could not be found. */
  approval: ApprovalRequest | null;
}

export interface RuntimeRepairObservation {
  nowMs: number;
  /** Durable `approval.wait` runs and the approval each one waits on. */
  approvalWaits: RuntimeRepairApprovalWait[];
  pendingApprovals: ApprovalRequest[];
  expiredPendingApprovals: ApprovalRequest[];
  deadLetters: DurableDeadLetterRecord[];
  /** The most recently created durable runs, any status. */
  recentRuns: DurableRunRecord[];
}

export interface RuntimeRepairFindingCandidate {
  detectorId: RuntimeRepairDetectorId;
  detectorVersion: number;
  fingerprint: string;
  subject: RuntimeRepairSubject;
  summary: string;
  proposedTier: RuntimeRepairProposedTier;
  facts: Record<string, string | number | boolean>;
}

const SUBJECT_KEYS = ["runId", "approvalId", "deadLetterId", "sessionId", "workspaceId"] as const;

/** Stable identity for one problem: the detector plus the subject IDs, in a fixed order. */
export function runtimeRepairFingerprint(detectorId: RuntimeRepairDetectorId, subject: RuntimeRepairSubject): string {
  const parts = SUBJECT_KEYS.flatMap((key) => (subject[key] ? [`${key}=${subject[key]}`] : []));
  return [detectorId, ...parts].join("|");
}

const TRANSIENT_FAILURE_PATTERN =
  /\b(?:429|too many requests|rate[ -]?limit(?:ed)?|timed? ?out|timeout|etimedout|econnreset|econnrefused|eai_again|socket hang up|50[234]|bad gateway|service unavailable|gateway timeout|overloaded|temporarily unavailable)\b/i;

/** True when a failure reason names a cause that usually clears on its own. */
export function classifyTransientFailure(reason: string): boolean {
  return TRANSIENT_FAILURE_PATTERN.test(reason);
}

const RECLAIM_EXHAUSTED_PATTERN = /^The run was restarted (\d+) times after its worker stopped/;

function candidate(
  detectorId: RuntimeRepairDetectorId,
  subject: RuntimeRepairSubject,
  summary: string,
  proposedTier: RuntimeRepairProposedTier,
  facts: Record<string, string | number | boolean>,
): RuntimeRepairFindingCandidate {
  const compactSubject = Object.fromEntries(
    SUBJECT_KEYS.flatMap((key) => (subject[key] ? [[key, subject[key]]] : [])),
  ) as RuntimeRepairSubject;
  return {
    detectorId,
    detectorVersion: RUNTIME_REPAIR_DETECTOR_VERSION,
    fingerprint: runtimeRepairFingerprint(detectorId, compactSubject),
    subject: compactSubject,
    summary,
    proposedTier,
    facts,
  };
}

function ageMs(nowMs: number, iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? nowMs - parsed : undefined;
}

const wholeMinutes = (ms: number) => Math.floor(ms / 60_000);

function boundedReason(reason: string): string {
  const redacted = redactSecretText(reason).value.replace(/\s+/g, " ").trim();
  const limit = RUNTIME_REPAIR_THRESHOLDS.reasonCharacters;
  return redacted.length <= limit ? redacted : `${redacted.slice(0, limit - 1)}…`;
}

function workspaceOf(approval: ApprovalRequest | null | undefined): string | undefined {
  return approval?.linkage?.workspaceId?.trim() || undefined;
}

function detectApprovalWaits(observed: RuntimeRepairObservation): RuntimeRepairFindingCandidate[] {
  return observed.approvalWaits.flatMap(({ run, approvalId, approval }) => {
    if (run.status !== "waiting") return [];
    if (approval === null) {
      const runAge = ageMs(observed.nowMs, run.createdAt);
      if (runAge === undefined || runAge < RUNTIME_REPAIR_THRESHOLDS.orphanedWaitGraceMs) return [];
      return [
        candidate(
          "approval.wait-orphaned",
          { runId: run.runId, approvalId },
          "A run is waiting on an approval that no longer exists, so it can never continue.",
          "automatic",
          { minutesWaiting: wholeMinutes(runAge) },
        ),
      ];
    }
    if (approval.status === "pending") return [];
    const sinceResolved = ageMs(observed.nowMs, approval.resolvedAt ?? run.updatedAt);
    if (sinceResolved === undefined || sinceResolved < RUNTIME_REPAIR_THRESHOLDS.resolvedWaitGraceMs) return [];
    return [
      candidate(
        "approval.resolved-wait-not-woken",
        {
          runId: run.runId,
          approvalId: approval.approvalId,
          sessionId: approval.linkage?.sessionId,
          workspaceId: workspaceOf(approval),
        },
        "An approval was answered, but the run waiting on it never continued.",
        "automatic",
        { approvalStatus: approval.status, minutesSinceResolved: wholeMinutes(sinceResolved) },
      ),
    ];
  });
}

function detectNoInboxApprovals(observed: RuntimeRepairObservation): RuntimeRepairFindingCandidate[] {
  return observed.pendingApprovals.flatMap((approval) => {
    // An approval with no linkage is install-wide and every Inbox lists it.
    if (!approval.linkage) return [];
    if (workspaceOf(approval) || approval.linkage.sessionId?.trim()) return [];
    const age = ageMs(observed.nowMs, approval.createdAt);
    if (age === undefined || age < RUNTIME_REPAIR_THRESHOLDS.noInboxGraceMs) return [];
    return [
      candidate(
        "approval.no-inbox",
        { approvalId: approval.approvalId, runId: approval.linkage.durableRunId ?? approval.linkage.runId },
        "An approval is waiting for you, but it belongs to no workspace or chat, so no Inbox shows it.",
        "report",
        { approvalKind: approval.kind, minutesPending: wholeMinutes(age) },
      ),
    ];
  });
}

function detectExpiryLag(observed: RuntimeRepairObservation): RuntimeRepairFindingCandidate[] {
  return observed.expiredPendingApprovals.flatMap((approval) => {
    if (approval.status !== "pending") return [];
    const pastExpiry = ageMs(observed.nowMs, approval.expiresAt);
    if (pastExpiry === undefined || pastExpiry < RUNTIME_REPAIR_THRESHOLDS.expiryLagMs) return [];
    return [
      candidate(
        "approval.expiry-lagging",
        {
          approvalId: approval.approvalId,
          sessionId: approval.linkage?.sessionId,
          workspaceId: workspaceOf(approval),
        },
        "An approval is past its expiry but still pending, so the expiry check may not be running.",
        "report",
        { approvalKind: approval.kind, minutesPastExpiry: wholeMinutes(pastExpiry) },
      ),
    ];
  });
}

function detectDeadLetters(observed: RuntimeRepairObservation): RuntimeRepairFindingCandidate[] {
  return observed.deadLetters.flatMap((entry) => {
    if (entry.resolvedAt) return [];
    const transient = classifyTransientFailure(entry.reason);
    return [
      candidate(
        "durable.dead-letter",
        { deadLetterId: entry.deadLetterId, runId: entry.runId },
        transient
          ? "A run stopped for good after a temporary failure. Retrying it once would likely work."
          : "A run stopped for good and needs a decision before it is retried.",
        transient ? "automatic" : "proposed",
        { transient, reason: boundedReason(entry.reason) },
      ),
    ];
  });
}

function detectReclaimExhausted(observed: RuntimeRepairObservation): RuntimeRepairFindingCandidate[] {
  return observed.recentRuns.flatMap((run) => {
    if (run.status !== "failed") return [];
    const match = RECLAIM_EXHAUSTED_PATTERN.exec(run.lastError ?? "");
    if (!match) return [];
    return [
      candidate(
        "durable.reclaim-exhausted",
        { runId: run.runId },
        "A run kept crashing its worker and was stopped after repeated restarts.",
        "report",
        { workflowKey: run.workflowKey, restarts: Number(match[1]) },
      ),
    ];
  });
}

/** Runs every Phase 0 detector over one observation. Order is stable for tests and the audit log. */
export function detectRuntimeRepairFindings(observed: RuntimeRepairObservation): RuntimeRepairFindingCandidate[] {
  return [
    ...detectApprovalWaits(observed),
    ...detectNoInboxApprovals(observed),
    ...detectExpiryLag(observed),
    ...detectDeadLetters(observed),
    ...detectReclaimExhausted(observed),
  ];
}
