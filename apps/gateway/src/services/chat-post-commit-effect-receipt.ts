import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import { DurableWorkerInterruptionError } from "./durable-run-service.js";

const CANONICAL_RECEIPT_METADATA_KEY = "generalChatPostCommitCanonical";
const CANONICAL_RECEIPT_VERSION = 1;

export type ChatPostCommitEffectReceiptStoragePort = Pick<Storage, "durableRuns" | "runImmediateTransaction">;

export type GeneralChatPostCommitCanonicalEffect = "commitments" | "background_review" | "memory_maintenance";
export type GeneralChatPostCommitCanonicalStage =
  | "commitments_write"
  | "background_counter"
  | "background_evidence"
  | "memory_maintenance_evaluation";

export type GeneralChatPostCommitStageDisposition = "completed" | "late_blocked";
export type ChatPostCommitAuthorityDecision = "allowed" | "late_blocked";

export type GeneralChatPostCommitStageReceipt =
  | {
      completedAt: string;
      /** Absent only on legacy v1 receipts, which are equivalent to completed. */
      disposition?: "completed";
      result: Record<string, unknown>;
    }
  | {
      completedAt: string;
      disposition: "late_blocked";
      /** Intentionally no result: late authority failures must retain no provider/domain content. */
    };

interface GeneralChatPostCommitCanonicalReceipt {
  version: 1;
  effect: GeneralChatPostCommitCanonicalEffect;
  stages: Partial<Record<GeneralChatPostCommitCanonicalStage, GeneralChatPostCommitStageReceipt>>;
}

/** Frozen session authority. Callers must never reconstruct this from current session metadata. */
export interface ChatPostCommitFrozenParentAdmissionIdentity {
  admissionId: string;
  sessionIncarnationId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  aggregateRevision: number;
  controllerGeneration: number;
  materialSha256: string;
}

/** Replayable synchronous child authority; it never occupies the active-turn slot. */
export interface ChatPostCommitFrozenChildAdmissionIdentity {
  admissionId: string;
  sessionIncarnationId: string;
  workspaceId: string;
  sessionId: string;
  aggregateRevision: number;
  controllerGeneration: number;
  actorKind: "operator" | "external_companion" | "system";
  actorId: string;
  operation: "chat_post_commit_child";
  materialSha256: string;
}

export interface ChatPostCommitChildDurableClaim {
  durableRunId: string;
  leaseOwnerId: string;
  attemptCount: number;
}

export interface ChatPostCommitFrozenEligibility {
  version: 1;
  autonomyEnabledAtParentSettlement: boolean;
  evalIntegrityTurn: boolean;
  humanSession: boolean;
}

/** Explicit parent/child authority supplied by the durable boundary. */
export interface ChatPostCommitEffectAuthorityContext {
  parent: ChatPostCommitFrozenParentAdmissionIdentity;
  child: ChatPostCommitFrozenChildAdmissionIdentity;
  childDurableClaim: ChatPostCommitChildDurableClaim;
  /** Frozen alongside the child payload/material; never reconstructed from current session state. */
  postCommitEligibility: ChatPostCommitFrozenEligibility;
}

export interface ChatPostCommitStageAuthorityInput {
  authority: ChatPostCommitEffectAuthorityContext;
  parentRunId: string;
  postCommitGenerationId: string;
  childRunId: string;
  sourceTurnId: string;
  postCommitEligibility: ChatPostCommitFrozenEligibility;
  effect: GeneralChatPostCommitCanonicalEffect;
  stage: GeneralChatPostCommitCanonicalStage;
  terminal: boolean;
}

export interface ChatPostCommitAtomicStageCallbackContext {
  disposition: ChatPostCommitAuthorityDecision;
  /** Exact active synchronous child admission; D3 intentionally treats the storage record as opaque. */
  admission: unknown;
  durableRunVersion: number;
}

