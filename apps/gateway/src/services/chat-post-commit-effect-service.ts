import type { Storage } from "@goatcitadel/storage";
import type { GeneralChatPostCommitDurableEffectExecutionInput } from "./chat-durable-run-service.js";
import type { GeneralChatPostCommitEffectExecutionContext } from "./durable-execution-service.js";
import type { BackgroundReviewService } from "./background-review-service.js";
import {
  commitGeneralChatPostCommitBackgroundSkillDecision,
  commitGeneralChatPostCommitStage,
  readGeneralChatPostCommitBackgroundSkillDecision,
  readGeneralChatPostCommitStage,
  type GeneralChatPostCommitBackgroundSkillDecision,
  type GeneralChatPostCommitCanonicalEffect,
  type GeneralChatPostCommitCanonicalStage,
  type ChatPostCommitEffectReceiptStoragePort,
  type GeneralChatPostCommitStageIdentity,
  type GeneralChatPostCommitStageReceipt,
} from "./chat-post-commit-effect-receipt.js";
import type { CommitmentClassifierService } from "./gateway/commitment-classifier-service.js";
import type { MemoryMaintenanceService } from "./memory-maintenance-service.js";
import { IDEMPOTENT_REALTIME_ENVELOPE_KEY } from "./realtime-event-service.js";

const BACKGROUND_REVIEW_TURNS_SINCE_SETTING_KEY = "background_review_turns_since_v1";
const BACKGROUND_REVIEW_TURN_INTERVAL = 5;

export type ChatPostCommitEffectStoragePort = Pick<Storage, "chatSessionMeta" | "systemSettings"> &
  ChatPostCommitEffectReceiptStoragePort;

export interface ChatPostCommitEffectServiceDeps {
  readonly storage: ChatPostCommitEffectStoragePort;
  readonly commitmentClassifier: CommitmentClassifierService;
  readonly backgroundReview: BackgroundReviewService;
  readonly memoryMaintenance: MemoryMaintenanceService;
  isAutonomyDisabled(): boolean;
  isReplayScratchSession(sessionId: string): boolean;
  publishRealtime(eventType: string, source: string, payload: Record<string, unknown>): void;
  requestDurableRunProcessing(runId: string): void;
}

interface EligibleHumanTurn {
  autonomyEnabled: true;
  evalIntegrityTurn: false;
  humanSession: true;
}

type HumanTurnEligibility =
  | { eligible: true; guards: EligibleHumanTurn }
  | { eligible: false; result: Record<string, unknown> };

/**
 * Canonical downstream owner for deterministic `chat.post_commit.effect`
 * children. Provider reads may repeat, but every stateful stage commits under
 * the child's database-clock lease fence with a receipt in the same transaction.
 */
export class ChatPostCommitEffectService {
  public constructor(private readonly deps: ChatPostCommitEffectServiceDeps) {}

