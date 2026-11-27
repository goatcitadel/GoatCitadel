/**
 * Runtime Repair Sweep contracts (Phase 0: detect-only).
 *
 * A finding records stuck runtime state that the sweep observed. Phase 0 never
 * acts on a finding; it only records when one appears and when it clears. See
 * docs/RUNTIME_REPAIR_SWEEP.md.
 */

export const RUNTIME_REPAIR_DETECTOR_IDS = [
  "approval.resolved-wait-not-woken",
  "approval.wait-orphaned",
  "approval.no-inbox",
  "approval.expiry-lagging",
  "durable.dead-letter",
  "durable.reclaim-exhausted",
] as const;

export type RuntimeRepairDetectorId = (typeof RUNTIME_REPAIR_DETECTOR_IDS)[number];

/** The audit stream that holds finding transitions. */
export const RUNTIME_REPAIR_AUDIT_STREAM = "runtime_repairs" as const;

/** Phase 0 tiers only describe what a later phase may do; nothing acts on them yet. */
export type RuntimeRepairProposedTier = "automatic" | "proposed" | "report";

/** Typed references only. Never payloads, previews, or error bodies beyond a bounded summary. */
export interface RuntimeRepairSubject {
  runId?: string;
  approvalId?: string;
  deadLetterId?: string;
  sessionId?: string;
  workspaceId?: string;
}

export type RuntimeRepairFindingState = "observed" | "cleared";

export interface RuntimeRepairFinding {
  findingId: string;
  detectorId: RuntimeRepairDetectorId;
  detectorVersion: number;
  fingerprint: string;
  subject: RuntimeRepairSubject;
  /** One plain-language sentence an operator can read. */
  summary: string;
  proposedTier: RuntimeRepairProposedTier;
  /** Small, secret-free facts that explain the finding (ages, kinds, a transient flag). */
  facts: Record<string, string | number | boolean>;
  state: RuntimeRepairFindingState;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Ticks that saw this finding in this Gateway process; the count starts again after a restart. */
  seenCount: number;
  clearedAt?: string;
}

export interface RuntimeRepairDetectorStatus {
  detectorId: RuntimeRepairDetectorId;
  lastRunAt?: string;
  /** True when the detector hit its read limit, so some subjects were not checked. */
  truncated: boolean;
  lastError?: string;
}

export interface RuntimeRepairSweepSnapshot {
  mode: "detect_only";
  /** False until the first tick has run in this process. */
  ready: boolean;
  lastTickAt?: string;
  detectors: RuntimeRepairDetectorStatus[];
  /** Open findings, newest first. */
  open: RuntimeRepairFinding[];
  /** Findings that cleared recently in this process, newest first. */
  recentlyCleared: RuntimeRepairFinding[];
}
