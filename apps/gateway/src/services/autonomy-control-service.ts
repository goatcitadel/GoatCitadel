/**
 * Autonomy control service (cross-cutting kill-switch & rollback).
 *
 * The user chose "full autonomy WITH rollback": the agent may *apply* its own
 * skill/memory/tune/curator changes, but every change is snapshotted and
 * reversible. The master kill switch (`autonomyV1Disabled`) already halts all
 * autonomous loops. This service is the missing other half — a UNIFIED revert:
 *
 *   - {@link AutonomyControlService.recordAutonomousMutation} — best-effort append
 *     to the unified {@link AutonomyAuditRepository} ledger from each autonomous
 *     write path. It reuses the snapshot/ref each subsystem already produced as
 *     `restoreRef`; it never duplicates a snapshot, and an append failure must
 *     never break the mutation it describes.
 *   - {@link AutonomyControlService.revertAutonomousChangesSince} — lists
 *     un-reverted ledger entries with `occurredAt >= since` (newest-first) and
 *     restores each via its kind's existing restore function, marking each
 *     reverted. Per-entry failure isolation: one failure logs + continues.
 *   - {@link AutonomyControlService.getStatus} — master kill-switch state +
 *     recent-audit summary.
 *   - {@link AutonomyControlService.setKillSwitch} — toggles `autonomyV1Disabled`
 *     through the gateway's feature-flag update path.
 *
 * The per-subsystem restore functions are injected as callbacks (mirroring the
 * ImprovementService callbacks pattern) so this service stays decoupled from the
 * GatewayService internals and is trivially testable with fakes.
 */
import type {
  AutonomyAuditAppendInput,
  AutonomyAuditEntry,
  AutonomyAuditKind,
  AutonomyAuditRestoreRef,
  AutonomyAuditSummary,
  AutonomyControlStatus,
  AutonomyRevertEntryResult,
  AutonomyRevertSummary,
} from "@goatcitadel/contracts";
import { AUTONOMY_AUDIT_KINDS } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";

type AutonomyControlStorage = Pick<Storage, "autonomyAudit">;

/** Structured best-effort diagnostic envelope (subset of the gateway's record input). */
export interface AutonomyControlDiagnostic {
  level: "info" | "warn" | "error" | "debug";
  category: string;
  event: string;
  message: string;
  context?: Record<string, unknown>;
}

/**
 * Per-kind restore callbacks. Each maps to the subsystem's existing restore
 * function (see the plan's "ALREADY-LANDED autonomous mutation paths"). They may
 * throw — the service isolates each call.
 */
export interface AutonomyRestoreHandlers {
  /** skill_revision → SkillMutationService restore via the activation snapshot ref. */
  restoreSkillRevision(snapshotRef: unknown): void;
  /** operator_profile / memory → OperatorProfileService.restoreOperatorProfileSnapshot. */
  restoreOperatorProfile(priorSnapshot: unknown): void;
  /** curator_archive → GatewayService.restoreCuratorIdleSkillSnapshot(skillId). */
  restoreCuratorArchive(skillId: string): boolean;
  /** tune → ImprovementService.revertDecisionAutoTune(tuneId). */
  revertTune(tuneId: string): void;
}

export interface AutonomyControlServiceDeps {
  storage: AutonomyControlStorage;
  /** Reads the master kill switch (`autonomyV1Disabled`). */
  isFeatureEnabled(flag: string): boolean;
  /** Sets the master kill switch through the feature-flag update path. */
  setKillSwitch(disabled: boolean): void;
  /** Per-subsystem restore callbacks. */
  restoreHandlers: AutonomyRestoreHandlers;
  /** Best-effort diagnostics sink (failures never propagate). */
  recordDevDiagnostic(input: AutonomyControlDiagnostic): void;
  /** Optional clock for deterministic tests. */
  now?: () => string;
}

/** Options for {@link AutonomyControlService.revertAutonomousChangesSince}. */
export interface RevertAutonomousChangesOptions {
  /** Restrict the revert to a subset of kinds (default: all). */
  kinds?: AutonomyAuditKind[];
  /** Cap how many entries are reverted in one pass (default: unbounded). */
  limit?: number;
}

const DEFAULT_RECENT_LIMIT = 20;

export class AutonomyControlService {
  private readonly storage: AutonomyControlStorage;
  private readonly isFeatureEnabled: (flag: string) => boolean;
  private readonly setKillSwitchFlag: (disabled: boolean) => void;
  private readonly handlers: AutonomyRestoreHandlers;
  private readonly recordDevDiagnostic: (input: AutonomyControlDiagnostic) => void;
  private readonly now: () => string;

