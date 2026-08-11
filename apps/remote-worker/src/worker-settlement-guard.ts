import { canonicalJsonString } from "@goatcitadel/contracts";
import type { WorkerDurableStatePort } from "./worker-durable-state.js";

/**
 * The terminal settlement the worker retains once the Gateway has settled an
 * assignment. `usageEventIds` are the canonical HX-306 identifiers the Gateway
 * returned; the worker never fabricates accounting evidence and never mints a
 * second usage id, so reconnect/restart carry no duplicate accounting.
 */
export interface WorkerSettlementReceipt {
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly outcome: "completed" | "failed" | "cancelled";
  readonly settlementSha256: string;
  readonly usageEventIds: readonly string[];
  readonly settledAt: string;
}

export class WorkerSettlementGuardError extends Error {
  readonly code = "REMOTE_WORKER_SETTLEMENT_GUARD_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "WorkerSettlementGuardError";
  }
}

/** A second, differing settlement for a terminal assignment is never accepted. */
export class WorkerSettlementConflictError extends Error {
  readonly code = "REMOTE_WORKER_SETTLEMENT_CONFLICT";

  constructor(readonly assignmentId: string) {
    super(`A conflicting settlement was submitted for assignment ${assignmentId}.`);
    this.name = "WorkerSettlementConflictError";
  }
}

const STATE_KEY = "settlement-receipts";
const OUTCOMES = new Set<WorkerSettlementReceipt["outcome"]>(["completed", "failed", "cancelled"]);

/**
 * Durable, idempotent record of settled assignments. The first settlement for
 * an assignment is stored; a byte-identical repeat is a no-op that returns the
 * retained receipt (so a lost settle response is safely retried); a conflicting
 * repeat fails closed. A restarted worker re-hydrates the settled set and will
 * not re-settle already-terminal work.
 */
export class WorkerSettlementGuard {
  private constructor(
    private readonly state: WorkerDurableStatePort,
    private readonly receipts: Map<string, WorkerSettlementReceipt>,
  ) {}

  static async open(state: WorkerDurableStatePort): Promise<WorkerSettlementGuard> {
    const raw = await state.read(STATE_KEY);
    const receipts = new Map<string, WorkerSettlementReceipt>();
    if (raw !== undefined) {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new WorkerSettlementGuardError("Retained settlements are corrupt.");
      for (const entry of parsed) {
        const receipt = normalizeReceipt(entry);
        receipts.set(receipt.assignmentId, receipt);
      }
    }
    return new WorkerSettlementGuard(state, receipts);
  }

  isSettled(assignmentId: string): boolean {
    return this.receipts.has(assertIdentifier(assignmentId));
  }

  getReceipt(assignmentId: string): WorkerSettlementReceipt | undefined {
    return this.receipts.get(assertIdentifier(assignmentId));
  }

  /**
   * Record a terminal settlement exactly once. Returns `firstTime: false` with
   * the retained receipt for a byte-identical repeat; throws on a conflicting
   * repeat. The caller uses `firstTime` to decide whether any settlement-time
   * side effect (which there are none of on the worker) should run.
   */
  async recordSettlement(
    receipt: WorkerSettlementReceipt,
  ): Promise<Readonly<{ firstTime: boolean; receipt: WorkerSettlementReceipt }>> {
    const normalized = normalizeReceipt(receipt);
    const existing = this.receipts.get(normalized.assignmentId);
    if (existing !== undefined) {
      if (canonicalJsonString(existing) !== canonicalJsonString(normalized)) {
        throw new WorkerSettlementConflictError(normalized.assignmentId);
      }
      return Object.freeze({ firstTime: false, receipt: existing });
    }
    this.receipts.set(normalized.assignmentId, normalized);
    await this.state.write(STATE_KEY, canonicalJsonString([...this.receipts.values()]));
    return Object.freeze({ firstTime: true, receipt: normalized });
  }
}

function normalizeReceipt(value: unknown): WorkerSettlementReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkerSettlementGuardError("A settlement receipt must be an object.");
  }
  const record = value as Record<string, unknown>;
  const outcome = record.outcome;
  if (typeof outcome !== "string" || !OUTCOMES.has(outcome as WorkerSettlementReceipt["outcome"])) {
    throw new WorkerSettlementGuardError("A settlement outcome is invalid.");
  }
  const usageEventIds = record.usageEventIds;
  if (!Array.isArray(usageEventIds) || usageEventIds.some((id) => typeof id !== "string" || id.length < 1)) {
    throw new WorkerSettlementGuardError("Settlement usage event ids must be non-empty strings.");
  }
  const settledAt = record.settledAt;
  if (typeof settledAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(settledAt)) {
    throw new WorkerSettlementGuardError("A settlement timestamp is invalid.");
  }
  return Object.freeze({
    assignmentId: assertIdentifier(record.assignmentId),
    assignmentGeneration: assertPositiveInteger(record.assignmentGeneration),
    outcome: outcome as WorkerSettlementReceipt["outcome"],
    settlementSha256: assertSha256(record.settlementSha256),
    usageEventIds: Object.freeze([...(usageEventIds as string[])]),
    settledAt,
  });
}

function assertIdentifier(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) {
    throw new WorkerSettlementGuardError("A settlement assignment id is invalid.");
  }
  return value;
}

function assertPositiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new WorkerSettlementGuardError("A settlement generation is invalid.");
  }
  return value;
}

function assertSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new WorkerSettlementGuardError("A settlement digest is invalid.");
  }
  return value;
}
