import type { Storage } from "@goatcitadel/storage";
import type { GeneralChatPostCommitDurableEffectExecutionInput } from "./chat-durable-run-service.js";
import type { GeneralChatPostCommitEffectExecutionContext } from "./durable-execution-service.js";
import {
  buildBackgroundReviewMemoryEvidenceFingerprints,
  buildBackgroundReviewSkillEvidenceFingerprint,
  type BackgroundReviewService,
} from "./background-review-service.js";
import {
  commitGeneralChatPostCommitStage,
  readGeneralChatPostCommitStage,
  readGeneralChatPostCommitStageResult,
  type ChatPostCommitAtomicStageAuthorityPort,
  type ChatPostCommitAuthorityDecision,
  type ChatPostCommitEffectAuthorityContext,
  type ChatPostCommitEffectReceiptStoragePort,
  type ChatPostCommitFrozenEligibility,
  type GeneralChatPostCommitCanonicalEffect,
  type GeneralChatPostCommitCanonicalStage,
  type GeneralChatPostCommitStageCommitOptions,
  type GeneralChatPostCommitStageIdentity,
} from "./chat-post-commit-effect-receipt.js";
import type { CommitmentClassifierService } from "./gateway/commitment-classifier-service.js";
import { IDEMPOTENT_REALTIME_ENVELOPE_KEY } from "./realtime-event-service.js";

const BACKGROUND_REVIEW_TURNS_SINCE_SETTING_KEY = "background_review_turns_since_v1";
const BACKGROUND_REVIEW_TURN_INTERVAL = 5;

export type ChatPostCommitEffectStoragePort = Pick<Storage, "systemSettings"> & ChatPostCommitEffectReceiptStoragePort;

export interface ChatPostCommitPredispatchAuthorityInput {
  authority: ChatPostCommitEffectAuthorityContext;
  parentRunId: string;
  postCommitGenerationId: string;
  effect: GeneralChatPostCommitCanonicalEffect;
}

/** D2-owned implementation port; D3 deliberately knows no storage admission API. */
export interface ChatPostCommitEffectAuthorityPort {
  predispatch(input: ChatPostCommitPredispatchAuthorityInput): ChatPostCommitAuthorityDecision;
  atomicStage: ChatPostCommitAtomicStageAuthorityPort;
}

interface ChatPostCommitEffectServiceBaseDeps {
  readonly storage: ChatPostCommitEffectStoragePort;
  readonly commitmentClassifier: CommitmentClassifierService;
  readonly backgroundReview: BackgroundReviewService;
  isAutonomyDisabled(): boolean;
  publishRealtime(eventType: string, source: string, payload: Record<string, unknown>): void;
}

export type ChatPostCommitEffectServiceDeps = ChatPostCommitEffectServiceBaseDeps &
  (
    | { readonly effectAuthority: ChatPostCommitEffectAuthorityPort; readonly allowUnfencedForTests?: false }
    | {
        readonly effectAuthority?: undefined;
        /** Explicit standalone-test seam. Production composition must never set this. */
        readonly allowUnfencedForTests: true;
      }
  );

interface EligibleHumanTurn {
  autonomyEnabled: true;
  evalIntegrityTurn: false;
  humanSession: true;
}

type HumanTurnEligibility =
  | { eligible: true; guards: EligibleHumanTurn }
  | { eligible: false; result: Record<string, unknown> };

type AuthorityAwareExecutionContext = GeneralChatPostCommitEffectExecutionContext & {
  /** Frozen by the durable boundary; never synthesized from current session metadata. */
  postCommitAuthority?: ChatPostCommitEffectAuthorityContext;
};

type EligibilityAwareEffectInput = GeneralChatPostCommitDurableEffectExecutionInput & {
  postCommitEligibility?: unknown;
};

/**
 * Canonical downstream owner for deterministic `chat.post_commit.effect`
 * children. Background review is evidence-only and maintenance is production-
 * dark. Commitments remain the sole stateful domain path and are fenced by the
 * explicit D2 authority seam when it is configured.
 */
export class ChatPostCommitEffectService {
  public constructor(private readonly deps: ChatPostCommitEffectServiceDeps) {}

