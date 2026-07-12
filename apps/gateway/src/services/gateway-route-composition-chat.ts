import fs from "node:fs/promises";
import path from "node:path";
import { NotFoundError } from "@goatcitadel/contracts";
import { assertWritePathInJail } from "@goatcitadel/policy-engine";
import { createAgentsRoutePort } from "./agents-route-service.js";
import * as chatAttachmentService from "./chat-attachment-service.js";
import * as chatCommandService from "./chat-command-service.js";
import * as chatGeneratedArtifactService from "./chat-generated-artifact-service.js";
import * as chatMessageRouteRuntime from "./chat-message-route-runtime.js";
import * as chatSessionService from "./chat-session-service.js";
import {
  handleChatGoalClearRequest,
  handleChatGoalSetRequest,
  handleChatGoalStatusRequest,
  handleChatSteerRequest,
} from "./chat-steer-route.js";
import * as chatThreadKnowledgeService from "./chat-thread-knowledge-service.js";
import * as chatToolArtifactService from "./chat-tool-artifact-service.js";
import * as chatWorkbenchService from "./chat-workbench-service.js";
import { resolveEffectiveRuntimeScopeFromStorage } from "./effective-runtime-scope-service.js";
import type { GatewayRouteServiceDependencies } from "./gateway-route-services.js";
import type { ChatStreamMutationLifecycle } from "./chat-turn-types.js";
import type { GatewayRouteCompositionPort, RouteDependencyDomain } from "./gateway-route-composition-port.js";
import { createChatThreadKnowledgeDependenciesForGateway } from "./gateway-route-composition-shared.js";

export function composeChatRouteDependencies(
  gateway: GatewayRouteCompositionPort,
): RouteDependencyDomain<
  | "agents"
  | "chatAttachments"
  | "chatDelegate"
  | "chatMessages"
  | "chatProjects"
  | "chatSessions"
  | "chatSupport"
  | "chatTools"