export interface ChatPostCommitAtomicStageCallbackResult<TValue> {
  /** May preserve the storage decision or reduce allowed to late_blocked; never upgrade it. */
  disposition: ChatPostCommitAuthorityDecision;
  value: TValue;
}

export interface ChatPostCommitAtomicStageOutcome<TValue> {
  disposition: ChatPostCommitAuthorityDecision;
  value: TValue;
  /** Resulting admission: active for an allowed nonterminal stage, otherwise completed/cancelled. */
  admission: unknown;
}

/**
 * Storage-agnostic seam for the D2 integrator. `run` locks the session and exact
 * active synchronous child admission before the exact durable claim, then calls
 * the awaited callback while the owned storage transaction retains those locks.
 * After the callback, an allowed nonterminal stage retains the active admission,
 * an allowed terminal stage completes it, and any late-blocked stage cancels it.
 * Any rejection rolls all writes back together.
 */
export interface ChatPostCommitAtomicStageAuthorityPort {
  run<TValue>(
    input: ChatPostCommitStageAuthorityInput,
    callback: (
      context: ChatPostCommitAtomicStageCallbackContext,
    ) => Promise<ChatPostCommitAtomicStageCallbackResult<TValue>>,
  ): Promise<ChatPostCommitAtomicStageOutcome<TValue>>;
}

export interface GeneralChatPostCommitStageIdentity {
  effectRunId: string;
  expectedLeaseOwnerId: string;
  effect: GeneralChatPostCommitCanonicalEffect;
  stage: GeneralChatPostCommitCanonicalStage;
}

export interface GeneralChatPostCommitStageCommitOptions {
  authority?: {
    context: ChatPostCommitEffectAuthorityContext;
    parentRunId: string;
    postCommitGenerationId: string;
    port: ChatPostCommitAtomicStageAuthorityPort;
    terminal: boolean;
  };
  /** Used when pre-dispatch already denied authority; provider/domain apply is skipped. */
  forcedDisposition?: "late_blocked";
  /** Re-evaluated under the atomic authority locks; may only reduce to late_blocked. */
  denyOnlyBlocked?: () => Promise<boolean>;
}

export interface GeneralChatPostCommitStageCommitResult<TValue> {
  replayed: boolean;
  value?: TValue;
  receipt: GeneralChatPostCommitStageReceipt;
}

/**
 * Reads an already-committed stage receipt so durable retries can avoid another
 * provider call. Canonical writes still go through {@link commitGeneralChatPostCommitStage}.
 */
export async function readGeneralChatPostCommitStage(
  storage: ChatPostCommitEffectReceiptStoragePort,
  identity: Omit<GeneralChatPostCommitStageIdentity, "expectedLeaseOwnerId">,
): Promise<GeneralChatPostCommitStageReceipt | undefined> {
  const run = await storage.durableRuns.getRun(identity.effectRunId);
  assertEffectRunIdentity(run.workflowKey, run.metadata, identity.effect);
  const receipt = readCanonicalReceipt(run.metadata, identity.effect)?.stages[identity.stage];
  return receipt ? sanitizeStageReceipt(identity.stage, receipt) : undefined;
}

/** Convert a receipt into a safe service result without exposing late provider/domain content. */
export function readGeneralChatPostCommitStageResult(
  receipt: GeneralChatPostCommitStageReceipt,
): Record<string, unknown> {
  return receipt.disposition === "late_blocked"
    ? { status: "late_blocked", disposition: "late_blocked" }
    : receipt.result;
}

/**
 * Serializes one canonical post-commit write. Lock order is deliberately:
 * outer transaction -> session/admission guard -> exact child lease -> domain
 * write + receipt -> authority settlement. Provider reads happen beforehand;
 * the awaited `apply` remains inside the owned storage transaction.
 */
