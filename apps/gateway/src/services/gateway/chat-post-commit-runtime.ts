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
  resolveModelDefaults(): Promise<{ providerId?: string; model?: string }>;
  resolveApiStyle(providerId?: string, model?: string): LlmApiStyle;
  proposeTraceMemoryCandidate: ChatPostCommitEffectServiceDeps["proposeTraceMemoryCandidate"];
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
  const commitmentClassifier = new CommitmentClassifierService({
    storage: input.storage,
    createChatCompletion: input.createChatCompletion,
    resolveModelDefaults: input.resolveModelDefaults,
    resolveApiStyle: input.resolveApiStyle,
  });
  const backgroundReviewService = new BackgroundReviewService({
    createChatCompletion: input.createChatCompletion,
    resolveModelDefaults: input.resolveModelDefaults,
    resolveApiStyle: input.resolveApiStyle,
  });
  const effectService = new ChatPostCommitEffectService({
    storage: input.storage,
    commitmentClassifier,
    backgroundReview: backgroundReviewService,
    proposeTraceMemoryCandidate: input.proposeTraceMemoryCandidate,
    effectAuthority: input.effectAuthority,
    isAutonomyDisabled: input.isAutonomyDisabled,
    publishRealtime: input.publishRealtime,
  });
  return {
    commitmentClassifier,
    backgroundReviewService,
    effectExecutor: createDurableChatPostCommitEffectWorkflowExecutor({
      storage: input.storage,
      executeGeneralChatPostCommitDurableEffect: (request, context) => effectService.execute(request, context),
      publishRealtime: input.publishRealtime,
      recordDurableTimelineEvent: input.recordDurableTimelineEvent,
      recordImprovementDurableRunCompletion: input.recordImprovementDurableRunCompletion,
    }),
  };
}
