/**
 * Runtime Repair Sweep service (Phase 0: detect-only).
 *
 * Each tick reads a bounded slice of durable-run and approval state, runs the
 * pure detectors, and records only finding transitions (observed, cleared) in
 * the `runtime_repairs` audit stream. It never writes to any owner and never
 * acts on a finding. Open findings are rebuilt from the audit stream on the
 * first tick after a restart. See docs/RUNTIME_REPAIR_SWEEP.md.
 */
import {
  RUNTIME_REPAIR_DETECTOR_IDS,
  type ApprovalRequest,
  type DurableDeadLetterRecord,
  type DurableRunRecord,
  type RuntimeRepairDetectorId,
  type RuntimeRepairDetectorStatus,
  type RuntimeRepairFinding,
  type RuntimeRepairSweepSnapshot,
} from "@goatcitadel/contracts";
import {
  detectRuntimeRepairFindings,
  type RuntimeRepairApprovalWait,
  type RuntimeRepairFindingCandidate,
  type RuntimeRepairObservation,
} from "./runtime-repair-detectors.js";

export const RUNTIME_REPAIR_READ_LIMITS = {
  waitingRuns: 500,
  approvalWaits: 200,
  pendingApprovals: 200,
  expiredPendingApprovals: 100,
  deadLetters: 200,
  recentRuns: 200,
  auditRebuild: 1_000,
  recentlyCleared: 50,
} as const;

const AUDIT_SCHEMA_VERSION = 1;
const APPROVAL_WAIT_WORKFLOW_KEY = "approval.wait";

/** Narrow read-only view of the owners the sweep inspects. */
export interface RuntimeRepairReadPort {
  listWaitingRunIds(limit: number): Promise<string[]>;
  getRunsByIds(runIds: string[]): Promise<Map<string, DurableRunRecord>>;
  /** Resolves `null` when the approval does not exist. */
  getApproval(approvalId: string): Promise<ApprovalRequest | null>;
  listPendingApprovals(limit: number): Promise<ApprovalRequest[]>;
  listExpiredPendingApprovals(nowIso: string, limit: number): Promise<ApprovalRequest[]>;
  listDeadLetters(limit: number): Promise<DurableDeadLetterRecord[]>;
  listRecentRuns(limit: number): Promise<DurableRunRecord[]>;
}

export interface RuntimeRepairAuditPort {
  append(payload: Record<string, unknown>): Promise<void>;
  listRecent(limit: number): Promise<Record<string, unknown>[]>;
}

/** What the read-only Ops route needs from the sweep. */
export interface RuntimeRepairsRouteService {
  snapshot(): RuntimeRepairSweepSnapshot;
}

export interface RuntimeRepairSweepServiceOptions {
  reads: RuntimeRepairReadPort;
  audit: RuntimeRepairAuditPort;
  now?: () => number;
  newId: () => string;
  onError?: (message: string, error: unknown) => void;
}

type SourceKey = keyof Omit<RuntimeRepairObservation, "nowMs">;

/** Which detectors depend on which source; a failed source leaves its detectors' findings untouched. */
const DETECTORS_BY_SOURCE: Record<SourceKey, RuntimeRepairDetectorId[]> = {
  approvalWaits: ["approval.resolved-wait-not-woken", "approval.wait-orphaned"],
  pendingApprovals: ["approval.no-inbox"],
  expiredPendingApprovals: ["approval.expiry-lagging"],
  deadLetters: ["durable.dead-letter"],
  recentRuns: ["durable.reclaim-exhausted"],
};

interface SourceResult<T> {
  value: T;
  truncated: boolean;
  error?: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const isDetectorId = (value: unknown): value is RuntimeRepairDetectorId =>
  typeof value === "string" && (RUNTIME_REPAIR_DETECTOR_IDS as readonly string[]).includes(value);

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rebuilds a finding from an untrusted audit record, or returns undefined when the record is not a valid one. */
function findingFromObservedEvent(record: Record<string, unknown>): RuntimeRepairFinding | undefined {
  if (record.event !== "finding_observed" || record.schemaVersion !== AUDIT_SCHEMA_VERSION) return undefined;
  const { findingId, fingerprint, detectorId, observedAt, summary, proposedTier } = record;
  if (!isString(findingId) || !isString(fingerprint) || !isDetectorId(detectorId) || !isString(observedAt)) {
    return undefined;
  }
  if (!isString(summary) || !["automatic", "proposed", "report"].includes(String(proposedTier))) return undefined;
  const subject = isPlainRecord(record.subject) ? record.subject : {};
  const facts = isPlainRecord(record.facts) ? record.facts : {};
  return {
    findingId,
    detectorId,
    detectorVersion: typeof record.detectorVersion === "number" ? record.detectorVersion : 0,
    fingerprint,
    subject: Object.fromEntries(Object.entries(subject).filter(([, value]) => isString(value))),
    summary,
    proposedTier: proposedTier as RuntimeRepairFinding["proposedTier"],
    facts: Object.fromEntries(
      Object.entries(facts).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value)),
    ) as RuntimeRepairFinding["facts"],
    state: "observed",
    firstSeenAt: observedAt,
    lastSeenAt: observedAt,
    // Rebuilt from history, not seen yet in this process; the next tick that sees it counts 1.
    seenCount: 0,
  };
}