  public async execute(
    input: GeneralChatPostCommitDurableEffectExecutionInput,
    context: GeneralChatPostCommitEffectExecutionContext,
  ): Promise<Record<string, unknown>> {
    context.signal?.throwIfAborted();
    this.assertAuthorityMatchesExecution(input, context);
    let result: Record<string, unknown>;
    switch (input.effect) {
      case "commitments":
        result = await this.executeCommitments(input, context);
        break;
      case "background_review":
        result = await this.executeBackgroundReview(input, context);
        break;
      case "memory_maintenance":
        result = this.executeMemoryMaintenance(input, context);
        break;
      default: {
        const exhaustive: never = input;
        throw new Error(`Unsupported durable Chat post-commit effect: ${String(exhaustive)}`);
      }
    }
    context.signal?.throwIfAborted();
    return {
      ...result,
      effect: input.effect,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      deliverySemantics: "canonical_receipts_exactly_once_provider_reads_at_least_once",
    };
  }

  private async executeCommitments(
    input: Extract<GeneralChatPostCommitDurableEffectExecutionInput, { effect: "commitments" }>,
    context: GeneralChatPostCommitEffectExecutionContext,
  ): Promise<Record<string, unknown>> {
    const identity = this.stageIdentity(context, "commitments", "commitments_write");
    const existing = readGeneralChatPostCommitStage(this.deps.storage, identity);
    if (existing) {
      return readGeneralChatPostCommitStageResult(existing);
    }
    const predispatch = this.resolvePredispatch(context, "commitments");
    if (predispatch === "late_blocked") {
      return this.commitLateBlocked(identity, context);
    }
    const eligibility = this.resolveEligibleHumanTurn(input);
    if (!eligibility.eligible) {
      return this.commitResult(identity, context, eligibility.result);
    }

    const classifications = await this.deps.commitmentClassifier.classifyTurnForCommitments({
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      sourceTurnId: input.turnId,
      userText: input.userText,
      assistantText: input.assistantText,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    context.signal?.throwIfAborted();
    return readGeneralChatPostCommitStageResult(
      commitGeneralChatPostCommitStage(
        this.deps.storage,
        identity,
        () => {
          const persisted = this.deps.commitmentClassifier.persistTurnCommitments(
            {
              sessionId: input.sessionId,
              workspaceId: input.workspaceId,
              userText: input.userText,
              assistantText: input.assistantText,
              ...eligibility.guards,
              ...(context.signal ? { signal: context.signal } : {}),
            },
            classifications,
            { strict: true },
          );
          return {
            value: persisted,
            result: { status: "classified", persistedCount: persisted.length },
          };
        },
        this.stageCommitOptions(context, true),
      ).receipt,
    );
  }

  private async executeBackgroundReview(
    input: Extract<GeneralChatPostCommitDurableEffectExecutionInput, { effect: "background_review" }>,
    context: GeneralChatPostCommitEffectExecutionContext,
  ): Promise<Record<string, unknown>> {
    const evidenceIdentity = this.stageIdentity(context, "background_review", "background_evidence");
    const existingEvidence = readGeneralChatPostCommitStage(this.deps.storage, evidenceIdentity);
    if (existingEvidence) {
      return readGeneralChatPostCommitStageResult(existingEvidence);
    }
    const counterIdentity = this.stageIdentity(context, "background_review", "background_counter");
    const existingCounter = readGeneralChatPostCommitStage(this.deps.storage, counterIdentity);
    // A late nonterminal guard cancels the child admission. Its content-free
    // receipt is therefore the terminal effect result; never attempt a second
    // evidence-stage settlement against that already-closed admission.
    if (existingCounter?.disposition === "late_blocked") {
      return readGeneralChatPostCommitStageResult(existingCounter);
    }
    const predispatch = this.resolvePredispatch(context, "background_review");
    if (predispatch === "late_blocked") {
      return this.commitLateBlocked(evidenceIdentity, context);
    }
    const eligibility = this.resolveEligibleHumanTurn(input);
    if (!eligibility.eligible) {
      return this.commitResult(evidenceIdentity, context, eligibility.result);
    }
    if (input.delegatedChild) {
      return this.commitResult(evidenceIdentity, context, { status: "skipped", reason: "delegated_child" });
    }

    const counter =
      existingCounter ??
      commitGeneralChatPostCommitStage(
        this.deps.storage,
        counterIdentity,
        () => {
          const due = this.advanceBackgroundReviewCounter();
          return { value: due, result: { due } };
        },
        this.stageCommitOptions(context, false),
      ).receipt;
    if (counter.disposition === "late_blocked") {
      return readGeneralChatPostCommitStageResult(counter);
    }
    if (counter.result.due !== true) {
      return this.commitResult(evidenceIdentity, context, { status: "skipped", reason: "counter_not_due" });
    }

    const lineage = {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      sourceTurnId: input.turnId,
      effectExecutionId: context.effectRunId,
    };
    const facts = await this.deps.backgroundReview.extractTurnMemoryFacts(
      input.userText,
      input.assistantText,
      context.signal,
      lineage,
    );
    context.signal?.throwIfAborted();
    const suggestion = await this.deps.backgroundReview.suggestTurnSkill(
      input.userText,
      input.assistantText,
      context.signal,
      lineage,
    );
    context.signal?.throwIfAborted();

    const memoryEvidenceFingerprints = buildBackgroundReviewMemoryEvidenceFingerprints(facts);
    const skillEvidenceFingerprint = buildBackgroundReviewSkillEvidenceFingerprint(suggestion);
    const result = readGeneralChatPostCommitStageResult(
      commitGeneralChatPostCommitStage(
        this.deps.storage,
        evidenceIdentity,
        () => ({
          value: undefined,
          result: {
            status: "evidence_recorded",
            memoryFactCount: memoryEvidenceFingerprints.length,
            memoryEvidenceFingerprints,
            skillProposed: Boolean(skillEvidenceFingerprint),
            ...(skillEvidenceFingerprint ? { skillEvidenceFingerprint } : {}),
            promotionDisposition: "governed_review_required",
          },
        }),
        this.stageCommitOptions(context, true),
      ).receipt,
    );
    if (result.status === "evidence_recorded") {
      this.publishIdempotent(
        "self_improvement_review",
        "system",
        {
          type: "background_review_evidence",
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
          memoryFactCount: readNumber(result.memoryFactCount),
          skillProposed: result.skillProposed === true,
          promotionDisposition: "governed_review_required",
        },
        `${context.effectRunId}:background-review-evidence`,
        new Date().toISOString(),
      );
    }
    return result;
  }

  private executeMemoryMaintenance(
    input: Extract<GeneralChatPostCommitDurableEffectExecutionInput, { effect: "memory_maintenance" }>,
    context: GeneralChatPostCommitEffectExecutionContext,
  ): Record<string, unknown> {
    const identity = this.stageIdentity(context, "memory_maintenance", "memory_maintenance_evaluation");
    const existing = readGeneralChatPostCommitStage(this.deps.storage, identity);
    if (existing) {
      return readGeneralChatPostCommitStageResult(existing);
    }
    const predispatch = this.resolvePredispatch(context, "memory_maintenance");
    if (predispatch === "late_blocked") {
      return this.commitLateBlocked(identity, context);
    }
    const eligibility = this.resolveEligibleHumanTurn({ ...input, autonomous: false });
    if (!eligibility.eligible) {
      return this.commitResult(identity, context, eligibility.result);
    }
    const result = input.delegatedChild
      ? { status: "skipped", reason: "delegated_child" }
      : {
          status: "production_dark",
          reason: "governed_memory_promotion_not_implemented",
          enqueueDisposition: "not_enqueued",
        };
    return this.commitResult(identity, context, result);
  }

  private resolveEligibleHumanTurn(
    input: EligibilityAwareEffectInput | (EligibilityAwareEffectInput & { autonomous: boolean }),
  ): HumanTurnEligibility {
    const frozen = readFrozenEligibility(input.postCommitEligibility);
    if (!frozen) {
      return { eligible: false, result: { status: "skipped", reason: "frozen_eligibility_invalid" } };
    }
    if ("autonomous" in input && input.autonomous) {
      return { eligible: false, result: { status: "skipped", reason: "autonomous_turn" } };
    }
    if (!frozen.autonomyEnabledAtParentSettlement || this.deps.isAutonomyDisabled()) {
      return { eligible: false, result: { status: "skipped", reason: "autonomy_disabled" } };
    }
    if (frozen.evalIntegrityTurn || !frozen.humanSession) {
      return {
        eligible: false,
        result: { status: "skipped", reason: frozen.evalIntegrityTurn ? "eval_integrity" : "non_human_session" },
      };
    }
    return {
      eligible: true,
      guards: { autonomyEnabled: true, evalIntegrityTurn: false, humanSession: true },
    };
  }

  private advanceBackgroundReviewCounter(): boolean {
    return this.deps.storage.systemSettings.advanceCyclicCounter(
      BACKGROUND_REVIEW_TURNS_SINCE_SETTING_KEY,
      BACKGROUND_REVIEW_TURN_INTERVAL,
    ).due;
  }

  private resolvePredispatch(
    context: GeneralChatPostCommitEffectExecutionContext,
    effect: GeneralChatPostCommitCanonicalEffect,
  ): ChatPostCommitAuthorityDecision {
    const authority = this.resolveAuthority(context);
    if (!authority) {
      return "allowed";
    }
    const decision = this.deps.effectAuthority!.predispatch({
      authority,
      parentRunId: context.parentRunId,
      postCommitGenerationId: context.generationId,
      effect,
    });
    if (decision !== "allowed" && decision !== "late_blocked") {
      throw new Error(`Unsupported durable Chat post-commit predispatch decision: ${String(decision)}`);
    }
    return decision;
  }

  private commitResult(
    identity: GeneralChatPostCommitStageIdentity,
    context: GeneralChatPostCommitEffectExecutionContext,
    result: Record<string, unknown>,
  ): Record<string, unknown> {
    return readGeneralChatPostCommitStageResult(
      commitGeneralChatPostCommitStage(
        this.deps.storage,
        identity,
        () => ({ value: undefined, result }),
        this.stageCommitOptions(context, true),
      ).receipt,
    );
  }

  private commitLateBlocked(
    identity: GeneralChatPostCommitStageIdentity,
    context: GeneralChatPostCommitEffectExecutionContext,
  ): Record<string, unknown> {
    return readGeneralChatPostCommitStageResult(
      commitGeneralChatPostCommitStage(
        this.deps.storage,
        identity,
        () => {
          throw new Error("late-blocked Chat post-commit stages must never apply domain content");
        },
        { ...this.stageCommitOptions(context, true), forcedDisposition: "late_blocked" },
      ).receipt,
    );
  }

  private stageCommitOptions(
    context: GeneralChatPostCommitEffectExecutionContext,
    terminal: boolean,
  ): GeneralChatPostCommitStageCommitOptions {
    const authority = this.resolveAuthority(context);
    return authority
      ? {
          authority: {
            context: authority,
            parentRunId: context.parentRunId,
            postCommitGenerationId: context.generationId,
            port: this.deps.effectAuthority!.atomicStage,
            terminal,
          },
          denyOnlyBlocked: () => this.deps.isAutonomyDisabled(),
        }
      : { denyOnlyBlocked: () => this.deps.isAutonomyDisabled() };
  }

  private resolveAuthority(
    context: GeneralChatPostCommitEffectExecutionContext,
  ): ChatPostCommitEffectAuthorityContext | undefined {
    const authority = (context as AuthorityAwareExecutionContext).postCommitAuthority;
    if (Boolean(authority) !== Boolean(this.deps.effectAuthority)) {
      throw new Error(
        "Durable Chat post-commit authority port and frozen execution identity must be configured together.",
      );
    }
    return authority;
  }

  private assertAuthorityMatchesExecution(
    input: GeneralChatPostCommitDurableEffectExecutionInput,
    context: GeneralChatPostCommitEffectExecutionContext,
  ): void {
    const authority = this.resolveAuthority(context);
    if (!authority) {
      return;
    }
    if (
      !hasExactKeys(authority as unknown as Record<string, unknown>, [
        "child",
        "childDurableClaim",
        "parent",
        "postCommitEligibility",
      ]) ||
      !hasExactKeys(authority.parent as unknown as Record<string, unknown>, [
        "admissionId",
        "aggregateRevision",
        "controllerGeneration",
        "materialSha256",
        "sessionId",
        "sessionIncarnationId",
        "turnId",
        "workspaceId",
      ]) ||
      !hasExactKeys(authority.child as unknown as Record<string, unknown>, [
        "actorId",
        "actorKind",
        "admissionId",
        "aggregateRevision",
        "controllerGeneration",
        "materialSha256",
        "operation",
        "sessionId",
        "sessionIncarnationId",
        "workspaceId",
      ]) ||
      !hasExactKeys(authority.childDurableClaim as unknown as Record<string, unknown>, [
        "attemptCount",
        "durableRunId",
        "leaseOwnerId",
      ]) ||
      !isNonEmpty(context.parentRunId) ||
      !isNonEmpty(context.generationId) ||
      !isNonEmpty(authority.parent.admissionId) ||
      !isNonEmpty(authority.child.admissionId) ||
      authority.parent.sessionIncarnationId !== authority.child.sessionIncarnationId ||
      authority.parent.workspaceId !== input.workspaceId ||
      authority.parent.sessionId !== input.sessionId ||
      authority.parent.turnId !== input.turnId ||
      authority.child.workspaceId !== input.workspaceId ||
      authority.child.sessionId !== input.sessionId ||
      !isPositiveInteger(authority.parent.aggregateRevision) ||
      !isPositiveInteger(authority.parent.controllerGeneration) ||
      !isPositiveInteger(authority.child.aggregateRevision) ||
      !isPositiveInteger(authority.child.controllerGeneration) ||
      !isSha256(authority.parent.materialSha256) ||
      !isSha256(authority.child.materialSha256) ||
      authority.child.operation !== "chat_post_commit_child" ||
      (authority.child.actorKind !== "operator" &&
        authority.child.actorKind !== "external_companion" &&
        authority.child.actorKind !== "system") ||
      !isNonEmpty(authority.child.actorId) ||
      authority.childDurableClaim.durableRunId !== context.effectRunId ||
      authority.childDurableClaim.leaseOwnerId !== context.leaseOwnerId ||
      !Number.isSafeInteger(authority.childDurableClaim.attemptCount) ||
      authority.childDurableClaim.attemptCount < 0 ||
      !sameFrozenEligibility(
        readFrozenEligibility((input as EligibilityAwareEffectInput).postCommitEligibility),
        authority.postCommitEligibility,
      )
    ) {
      throw new Error("Durable Chat post-commit frozen authority does not match execution provenance.");
    }
  }

  private stageIdentity(
    context: GeneralChatPostCommitEffectExecutionContext,
    effect: GeneralChatPostCommitCanonicalEffect,
    stage: GeneralChatPostCommitCanonicalStage,
  ): GeneralChatPostCommitStageIdentity {
    return {
      effectRunId: context.effectRunId,
      expectedLeaseOwnerId: context.leaseOwnerId,
      effect,
      stage,
    };
  }

  private publishIdempotent(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    deliveryId: string,
    occurredAt: string,
  ): void {
    this.deps.publishRealtime(eventType, source, {
      ...payload,
      [IDEMPOTENT_REALTIME_ENVELOPE_KEY]: { deliveryId, occurredAt },
    });
  }
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function hasExactKeys(value: unknown, expected: readonly string[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function readFrozenEligibility(value: unknown): ChatPostCommitFrozenEligibility | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Partial<ChatPostCommitFrozenEligibility>;
  if (
    Object.keys(candidate).sort().join(",") !==
    "autonomyEnabledAtParentSettlement,evalIntegrityTurn,humanSession,version"
  ) {
    return undefined;
  }
  if (
    candidate.version !== 1 ||
    typeof candidate.autonomyEnabledAtParentSettlement !== "boolean" ||
    typeof candidate.evalIntegrityTurn !== "boolean" ||
    typeof candidate.humanSession !== "boolean"
  ) {
    return undefined;
  }
  return candidate as ChatPostCommitFrozenEligibility;
}

function sameFrozenEligibility(
  input: ChatPostCommitFrozenEligibility | undefined,
  authority: ChatPostCommitFrozenEligibility,
): boolean {
  const frozenAuthority = readFrozenEligibility(authority);
  return Boolean(
    input &&
    frozenAuthority &&
    input.version === frozenAuthority.version &&
    input.autonomyEnabledAtParentSettlement === frozenAuthority.autonomyEnabledAtParentSettlement &&
    input.evalIntegrityTurn === frozenAuthority.evalIntegrityTurn &&
    input.humanSession === frozenAuthority.humanSession,
  );
}
