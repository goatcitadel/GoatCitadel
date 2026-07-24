import type {
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

export interface ChatSupportRouteDependencies {
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
    ): {
      items: LearnedMemoryItemRecord[];
      conflicts: LearnedMemoryConflictRecord[];
    };
    rebuildChatSessionLearnedMemory(sessionId: string): Promise<{
      rebuiltAt: string;
      items: LearnedMemoryItemRecord[];
      conflicts: LearnedMemoryConflictRecord[];
    }>;
    updateChatSessionLearnedMemory(
      sessionId: string,
      itemId: string,
      input: LearnedMemoryUpdateInput,
    ): LearnedMemoryItemRecord;
  };
  prefs: {
    getChatSessionPrefs(sessionId: string): ChatSessionPrefsRecord;
    updateChatSessionPrefs(sessionId: string, input: ChatSessionPrefsPatch): ChatSessionPrefsRecord;
  };
  proactive: {
    getChatSessionProactiveStatus(sessionId: string): {
      policy: ProactivePolicy;
      idleSeconds: number;
      hasRunningTurn: boolean;
      pendingSuggestions: number;
      actionsLastHour: number;
      lastRun?: ProactiveRunRecord;
    };
    listChatSessionProactiveRuns(sessionId: string, limit?: number): ProactiveRunRecord[];
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
    ): ProactivePolicy;
  };
  research: {
    getChatResearchRun(
      sessionId: string,
      runId: string,
    ): {
      run: ResearchRunRecord;
      sources: ResearchSourceRecord[];
    };
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
    ): ChatSpecialistCandidateRecord;
    listChatSessionSpecialistCandidates(
      sessionId: string,
      limit?: number,
    ): {
      items: ChatSpecialistCandidateRecord[];
    };
    updateChatSessionSpecialistCandidate(
      sessionId: string,
      candidateId: string,
      input: ChatSpecialistCandidatePatchInput,
    ): ChatSpecialistCandidateRecord;
  };
  steer: {
    submitChatSteerInstruction(sessionId: string, body: ChatSteerRequest): Promise<ChatSteerResponse>;
  };
  goal: {
    getChatSessionGoal(sessionId: string): Promise<ChatGoalStatusResponse>;
    setChatSessionGoal(sessionId: string, body: ChatGoalRequest): Promise<ChatGoalStatusResponse>;
    clearChatSessionGoal(sessionId: string, expectedRevision?: number): Promise<ChatGoalStatusResponse>;
  };
}

export class ChatSupportRouteService {
  public constructor(private readonly deps: ChatSupportRouteDependencies) {}

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