export async function commitGeneralChatPostCommitStage<TValue>(
  storage: ChatPostCommitEffectReceiptStoragePort,
  identity: GeneralChatPostCommitStageIdentity,
  apply: () => Promise<{ value: TValue; result: Record<string, unknown> }>,
  options: GeneralChatPostCommitStageCommitOptions = {},
): Promise<GeneralChatPostCommitStageCommitResult<TValue>> {
  // A completed immutable receipt is authoritative replay truth. Its terminal
  // admission may already be closed, so do not call the active-authority guard
  // or settlement callback again.
  const fastReplay = await readGeneralChatPostCommitStage(storage, identity);
  if (fastReplay) {
    return { replayed: true, receipt: fastReplay };
  }
  return await storage.runImmediateTransaction(async () => {
    const authorityInput = options.authority
      ? {
          authority: options.authority.context,
          parentRunId: options.authority.parentRunId,
          postCommitGenerationId: options.authority.postCommitGenerationId,
          childRunId: options.authority.context.childDurableClaim.durableRunId,
          sourceTurnId: options.authority.context.parent.turnId,
          postCommitEligibility: options.authority.context.postCommitEligibility,
          effect: identity.effect,
          stage: identity.stage,
          terminal: options.authority.terminal,
        }
      : undefined;
    const commitUnderAuthority = async (
      callbackContext: ChatPostCommitAtomicStageCallbackContext,
    ): Promise<GeneralChatPostCommitStageCommitResult<TValue>> => {
      assertAuthorityDecision(callbackContext.disposition);
      if (!Number.isSafeInteger(callbackContext.durableRunVersion) || callbackContext.durableRunVersion < 1) {
        throw new Error("Durable Chat post-commit authority returned an invalid durable run version.");
      }
      const disposition = callbackContext.disposition === "allowed" ? "completed" : "late_blocked";

      // The authority wrapper has locked session/admission and the exact claim
      // before this defensive exact child-run lock/read.
      const locked = await requireFreshEffectLease(storage, identity);
      if (locked.version !== callbackContext.durableRunVersion) {
        throw new Error("Durable Chat post-commit authority and effect lease versions diverged.");
      }
      const currentReceipt =
        readCanonicalReceipt(locked.metadata, identity.effect) ?? createCanonicalReceipt(identity.effect);
      const existing = currentReceipt.stages[identity.stage];
      if (existing) {
        return { replayed: true, receipt: sanitizeStageReceipt(identity.stage, existing) };
      }

      const completedAt = new Date().toISOString();
      let value: TValue | undefined;
      let stageReceipt: GeneralChatPostCommitStageReceipt;
      if (disposition === "late_blocked") {
        stageReceipt = { completedAt, disposition: "late_blocked" };
      } else {
        const applied = await apply();
        value = applied.value;
        stageReceipt = {
          completedAt,
          disposition: "completed",
          result: sanitizeStageResult(identity.stage, applied.result),
        };
      }
      await storage.durableRuns.updateRun({
        runId: locked.runId,
        status: locked.status,
        metadata: {
          ...(locked.metadata ?? {}),
          [CANONICAL_RECEIPT_METADATA_KEY]: {
            ...currentReceipt,
            stages: {
              ...currentReceipt.stages,
              [identity.stage]: stageReceipt,
            },
          },
        },
        updatedAt: completedAt,
        expectedVersion: locked.version,
      });
      return { replayed: false, ...(value === undefined ? {} : { value }), receipt: stageReceipt };
    };

    if (!authorityInput) {
      const run = await storage.durableRuns.getRun(identity.effectRunId);
      const disposition = await reduceAuthorityDecision("allowed", options);
      return await commitUnderAuthority({ disposition, admission: undefined, durableRunVersion: run.version });
    }
    let callbackDisposition: ChatPostCommitAuthorityDecision | undefined;
    const outcome = await options.authority!.port.run(authorityInput, async (callbackContext) => {
      callbackDisposition = await reduceAuthorityDecision(callbackContext.disposition, options);
      return {
        disposition: callbackDisposition,
        value: await commitUnderAuthority({ ...callbackContext, disposition: callbackDisposition }),
      };
    });
    assertAuthorityDecision(outcome.disposition);
    if (!callbackDisposition || outcome.disposition !== callbackDisposition) {
      throw new Error("Durable Chat post-commit atomic authority outcome conflicts with its callback.");
    }
    return outcome.value;
  });
}

