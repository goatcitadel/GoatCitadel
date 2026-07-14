import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  DurableRunRecord,
  DurableRunTimelineEvent,
  LlmApiStyle,
  ModelUsageAttributionContext,
  RealtimeEvent,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { BackgroundReviewService } from "../background-review-service.js";
import { ChatPostCommitEffectService } from "../chat-post-commit-effect-service.js";
import {
  createDurableChatPostCommitEffectWorkflowExecutor,
  type DurableWorkflowExecutor,
} from "../durable-execution-service.js";
import type { MemoryMaintenanceService } from "../memory-maintenance-service.js";
import type { AutonomyControlService } from "../autonomy-control-service.js";
import type { OperatorProfileService } from "../operator-profile-service.js";
import type { SkillMutationService } from "../skill-mutation-service.js";
import { CommitmentClassifierService } from "./commitment-classifier-service.js";

export interface ChatPostCommitRuntimeCompositionInput {
  storage: Storage;
  createChatCompletion(
    request: ChatCompletionRequest,
    attribution: ModelUsageAttributionContext,
  ): Promise<ChatCompletionResponse>;
  resolveModelDefaults(): { providerId?: string; model?: string };
  resolveApiStyle(providerId?: string, model?: string): LlmApiStyle;
  operatorProfileService: OperatorProfileService;
  autonomyControlService: AutonomyControlService;
  skillMutationService: SkillMutationService;
  memoryMaintenanceService: MemoryMaintenanceService;
  isAutonomyDisabled(): boolean;
  isReplayScratchSession(sessionId: string): boolean;
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): void;
  requestDurableRunProcessing(runId: string): void;
  recordDurableTimelineEvent(
    runId: string,
    eventType: DurableRunTimelineEvent["eventType"],
    payload?: Record<string, unknown>,
  ): void;
  recordImprovementDurableRunCompletion(run: DurableRunRecord, checkpointState: Record<string, unknown>): void;
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
    recordOperatorProfileFacts: (workspaceId, facts) => {
      const result = input.operatorProfileService.recordOperatorProfileFacts(workspaceId, { facts });
      if (result.outcome === "applied" && result.priorSnapshot) {
        input.autonomyControlService.recordAutonomousMutation({
          kind: "memory",
          targetKey: result.record.operatorProfileId,
          restoreRef: { kind: "memory", priorSnapshot: result.priorSnapshot },
        });
      }
      return result;
    },
    draftSkillMutation: (request) => input.skillMutationService.draftSkillMutation(request),
    prepareDurableSkillMutation: (request) => input.skillMutationService.prepareDurableSkillMutation(request),
    applyPreparedSkillMutationFilesSync: (plan) => input.skillMutationService.applyPreparedSkillMutationFilesSync(plan),
    commitPreparedSkillMutation: (plan) => input.skillMutationService.commitPreparedSkillMutation(plan),
  });
  const effectService = new ChatPostCommitEffectService({
    storage: input.storage,
    commitmentClassifier,
    backgroundReview: backgroundReviewService,
    memoryMaintenance: input.memoryMaintenanceService,
    isAutonomyDisabled: input.isAutonomyDisabled,
    isReplayScratchSession: input.isReplayScratchSession,
    publishRealtime: input.publishRealtime,
    requestDurableRunProcessing: input.requestDurableRunProcessing,
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