  public async execute(
    input: GeneralChatPostCommitDurableEffectExecutionInput,
    context: GeneralChatPostCommitEffectExecutionContext,
  ): Promise<Record<string, unknown>> {
    context.signal?.throwIfAborted();
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
      deliverySemantics: "canonical_writes_exactly_once_provider_reads_at_least_once",
    };
  }

  private async executeCommitments(
    input: Extract<GeneralChatPostCommitDurableEffectExecutionInput, { effect: "commitments" }>,
    context: GeneralChatPostCommitEffectExecutionContext,
  ): Promise<Record<string, unknown>> {
    const eligibility = this.resolveEligibleHumanTurn(input.sessionId, input.autonomous);
    if (!eligibility.eligible) {
      return eligibility.result;
    }
    const identity = this.stageIdentity(context, "commitments", "commitments_write");
    const existing = readGeneralChatPostCommitStage(this.deps.storage, identity);
    if (existing) {
      return existing.result;
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
    return commitGeneralChatPostCommitStage(this.deps.storage, identity, () => {
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
      const result = { status: "classified", persistedCount: persisted.length };
      return { value: persisted, result };
    }).receipt.result;
  }

  private async executeBackgroundReview(
    input: Extract<GeneralChatPostCommitDurableEffectExecutionInput, { effect: "background_review" }>,
    context: GeneralChatPostCommitEffectExecutionContext,
  ): Promise<Record<string, unknown>> {
    if (input.delegatedChild) {
      return { status: "skipped", reason: "delegated_child" };
    }
    const eligibility = this.resolveEligibleHumanTurn(input.sessionId, input.autonomous);
    if (!eligibility.eligible) {
      return eligibility.result;
    }

    const counter = this.readOrCommitStage(context, "background_review", "background_counter", () => {
      const due = this.advanceBackgroundReviewCounter();
      return { value: due, result: { due } };
    });
    if (counter.result.due !== true) {
      return { status: "skipped", reason: "counter_not_due" };
    }

    const memoryIdentity = this.stageIdentity(context, "background_review", "background_memory");
    let memory = readGeneralChatPostCommitStage(this.deps.storage, memoryIdentity);
    if (!memory) {
      const facts = await this.deps.backgroundReview.extractTurnMemoryFacts(
        input.userText,
        input.assistantText,
        context.signal,
        {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          sourceTurnId: input.turnId,
          effectExecutionId: context.effectRunId,
        },
      );
      context.signal?.throwIfAborted();
      memory = commitGeneralChatPostCommitStage(this.deps.storage, memoryIdentity, () => {
        const write =
          facts.length > 0
            ? this.deps.backgroundReview.recordMemoryFacts(input.workspaceId, facts, { strict: true })
            : undefined;
        const result = {
          memoryFactCount: facts.length,
          memoryOutcome: write?.outcome ?? "none",
        };
        return { value: write, result };
      }).receipt;
    }

    const skillIdentity = this.stageIdentity(context, "background_review", "background_skill");
    let skill = readGeneralChatPostCommitStage(this.deps.storage, skillIdentity);
    if (!skill) {
      let proposedDecision: GeneralChatPostCommitBackgroundSkillDecision | undefined =
        readGeneralChatPostCommitBackgroundSkillDecision(this.deps.storage, skillIdentity);
      if (!proposedDecision) {
        const suggestion = await this.deps.backgroundReview.suggestTurnSkill(
          input.userText,
          input.assistantText,
          context.signal,
          {
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            sourceTurnId: input.turnId,
            effectExecutionId: context.effectRunId,
          },
        );
        context.signal?.throwIfAborted();
        const plan = this.deps.backgroundReview.prepareSuggestedSkillMutation(
          suggestion,
          input.turnId,
          context.effectRunId,
        );
        proposedDecision = plan ? { version: 1, shouldAuthor: true, plan } : { version: 1, shouldAuthor: false };
      }
      const decision = commitGeneralChatPostCommitBackgroundSkillDecision(
        this.deps.storage,
        skillIdentity,
        proposedDecision,
      );
      if (decision.shouldAuthor) {
        this.deps.backgroundReview.applyPreparedSkillMutationFiles(decision.plan);
      }
      skill = commitGeneralChatPostCommitStage(this.deps.storage, skillIdentity, () => {
        const mutation = decision.shouldAuthor
          ? this.deps.backgroundReview.commitPreparedSkillMutation(decision.plan)
          : undefined;
        const result = {
          skillProposed: decision.shouldAuthor,
          skillMutationApplied: Boolean(mutation),
          ...(mutation?.skillId ? { skillId: mutation.skillId } : {}),
        };
        return { value: mutation, result };
      }).receipt;
    }

    const memoryFactCount = readNumber(memory.result.memoryFactCount);
    const skillProposed = skill.result.skillProposed === true;
    const skillId = readString(skill.result.skillId);
    const summaryMarker = buildSummaryMarker(readString(memory.result.memoryOutcome), skillId);
    if (summaryMarker) {
      this.publishIdempotent(
        "self_improvement_review",
        "system",
        {
          type: "background_review",
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
          summaryMarker,
          memoryFactCount,
          skillProposed,
          ...(skillId ? { skillId } : {}),
        },
        `${context.effectRunId}:background-review`,
        skill.completedAt,
      );
    }
    return {
      status: "reviewed",
      memoryFactCount,
      skillProposed,
      ...(skillId ? { skillId } : {}),
    };
  }

  private executeMemoryMaintenance(
    input: Extract<GeneralChatPostCommitDurableEffectExecutionInput, { effect: "memory_maintenance" }>,
    context: GeneralChatPostCommitEffectExecutionContext,
  ): Record<string, unknown> {
    if (input.delegatedChild) {
      return { status: "skipped", reason: "delegated_child" };
    }
    const receipt = this.readOrCommitStage(context, "memory_maintenance", "memory_maintenance_evaluation", () => {
      const result = this.deps.memoryMaintenance.noteSuccessfulRootTurnSync(input.sessionId);
      return { value: result, result: { ...result } };
    });
    const result = receipt.result;
    const memoryMaintenanceRunId = readString(result.memoryMaintenanceRunId);
    const durableRunId = readString(result.durableRunId);
    if (result.status === "enqueued" && memoryMaintenanceRunId && durableRunId) {
      const payload = {
        workspaceId: input.workspaceId,
        runId: memoryMaintenanceRunId,
        durableRunId,
        triggerSource: "hybrid_due",
      };
      this.publishIdempotent(
        "system",
        "memory",
        { type: "memory_maintenance_run_created", ...payload },
        `${context.effectRunId}:memory-maintenance-created`,
        receipt.completedAt,
      );
      this.publishIdempotent(
        "system",
        "durable",
        { type: "durable_run_created", runId: durableRunId, workflowKey: "memory.maintenance", status: "queued" },
        `${context.effectRunId}:memory-maintenance-durable-created`,
        receipt.completedAt,
      );
      this.deps.requestDurableRunProcessing(durableRunId);
    }
    return result;
  }

  private resolveEligibleHumanTurn(sessionId: string, autonomous: boolean): HumanTurnEligibility {
    if (autonomous) {
      return { eligible: false, result: { status: "skipped", reason: "autonomous_turn" } };
    }
    if (this.deps.isAutonomyDisabled()) {
      return { eligible: false, result: { status: "skipped", reason: "autonomy_disabled" } };
    }
    const origin = this.deps.storage.chatSessionMeta.get(sessionId)?.origin;
    const evalIntegrityTurn = origin === "prompt_pack";
    const humanSession =
      origin !== "system" && origin !== "prompt_pack" && !this.deps.isReplayScratchSession(sessionId);
    if (evalIntegrityTurn || !humanSession) {
      return {
        eligible: false,
        result: { status: "skipped", reason: evalIntegrityTurn ? "eval_integrity" : "non_human_session" },
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

  private readOrCommitStage<TValue>(
    context: GeneralChatPostCommitEffectExecutionContext,
    effect: GeneralChatPostCommitCanonicalEffect,
    stage: GeneralChatPostCommitCanonicalStage,
    apply: () => { value: TValue; result: Record<string, unknown> },
  ): GeneralChatPostCommitStageReceipt {
    const identity = this.stageIdentity(context, effect, stage);
    return (
      readGeneralChatPostCommitStage(this.deps.storage, identity) ??
      commitGeneralChatPostCommitStage(this.deps.storage, identity, apply).receipt
    );
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

function buildSummaryMarker(memoryOutcome: string | undefined, skillId: string | undefined): string | undefined {
  const parts: string[] = [];
  if (memoryOutcome === "applied") {
    parts.push("updated durable memory");
  } else if (memoryOutcome === "proposed") {
    parts.push("proposed durable memory");
  }
  if (skillId) {
    parts.push(`drafted skill "${skillId}"`);
  }
  return parts.length > 0 ? `💾 Self-improvement review: ${parts.join("; ")}.` : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
