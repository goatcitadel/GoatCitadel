import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  DurableRunRecord,
  DurableRunTimelineEvent,
  LlmApiStyle,
  ModelUsageAttributionContext,
  RealtimeEvent,
} from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import { BackgroundReviewService } from "../background-review-service.js";
import {
  ChatPostCommitEffectService,
  type ChatPostCommitEffectAuthorityPort,
  type ChatPostCommitEffectServiceDeps,
} from "../chat-post-commit-effect-service.js";
import {
  createDurableChatPostCommitEffectWorkflowExecutor,
  type DurableWorkflowExecutor,
} from "../durable-execution-service.js";
import { CommitmentClassifierService } from "./commitment-classifier-service.js";

export interface ChatPostCommitRuntimeCompositionInput {
  storage: Storage;
  createChatCompletion(
    request: ChatCompletionRequest,
    attribution: ModelUsageAttributionContext,
  ): Promise<ChatCompletionResponse>;
  /** Background-job model; `undefined` means skip (the active provider is not ready). */
  resolveModelDefaults(): Promise<{ providerId?: string; model?: string } | undefined>;
  resolveApiStyle(providerId?: string, model?: string): LlmApiStyle;
  proposeTraceMemoryCandidate: ChatPostCommitEffectServiceDeps["proposeTraceMemoryCandidate"];
  resolveBackgroundLearningReadiness: ChatPostCommitEffectServiceDeps["resolveBackgroundLearningReadiness"];
  enqueueLearningReview: NonNullable<ChatPostCommitEffectServiceDeps["enqueueLearningReview"]>;
  evaluateGovernedMemoryMaintenance: NonNullable<ChatPostCommitEffectServiceDeps["evaluateGovernedMemoryMaintenance"]>;
  /** Required in production composition: post-commit children must never run unfenced. */
  effectAuthority: ChatPostCommitEffectAuthorityPort;
  isAutonomyDisabled(): Promise<boolean>;
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): Promise<unknown>;
  recordDurableTimelineEvent(
    runId: string,
    eventType: DurableRunTimelineEvent["eventType"],
    payload?: Record<string, unknown>,
  ): Promise<void>;
  recordImprovementDurableRunCompletion(run: DurableRunRecord, checkpointState: Record<string, unknown>): Promise<void>;
}

export interface ChatPostCommitRuntimeComposition {
  commitmentClassifier: CommitmentClassifierService;
  backgroundReviewService: BackgroundReviewService;
  effectExecutor: DurableWorkflowExecutor;
}

export function createChatPostCommitRuntime(
  input: ChatPostCommitRuntimeCompositionInput,
): ChatPostCommitRuntimeComposition {
  const {
    storage,
    createChatCompletion,
    resolveModelDefaults,
    resolveApiStyle,
    resolveBackgroundLearningReadiness,
    publishRealtime,
  } = input;
  const commitmentClassifier = new CommitmentClassifierService({
    storage,
    createChatCompletion,
    resolveModelDefaults,
    resolveApiStyle,
  });
  const backgroundReviewService = new BackgroundReviewService({
    createChatCompletion,
    resolveModelRoute: async (admittedModel) => {
      const route = await resolveModelDefaults();
      if (
        !route ||
        (admittedModel && (route.providerId !== admittedModel.providerId || route.model !== admittedModel.model))
      ) {
        return undefined;
      }
      return { ...route, apiStyle: resolveApiStyle(route.providerId, route.model) };
    },
    resolveBackgroundLearningReadiness,
  });
  const effectService = new ChatPostCommitEffectService({
    storage,
    commitmentClassifier,
    backgroundReview: backgroundReviewService,
    enqueueLearningReview: input.enqueueLearningReview,
    evaluateGovernedMemoryMaintenance: input.evaluateGovernedMemoryMaintenance,
    resolveBackgroundLearningReadiness,
    proposeTraceMemoryCandidate: input.proposeTraceMemoryCandidate,
    effectAuthority: input.effectAuthority,
    isAutonomyDisabled: input.isAutonomyDisabled,
    publishRealtime,
  });
  return {
    commitmentClassifier,
    backgroundReviewService,
    effectExecutor: createDurableChatPostCommitEffectWorkflowExecutor({
      storage,
      executeGeneralChatPostCommitDurableEffect: (request, context) => effectService.execute(request, context),
      publishRealtime,
      recordDurableTimelineEvent: input.recordDurableTimelineEvent,
      recordImprovementDurableRunCompletion: input.recordImprovementDurableRunCompletion,
    }),
  };
}