> {
  const agents = createAgentsRoutePort({
    storage: gateway.storage,
    normalizeWorkspaceId: (workspaceId) => gateway.normalizeWorkspaceId(workspaceId),
    getSession: (sessionId) => gateway.getSession(sessionId),
    getChatSessionPrefs: (sessionId) => gateway.getChatSessionPrefs(sessionId),
    createChatSessionSpecialistCandidate: (sessionId, input) =>
      gateway.createChatSessionSpecialistCandidate(sessionId, input),
    publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload ?? {}),
  });
  const chatAttachmentHost: chatAttachmentService.ChatAttachmentHost = {
    config: gateway.config,
    storage: gateway.storage,
    getSession: (sessionId) => gateway.getSession(sessionId),
    normalizeWorkspaceId: (workspaceId) => gateway.normalizeWorkspaceId(workspaceId),
    publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload),
    createMediaJob: (input) => gateway.mediaVoiceService.createMediaJob(input),
  };
  const ChatSessionDependencies: chatSessionService.ChatSessionDependencies = {
    storage: gateway.storage,
    operatorSummaryCache: gateway.operatorSummaryCache,
    normalizeWorkspaceId: (workspaceId) => gateway.normalizeWorkspaceId(workspaceId),
    ensureChatSessionRuntimeGrants: (sessionId) => gateway.ensureChatSessionRuntimeGrants(sessionId),
    requireChatSession: (sessionId) => gateway.requireChatSession(sessionId),
    getSession: (sessionId) => gateway.getSession(sessionId),
    publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload),
    clearChatTurnWriteLease: (sessionId) => gateway.clearChatTurnWriteLease(sessionId),
    removeChatSessionStoredFile: async (storageRelPath) => {
      const normalized = storageRelPath.trim();
      if (!normalized) {
        return;
      }
      const fullPath = resolvePortablePath(gateway.config.rootDir, gateway.config.assistant.workspaceDir, normalized);
      assertWritePathInJail(fullPath, gateway.config.toolPolicy.sandbox.writeJailRoots);
      await fs.rm(fullPath, { force: true });
    },
    ensureChatSessionModelDefaults: (sessionId, prefs) => gateway.ensureChatSessionModelDefaults(sessionId, prefs),
    hydrateChatPrefsWithAutonomy: (sessionId, prefs) => gateway.hydrateChatPrefsWithAutonomy(sessionId, prefs),
    patchSessionAutonomyPrefs: (sessionId, patch) => gateway.patchSessionAutonomyPrefs(sessionId, patch),
  };
  const ChatGeneratedArtifactDependencies: chatGeneratedArtifactService.ChatGeneratedArtifactDependencies = {
    storage: gateway.storage,
    requireChatSession: (sessionId) => gateway.requireChatSession(sessionId),
  };
  const ChatWorkbenchDependencies: chatWorkbenchService.ChatWorkbenchDependencies = {
    config: gateway.config,
    storage: gateway.storage,
    requireChatSession: (sessionId) => gateway.requireChatSession(sessionId),
    listCodeModeRuns: (options) => gateway.capabilitySystemService.listCodeModeRuns(options),
    publishRealtime: (channel, topic, payload, options) => gateway.publishRealtime(channel, topic, payload, options),
  };
  const chatMessageRouteRuntimeHost = gateway.chatMessageRouteRuntimeHost;
  const ChatThreadKnowledgeDependencies = createChatThreadKnowledgeDependenciesForGateway(gateway);
  const chatAttachments: GatewayRouteServiceDependencies["chatAttachments"] = {
    getChatAttachment: (attachmentId) => chatAttachmentService.getChatAttachment(chatAttachmentHost, attachmentId),
    readChatAttachmentContent: (attachmentId) =>
      chatAttachmentService.readChatAttachmentContent(chatAttachmentHost, attachmentId),
    uploadChatAttachment: (input) => chatAttachmentService.uploadChatAttachment(chatAttachmentHost, input),
  };
  const chatSessions: GatewayRouteServiceDependencies["chatSessions"] = {
    archiveChatSession: (sessionId) => chatSessionService.archiveChatSession(ChatSessionDependencies, sessionId),
    archiveChatSessionsBulk: (input) => {
      const { citadelId, ...sessionInput } = input ?? {};
      const scope = resolveChatRuntimeScope(gateway, {
        citadelId,
        workspaceId: sessionInput.workspaceId,
      });
      return chatSessionService.archiveChatSessionsBulk(ChatSessionDependencies, {
        ...sessionInput,
        workspaceId: scope.workspaceId,
      });
    },
    applyChatSessionWorkbenchPatch: (sessionId, input) =>
      chatWorkbenchService.applyChatSessionWorkbenchPatch(ChatWorkbenchDependencies, sessionId, input),
    assignChatSessionProject: (sessionId, projectId) =>
      chatSessionService.assignChatSessionProject(ChatSessionDependencies, sessionId, projectId),
    attachChatThreadKnowledgeAttachment: (sessionId, input) =>
      chatThreadKnowledgeService.attachChatThreadKnowledgeAttachment(ChatThreadKnowledgeDependencies, sessionId, input),
    createChatGeneratedArtifactFromTurn: (input) =>
      chatGeneratedArtifactService.createChatGeneratedArtifactFromTurn(ChatGeneratedArtifactDependencies, input),
    createChatSideChat: (sessionId, input) =>
      chatSessionService.createChatSideChat(ChatSessionDependencies, sessionId, input),
    createChatSession: (input) => {
      const { citadelId, ...sessionInput } = input ?? {};
      const scope = resolveChatRuntimeScope(gateway, {
        citadelId,
        workspaceId: sessionInput.workspaceId,
        projectId: sessionInput.projectId,
      });
      return chatSessionService.createChatSession(ChatSessionDependencies, {
        ...sessionInput,
        workspaceId: scope.workspaceId,
      });
    },
    createChatSessionWorkbenchWorktree: (sessionId, input) =>
      chatWorkbenchService.createChatSessionWorkbenchWorktree(ChatWorkbenchDependencies, sessionId, input),
    deleteChatSession: (sessionId) => chatSessionService.deleteChatSession(ChatSessionDependencies, sessionId),
    exportChatSessionWorkbenchPatch: (sessionId) =>
      chatWorkbenchService.exportChatSessionWorkbenchPatch(ChatWorkbenchDependencies, sessionId),
    getChatGeneratedArtifact: (artifactId, options) => {
      const scope = resolveChatRuntimeScope(gateway, {
        citadelId: options?.citadelId,
        workspaceId: options?.workspaceId,
      });
      return chatGeneratedArtifactService.getChatGeneratedArtifact(ChatGeneratedArtifactDependencies, artifactId, {
        workspaceId: scope.workspaceId,
      });
    },
    getChatSessionBinding: (sessionId) => chatSessionService.getChatSessionBinding(ChatSessionDependencies, sessionId),
    getChatSessionWorkbench: (sessionId) =>
      chatWorkbenchService.getChatSessionWorkbench(ChatWorkbenchDependencies, sessionId),
    getChatSessionWorkbenchDiff: (sessionId) =>
      chatWorkbenchService.getChatSessionWorkbenchDiff(ChatWorkbenchDependencies, sessionId),
    getChatSessionWorkbenchFile: (sessionId, relativePath) =>
      chatWorkbenchService.getChatSessionWorkbenchFile(ChatWorkbenchDependencies, sessionId, relativePath),
    getChatSessionWorkbenchFileDiff: (sessionId, relativePath) =>
      chatWorkbenchService.getChatSessionWorkbenchFileDiff(ChatWorkbenchDependencies, sessionId, relativePath),
    getChatSessionWorkbenchOutput: (sessionId) =>
      chatWorkbenchService.getChatSessionWorkbenchOutput(ChatWorkbenchDependencies, sessionId),
    getChatSessionWorkbenchTree: (sessionId) =>
      chatWorkbenchService.getChatSessionWorkbenchTree(ChatWorkbenchDependencies, sessionId),
    getChatSideChat: (sessionId) => chatSessionService.getChatSideChat(ChatSessionDependencies, sessionId),
    listChatGeneratedArtifacts: (input) => {
      const { citadelId, ...artifactInput } = input ?? {};
      const scope = resolveChatRuntimeScope(gateway, {
        citadelId,
        sessionId: artifactInput.sessionId,
        workspaceId: artifactInput.workspaceId,
        projectId: artifactInput.projectId,
      });
      return chatGeneratedArtifactService.listChatGeneratedArtifacts(ChatGeneratedArtifactDependencies, {
        ...artifactInput,
        workspaceId: scope.workspaceId,
      });
    },
    listChatSessions: (query) => {
      const { citadelId, ...sessionQuery } = query ?? {};
      const scope = resolveChatRuntimeScope(gateway, {
        citadelId,
        workspaceId: sessionQuery.workspaceId,
        projectId: sessionQuery.projectId,
      });
      return chatSessionService.listChatSessions(ChatSessionDependencies, {
        ...sessionQuery,
        workspaceId: scope.workspaceId,
      });
    },
    listChatThreadKnowledgeAttachments: (sessionId) =>
      chatThreadKnowledgeService.listChatThreadKnowledgeAttachments(ChatThreadKnowledgeDependencies, sessionId),
    listRecentCrossProjectSessions: (input) => {
      const { citadelId, ...sessionInput } = input;
      const scope = resolveChatRuntimeScope(gateway, {
        citadelId,
        workspaceId: sessionInput.workspaceId,
      });
      return chatSessionService.listRecentCrossProjectSessions(ChatSessionDependencies, {
        ...sessionInput,
        workspaceId: scope.workspaceId,
      });
    },
    pinChatSession: (sessionId) => chatSessionService.pinChatSession(ChatSessionDependencies, sessionId),
    removeChatThreadKnowledgeAttachment: (sessionId, attachmentId) =>
      chatThreadKnowledgeService.removeChatThreadKnowledgeAttachment(
        ChatThreadKnowledgeDependencies,
        sessionId,
        attachmentId,
      ),
    restoreChatSession: (sessionId) => chatSessionService.restoreChatSession(ChatSessionDependencies, sessionId),
    revertChatSessionWorkbenchChanges: (sessionId) =>
      chatWorkbenchService.revertChatSessionWorkbenchChanges(ChatWorkbenchDependencies, sessionId),
    revertChatSessionWorkbenchFile: (sessionId, input) =>
      chatWorkbenchService.revertChatSessionWorkbenchFile(ChatWorkbenchDependencies, sessionId, input),
    runChatSessionWorkbenchCommand: (sessionId, input) =>
      chatWorkbenchService.runChatSessionWorkbenchCommand(ChatWorkbenchDependencies, sessionId, input),
    runChatSessionWorkbenchFileOperation: (sessionId, input) =>
      chatWorkbenchService.runChatSessionWorkbenchFileOperation(ChatWorkbenchDependencies, sessionId, input),
    saveChatSessionWorkbenchFile: (sessionId, input) =>
      chatWorkbenchService.saveChatSessionWorkbenchFile(ChatWorkbenchDependencies, sessionId, input),
    searchChatSessions: (input) => {
      const { citadelId, ...searchInput } = input;
      const scope = resolveChatRuntimeScope(gateway, {
        citadelId,
        workspaceId: searchInput.workspaceId,
      });
      return chatSessionService.searchChatSessions(ChatSessionDependencies, {
        ...searchInput,
        workspaceId: scope.workspaceId,
      });
    },
    setChatSessionBinding: (input) => chatSessionService.setChatSessionBinding(ChatSessionDependencies, input),
    unpinChatSession: (sessionId) => chatSessionService.unpinChatSession(ChatSessionDependencies, sessionId),
    updateChatSession: (sessionId, input) =>
      chatSessionService.updateChatSession(ChatSessionDependencies, sessionId, input),
  };
  const chatDelegate: GatewayRouteServiceDependencies["chatDelegate"] = {
    acceptChatDelegation: (sessionId, input) => gateway.acceptChatDelegation(sessionId, input),
    getChatDelegationRun: (sessionId, runId) => {
      gateway.storage.chatDelegationRuns.reconcileSupersededRunningRunsForSession?.(sessionId);
      const run = gateway.storage.chatDelegationRuns.get(runId);
      if (run.sessionId !== sessionId) {
        throw new NotFoundError(`Delegation run ${runId} not found for session ${sessionId}`);
      }
      return {
        run,
        steps: gateway.storage.chatDelegationSteps.listByRun(runId),
      };
    },
    runChatDelegation: (sessionId, input) => gateway.runChatDelegation(sessionId, input),
    runChatDelegationStream: (sessionId, input, options) => gateway.runChatDelegationStream(sessionId, input, options),
    suggestChatDelegation: (sessionId, input) => gateway.suggestChatDelegation(sessionId, input),
  };
  const chatTools: GatewayRouteServiceDependencies["chatTools"] = {
    getChatToolArtifactContent: (artifactId, options) =>
      chatToolArtifactService.getChatToolArtifactContent(gateway, artifactId, options),
    listChatPendingApprovals: (sessionId) => gateway.capabilitySystemService.listChatPendingApprovals(sessionId),
    resolveChatToolApproval: (sessionId, approvalId, decision, options) =>
      gateway.approvalRuntime.resolveChatToolApproval(sessionId, approvalId, decision, options),
  };
  const chatMessages: GatewayRouteServiceDependencies["chatMessages"] = {
    agentSendChatMessage: (sessionId, input) => gateway.chatTurnRuntime.agentSendChatMessage(sessionId, input),
    agentSendChatMessageStream: (
      sessionId,
      input,
      signal?: AbortSignal,
      mutationLifecycle?: ChatStreamMutationLifecycle,
    ) =>
      gateway.chatTurnRuntime.agentSendChatMessageStream(sessionId, input, {
        abortSignal: signal,
        ...(mutationLifecycle ? { mutationLifecycle } : {}),
      }),
    answerChatUserInputPrompt: (sessionId, turnId, promptId, input) =>
      chatMessageRouteRuntime.answerChatUserInputPrompt(
        chatMessageRouteRuntimeHost,
        sessionId,
        turnId,
        promptId,
        input,
      ),
    cancelChatTurn: (sessionId, turnId, cancelledBy) =>
      gateway.chatTurnRuntime.cancelChatTurn(sessionId, turnId, cancelledBy),
    editChatTurn: (sessionId, turnId, input) => gateway.chatTurnRuntime.editChatTurn(sessionId, turnId, input),
    editChatTurnStream: (
      sessionId,
      turnId,
      input,
      signal?: AbortSignal,
      mutationLifecycle?: ChatStreamMutationLifecycle,
    ) =>
      gateway.chatTurnRuntime.editChatTurnStream(sessionId, turnId, input, {
        abortSignal: signal,
        ...(mutationLifecycle ? { mutationLifecycle } : {}),
      }),
    getChatThread: (sessionId, options) =>
      chatMessageRouteRuntime.getChatThread(chatMessageRouteRuntimeHost, sessionId, options),
    getTurnContextManifestForSession: (sessionId, turnId) =>
      chatMessageRouteRuntime.getTurnContextManifestForSession(chatMessageRouteRuntimeHost, sessionId, turnId),
    listChatMessages: (sessionId, limit, cursor) => gateway.listChatMessages(sessionId, limit, cursor),
    resumeAgentChatTurnStream: (sessionId, turnId, sinceEventId, signal?: AbortSignal) =>
      gateway.chatTurnRuntime.resumeAgentChatTurnStream(sessionId, turnId, sinceEventId, { abortSignal: signal }),
    retryChatTurn: (sessionId, turnId, input) => gateway.chatTurnRuntime.retryChatTurn(sessionId, turnId, input),
    retryChatTurnStream: (
      sessionId,
      turnId,
      input,
      signal?: AbortSignal,
      mutationLifecycle?: ChatStreamMutationLifecycle,
    ) =>
      gateway.chatTurnRuntime.retryChatTurnStream(sessionId, turnId, input, {
        abortSignal: signal,
        ...(mutationLifecycle ? { mutationLifecycle } : {}),
      }),
    routePreflight: (sessionId, input) => gateway.chatTurnRuntime.routePreflight(sessionId, input),
    selectChatBranchTurn: (sessionId, turnId) =>
      chatMessageRouteRuntime.selectChatBranchTurn(chatMessageRouteRuntimeHost, sessionId, turnId),
  };

  return {
    agents,
    chatAttachments,
    chatDelegate,
    chatMessages,
    chatProjects: {
      archiveChatProject: (projectId) => gateway.chatProjectService.archiveChatProject(projectId),
      createChatProject: (input) => {
        const { citadelId, ...projectInput } = input;
        const scope = resolveChatRuntimeScope(gateway, {
          citadelId,
          workspaceId: projectInput.workspaceId,
        });
        return gateway.chatProjectService.createChatProject({ ...projectInput, workspaceId: scope.workspaceId });
      },
      hardDeleteChatProject: (projectId) => gateway.chatProjectService.hardDeleteChatProject(projectId),
      importChatProject: (input) => {
        const { citadelId, ...projectInput } = input;
        const scope = resolveChatRuntimeScope(gateway, {
          citadelId,
          workspaceId: projectInput.workspaceId,
        });
        return gateway.chatProjectService.importChatProject({ ...projectInput, workspaceId: scope.workspaceId });
      },
      listChatProjects: (view, limit, workspaceId, citadelId) => {
        const scope = resolveChatRuntimeScope(gateway, { citadelId, workspaceId });
        return gateway.chatProjectService.listChatProjects(view, limit, scope.workspaceId);
      },
      restoreChatProject: (projectId) => gateway.chatProjectService.restoreChatProject(projectId),
      updateChatProject: (projectId, input) => {
        const { citadelId, ...projectInput } = input;
        const scope = resolveChatRuntimeScope(gateway, {
          citadelId,
          projectId,
          workspaceId: projectInput.workspaceId,
        });
        return gateway.chatProjectService.updateChatProject(projectId, {
          ...projectInput,
          workspaceId: scope.workspaceId,
        });
      },
    },
    chatSessions,
    chatSupport: {
      commands: {
        listChatCommandCatalog: () => chatCommandService.listChatCommandCatalog(),
        parseChatCommand: (sessionId, commandText, options) =>
          gateway.parseChatCommand(sessionId, commandText, options),
      },
      learnedMemory: {
        listChatSessionLearnedMemory: (sessionId, limit) =>
          gateway.memoryLifecycleService.listSessionLearnedMemory(sessionId, limit),
        rebuildChatSessionLearnedMemory: (sessionId) =>
          gateway.memoryLifecycleService.rebuildSessionLearnedMemory(sessionId),
        updateChatSessionLearnedMemory: (sessionId, itemId, input) =>
          gateway.memoryLifecycleService.updateSessionLearnedMemory(sessionId, itemId, input),
      },
      prefs: {
        getChatSessionPrefs: (sessionId) => gateway.getChatSessionPrefs(sessionId),
        updateChatSessionPrefs: (sessionId, input) => gateway.updateChatSessionPrefs(sessionId, input),
      },
      proactive: {
        getChatSessionProactiveStatus: (sessionId) =>
          gateway.chatProactiveService.getChatSessionProactiveStatus(sessionId),
        listChatSessionProactiveRuns: (sessionId, limit) =>
          gateway.chatProactiveService.listChatSessionProactiveRuns(sessionId, limit),
        triggerChatSessionProactive: (sessionId, input) =>
          gateway.chatProactiveService.triggerChatSessionProactive(sessionId, input),
        updateChatSessionProactivePolicy: (sessionId, input) =>
          gateway.chatProactiveService.updateChatSessionProactivePolicy(sessionId, input),
      },
      research: {
        getChatResearchRun: (sessionId, runId) => gateway.researchService.getRun(sessionId, runId),
        runChatResearch: (sessionId, input) => gateway.runChatResearch(sessionId, input),
      },
      specialists: {
        createChatSessionSpecialistCandidate: (sessionId, input) =>
          gateway.createChatSessionSpecialistCandidate(sessionId, input),
        listChatSessionSpecialistCandidates: (sessionId, limit = 200) => {
          gateway.getSession(sessionId);
          return {
            items: gateway.storage.chatSpecialistCandidates.listBySession(sessionId, limit),
          };
        },
        updateChatSessionSpecialistCandidate: (sessionId, candidateId, input) => {
          gateway.getSession(sessionId);
          const current = gateway.storage.chatSpecialistCandidates.get(candidateId);
          if (current.sessionId !== sessionId) {
            throw new Error("Specialist candidate does not belong to this session.");
          }
          return gateway.storage.chatSpecialistCandidates.patch(candidateId, input);
        },
      },
      steer: {
        submitChatSteerInstruction: (sessionId, body) =>
          handleChatSteerRequest({ sessionId, body, steerService: gateway.steerService }),
      },
      goal: {
        getChatSessionGoal: (sessionId) =>
          handleChatGoalStatusRequest({ sessionId, chatSessionMeta: gateway.storage.chatSessionMeta }),
        setChatSessionGoal: (sessionId, body) =>
          handleChatGoalSetRequest({ sessionId, body, chatSessionMeta: gateway.storage.chatSessionMeta }),
        clearChatSessionGoal: (sessionId) =>
          handleChatGoalClearRequest({ sessionId, chatSessionMeta: gateway.storage.chatSessionMeta }),
      },
    },
    chatTools,
  };
}

function resolveChatRuntimeScope(
  gateway: GatewayRouteCompositionPort,
  source: Parameters<typeof resolveEffectiveRuntimeScopeFromStorage>[1],
) {
  return resolveEffectiveRuntimeScopeFromStorage(
    {
      storage: gateway.storage,
      normalizeWorkspaceId: (workspaceId) => gateway.normalizeWorkspaceId(workspaceId),
    },
    source,
  );
}

function resolvePortablePath(rootDir: string, workspaceDir: string, relativePath: string): string {
  return isWindowsAbsolutePath(rootDir)
    ? path.win32.resolve(rootDir, workspaceDir, relativePath)
    : path.resolve(rootDir, workspaceDir, relativePath);
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value.trim());
}