async function reduceAuthorityDecision(
  authorityDecision: ChatPostCommitAuthorityDecision,
  options: GeneralChatPostCommitStageCommitOptions,
): Promise<ChatPostCommitAuthorityDecision> {
  return authorityDecision === "late_blocked" ||
    options.forcedDisposition === "late_blocked" ||
    (options.denyOnlyBlocked ? await options.denyOnlyBlocked() : false)
    ? "late_blocked"
    : "allowed";
}

function assertEffectRunIdentity(
  workflowKey: string,
  metadata: Record<string, unknown> | undefined,
  effect: GeneralChatPostCommitCanonicalEffect,
): void {
  if (workflowKey !== "chat.post_commit.effect" || metadata?.effect !== effect) {
    throw new Error(`Durable Chat post-commit child does not own canonical ${effect} effects.`);
  }
}

async function requireFreshEffectLease(
  storage: ChatPostCommitEffectReceiptStoragePort,
  identity: GeneralChatPostCommitStageIdentity,
) {
  const locked = await storage.durableRuns.lockFreshActiveLeaseForUpdate(
    identity.effectRunId,
    identity.expectedLeaseOwnerId,
  );
  if (!locked) {
    throw new DurableWorkerInterruptionError(
      "lease_lost",
      `Durable Chat post-commit effect ${identity.effectRunId} lost lease ownership before ${identity.stage} could commit.`,
    );
  }
  assertEffectRunIdentity(locked.workflowKey, locked.metadata, identity.effect);
  return locked;
}

function createCanonicalReceipt(effect: GeneralChatPostCommitCanonicalEffect): GeneralChatPostCommitCanonicalReceipt {
  return {
    version: CANONICAL_RECEIPT_VERSION,
    effect,
    stages: {},
  };
}

function readCanonicalReceipt(
  metadata: Record<string, unknown> | undefined,
  effect: GeneralChatPostCommitCanonicalEffect,
): GeneralChatPostCommitCanonicalReceipt | undefined {
  const value = metadata?.[CANONICAL_RECEIPT_METADATA_KEY];
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Durable Chat post-commit canonical receipt is malformed.");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== CANONICAL_RECEIPT_VERSION || record.effect !== effect || !isStageMap(record.stages)) {
    throw new Error("Durable Chat post-commit canonical receipt does not match its child effect.");
  }
  // Return a sanitized shape. In particular, legacy backgroundSkillDecision
  // blobs (which contained raw Markdown) are never copied into a new write.
  return {
    version: CANONICAL_RECEIPT_VERSION,
    effect,
    stages: sanitizeCanonicalStageMap(effect, record.stages as Record<string, GeneralChatPostCommitStageReceipt>),
  };
}

function sanitizeCanonicalStageMap(
  effect: GeneralChatPostCommitCanonicalEffect,
  stages: Record<string, GeneralChatPostCommitStageReceipt>,
): GeneralChatPostCommitCanonicalReceipt["stages"] {
  const allowedStages: GeneralChatPostCommitCanonicalStage[] =
    effect === "commitments"
      ? ["commitments_write"]
      : effect === "background_review"
        ? ["background_counter", "background_evidence"]
        : ["memory_maintenance_evaluation"];
  const sanitized: GeneralChatPostCommitCanonicalReceipt["stages"] = {};
  for (const stage of allowedStages) {
    const receipt = stages[stage];
    if (receipt) {
      sanitized[stage] = sanitizeStageReceipt(stage, receipt);
    }
  }
  return sanitized;
}

