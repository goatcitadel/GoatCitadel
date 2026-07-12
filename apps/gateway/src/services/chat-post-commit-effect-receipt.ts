import type { Storage } from "@goatcitadel/storage";
import { DurableWorkerInterruptionError } from "./durable-run-service.js";
import type { PreparedSkillMutationPlan } from "./skill-mutation-service.js";

const CANONICAL_RECEIPT_METADATA_KEY = "generalChatPostCommitCanonical";
const CANONICAL_RECEIPT_VERSION = 1;

export type ChatPostCommitEffectReceiptStoragePort = Pick<Storage, "durableRuns" | "runImmediateTransaction">;

export type GeneralChatPostCommitCanonicalEffect = "commitments" | "background_review" | "memory_maintenance";
export type GeneralChatPostCommitCanonicalStage =
  | "commitments_write"
  | "background_counter"
  | "background_memory"
  | "background_skill"
  | "memory_maintenance_evaluation";

export interface GeneralChatPostCommitStageReceipt {
  completedAt: string;
  result: Record<string, unknown>;
}

interface GeneralChatPostCommitCanonicalReceipt {
  version: 1;
  effect: GeneralChatPostCommitCanonicalEffect;
  stages: Partial<Record<GeneralChatPostCommitCanonicalStage, GeneralChatPostCommitStageReceipt>>;
  backgroundSkillDecision?: GeneralChatPostCommitBackgroundSkillDecision;
}

export type GeneralChatPostCommitBackgroundSkillDecision =
  | { version: 1; shouldAuthor: false }
  | { version: 1; shouldAuthor: true; plan: PreparedSkillMutationPlan };

export interface GeneralChatPostCommitStageIdentity {
  effectRunId: string;
  expectedLeaseOwnerId: string;
  effect: GeneralChatPostCommitCanonicalEffect;
  stage: GeneralChatPostCommitCanonicalStage;
}

export interface GeneralChatPostCommitStageCommitResult<TValue> {
  replayed: boolean;
  value?: TValue;
  receipt: GeneralChatPostCommitStageReceipt;
}

/**
 * Reads an already-committed stage receipt so durable retries can avoid another
 * provider call. Canonical writes still go through {@link commitGeneralChatPostCommitStage},
 * which rechecks the receipt under a database-clock lease fence.
 */
export function readGeneralChatPostCommitStage(
  storage: ChatPostCommitEffectReceiptStoragePort,
  identity: Omit<GeneralChatPostCommitStageIdentity, "expectedLeaseOwnerId">,
): GeneralChatPostCommitStageReceipt | undefined {
  const run = storage.durableRuns.getRun(identity.effectRunId);
  assertEffectRunIdentity(run.workflowKey, run.metadata, identity.effect);
  return readCanonicalReceipt(run.metadata, identity.effect)?.stages[identity.stage];
}

export function readGeneralChatPostCommitBackgroundSkillDecision(
  storage: ChatPostCommitEffectReceiptStoragePort,
  identity: Omit<GeneralChatPostCommitStageIdentity, "expectedLeaseOwnerId">,
): GeneralChatPostCommitBackgroundSkillDecision | undefined {
  assertBackgroundSkillIdentity(identity);
  const run = storage.durableRuns.getRun(identity.effectRunId);
  assertEffectRunIdentity(run.workflowKey, run.metadata, identity.effect);
  return readCanonicalReceipt(run.metadata, identity.effect)?.backgroundSkillDecision;
}

/** Persist the first validated provider decision under the fresh child lease. */
export function commitGeneralChatPostCommitBackgroundSkillDecision(
  storage: ChatPostCommitEffectReceiptStoragePort,
  identity: GeneralChatPostCommitStageIdentity,
  proposed: GeneralChatPostCommitBackgroundSkillDecision,
): GeneralChatPostCommitBackgroundSkillDecision {
  assertBackgroundSkillIdentity(identity);
  if (!isBackgroundSkillDecision(proposed)) {
    throw new Error("Durable Chat background-skill decision is malformed.");
  }
  return storage.runImmediateTransaction(() => {
    const locked = requireFreshEffectLease(storage, identity);
    const currentReceipt =
      readCanonicalReceipt(locked.metadata, identity.effect) ?? createCanonicalReceipt(identity.effect);
    if (currentReceipt.backgroundSkillDecision) {
      return currentReceipt.backgroundSkillDecision;
    }
    const updatedAt = new Date().toISOString();
    storage.durableRuns.updateRun({
      runId: locked.runId,
      status: locked.status,
      metadata: {
        ...(locked.metadata ?? {}),
        [CANONICAL_RECEIPT_METADATA_KEY]: {
          ...currentReceipt,
          backgroundSkillDecision: proposed,
        },
      },
      updatedAt,
      expectedVersion: locked.version,
    });
    return proposed;
  });
}

