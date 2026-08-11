import { createHash } from "node:crypto";
import {
  ConflictError,
  PolicyViolationError,
  ValidationError,
  type OperatorProfileFact,
  type TraceMemoryCandidateInput,
  type TraceMemoryCandidateRecord,
} from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
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

const BACKGROUND_REVIEW_TURNS_SINCE_SETTING_PREFIX = "background_review_turns_since_v2";
const BACKGROUND_REVIEW_TURN_INTERVAL = 5;
const BACKGROUND_REVIEW_WARM_START_VALUE = BACKGROUND_REVIEW_TURN_INTERVAL - 1;

export type ChatPostCommitEffectStoragePort = Pick<Storage, "systemSettings"> & ChatPostCommitEffectReceiptStoragePort;

export interface ChatPostCommitPredispatchAuthorityInput {
  authority: ChatPostCommitEffectAuthorityContext;
  parentRunId: string;
  postCommitGenerationId: string;
  effect: GeneralChatPostCommitCanonicalEffect;
}

/** D2-owned implementation port; D3 deliberately knows no storage admission API. */
export interface ChatPostCommitEffectAuthorityPort {
  predispatch(input: ChatPostCommitPredispatchAuthorityInput): Promise<ChatPostCommitAuthorityDecision>;
  atomicStage: ChatPostCommitAtomicStageAuthorityPort;
}

