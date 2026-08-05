import { createHash, randomUUID } from "node:crypto";
import type {
  DryRunCommitDiagnostic,
  DryRunCommitRecord,
  DryRunCommitStore,
  DryRunPlannedAction,
  WardEffect,
} from "@goatcitadel/contracts";
import { canonicalJsonBytes } from "./evidence-receipt-service.js";

// The persistence-facing shapes moved to @goatcitadel/contracts so the storage package can
// implement a durable ledger; re-export them so existing importers keep working.
export type {
  DryRunCommitDiagnostic,
  DryRunCommitRecord,
  DryRunCommitState,
  DryRunCommitStore,
  DryRunPlannedAction,
} from "@goatcitadel/contracts";

/**
 * Provable Dry-Run → Commit (C2 "destroyer" moat).
 *
 * Every gated external side-effect first emits a DRY-RUN preview of the *exact* planned
 * action. The preview is canonicalized + hashed (`dryRunHash`). An operator approves the
 * preview. The COMMIT path then re-derives the hash of the action it is about to execute
 * and REJECTS the commit unless it byte-for-byte matches the approved `dryRunHash`.
 *
 *   plannedAction --canonicalize--> bytes --sha256(domain-separated)--> dryRunHash   (NO boundary crossed)
 *        |                                                                   |
 *        +-- persisted in `dry_run` / awaiting-commit state                   |
 *                                                                            v
 *   commit(plannedAction') --re-hash--> compare ==> match ? cross boundary once : REJECT (no boundary)
 *
 * The guarantee: an agent cannot preview one thing and commit another. The hash is computed
 * over the SAME canonical bytes for both preview and commit, so any divergence in route, target,
 * or payload changes the hash and the commit is refused *before* the external boundary is reached.
 *
 * This module is deliberately self-contained and dependency-light (mirrors the evidence-receipt
 * canonicalization moat): it reuses `canonicalJsonBytes` so the dry-run hash is stable across key
 * ordering and JSON transport, and it defines its own narrow store port so it stays testable and
 * does not widen the external side-effect ledger contract.
 */

/** Domain-separation tag so a dry-run hash can never collide with another sha256 use in the system. */
const DRY_RUN_COMMIT_DIGEST_DOMAIN_KEY = "goatcitadel:dry-run-commit-digest:v1";

/** Inputs needed to open a dry-run preview for a planned side-effect. */
export interface DryRunPreviewInput {
  /** The owning external side-effect run id (links the preview to the ledger lineage). */
  runId: string;
  /** The external side-effect boundary this action would cross. */
  boundary: string;
  /** The exact planned action (route/target/payload). */
  plannedAction: DryRunPlannedAction;
  /** The runner's payloadHash for the same payload (carried through for ledger/receipt linkage). */
  payloadHash: string;
  workspaceId?: string;
  createdAt: string;
}

type Awaitable<T> = T | Promise<T>;

/** Promise-compatible port used by the Gateway async-storage boundary and synchronous test stores. */
export interface DryRunCommitStorePort {
  create(record: DryRunCommitRecord): Awaitable<DryRunCommitRecord>;
  get(dryRunId: string): Awaitable<DryRunCommitRecord | undefined>;
  update(dryRunId: string, patch: Partial<DryRunCommitRecord>): Awaitable<DryRunCommitRecord | undefined>;
}

/** Compute the canonical, domain-separated dry-run hash for a planned action. Pure + deterministic. */
export function computeDryRunHash(plannedAction: DryRunPlannedAction): string {
  // Hash the canonical bytes of a fixed-shape object so the digest is independent of key order and
  // stable across JSON transport. Domain separation prevents cross-protocol hash reuse.
  const canonicalBytes = canonicalJsonBytes({
    route: plannedAction.route,
    target: plannedAction.target,
    payload: plannedAction.payload,
  });
  return createHash("sha256")
    .update(DRY_RUN_COMMIT_DIGEST_DOMAIN_KEY)
    .update("\0")
    .update(canonicalBytes)
    .digest("hex");
}

function nextDryRunId(): string {
  return `dryrun-${randomUUID()}`;
}

/**
 * Produce + persist a DRY-RUN preview for a planned side-effect. NO external boundary is crossed.
 * The returned record is in `awaiting_commit` state and carries the `dryRunHash` an operator approves.
 */
