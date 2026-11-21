import type {
  ChatChangePlanCreateInput,
  ChatChangePlanRecord,
  ChatGoalRequest,
  ChatGoalStatusResponse,
  ChatProactiveMode,
  ChatReflectionMode,
  ChatRetrievalMode,
  ChatSessionPrefsPatch,
  ChatSessionPrefsRecord,
  ChatSpecialistCandidatePatchInput,
  ChatSpecialistCandidateRecord,
  ChatSpecialistCandidateSuggestionRecord,
  ChatSteerRequest,
  ChatSteerResponse,
  LearnedMemoryConflictRecord,
  LearnedMemoryItemRecord,
  LearnedMemoryUpdateInput,
  ProactivePolicy,
  ProactiveRunRecord,
  ProactiveTriggerSource,
  ResearchRunRecord,
  ResearchSourceRecord,
  ResearchSummaryRecord,
  ToolPolicyActorContext,
} from "@goatcitadel/contracts";
import type { ChatCommandOptions, ChatCommandResult } from "./chat-command-service.js";
import type { CallerPolicyScope } from "./chat-policy-scope-service.js";
import type {AssistantReadinessService} from "./assistant-readiness-service.js";
import type {FollowThroughProjectionService} from "./follow-through-projection-service.js";
import type {ChatLearningReceiptService} from "./chat-learning-receipt-service.js";
import type {ChatContinuationService} from "./chat-continuation-service.js";
import type {FollowThroughSetupService} from "./follow-through-setup-service.js";
import {ServiceUnavailableError} from "@goatcitadel/contracts";

export interface ChatSupportRouteDependencies {
  assistantReadiness?:Pick<AssistantReadinessService,"getAssistantReadiness">&Partial<Pick<AssistantReadinessService,"prepareSetup">>;
  followThrough?:Pick<FollowThroughProjectionService,"listFollowThrough"|"requestFollowThroughAction">;
  learningReceipt?:Pick<ChatLearningReceiptService,"getTurnLearningReceipt">;
  continuations?:Pick<ChatContinuationService,"inspect"|"prepare">;
  followThroughSetup?:Pick<FollowThroughSetupService,"inspect"|"create">;
  changePlans: {
    create(sessionId: string, input: Omit<ChatChangePlanCreateInput, "sessionId">): Promise<ChatChangePlanRecord>;
    list(sessionId: string, limit?: number): Promise<ChatChangePlanRecord[]>;
    confirm(sessionId: string, planId: string, expectedRevision: number): Promise<ChatChangePlanRecord>;
    cancel(sessionId: string, planId: string, expectedRevision: number): Promise<ChatChangePlanRecord>;
  };
  commands: {
    listChatCommandCatalog(): Array<{
      command: string;
      usage: string;
      description: string;
    }>;
    parseChatCommand(sessionId: string, commandText: string, options?: ChatCommandOptions): Promise<ChatCommandResult>;
  };
  learnedMemory: {
    listChatSessionLearnedMemory(
      sessionId: string,
      limit?: number,
    ): Promise<{
      items: LearnedMemoryItemRecord[];
      conflicts: LearnedMemoryConflictRecord[];
    }>;
    rebuildChatSessionLearnedMemory(sessionId: string): Promise<{
      rebuiltAt: string;
      items: LearnedMemoryItemRecord[];
      conflicts: LearnedMemoryConflictRecord[];
    }>;
    updateChatSessionLearnedMemory(
      sessionId: string,
      itemId: string,
      input: LearnedMemoryUpdateInput,
    ): Promise<LearnedMemoryItemRecord>;
  };
  prefs: {
    getChatSessionPrefs(sessionId: string): Promise<ChatSessionPrefsRecord>;
    updateChatSessionPrefs(sessionId: string, input: ChatSessionPrefsPatch): Promise<ChatSessionPrefsRecord>;
  };
  proactive: {
    getChatSessionProactiveStatus(sessionId: string): Promise<{
      policy: ProactivePolicy;
      idleSeconds: number;
      hasRunningTurn: boolean;
      pendingSuggestions: number;
      actionsLastHour: number;
      lastRun?: ProactiveRunRecord;
    }>;
    listChatSessionProactiveRuns(sessionId: string, limit?: number): Promise<ProactiveRunRecord[]>;
    triggerChatSessionProactive(
      sessionId: string,
      input?: {
        source?: ProactiveTriggerSource;
        reason?: string;
        operatorId?: string;
        authActorId?: string;
        authActorSource?: ToolPolicyActorContext["authActorSource"];
      },
    ): Promise<ProactiveRunRecord>;
    updateChatSessionProactivePolicy(
      sessionId: string,
      input: Partial<{
        proactiveMode: ChatProactiveMode;
        autonomyBudget: {
          maxActionsPerHour?: number;
          maxActionsPerTurn?: number;
          cooldownSeconds?: number;
        };
        retrievalMode: ChatRetrievalMode;
        reflectionMode: ChatReflectionMode;
        expectedRevision: number;
      }>,
    ): Promise<ProactivePolicy>;
  };
  research: {
    getChatResearchRun(
      sessionId: string,
      runId: string,
    ): Promise<{
      run: ResearchRunRecord;
      sources: ResearchSourceRecord[];
    }>;
    runChatResearch(
      sessionId: string,
      input: {
        query: string;
        mode: "quick" | "deep";
        providerId?: string;
        model?: string;
        policyRunId?: string;
        policyTaskId?: string;
        operatorId?: string;
        authActorId?: string;
        authActorSource?: ToolPolicyActorContext["authActorSource"];
        permissionProfileId?: string;
        localOperatorOverrideId?: string;
        surface?: ToolPolicyActorContext["surface"];
      },
    ): Promise<ResearchSummaryRecord>;
  };
  specialists: {
    createChatSessionSpecialistCandidate(
      sessionId: string,
      input: {
        turnId?: string;
        suggestion: ChatSpecialistCandidateSuggestionRecord;
      },
    ): Promise<ChatSpecialistCandidateRecord>;
    listChatSessionSpecialistCandidates(
      sessionId: string,
      limit?: number,
    ): Promise<{
      items: ChatSpecialistCandidateRecord[];
    }>;
    updateChatSessionSpecialistCandidate(
      sessionId: string,
      candidateId: string,
      input: ChatSpecialistCandidatePatchInput,
    ): Promise<ChatSpecialistCandidateRecord>;
  };
  steer: {
    submitChatSteerInstruction(sessionId: string, body: ChatSteerRequest): Promise<ChatSteerResponse>;
  };
  goal: {
    getChatSessionGoal(sessionId: string): Promise<ChatGoalStatusResponse>;
    setChatSessionGoal(sessionId: string, body: ChatGoalRequest): Promise<ChatGoalStatusResponse>;
    clearChatSessionGoal(sessionId: string, expectedRevision?: number): Promise<ChatGoalStatusResponse>;
  };
  policyScope: {
    assertCallerPolicyScope(sessionId: string, scope: CallerPolicyScope): Promise<void>;
  };
}