interface ChatPostCommitEffectServiceBaseDeps {
  readonly storage: ChatPostCommitEffectStoragePort;
  readonly commitmentClassifier: CommitmentClassifierService;
  readonly backgroundReview: BackgroundReviewService;
  /** Existing governed review owner. This files proposals; it never promotes them. */
  proposeTraceMemoryCandidate(
    input: TraceMemoryCandidateInput,
    actorId: string,
    authority: "agent_proposed",
  ): Promise<Pick<TraceMemoryCandidateRecord, "candidateId">>;
  isAutonomyDisabled(): Promise<boolean>;
  publishRealtime(eventType: string, source: string, payload: Record<string, unknown>): Promise<unknown>;
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
 * children. Background review may file evidence-only trace candidates through
 * the existing governed memory review owner, but never promotes them or writes
 * OperatorProfile state. Maintenance is production-dark. Commitments remain a
 * stateful domain path and every mutation is fenced by the explicit D2 authority
 * seam when it is configured.
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
        result = await this.executeMemoryMaintenance(input, context);
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
    const existing = await readGeneralChatPostCommitStage(this.deps.storage, identity);
    if (existing) {
      return readGeneralChatPostCommitStageResult(existing);
    }
    const predispatch = await this.resolvePredispatch(context, "commitments");
    if (predispatch === "late_blocked") {
      return await this.commitLateBlocked(identity, context);
    }
    const eligibility = await this.resolveEligibleHumanTurn(input);
    if (!eligibility.eligible) {
      return await this.commitResult(identity, context, eligibility.result);
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
      (
        await commitGeneralChatPostCommitStage(
          this.deps.storage,
          identity,
          async () => {
            const persisted = await this.deps.commitmentClassifier.persistTurnCommitments(
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
        )
      ).receipt,
    );
  }

  private async executeBackgroundReview(
    input: Extract<GeneralChatPostCommitDurableEffectExecutionInput, { effect: "background_review" }>,
    context: GeneralChatPostCommitEffectExecutionContext,
  ): Promise<Record<string, unknown>> {
    const evidenceIdentity = this.stageIdentity(context, "background_review", "background_evidence");
    const existingEvidence = await readGeneralChatPostCommitStage(this.deps.storage, evidenceIdentity);
    if (existingEvidence) {
      const result = readGeneralChatPostCommitStageResult(existingEvidence);
      await this.publishBackgroundReviewEvidenceIfRecorded(input, context, result, existingEvidence.completedAt);
      return result;
    }
    const counterIdentity = this.stageIdentity(context, "background_review", "background_counter");
    const existingCounter = await readGeneralChatPostCommitStage(this.deps.storage, counterIdentity);
    // A late nonterminal guard cancels the child admission. Its content-free
    // receipt is therefore the terminal effect result; never attempt a second
    // evidence-stage settlement against that already-closed admission.
    if (existingCounter?.disposition === "late_blocked") {
      return readGeneralChatPostCommitStageResult(existingCounter);
    }
    const predispatch = await this.resolvePredispatch(context, "background_review");
    if (predispatch === "late_blocked") {
      return await this.commitLateBlocked(evidenceIdentity, context);
    }
    const eligibility = await this.resolveEligibleHumanTurn(input);
    if (!eligibility.eligible) {
      return await this.commitResult(evidenceIdentity, context, eligibility.result);
    }
    if (input.delegatedChild) {
      return await this.commitResult(evidenceIdentity, context, { status: "skipped", reason: "delegated_child" });
    }

    const counter =
      existingCounter ??
      (
        await commitGeneralChatPostCommitStage(
          this.deps.storage,
          counterIdentity,
          async () => {
            const due = await this.advanceBackgroundReviewCounter(input.workspaceId);
            return { value: due, result: { due } };
          },
          this.stageCommitOptions(context, false),
        )
      ).receipt;
    if (counter.disposition === "late_blocked") {
      return readGeneralChatPostCommitStageResult(counter);
    }
    if (counter.result.due !== true) {
      return await this.commitResult(evidenceIdentity, context, { status: "skipped", reason: "counter_not_due" });
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
    const evidenceCommit = await commitGeneralChatPostCommitStage(
      this.deps.storage,
      evidenceIdentity,
      async () => {
        const reviewCandidates = await this.proposeOperatorProfileReviewCandidates(input, context, facts);
        return {
          value: undefined,
          result: {
            status: "evidence_recorded",
            memoryFactCount: memoryEvidenceFingerprints.length,
            memoryEvidenceFingerprints,
            memoryReviewCandidateCount: reviewCandidates.candidateIds.length,
            memoryReviewCandidateIds: reviewCandidates.candidateIds,
            memoryReviewCandidateRejectedCount: reviewCandidates.rejectedCount,
            skillProposed: Boolean(skillEvidenceFingerprint),
            ...(skillEvidenceFingerprint ? { skillEvidenceFingerprint } : {}),
            promotionDisposition: "governed_trace_candidate_review_required",
          },
        };
      },
      this.stageCommitOptions(context, true),
    );
    const result = readGeneralChatPostCommitStageResult(evidenceCommit.receipt);
    await this.publishBackgroundReviewEvidenceIfRecorded(input, context, result, evidenceCommit.receipt.completedAt);
    return result;
  }

  private async executeMemoryMaintenance(
    input: Extract<GeneralChatPostCommitDurableEffectExecutionInput, { effect: "memory_maintenance" }>,
    context: GeneralChatPostCommitEffectExecutionContext,
  ): Promise<Record<string, unknown>> {
    const identity = this.stageIdentity(context, "memory_maintenance", "memory_maintenance_evaluation");
    const existing = await readGeneralChatPostCommitStage(this.deps.storage, identity);
    if (existing) {
      return readGeneralChatPostCommitStageResult(existing);
    }
    const predispatch = await this.resolvePredispatch(context, "memory_maintenance");
    if (predispatch === "late_blocked") {
      return await this.commitLateBlocked(identity, context);
    }
    const eligibility = await this.resolveEligibleHumanTurn({ ...input, autonomous: false });
    if (!eligibility.eligible) {
      return await this.commitResult(identity, context, eligibility.result);
    }
    const result = input.delegatedChild
      ? { status: "skipped", reason: "delegated_child" }
      : {
          status: "production_dark",
          reason: "governed_memory_promotion_not_implemented",
          enqueueDisposition: "not_enqueued",
        };
    return await this.commitResult(identity, context, result);
  }

  private async resolveEligibleHumanTurn(
    input: EligibilityAwareEffectInput | (EligibilityAwareEffectInput & { autonomous: boolean }),
  ): Promise<HumanTurnEligibility> {
    const frozen = readFrozenEligibility(input.postCommitEligibility);
    if (!frozen) {
      return { eligible: false, result: { status: "skipped", reason: "frozen_eligibility_invalid" } };
    }
    if ("autonomous" in input && input.autonomous) {
      return { eligible: false, result: { status: "skipped", reason: "autonomous_turn" } };
    }
    if (!frozen.autonomyEnabledAtParentSettlement || (await this.deps.isAutonomyDisabled())) {
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

  private async advanceBackgroundReviewCounter(workspaceId: string): Promise<boolean> {
    return (
      await this.deps.storage.systemSettings.advanceCyclicCounter(
        buildBackgroundReviewCounterSettingKey(workspaceId),
        BACKGROUND_REVIEW_TURN_INTERVAL,
        undefined,
        BACKGROUND_REVIEW_WARM_START_VALUE,
      )
    ).due;
  }

  private async proposeOperatorProfileReviewCandidates(
    input: Extract<GeneralChatPostCommitDurableEffectExecutionInput, { effect: "background_review" }>,
    context: GeneralChatPostCommitEffectExecutionContext,
    facts: OperatorProfileFact[],
  ): Promise<{ candidateIds: string[]; rejectedCount: number }> {
    const candidateIds: string[] = [];
    let rejectedCount = 0;
    for (const fact of facts) {
      try {
        const candidate = await this.deps.proposeTraceMemoryCandidate(
          {
            workspaceId: input.workspaceId,
            candidateType: fact.kind === "preference" ? "operator_preference" : "fact",
            sourceText: `Successful root Chat turn ${input.turnId} in session ${input.sessionId}.`,
            sourceSessionId: input.sessionId,
            sourceRunId: context.parentRunId,
            sourceTurnId: input.turnId,
            proposedInsight: fact.content,
            confidence: fact.confidence,
            sourceRefs: [
              { sourceType: "session", sourceRef: input.sessionId },
              { sourceType: "turn", sourceRef: input.turnId },
              { sourceType: "run", sourceRef: context.parentRunId },
            ],
            metadata: {
              operatorProfileReviewCandidate: true,
              operatorProfileFactKind: fact.kind,
              source: "background_review",
              sourceEffectRunId: context.effectRunId,
            },
          },
          "background-reviewer",
          "agent_proposed",
        );
        candidateIds.push(candidate.candidateId);
      } catch (error) {
        // Content-policy and feature-state refusals are expected governed
        // dispositions. Storage/runtime failures still throw so durable replay
        // can retry instead of silently losing otherwise-valid review material.
        if (
          error instanceof ConflictError ||
          error instanceof PolicyViolationError ||
          error instanceof ValidationError ||
          error instanceof TypeError
        ) {
          rejectedCount += 1;
          continue;
        }
        throw error;
      }
    }
    return { candidateIds, rejectedCount };
  }

  private async resolvePredispatch(
    context: GeneralChatPostCommitEffectExecutionContext,
    effect: GeneralChatPostCommitCanonicalEffect,
  ): Promise<ChatPostCommitAuthorityDecision> {
    const authority = this.resolveAuthority(context);
    if (!authority) {
      return "allowed";
    }
    const decision = await this.deps.effectAuthority!.predispatch({
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

  private async commitResult(
    identity: GeneralChatPostCommitStageIdentity,
    context: GeneralChatPostCommitEffectExecutionContext,
    result: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return readGeneralChatPostCommitStageResult(
      (
        await commitGeneralChatPostCommitStage(
          this.deps.storage,
          identity,
          async () => ({ value: undefined, result }),
          this.stageCommitOptions(context, true),
        )
      ).receipt,
    );
  }

  private async commitLateBlocked(
    identity: GeneralChatPostCommitStageIdentity,
    context: GeneralChatPostCommitEffectExecutionContext,
  ): Promise<Record<string, unknown>> {
    return readGeneralChatPostCommitStageResult(
      (
        await commitGeneralChatPostCommitStage(
          this.deps.storage,
          identity,
          async () => {
            throw new Error("late-blocked Chat post-commit stages must never apply domain content");
          },
          { ...this.stageCommitOptions(context, true), forcedDisposition: "late_blocked" },
        )
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
          denyOnlyBlocked: async () => await this.deps.isAutonomyDisabled(),
        }
      : { denyOnlyBlocked: async () => await this.deps.isAutonomyDisabled() };
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

  private async publishIdempotent(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    deliveryId: string,
    occurredAt: string,
  ): Promise<void> {
    await this.deps.publishRealtime(eventType, source, {
      ...payload,
      [IDEMPOTENT_REALTIME_ENVELOPE_KEY]: { deliveryId, occurredAt },
    });
  }

  private async publishBackgroundReviewEvidenceIfRecorded(
    input: Extract<GeneralChatPostCommitDurableEffectExecutionInput, { effect: "background_review" }>,
    context: GeneralChatPostCommitEffectExecutionContext,
    result: Record<string, unknown>,
    occurredAt: string,
  ): Promise<void> {
    if (result.status !== "evidence_recorded") {
      return;
    }
    await this.publishIdempotent(
      "self_improvement_review",
      "system",
      {
        type: "background_review_evidence",
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        memoryFactCount: readNumber(result.memoryFactCount),
        memoryReviewCandidateCount: readNumber(result.memoryReviewCandidateCount),
        memoryReviewCandidateIds: readStringArray(result.memoryReviewCandidateIds),
        memoryReviewCandidateRejectedCount: readNumber(result.memoryReviewCandidateRejectedCount),
        skillProposed: result.skillProposed === true,
        promotionDisposition: "governed_trace_candidate_review_required",
      },
      `${context.effectRunId}:background-review-evidence`,
      occurredAt,
    );
  }
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function buildBackgroundReviewCounterSettingKey(workspaceId: string): string {
  const normalized = workspaceId.trim() || "default";
  const workspaceHash = createHash("sha256").update(normalized).digest("hex").slice(0, 32);
  return `${BACKGROUND_REVIEW_TURNS_SINCE_SETTING_PREFIX}:${workspaceHash}`;
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