export async function createDryRunPreview(
  store: DryRunCommitStorePort,
  input: DryRunPreviewInput,
): Promise<DryRunCommitRecord> {
  const dryRunHash = computeDryRunHash(input.plannedAction);
  const record: DryRunCommitRecord = {
    dryRunId: nextDryRunId(),
    runId: input.runId,
    boundary: input.boundary,
    workspaceId: input.workspaceId,
    plannedAction: input.plannedAction,
    payloadHash: input.payloadHash,
    dryRunHash,
    state: "awaiting_commit",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
  return store.create(record);
}

/** Operator approval of a previewed action. The commit is refused until this has been recorded. */
export async function approveDryRun(
  store: DryRunCommitStorePort,
  dryRunId: string,
  input: { approvedBy?: string; approvedAt: string },
): Promise<DryRunCommitRecord | undefined> {
  const record = await store.get(dryRunId);
  if (!record || record.state !== "awaiting_commit") {
    return record;
  }
  return store.update(dryRunId, {
    approvedAt: input.approvedAt,
    approvedBy: input.approvedBy,
    updatedAt: input.approvedAt,
  });
}

/** The boundary-crossing executor a commit runs once, and ONLY once the hash has matched. */
export interface DryRunCommitExecuteContext {
  readonly record: DryRunCommitRecord;
  /** Call immediately before the request crosses the external boundary (mirrors the runner seam). */
  markExternalCallStarted(): void;
}

export interface DryRunCommitInput<TValue> {
  dryRunId: string;
  /**
   * The action the agent is ACTUALLY about to commit. This is re-hashed and compared to the approved
   * `dryRunHash`; if it differs, the commit is refused before `execute` runs. Pass the action the
   * commit path would really send — passing the stored preview action here would defeat the moat.
   */
  committedAction: DryRunPlannedAction;
  committedAt: string;
  /** Crosses the external boundary. Invoked at most once, only after approval + hash match. */
  execute(context: DryRunCommitExecuteContext): Promise<TValue>;
}

export type DryRunCommitResult<TValue> =
  | {
      status: "committed";
      record: DryRunCommitRecord;
      value: TValue;
    }
  | {
      status: "rejected";
      record: DryRunCommitRecord;
      diagnostic: DryRunCommitDiagnostic;
    }
  | {
      status: "failed";
      record: DryRunCommitRecord;
      diagnostic: DryRunCommitDiagnostic;
      error: Error;
    };

/**
 * Commit a previously-approved dry-run — the heart of the moat.
 *
 * Recomputes the hash of `committedAction` and REJECTS (before crossing the boundary) unless it
 * matches the operator-approved `dryRunHash`. A mismatch persists a durable `hash_mismatch`
 * diagnostic and `execute` is never invoked — so an agent that previewed one action and tries to
 * commit a different one physically cannot reach the external system.
 */
export async function commitDryRun<TValue>(
  store: DryRunCommitStorePort,
  input: DryRunCommitInput<TValue>,
): Promise<DryRunCommitResult<TValue>> {
  const existing = await store.get(input.dryRunId);
  if (!existing) {
    throw new Error(`dry-run record ${input.dryRunId} not found; cannot commit an unknown preview`);
  }

  if (existing.state !== "awaiting_commit") {
    const diagnostic: DryRunCommitDiagnostic = {
      code: "not_awaiting_commit",
      message: `dry-run ${input.dryRunId} is in state "${existing.state}" and cannot be committed`,
      approvedDryRunHash: existing.dryRunHash,
      recordedAt: input.committedAt,
    };
    return { status: "rejected", record: existing, diagnostic };
  }

  if (!existing.approvedAt) {
    const diagnostic: DryRunCommitDiagnostic = {
      code: "not_approved",
      message: `dry-run ${input.dryRunId} has not been approved by an operator; commit refused before the boundary`,
      approvedDryRunHash: existing.dryRunHash,
      recordedAt: input.committedAt,
    };
    const record = (await store.update(input.dryRunId, { diagnostic, updatedAt: input.committedAt })) ?? existing;
    return { status: "rejected", record, diagnostic };
  }

  // THE GUARANTEE: re-derive the hash of what is actually about to be committed and refuse on mismatch.
  const attemptedCommitHash = computeDryRunHash(input.committedAction);
  if (attemptedCommitHash !== existing.dryRunHash) {
    const diagnostic: DryRunCommitDiagnostic = {
      code: "hash_mismatch",
      message:
        `commit refused: planned action hashes to ${attemptedCommitHash} but the approved dry-run is ${existing.dryRunHash}. ` +
        "The committed action does not match the previewed-and-approved action; the external boundary was not crossed.",
      approvedDryRunHash: existing.dryRunHash,
      attemptedCommitHash,
      recordedAt: input.committedAt,
    };
    const record =
      (await store.update(input.dryRunId, {
        state: "rejected_hash_mismatch",
        diagnostic,
        updatedAt: input.committedAt,
      })) ?? existing;
    return { status: "rejected", record, diagnostic };
  }

  // Hash matched + approved: this is the only path that may cross the external boundary.
  let externalCallStarted = false;
  const context: DryRunCommitExecuteContext = {
    record: existing,
    markExternalCallStarted() {
      externalCallStarted = true;
    },
  };

  try {
    const value = await input.execute(context);
    const record =
      (await store.update(input.dryRunId, {
        state: "committed",
        committedAt: input.committedAt,
        externalReferenceId: readExternalReferenceId(value),
        updatedAt: input.committedAt,
      })) ?? existing;
    return { status: "committed", record, value };
  } catch (error) {
    const diagnostic: DryRunCommitDiagnostic = {
      code: "commit_execution_failed",
      message:
        `commit matched the approved dry-run but the external execution failed: ` +
        `${error instanceof Error ? error.message : "unknown error"}` +
        (externalCallStarted
          ? " (the external boundary may have been crossed; manual reconciliation required)"
          : " (the external boundary was not crossed)"),
      approvedDryRunHash: existing.dryRunHash,
      attemptedCommitHash,
      recordedAt: input.committedAt,
    };
    const record =
      (await store.update(input.dryRunId, {
        state: "rejected_commit_failed",
        diagnostic,
        updatedAt: input.committedAt,
      })) ?? existing;
    return {
      status: "failed",
      record,
      diagnostic,
      error: error instanceof Error ? error : new Error("dry_run_commit_execution_failed"),
    };
  }
}

/**
 * Ward enforcement entry point. Decides whether a side-effect must be forced through the
 * dry-run → approve → commit flow based on the Ward effect produced by `evaluateWards()`.
 *
 * Returns `"force_dry_run"` for `require_dry_run` (the caller MUST NOT execute directly — it has to
 * open a preview and await an approved commit), and `"pass_through"` for every other effect so
 * non-gated side-effects behave exactly as today. `deny` is intentionally NOT handled here: it is
 * enforced upstream (policy engine / route layer) before a side-effect runner is ever reached.
 */
export type DryRunEnforcementDecision = "force_dry_run" | "pass_through";

export function decideDryRunEnforcement(wardEffect: WardEffect | undefined): DryRunEnforcementDecision {
  return wardEffect === "require_dry_run" ? "force_dry_run" : "pass_through";
}

/** True when a Ward effect requires the provable dry-run → commit flow. */
export function wardRequiresDryRun(wardEffect: WardEffect | undefined): boolean {
  return decideDryRunEnforcement(wardEffect) === "force_dry_run";
}

function readExternalReferenceId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const output =
    record.output && typeof record.output === "object" && !Array.isArray(record.output) ? record.output : record;
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return undefined;
  }
  for (const key of ["workflowRunId", "flowRunId", "runId", "run_id", "id", "messageId", "threadId", "url", "webUrl"]) {
    const field = (output as Record<string, unknown>)[key];
    if (typeof field === "string" && field.trim()) {
      return `${key}:${field.trim().slice(0, 128)}`;
    }
  }
  return undefined;
}

/** A minimal in-memory store for the dry-run/commit ledger (tests + non-persistent runtime). */
export function createInMemoryDryRunCommitStore(): DryRunCommitStore {
  const records = new Map<string, DryRunCommitRecord>();
  return {
    create(record) {
      records.set(record.dryRunId, { ...record });
      return { ...record };
    },
    get(dryRunId) {
      const found = records.get(dryRunId);
      return found ? { ...found } : undefined;
    },
    update(dryRunId, patch) {
      const found = records.get(dryRunId);
      if (!found) {
        return undefined;
      }
      const next = { ...found, ...patch };
      records.set(dryRunId, next);
      return { ...next };
    },
  };
}