function isStageMap(value: unknown): value is GeneralChatPostCommitCanonicalReceipt["stages"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((stage) => {
    if (!stage || typeof stage !== "object" || Array.isArray(stage)) {
      return false;
    }
    const candidate = stage as { completedAt?: unknown; disposition?: unknown; result?: unknown };
    if (typeof candidate.completedAt !== "string") {
      return false;
    }
    if (candidate.disposition === "late_blocked") {
      return candidate.result === undefined;
    }
    return (
      (candidate.disposition === undefined || candidate.disposition === "completed") &&
      Boolean(candidate.result) &&
      typeof candidate.result === "object" &&
      !Array.isArray(candidate.result)
    );
  });
}

function assertAuthorityDecision(value: string): asserts value is ChatPostCommitAuthorityDecision {
  if (value !== "allowed" && value !== "late_blocked") {
    throw new Error(`Unsupported durable Chat post-commit authority decision: ${value}`);
  }
}

const SAFE_SKIP_REASONS = new Set([
  "autonomous_turn",
  "autonomy_disabled",
  "counter_not_due",
  "delegated_child",
  "eval_integrity",
  "frozen_eligibility_invalid",
  "non_human_session",
]);

function sanitizeStageReceipt(
  stage: GeneralChatPostCommitCanonicalStage,
  receipt: GeneralChatPostCommitStageReceipt,
): GeneralChatPostCommitStageReceipt {
  if (receipt.disposition === "late_blocked") {
    return { completedAt: receipt.completedAt, disposition: "late_blocked" };
  }
  return {
    completedAt: receipt.completedAt,
    disposition: "completed",
    result: sanitizeStageResult(stage, receipt.result),
  };
}

function sanitizeStageResult(
  stage: GeneralChatPostCommitCanonicalStage,
  result: Record<string, unknown>,
): Record<string, unknown> {
  const skipped = sanitizeSkippedResult(result);
  if (skipped && stage !== "background_counter") {
    return skipped;
  }
  switch (stage) {
    case "commitments_write":
      return result.status === "classified" && isNonNegativeInteger(result.persistedCount)
        ? { status: "classified", persistedCount: result.persistedCount }
        : redactedReplayResult();
    case "background_counter":
      return typeof result.due === "boolean" ? { due: result.due } : redactedReplayResult();
    case "background_evidence": {
      if (result.status !== "evidence_recorded" || !Array.isArray(result.memoryEvidenceFingerprints)) {
        return redactedReplayResult();
      }
      const memoryEvidenceFingerprints = result.memoryEvidenceFingerprints.filter(isSha256Value);
      if (memoryEvidenceFingerprints.length !== result.memoryEvidenceFingerprints.length) {
        return redactedReplayResult();
      }
      const skillEvidenceFingerprint = isSha256Value(result.skillEvidenceFingerprint)
        ? result.skillEvidenceFingerprint
        : undefined;
      return {
        status: "evidence_recorded",
        memoryFactCount: memoryEvidenceFingerprints.length,
        memoryEvidenceFingerprints,
        skillProposed: Boolean(skillEvidenceFingerprint),
        ...(skillEvidenceFingerprint ? { skillEvidenceFingerprint } : {}),
        promotionDisposition: "governed_review_required",
      };
    }
    case "memory_maintenance_evaluation":
      return result.status === "production_dark"
        ? {
            status: "production_dark",
            reason: "governed_memory_promotion_not_implemented",
            enqueueDisposition: "not_enqueued",
          }
        : redactedReplayResult();
  }
}

function sanitizeSkippedResult(result: Record<string, unknown>): Record<string, unknown> | undefined {
  return result.status === "skipped" && typeof result.reason === "string" && SAFE_SKIP_REASONS.has(result.reason)
    ? { status: "skipped", reason: result.reason }
    : undefined;
}

function redactedReplayResult(): Record<string, unknown> {
  return { status: "replay_redacted", reason: "canonical_result_not_allowlisted" };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSha256Value(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