/**
 * Serializes one canonical post-commit write against the deterministic child
 * run. The database clock, current lease owner, domain write, and stage receipt
 * are checked/committed in the same transaction. Provider reads must happen
 * before this callback; `apply` must remain synchronous.
 */
export function commitGeneralChatPostCommitStage<TValue>(
  storage: ChatPostCommitEffectReceiptStoragePort,
  identity: GeneralChatPostCommitStageIdentity,
  apply: () => { value: TValue; result: Record<string, unknown> },
): GeneralChatPostCommitStageCommitResult<TValue> {
  return storage.runImmediateTransaction(() => {
    const locked = requireFreshEffectLease(storage, identity);
    const currentReceipt =
      readCanonicalReceipt(locked.metadata, identity.effect) ?? createCanonicalReceipt(identity.effect);
    const existing = currentReceipt.stages[identity.stage];
    if (existing) {
      return { replayed: true, receipt: existing };
    }

    const applied = apply();
    const stageReceipt: GeneralChatPostCommitStageReceipt = {
      completedAt: new Date().toISOString(),
      result: applied.result,
    };
    storage.durableRuns.updateRun({
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
      updatedAt: stageReceipt.completedAt,
      expectedVersion: locked.version,
    });
    return { replayed: false, value: applied.value, receipt: stageReceipt };
  });
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

function requireFreshEffectLease(
  storage: ChatPostCommitEffectReceiptStoragePort,
  identity: GeneralChatPostCommitStageIdentity,
) {
  const locked = storage.durableRuns.lockFreshActiveLeaseForUpdate(identity.effectRunId, identity.expectedLeaseOwnerId);
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

function assertBackgroundSkillIdentity(
  identity: Omit<GeneralChatPostCommitStageIdentity, "expectedLeaseOwnerId">,
): void {
  if (identity.effect !== "background_review" || identity.stage !== "background_skill") {
    throw new Error("Durable background-skill decisions belong only to the background_review/background_skill stage.");
  }
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
  if (
    record.version !== CANONICAL_RECEIPT_VERSION ||
    record.effect !== effect ||
    !isStageMap(record.stages) ||
    (record.backgroundSkillDecision !== undefined && !isBackgroundSkillDecision(record.backgroundSkillDecision))
  ) {
    throw new Error("Durable Chat post-commit canonical receipt does not match its child effect.");
  }
  return record as unknown as GeneralChatPostCommitCanonicalReceipt;
}

function isBackgroundSkillDecision(value: unknown): value is GeneralChatPostCommitBackgroundSkillDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const decision = value as { version?: unknown; shouldAuthor?: unknown; plan?: unknown };
  if (decision.version !== 1) {
    return false;
  }
  if (decision.shouldAuthor === false) {
    return true;
  }
  if (
    decision.shouldAuthor !== true ||
    !decision.plan ||
    typeof decision.plan !== "object" ||
    Array.isArray(decision.plan)
  ) {
    return false;
  }
  const plan = decision.plan as Partial<PreparedSkillMutationPlan>;
  return (
    plan.version === 1 &&
    typeof plan.skillId === "string" &&
    typeof plan.evaluationRunId === "string" &&
    typeof plan.skillMarkdown === "string" &&
    typeof plan.preparedAt === "string" &&
    typeof plan.changeHash === "string"
  );
}

function isStageMap(value: unknown): value is GeneralChatPostCommitCanonicalReceipt["stages"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(
    (stage) =>
      Boolean(stage) &&
      typeof stage === "object" &&
      !Array.isArray(stage) &&
      typeof (stage as { completedAt?: unknown }).completedAt === "string" &&
      Boolean(
        (stage as { result?: unknown }).result &&
        typeof (stage as { result?: unknown }).result === "object" &&
        !Array.isArray((stage as { result?: unknown }).result),
      ),
  );
}