export class ChatSupportRouteService {
  public constructor(private readonly deps: ChatSupportRouteDependencies) {}
  public inspectFollowThroughSetup(input:Parameters<FollowThroughSetupService["inspect"]>[0]){if(!this.deps.followThroughSetup)throw new ServiceUnavailableError("Schedule setup is unavailable on this runtime.");return this.deps.followThroughSetup.inspect(input);}
  public createFollowThroughSetup(input:Parameters<FollowThroughSetupService["create"]>[0]){if(!this.deps.followThroughSetup)throw new ServiceUnavailableError("Schedule setup is unavailable on this runtime.");return this.deps.followThroughSetup.create(input);}
  public inspectChatContinuation(input:Parameters<ChatContinuationService["inspect"]>[0]){
    if(!this.deps.continuations)throw new ServiceUnavailableError("Chat recovery is unavailable on this runtime.");
    return this.deps.continuations.inspect(input);
  }
  public prepareChatContinuation(input:Parameters<ChatContinuationService["prepare"]>[0]){
    if(!this.deps.continuations)throw new ServiceUnavailableError("Chat recovery is unavailable on this runtime.");
    return this.deps.continuations.prepare(input);
  }
  public getAssistantReadiness(sessionId:string,workspaceId?:string) {
    if(!this.deps.assistantReadiness) throw new ServiceUnavailableError("Assistant readiness is unavailable on this runtime.");
    return this.deps.assistantReadiness.getAssistantReadiness(sessionId,workspaceId);
  }
  public prepareAssistantSetup(input:import("@goatcitadel/contracts").AssistantSetupReviewInput,actorId?:string){if(!this.deps.assistantReadiness?.prepareSetup)throw new ServiceUnavailableError("Assistant setup reviews are unavailable on this runtime.");return this.deps.assistantReadiness.prepareSetup(input,actorId);}
  public getTurnLearningReceipt(sessionId:string,turnId:string,workspaceId?:string){
    if(!this.deps.learningReceipt)throw new ServiceUnavailableError("Learning receipts are unavailable on this runtime.");
    return this.deps.learningReceipt.getTurnLearningReceipt(sessionId,turnId,workspaceId);
  }
  public listFollowThrough(sessionId:string,workspaceId?:string){
    if(!this.deps.followThrough)throw new ServiceUnavailableError("Follow-through is unavailable on this runtime.");
    return this.deps.followThrough.listFollowThrough(sessionId,workspaceId);
  }
  public requestFollowThroughAction(input:Parameters<FollowThroughProjectionService["requestFollowThroughAction"]>[0],actorId?:string){
    if(!this.deps.followThrough)throw new ServiceUnavailableError("Follow-through is unavailable on this runtime.");
    return this.deps.followThrough.requestFollowThroughAction(input,actorId);
  }