export class RuntimeRepairSweepService {
  private readonly now: () => number;
  private readonly open = new Map<string, RuntimeRepairFinding>();
  private recentlyCleared: RuntimeRepairFinding[] = [];
  private readonly detectorStatus = new Map<RuntimeRepairDetectorId, RuntimeRepairDetectorStatus>(
    RUNTIME_REPAIR_DETECTOR_IDS.map((detectorId) => [detectorId, { detectorId, truncated: false }]),
  );
  private rebuilt = false;
  private ticking = false;
  private lastTickAt: string | undefined;

  public constructor(private readonly options: RuntimeRepairSweepServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Runs one detect-only pass. Overlapping calls return immediately. Never throws. */
  public async runTick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (!this.rebuilt) await this.rebuildFromAudit();
      const nowMs = this.now();
      const nowIso = new Date(nowMs).toISOString();
      const sources = await this.readSources(nowIso);
      const observation = Object.fromEntries([
        ["nowMs", nowMs],
        ...Object.entries(sources).map(([key, result]) => [key, result.value]),
      ]) as unknown as RuntimeRepairObservation;
      const healthyDetectors = this.recordDetectorStatus(sources, nowIso);
      const candidates = detectRuntimeRepairFindings(observation).filter((item) =>
        healthyDetectors.has(item.detectorId),
      );
      await this.applyCandidates(candidates, healthyDetectors, nowIso);
      this.lastTickAt = nowIso;
    } catch (error) {
      this.options.onError?.("runtime repair sweep tick failed", error);
    } finally {
      this.ticking = false;
    }
  }

  public snapshot(): RuntimeRepairSweepSnapshot {
    const newestFirst = (a: RuntimeRepairFinding, b: RuntimeRepairFinding) =>
      b.firstSeenAt.localeCompare(a.firstSeenAt);
    return {
      mode: "detect_only",
      ready: this.lastTickAt !== undefined,
      ...(this.lastTickAt ? { lastTickAt: this.lastTickAt } : {}),
      detectors: [...this.detectorStatus.values()].map((status) => ({ ...status })),
      open: [...this.open.values()].map((finding) => ({ ...finding })).sort(newestFirst),
      recentlyCleared: this.recentlyCleared.map((finding) => ({ ...finding })),
    };
  }

  private async rebuildFromAudit(): Promise<void> {
    let records: Record<string, unknown>[];
    try {
      records = await this.options.audit.listRecent(RUNTIME_REPAIR_READ_LIMITS.auditRebuild);
    } catch (error) {
      // Without the history, a known finding would be logged again; retry next tick instead.
      this.options.onError?.("runtime repair sweep could not read its audit history", error);
      throw error;
    }
    for (const record of records) {
      if (!isPlainRecord(record)) continue;
      const observed = findingFromObservedEvent(record);
      if (observed) {
        this.open.set(observed.fingerprint, observed);
      } else if (record.event === "finding_cleared" && isString(record.fingerprint)) {
        this.open.delete(record.fingerprint);
      }
    }
    this.rebuilt = true;
  }

  private async readSources(
    nowIso: string,
  ): Promise<{ [Key in SourceKey]: SourceResult<RuntimeRepairObservation[Key]> }> {
    const limits = RUNTIME_REPAIR_READ_LIMITS;
    const { reads } = this.options;
    const [approvalWaits, pendingApprovals, expiredPendingApprovals, deadLetters, recentRuns] = await Promise.all([
      this.readSource(() => this.readApprovalWaits(), []),
      this.readSource(async () => {
        const items = await reads.listPendingApprovals(limits.pendingApprovals);
        return { value: items, truncated: items.length >= limits.pendingApprovals };
      }, []),
      this.readSource(async () => {
        const items = await reads.listExpiredPendingApprovals(nowIso, limits.expiredPendingApprovals);
        return { value: items, truncated: items.length >= limits.expiredPendingApprovals };
      }, []),
      this.readSource(async () => {
        const items = await reads.listDeadLetters(limits.deadLetters);
        return { value: items, truncated: items.length >= limits.deadLetters };
      }, []),
      this.readSource(async () => {
        const items = await reads.listRecentRuns(limits.recentRuns);
        return { value: items, truncated: items.length >= limits.recentRuns };
      }, []),
    ]);
    return { approvalWaits, pendingApprovals, expiredPendingApprovals, deadLetters, recentRuns };
  }

  private async readSource<T>(
    read: () => Promise<{ value: T; truncated: boolean }>,
    fallback: T,
  ): Promise<SourceResult<T>> {
    try {
      return await read();
    } catch (error) {
      return { value: fallback, truncated: false, error: errorText(error) };
    }
  }

  private async readApprovalWaits(): Promise<{ value: RuntimeRepairApprovalWait[]; truncated: boolean }> {
    const limits = RUNTIME_REPAIR_READ_LIMITS;
    const { reads } = this.options;
    const runIds = await reads.listWaitingRunIds(limits.waitingRuns);
    const runs = await reads.getRunsByIds(runIds);
    const waits = [...runs.values()].filter((run) => run.workflowKey === APPROVAL_WAIT_WORKFLOW_KEY);
    const checked = waits.slice(0, limits.approvalWaits);
    const value = await Promise.all(
      checked.map(async (run): Promise<RuntimeRepairApprovalWait> => {
        const approvalId = isString(run.payload.approvalId) ? run.payload.approvalId : undefined;
        return { run, approvalId, approval: approvalId ? await reads.getApproval(approvalId) : null };
      }),
    );
    return { value, truncated: runIds.length >= limits.waitingRuns || waits.length > checked.length };
  }

  /** Records per-detector status and returns the detectors whose sources were read. */
  private recordDetectorStatus(
    sources: { [Key in SourceKey]: SourceResult<unknown> },
    nowIso: string,
  ): Set<RuntimeRepairDetectorId> {
    const healthy = new Set<RuntimeRepairDetectorId>();
    for (const [source, detectorIds] of Object.entries(DETECTORS_BY_SOURCE) as [
      SourceKey,
      RuntimeRepairDetectorId[],
    ][]) {
      const result = sources[source];
      for (const detectorId of detectorIds) {
        this.detectorStatus.set(detectorId, {
          detectorId,
          lastRunAt: nowIso,
          truncated: result.truncated,
          ...(result.error ? { lastError: result.error } : {}),
        });
        if (!result.error) healthy.add(detectorId);
      }
    }
    return healthy;
  }

  private async applyCandidates(
    candidates: RuntimeRepairFindingCandidate[],
    healthyDetectors: Set<RuntimeRepairDetectorId>,
    nowIso: string,
  ): Promise<void> {
    const seen = new Set<string>();
    for (const item of candidates) {
      if (seen.has(item.fingerprint)) continue;
      seen.add(item.fingerprint);
      const existing = this.open.get(item.fingerprint);
      if (existing) {
        this.open.set(item.fingerprint, {
          ...existing,
          summary: item.summary,
          facts: item.facts,
          lastSeenAt: nowIso,
          seenCount: existing.seenCount + 1,
        });
        continue;
      }
      await this.recordObserved(item, nowIso);
    }
    for (const finding of [...this.open.values()]) {
      if (seen.has(finding.fingerprint) || !healthyDetectors.has(finding.detectorId)) continue;
      await this.recordCleared(finding, nowIso);
    }
  }

  private async recordObserved(item: RuntimeRepairFindingCandidate, nowIso: string): Promise<void> {
    const finding: RuntimeRepairFinding = {
      findingId: this.options.newId(),
      detectorId: item.detectorId,
      detectorVersion: item.detectorVersion,
      fingerprint: item.fingerprint,
      subject: item.subject,
      summary: item.summary,
      proposedTier: item.proposedTier,
      facts: item.facts,
      state: "observed",
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
      seenCount: 1,
    };
    try {
      await this.options.audit.append({
        event: "finding_observed",
        schemaVersion: AUDIT_SCHEMA_VERSION,
        findingId: finding.findingId,
        fingerprint: finding.fingerprint,
        detectorId: finding.detectorId,
        detectorVersion: finding.detectorVersion,
        subject: finding.subject,
        summary: finding.summary,
        proposedTier: finding.proposedTier,
        facts: finding.facts,
        observedAt: nowIso,
      });
    } catch (error) {
      // Not recorded, so not open: the next tick sees it again and retries the write.
      this.options.onError?.("runtime repair sweep could not record a finding", error);
      return;
    }
    this.open.set(finding.fingerprint, finding);
  }

  private async recordCleared(finding: RuntimeRepairFinding, nowIso: string): Promise<void> {
    try {
      await this.options.audit.append({
        event: "finding_cleared",
        schemaVersion: AUDIT_SCHEMA_VERSION,
        findingId: finding.findingId,
        fingerprint: finding.fingerprint,
        detectorId: finding.detectorId,
        clearedAt: nowIso,
        seenCount: finding.seenCount,
      });
    } catch (error) {
      // Still open on disk; keep it open here so the clear is retried next tick.
      this.options.onError?.("runtime repair sweep could not record a cleared finding", error);
      return;
    }
    this.open.delete(finding.fingerprint);
    const cleared: RuntimeRepairFinding = { ...finding, state: "cleared", clearedAt: nowIso };
    this.recentlyCleared = [cleared, ...this.recentlyCleared].slice(0, RUNTIME_REPAIR_READ_LIMITS.recentlyCleared);
  }
}