  public constructor(deps: AutonomyControlServiceDeps) {
    this.storage = deps.storage;
    this.isFeatureEnabled = deps.isFeatureEnabled;
    this.setKillSwitchFlag = deps.setKillSwitch;
    this.handlers = deps.restoreHandlers;
    this.recordDevDiagnostic = deps.recordDevDiagnostic;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /**
   * Append an audit entry for an autonomous mutation. Best-effort: any failure is
   * swallowed (logged) so the mutation it describes is never broken. Returns the
   * stored entry, or `undefined` if the append failed.
   */
  public recordAutonomousMutation(input: AutonomyAuditAppendInput): AutonomyAuditEntry | undefined {
    try {
      return this.storage.autonomyAudit.append(input, this.now());
    } catch (error) {
      this.recordDevDiagnostic({
        level: "warn",
        category: "autonomy",
        event: "autonomy_audit_append_failed",
        message: "failed to append autonomy audit entry (mutation itself is unaffected)",
        context: { kind: input.kind, targetKey: input.targetKey, error: describeError(error) },
      });
      return undefined;
    }
  }

  /** Master kill-switch state + recent-audit summary. */
  public getStatus(recentLimit = DEFAULT_RECENT_LIMIT): AutonomyControlStatus {
    const killSwitchEngaged = this.isFeatureEnabled("autonomyV1Disabled");
    return {
      killSwitchEngaged,
      autonomyEnabled: !killSwitchEngaged,
      audit: this.buildAuditSummary(recentLimit),
    };
  }

  /** Engage/disengage the master kill switch (`autonomyV1Disabled`). */
  public setKillSwitch(disabled: boolean): AutonomyControlStatus {
    this.setKillSwitchFlag(disabled);
    return this.getStatus();
  }

  /**
   * Revert every un-reverted autonomous change with `occurredAt >= sinceIso`,
   * newest-first. Each entry is restored via its kind's restore callback; a
   * single failure is isolated (logged) and the pass continues. Successfully
   * restored entries are marked reverted (idempotent on re-run). Returns a
   * summary.
   */
  public revertAutonomousChangesSince(
    sinceIso: string,
    opts: RevertAutonomousChangesOptions = {},
  ): AutonomyRevertSummary {
    const kindFilter = opts.kinds && opts.kinds.length > 0 ? new Set(opts.kinds) : undefined;
    let candidates = this.storage.autonomyAudit.listUnrevertedSince(sinceIso);
    if (kindFilter) {
      candidates = candidates.filter((entry) => kindFilter.has(entry.kind));
    }
    if (typeof opts.limit === "number" && opts.limit >= 0) {
      candidates = candidates.slice(0, Math.floor(opts.limit));
    }

    const results: AutonomyRevertEntryResult[] = [];
    for (const entry of candidates) {
      results.push(this.revertOne(entry));
    }

    const reverted = results.filter((r) => r.status === "reverted").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    const failed = results.filter((r) => r.status === "failed").length;
    return {
      since: sinceIso,
      considered: candidates.length,
      reverted,
      skipped,
      failed,
      results,
    };
  }

  /** Restore a single entry with per-entry failure isolation. */
  private revertOne(entry: AutonomyAuditEntry): AutonomyRevertEntryResult {
    const base = { auditId: entry.auditId, kind: entry.kind, targetKey: entry.targetKey };
    // Claim the entry BEFORE dispatching the restore. `markReverted` is an atomic
    // `... AND reverted = 0` update that returns false if the row was already
    // reverted (e.g. a concurrent revert pass), so claiming first guarantees the
    // restore callback runs at most once per entry — no double-dispatch races.
    const claimed = this.storage.autonomyAudit.markReverted(entry.auditId, this.now());
    if (!claimed) {
      return { ...base, status: "skipped" };
    }
    try {
      const applied = this.dispatchRestore(entry.restoreRef);
      if (!applied) {
        // The subsystem reported nothing to restore (e.g. snapshot already gone).
        // The entry is already marked reverted (claimed above) so it does not
        // block subsequent passes.
        return { ...base, status: "skipped" };
      }
      return { ...base, status: "reverted" };
    } catch (error) {
      // The restore threw: roll back the claim so the entry stays UN-reverted and
      // a later pass can retry it (the claim only existed to guard the dispatch).
      this.storage.autonomyAudit.unmarkReverted(entry.auditId);
      const message = describeError(error);
      this.recordDevDiagnostic({
        level: "warn",
        category: "autonomy",
        event: "autonomy_revert_entry_failed",
        message: "failed to revert one autonomy audit entry; continuing with the rest",
        context: { auditId: entry.auditId, kind: entry.kind, targetKey: entry.targetKey, error: message },
      });
      return { ...base, status: "failed", error: message };
    }
  }

  /**
   * Dispatch to the kind's restore callback. Returns true when a restore was
   * applied, false when there was nothing to restore (callbacks that cannot
   * report that return true). Throws are surfaced to {@link revertOne}.
   */
  private dispatchRestore(ref: AutonomyAuditRestoreRef): boolean {
    switch (ref.kind) {
      case "skill_revision":
        this.handlers.restoreSkillRevision(ref.snapshotRef);
        return true;
      case "operator_profile":
      case "memory":
        this.handlers.restoreOperatorProfile(ref.priorSnapshot);
        return true;
      case "curator_archive":
        return this.handlers.restoreCuratorArchive(ref.skillId);
      case "tune":
        this.handlers.revertTune(ref.tuneId);
        return true;
      default:
        return assertNever(ref);
    }
  }

  private buildAuditSummary(recentLimit: number): AutonomyAuditSummary {
    const counts = this.storage.autonomyAudit.countByKind();
    const byKind = AUTONOMY_AUDIT_KINDS.map((kind) => {
      const found = counts.find((c) => c.kind === kind);
      return { kind, total: found?.total ?? 0, reverted: found?.reverted ?? 0 };
    });
    const totalEntries = byKind.reduce((sum, k) => sum + k.total, 0);
    const revertedEntries = byKind.reduce((sum, k) => sum + k.reverted, 0);
    return {
      totalEntries,
      unrevertedEntries: totalEntries - revertedEntries,
      byKind,
      recent: this.storage.autonomyAudit.listRecent(recentLimit),
    };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled autonomy audit restore kind: ${JSON.stringify(value)}`);
}