  /** Rejects a caller-supplied `policyTaskId` or `policyRunId` that does not belong to the session. */
  public assertCallerPolicyScope(sessionId: string, scope: CallerPolicyScope) {
    return this.deps.policyScope.assertCallerPolicyScope(sessionId, scope);
  }

  public createChatChangePlan(sessionId: string, input: Omit<ChatChangePlanCreateInput, "sessionId">) {
    return this.deps.changePlans.create(sessionId, input);
  }

  public listChatChangePlans(sessionId: string, limit?: number) {
    return this.deps.changePlans.list(sessionId, limit);
  }

  public confirmChatChangePlan(sessionId: string, planId: string, expectedRevision: number) {
    return this.deps.changePlans.confirm(sessionId, planId, expectedRevision);
  }

  public cancelChatChangePlan(sessionId: string, planId: string, expectedRevision: number) {
    return this.deps.changePlans.cancel(sessionId, planId, expectedRevision);
  }

  public getChatSessionPrefs(sessionId: string) {
    return this.deps.prefs.getChatSessionPrefs(sessionId);
  }

  public updateChatSessionPrefs(sessionId: string, input: ChatSessionPrefsPatch) {
    return this.deps.prefs.updateChatSessionPrefs(sessionId, input);
  }

  public listChatCommandCatalog() {
    return this.deps.commands.listChatCommandCatalog();
  }

  public parseChatCommand(sessionId: string, commandText: string, options?: ChatCommandOptions) {
    return options
      ? this.deps.commands.parseChatCommand(sessionId, commandText, options)
      : this.deps.commands.parseChatCommand(sessionId, commandText);
  }

  public runChatResearch(
    sessionId: string,
    input: Parameters<ChatSupportRouteDependencies["research"]["runChatResearch"]>[1],
  ) {
    return this.deps.research.runChatResearch(sessionId, input);
  }

  public getChatResearchRun(sessionId: string, runId: string) {
    return this.deps.research.getChatResearchRun(sessionId, runId);
  }

  public getChatSessionProactiveStatus(sessionId: string) {
    return this.deps.proactive.getChatSessionProactiveStatus(sessionId);
  }

  public updateChatSessionProactivePolicy(
    sessionId: string,
    input: Parameters<ChatSupportRouteDependencies["proactive"]["updateChatSessionProactivePolicy"]>[1],
  ) {
    return this.deps.proactive.updateChatSessionProactivePolicy(sessionId, input);
  }

  public triggerChatSessionProactive(
    sessionId: string,
    input: Parameters<ChatSupportRouteDependencies["proactive"]["triggerChatSessionProactive"]>[1],
  ) {
    return this.deps.proactive.triggerChatSessionProactive(sessionId, input);
  }

  public listChatSessionProactiveRuns(sessionId: string, limit?: number) {
    return this.deps.proactive.listChatSessionProactiveRuns(sessionId, limit);
  }

  public listChatSessionLearnedMemory(sessionId: string, limit?: number) {
    return this.deps.learnedMemory.listChatSessionLearnedMemory(sessionId, limit);
  }

  public updateChatSessionLearnedMemory(sessionId: string, itemId: string, input: LearnedMemoryUpdateInput) {
    return this.deps.learnedMemory.updateChatSessionLearnedMemory(sessionId, itemId, input);
  }

  public rebuildChatSessionLearnedMemory(sessionId: string) {
    return this.deps.learnedMemory.rebuildChatSessionLearnedMemory(sessionId);
  }

  public listChatSessionSpecialistCandidates(sessionId: string, limit?: number) {
    return this.deps.specialists.listChatSessionSpecialistCandidates(sessionId, limit);
  }

  public createChatSessionSpecialistCandidate(
    sessionId: string,
    input: {
      turnId?: string;
      suggestion: ChatSpecialistCandidateSuggestionRecord;
    },
  ) {
    return this.deps.specialists.createChatSessionSpecialistCandidate(sessionId, input);
  }

  public updateChatSessionSpecialistCandidate(
    sessionId: string,
    candidateId: string,
    input: ChatSpecialistCandidatePatchInput,
  ) {
    return this.deps.specialists.updateChatSessionSpecialistCandidate(sessionId, candidateId, input);
  }

  public submitChatSteerInstruction(sessionId: string, body: ChatSteerRequest) {
    return this.deps.steer.submitChatSteerInstruction(sessionId, body);
  }

  public getChatSessionGoal(sessionId: string) {
    return this.deps.goal.getChatSessionGoal(sessionId);
  }

  public setChatSessionGoal(sessionId: string, body: ChatGoalRequest) {
    return this.deps.goal.setChatSessionGoal(sessionId, body);
  }

  public clearChatSessionGoal(sessionId: string, expectedRevision?: number) {
    return expectedRevision === undefined
      ? this.deps.goal.clearChatSessionGoal(sessionId)
      : this.deps.goal.clearChatSessionGoal(sessionId, expectedRevision);
  }
}
