import fs from "node:fs/promises";
import path from "node:path";
import { CHAT_ROUTED_CONTEXT_TOOL_NAMES, NotFoundError } from "@goatcitadel/contracts";
import { assertWritePathInJail } from "@goatcitadel/policy-engine";
import { createAgentsRoutePort } from "./agents-route-service.js";
import * as chatAttachmentService from "./chat-attachment-service.js";
import * as chatCommandService from "./chat-command-service.js";
import * as chatGeneratedArtifactService from "./chat-generated-artifact-service.js";
import * as chatHistoryService from "./chat-history-service.js";
import * as chatMessageRouteRuntime from "./chat-message-route-runtime.js";
import * as chatSessionService from "./chat-session-service.js";
import {
  buildWorkspaceExplorerReport,
  isReadOnlyWorkspaceExplorerRun,
  READ_ONLY_EXPLORER_WORKFLOW_TEMPLATE,
} from "./chat-delegation-service.js";
import {
  handleChatGoalClearRequest,
  handleChatGoalSetRequest,
  handleChatGoalStatusRequest,
  handleChatSteerRequest,
} from "./chat-steer-route.js";
import * as chatThreadKnowledgeService from "./chat-thread-knowledge-service.js";
import * as chatToolArtifactService from "./chat-tool-artifact-service.js";
import * as chatWorkbenchService from "./chat-workbench-service.js";
import { DocumentEditingService } from "./document-editing-service.js";
import { resolveEffectiveRuntimeScopeFromStorage } from "./effective-runtime-scope-service.js";
import { createSessionControlRouteService } from "./session-control-route-service.js";
import { getSessionControlRuntimeOwner } from "./session-control-runtime-owner.js";
import type { GatewayRouteServiceDependencies } from "./gateway-route-services.js";
import type { ChatStreamMutationLifecycle } from "./chat-turn-types.js";
import type { GatewayRouteCompositionPort, RouteDependencyDomain } from "./gateway-route-composition-port.js";
import { createChatThreadKnowledgeDependenciesForGateway } from "./gateway-route-composition-shared.js";

export function composeChatRouteDependencies(
  gateway: GatewayRouteCompositionPort,
): RouteDependencyDomain<
  | "agents"
  | "chatAttachments"
  | "chatCompactionBreakerActions"
  | "chatDelegate"
  | "chatMessages"
  | "chatProjects"
  | "sessionControl"
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
    requireTypedRunVariables: () => gateway.requireFeatureEnabled("typedRunVariablesV1Enabled"),
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
    requireChatSession: async (sessionId) => gateway.requireChatSession(sessionId),
    getSession: (sessionId) => gateway.getSession(sessionId),
    publishRealtime: async (eventType, source, payload) => {
      await gateway.publishRealtime(eventType, source, payload);
    },
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
    copyChatSessionStoredFile: async (storageRelPath, copyId) => {
      const normalized = storageRelPath.trim().replaceAll("\\", "/");
      if (!normalized) {
        throw new Error("Attachment storage path is empty.");
      }
      const sourcePath = resolvePortablePath(gateway.config.rootDir, gateway.config.assistant.workspaceDir, normalized);
      const destinationRelPath = path.posix.join(
        path.posix.dirname(normalized),
        "forks",
        `${copyId}-${path.posix.basename(normalized)}`,
      );
      const destinationPath = resolvePortablePath(
        gateway.config.rootDir,
        gateway.config.assistant.workspaceDir,
        destinationRelPath,
      );
      assertWritePathInJail(destinationPath, gateway.config.toolPolicy.sandbox.writeJailRoots);
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      await fs.copyFile(sourcePath, destinationPath);
      return destinationRelPath;
    },
    ensureChatSessionModelDefaults: (sessionId, prefs) => gateway.ensureChatSessionModelDefaults(sessionId, prefs),
    hydrateChatPrefsWithAutonomy: (sessionId, prefs) => gateway.hydrateChatPrefsWithAutonomy(sessionId, prefs),
    patchSessionAutonomyPrefs: (sessionId, patch) => gateway.patchSessionAutonomyPrefs(sessionId, patch),
  };
  const ChatGeneratedArtifactDependencies: chatGeneratedArtifactService.ChatGeneratedArtifactDependencies = {
    storage: gateway.storage,
    requireChatSession: async (sessionId) => await gateway.requireChatSession(sessionId),
  };
  let documentEditing: DocumentEditingService | undefined;
  const getDocumentEditing = (): DocumentEditingService => {
    documentEditing ??= new DocumentEditingService({
      storage: gateway.storage,
      requireChatSession: async (sessionId) => await gateway.requireChatSession(sessionId),
    });
    return documentEditing;
  };
  const ChatWorkbenchDependencies: chatWorkbenchService.ChatWorkbenchDependencies = {
    config: gateway.config,
    storage: gateway.storage,
    requireChatSession: async (sessionId) => await gateway.requireChatSession(sessionId),
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
    archiveChatSession: (sessionId, expectedRevision) =>
      chatSessionService.archiveChatSession(ChatSessionDependencies, sessionId, expectedRevision),
    archiveChatSessionsBulk: async (input) => {
      const { citadelId, ...sessionInput } = input ?? {};
      const scope = await resolveChatRuntimeScope(gateway, {
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
    assignChatSessionProject: (sessionId, projectId, expectedRevision) =>
      chatSessionService.assignChatSessionProject(ChatSessionDependencies, sessionId, projectId, expectedRevision),
    attachChatThreadKnowledgeAttachment: (sessionId, input) =>
      chatThreadKnowledgeService.attachChatThreadKnowledgeAttachment(ChatThreadKnowledgeDependencies, sessionId, input),
    createChatGeneratedArtifactFromTurn: (input) =>
      chatGeneratedArtifactService.createChatGeneratedArtifactFromTurn(ChatGeneratedArtifactDependencies, input),
    createChatGeneratedArtifactVersion: async (artifactId, input) => {
      await gateway.requireFeatureEnabled("documentEditingV1Enabled");
      return getDocumentEditing().createArtifactVersion(artifactId, input);
    },
    createDocumentPatchProposal: async (input, actorId) => {
      await gateway.requireFeatureEnabled("documentEditingV1Enabled");
      return getDocumentEditing().createProposal(input, actorId);
    },
    createAssistantDocumentPatchProposal: async (input, binding) => {
      await gateway.requireFeatureEnabled("documentEditingV1Enabled");
      return getDocumentEditing().createAssistantProposal(input, binding);
    },
    applyDocumentPatchProposal: async (proposalId, workspaceId, actorId) => {
      await gateway.requireFeatureEnabled("documentEditingV1Enabled");
      return getDocumentEditing().applyProposal(proposalId, workspaceId, actorId);
    },
    createChatSideChat: (sessionId, input) =>
      chatSessionService.createChatSideChat(ChatSessionDependencies, sessionId, input),
    createChatTimer: (sessionId, input, actorId) => {
      if (!gateway.isFeatureEnabled("chatTimersV1Enabled")) {
        throw new NotFoundError({ entity: "Chat timer", id: sessionId });
      }
      return gateway.chatTimerService.create(sessionId, input, actorId);
    },
    createChatSession: async (input) => {
      const { citadelId, ...sessionInput } = input ?? {};
      const scope = await resolveChatRuntimeScope(gateway, {
        citadelId,
        workspaceId: sessionInput.workspaceId,
        projectId: sessionInput.projectId,
      });
      return chatSessionService.createChatSession(ChatSessionDependencies, {
        ...sessionInput,
        workspaceId: scope.workspaceId,
      });
    },
    forkChatSessionFromTurn: (sessionId, turnId, input, actorId) => {
      if (!gateway.isFeatureEnabled("conversationForksV1Enabled")) {
        throw new NotFoundError({ entity: "Chat session fork", id: turnId });
      }
      return chatSessionService.forkChatSessionFromTurn(ChatSessionDependencies, sessionId, turnId, input, actorId);
    },
    createChatSessionWorkbenchWorktree: (sessionId, input) =>
      chatWorkbenchService.createChatSessionWorkbenchWorktree(ChatWorkbenchDependencies, sessionId, input),
    deleteChatSession: (sessionId, expectedRevision) =>
      chatSessionService.deleteChatSession(ChatSessionDependencies, sessionId, expectedRevision),
    exportChatSessionWorkbenchPatch: (sessionId) =>
      chatWorkbenchService.exportChatSessionWorkbenchPatch(ChatWorkbenchDependencies, sessionId),
    getChatGeneratedArtifact: async (artifactId, options) => {
      const scope = await resolveChatRuntimeScope(gateway, {
        citadelId: options?.citadelId,
        workspaceId: options?.workspaceId,
      });
      return chatGeneratedArtifactService.getChatGeneratedArtifact(ChatGeneratedArtifactDependencies, artifactId, {
        workspaceId: scope.workspaceId,
      });
    },
    getChatSessionBinding: (sessionId) => chatSessionService.getChatSessionBinding(ChatSessionDependencies, sessionId),
    getChatSessionStatus: (sessionId) => {
      if (!gateway.isFeatureEnabled("chatSessionStatusV1Enabled")) {
        throw new NotFoundError({ entity: "Chat session status", id: sessionId });
      }
      return gateway.chatSessionStatusService.getOperatorStatus(sessionId);
    },
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
    listChatGeneratedArtifacts: async (input) => {
      const { citadelId, ...artifactInput } = input ?? {};
      const scope = await resolveChatRuntimeScope(gateway, {
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
    listDocumentPatchProposals: async (input) => {
      await gateway.requireFeatureEnabled("documentEditingV1Enabled");
      return getDocumentEditing().listProposals(input);
    },
    listChatSessions: async (query) => {
      const { citadelId, ...sessionQuery } = query ?? {};
      const scope = await resolveChatRuntimeScope(gateway, {
        citadelId,
        workspaceId: sessionQuery.workspaceId,
        projectId: sessionQuery.projectId,
      });
      return chatSessionService.listChatSessions(ChatSessionDependencies, {
        ...sessionQuery,
        workspaceId: scope.workspaceId,
      });
    },
    listChatTimers: (sessionId) => {
      if (!gateway.isFeatureEnabled("chatTimersV1Enabled")) {
        throw new NotFoundError({ entity: "Chat timer", id: sessionId });
      }
      return gateway.chatTimerService.list(sessionId);
    },
    listChatThreadKnowledgeAttachments: (sessionId) =>
      chatThreadKnowledgeService.listChatThreadKnowledgeAttachments(ChatThreadKnowledgeDependencies, sessionId),
    listRecentCrossProjectSessions: async (input) => {
      const { citadelId, ...sessionInput } = input;
      const scope = await resolveChatRuntimeScope(gateway, {
        citadelId,
        workspaceId: sessionInput.workspaceId,
      });
      return chatSessionService.listRecentCrossProjectSessions(ChatSessionDependencies, {
        ...sessionInput,
        workspaceId: scope.workspaceId,
      });
    },
    pinChatSession: (sessionId, expectedRevision) =>
      chatSessionService.pinChatSession(ChatSessionDependencies, sessionId, expectedRevision),
    removeChatThreadKnowledgeAttachment: (sessionId, attachmentId) =>
      chatThreadKnowledgeService.removeChatThreadKnowledgeAttachment(
        ChatThreadKnowledgeDependencies,
        sessionId,
        attachmentId,
      ),
    rejectDocumentPatchProposal: async (proposalId, workspaceId, actorId) => {
      await gateway.requireFeatureEnabled("documentEditingV1Enabled");
      return getDocumentEditing().rejectProposal(proposalId, workspaceId, actorId);
    },
    restoreChatSession: (sessionId, expectedRevision) =>
      chatSessionService.restoreChatSession(ChatSessionDependencies, sessionId, expectedRevision),
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
    searchChatSessions: async (input) => {
      const { citadelId, ...searchInput } = input;
      const scope = await resolveChatRuntimeScope(gateway, {
        citadelId,
        workspaceId: searchInput.workspaceId,
      });
      return chatSessionService.searchChatSessions(ChatSessionDependencies, {
        ...searchInput,
        workspaceId: scope.workspaceId,
      });
    },
    setChatSessionBinding: (input) => chatSessionService.setChatSessionBinding(ChatSessionDependencies, input),
    unpinChatSession: (sessionId, expectedRevision) =>
      chatSessionService.unpinChatSession(ChatSessionDependencies, sessionId, expectedRevision),
    updateChatSession: (sessionId, input, expectedRevision) =>
      chatSessionService.updateChatSession(ChatSessionDependencies, sessionId, input, expectedRevision),
    cancelChatTimer: (sessionId, timerId, expectedRevision) => {
      if (!gateway.isFeatureEnabled("chatTimersV1Enabled")) {
        throw new NotFoundError({ entity: "Chat timer", id: timerId });
      }
      return gateway.chatTimerService.cancel(sessionId, timerId, expectedRevision);
    },
  };
  const chatDelegate: GatewayRouteServiceDependencies["chatDelegate"] = {
    acceptChatDelegation: (sessionId, input) => gateway.acceptChatDelegation(sessionId, input),
    getChatDelegationRun: async (sessionId, runId) => {
      await gateway.storage.chatDelegationRuns.reconcileSupersededRunningRunsForSession?.(sessionId);
      let run = await gateway.storage.chatDelegationRuns.get(runId);
      if (run.sessionId !== sessionId) {
        throw new NotFoundError(`Delegation run ${runId} not found for session ${sessionId}`);
      }
      if (isReadOnlyWorkspaceExplorerRun(run)) {
        await gateway.reconcilePersistedWorkspaceExplorer({
          sessionId,
          delegationRunId: run.runId,
        });
        run = await gateway.storage.chatDelegationRuns.get(runId);
      }
      const steps = await gateway.storage.chatDelegationSteps.listByRun(runId);
      return {
        run,
        steps,
        ...(isReadOnlyWorkspaceExplorerRun(run) ? { explorer: buildWorkspaceExplorerReport(run, steps) } : {}),
      };
    },
    getLatestChatWorkspaceExplorer: async (sessionId) => {
      await gateway.storage.chatDelegationRuns.reconcileSupersededRunningRunsForSession?.(sessionId);
      let run = await gateway.storage.chatDelegationRuns.findLatestBySessionAndWorkflowTemplate(
        sessionId,
        READ_ONLY_EXPLORER_WORKFLOW_TEMPLATE,
      );
      if (!run) return {};
      await gateway.reconcilePersistedWorkspaceExplorer({
        sessionId,
        delegationRunId: run.runId,
      });
      run = await gateway.storage.chatDelegationRuns.get(run.runId);
      const steps = await gateway.storage.chatDelegationSteps.listByRun(run.runId);
      return {
        item: {
          run,
          steps,
          explorer: buildWorkspaceExplorerReport(run, steps),
        },
      };
    },
    listChatDelegatedScopeCandidates: (input) => gateway.listChatDelegatedScopeCandidates(input),
    requestChatDelegatedScopeExpansion: (input) => gateway.requestChatDelegatedScopeExpansion(input),
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
    agentSendChatMessage: async (sessionId, input, authenticatedOperator, externalCompanion) =>
      await gateway.chatTurnRuntime.agentSendChatMessage(
        sessionId,
        await gateway.resolveChatRunVariableInput(sessionId, input),
        authenticatedOperator || externalCompanion
          ? {
              ...(authenticatedOperator ? { authenticatedOperator } : {}),
              ...(externalCompanion ? { externalCompanion } : {}),
            }
          : undefined,
      ),
    agentSendChatMessageStream: async function* (
      sessionId,
      input,
      signal?: AbortSignal,
      mutationLifecycle?: ChatStreamMutationLifecycle,
      authenticatedOperator?,
      externalCompanion?,
    ) {
      yield* gateway.chatTurnRuntime.agentSendChatMessageStream(
        sessionId,
        await gateway.resolveChatRunVariableInput(sessionId, input),
        {
          abortSignal: signal,
          ...(mutationLifecycle ? { mutationLifecycle } : {}),
          ...(authenticatedOperator ? { authenticatedOperator } : {}),
          ...(externalCompanion ? { externalCompanion } : {}),
        },
      );
    },
    answerChatUserInputPrompt: (sessionId, turnId, promptId, input, responder) =>
      chatMessageRouteRuntime.answerChatUserInputPrompt(
        chatMessageRouteRuntimeHost,
        sessionId,
        turnId,
        promptId,
        input,
        responder,
      ),
    cancelChatTurn: (sessionId, turnId, cancelledBy) =>
      gateway.chatTurnRuntime.cancelChatTurn(sessionId, turnId, cancelledBy),
    editChatTurn: (sessionId, turnId, input, authenticatedOperator) =>
      gateway.chatTurnRuntime.editChatTurn(
        sessionId,
        turnId,
        input,
        authenticatedOperator ? { authenticatedOperator } : undefined,
      ),
    editChatTurnStream: (
      sessionId,
      turnId,
      input,
      signal?: AbortSignal,
      mutationLifecycle?: ChatStreamMutationLifecycle,
      authenticatedOperator?,
    ) =>
      gateway.chatTurnRuntime.editChatTurnStream(sessionId, turnId, input, {
        abortSignal: signal,
        ...(mutationLifecycle ? { mutationLifecycle } : {}),
        ...(authenticatedOperator ? { authenticatedOperator } : {}),
      }),
    getChatThread: (sessionId, options) =>
      chatMessageRouteRuntime.getChatThread(chatMessageRouteRuntimeHost, sessionId, options),
    getChatTurnCapabilityProfile: (
      sessionId: string,
      turnId: string,
      options?: { workspaceId?: string; operatorId?: string },
    ) => {
      return (async () => {
        const trace = await gateway.storage.chatTurnTraces.get(turnId);
        if (trace.sessionId !== sessionId) {
          throw new NotFoundError({ entity: "Chat turn", id: turnId });
        }
        const sessionMeta = await gateway.storage.chatSessionMeta.get(sessionId);
        if (!sessionMeta) {
          throw new NotFoundError({ entity: "Chat session", id: sessionId });
        }
        const workspaceId = gateway.normalizeWorkspaceId(sessionMeta.workspaceId);
        if (options?.workspaceId && gateway.normalizeWorkspaceId(options.workspaceId) !== workspaceId) {
          throw new NotFoundError({ entity: "Chat turn capability profile", id: turnId });
        }
        // Authorize against narrow indexed columns before loading profile_json,
        // which contains full provider definitions and source provenance.
        const scope = await gateway.storage.chatTurnCapabilityProfiles.findScopeByTurn(turnId);
        if (!scope) {
          return { state: "legacy_missing" as const };
        }
        if (
          scope.turnId !== turnId ||
          scope.sessionId !== sessionId ||
          scope.workspaceId !== workspaceId ||
          (trace.capabilityProfileId !== undefined && trace.capabilityProfileId !== scope.profileId) ||
          (trace.capabilityProfileHash !== undefined && trace.capabilityProfileHash !== scope.profileHash)
        ) {
          throw new NotFoundError({ entity: "Chat turn capability profile", id: turnId });
        }
        const actorId = options?.operatorId?.trim();
        const boundActorIds = [scope.operatorId, scope.authActorId].filter((value): value is string => Boolean(value));
        if (boundActorIds.length > 0 && (!actorId || !boundActorIds.includes(actorId))) {
          throw new NotFoundError({ entity: "Chat turn capability profile", id: turnId });
        }
        const envelope = await gateway.storage.chatTurnCapabilityProfiles.inspectByTurn(turnId);
        if (envelope.state !== "available" || !envelope.profile) {
          return envelope;
        }
        const profile = envelope.profile;
        if (
          profile.profileId !== scope.profileId ||
          profile.hashes.profileHash !== scope.profileHash ||
          profile.identity.turnId !== scope.turnId ||
          profile.identity.sessionId !== scope.sessionId ||
          profile.identity.workspaceId !== scope.workspaceId
        ) {
          throw new NotFoundError({ entity: "Chat turn capability profile", id: turnId });
        }
        const snapshot = await gateway.storage.routedContextSnapshots.findByTurn(turnId);
        if (!snapshot) {
          return envelope;
        }
        if (
          snapshot.turnId !== turnId ||
          snapshot.sessionId !== sessionId ||
          snapshot.workspaceId !== workspaceId ||
          snapshot.capabilityProfileId !== profile.profileId ||
          snapshot.capabilityProfileHash !== profile.hashes.profileHash
        ) {
          throw new NotFoundError({ entity: "Chat routed context snapshot", id: turnId });
        }
        const traceBinding = trace.routing.routedContext;
        if (
          !traceBinding ||
          traceBinding.snapshotId !== snapshot.snapshotId ||
          traceBinding.snapshotHash !== snapshot.snapshotHash ||
          traceBinding.sourceRequestHash !== snapshot.sourceRequestHash ||
          traceBinding.contentHash !== snapshot.contentHash
        ) {
          throw new NotFoundError({ entity: "Chat routed context snapshot", id: turnId });
        }
        const routedContext = await gateway.storage.routedContextSnapshots.inspectByTurn(turnId);
        if (
          !routedContext ||
          routedContext.snapshotId !== snapshot.snapshotId ||
          routedContext.snapshotHash !== snapshot.snapshotHash
        ) {
          throw new NotFoundError({ entity: "Chat routed context snapshot", id: turnId });
        }
        const contextToolNames = new Set<string>(CHAT_ROUTED_CONTEXT_TOOL_NAMES);
        const snapshotHasEligibleText = (snapshot.entries ?? []).some(
          (entry) =>
            (entry.disposition === "included" || entry.disposition === "truncated") &&
            entry.admittedBytes > 0 &&
            entry.admittedText.length > 0,
        );
        const availableContextTools = snapshotHasEligibleText
          ? profile.selection.tools
              .map((tool) => tool.canonicalName)
              .filter((toolName) => contextToolNames.has(toolName))
          : [];
        return { ...envelope, routedContext, availableContextTools };
      })();
    },
    getTurnContextManifestForSession: (sessionId, turnId) =>
      chatMessageRouteRuntime.getTurnContextManifestForSession(chatMessageRouteRuntimeHost, sessionId, turnId),
    listChatMessagePage: (input) =>
      chatHistoryService.listChatMessagePage(
        {
          storage: gateway.storage,
          ensureChatMessageProjection: (sessionId) => gateway.ensureChatMessageProjection(sessionId),
        },
        input,
      ),
    listChatMessages: (sessionId, limit, cursor) => gateway.listChatMessages(sessionId, limit, cursor),
    readChatHistoryWindow: (anchor, limit) =>
      chatHistoryService.readChatHistoryWindow(
        {
          storage: gateway.storage,
          ensureChatMessageProjection: (sessionId) => gateway.ensureChatMessageProjection(sessionId),
        },
        anchor,
        limit,
      ),
    readChatHistoryContinuation: (input) =>
      chatHistoryService.readChatHistoryContinuation(
        {
          storage: gateway.storage,
          ensureChatMessageProjection: (sessionId) => gateway.ensureChatMessageProjection(sessionId),
        },
        input,
      ),
    resumeAgentChatTurnStream: (sessionId, turnId, sinceEventId, signal?: AbortSignal) =>
      gateway.chatTurnRuntime.resumeAgentChatTurnStream(sessionId, turnId, sinceEventId, { abortSignal: signal }),
    retryChatTurn: (sessionId, turnId, input, authenticatedOperator) =>
      gateway.chatTurnRuntime.retryChatTurn(
        sessionId,
        turnId,
        input,
        authenticatedOperator ? { authenticatedOperator } : undefined,
      ),
    retryChatTurnStream: (
      sessionId,
      turnId,
      input,
      signal?: AbortSignal,
      mutationLifecycle?: ChatStreamMutationLifecycle,
      authenticatedOperator?,
    ) =>
      gateway.chatTurnRuntime.retryChatTurnStream(sessionId, turnId, input, {
        abortSignal: signal,
        ...(mutationLifecycle ? { mutationLifecycle } : {}),
        ...(authenticatedOperator ? { authenticatedOperator } : {}),
      }),
    routePreflight: (sessionId, input) => gateway.chatTurnRuntime.routePreflight(sessionId, input),
    selectChatBranchTurn: (sessionId, turnId) =>
      chatMessageRouteRuntime.selectChatBranchTurn(chatMessageRouteRuntimeHost, sessionId, turnId),
  };

  return {
    agents,
    chatAttachments,
    chatCompactionBreakerActions: gateway.chatCompactionBreakerActionService,
    chatDelegate,
    chatMessages,
    // HX-411 controller-protocol owner. Sourced from the same storage-keyed
    // memoized runtime owner the gateway uses for turn admission, so the control
    // routes and the canonical send path share one durable authority — projected
    // down to the controller-protocol subset so the route layer never reaches the
    // owner's turn-admission, request-lease, or durable-binding methods.
    sessionControl: createSessionControlRouteService(getSessionControlRuntimeOwner(gateway.storage)),
    chatProjects: {
      archiveChatProject: (projectId, expectedRevision) =>
        gateway.chatProjectService.archiveChatProject(projectId, expectedRevision),
      createChatProject: async (input) => {
        const { citadelId, ...projectInput } = input;
        const scope = await resolveChatRuntimeScope(gateway, {
          citadelId,
          workspaceId: projectInput.workspaceId,
        });
        return gateway.chatProjectService.createChatProject({ ...projectInput, workspaceId: scope.workspaceId });
      },
      hardDeleteChatProject: (projectId, expectedRevision) =>
        gateway.chatProjectService.hardDeleteChatProject(projectId, expectedRevision),
      importChatProject: async (input) => {
        const { citadelId, ...projectInput } = input;
        const scope = await resolveChatRuntimeScope(gateway, {
          citadelId,
          workspaceId: projectInput.workspaceId,
        });
        return gateway.chatProjectService.importChatProject({ ...projectInput, workspaceId: scope.workspaceId });
      },
      listChatProjects: async (view, limit, workspaceId, citadelId) => {
        const scope = await resolveChatRuntimeScope(gateway, { citadelId, workspaceId });
        return gateway.chatProjectService.listChatProjects(view, limit, scope.workspaceId);
      },
      restoreChatProject: (projectId, expectedRevision) =>
        gateway.chatProjectService.restoreChatProject(projectId, expectedRevision),
      updateChatProject: async (projectId, input, expectedRevision) => {
        const { citadelId, ...projectInput } = input;
        const scope = await resolveChatRuntimeScope(gateway, {
          citadelId,
          projectId,
          workspaceId: projectInput.workspaceId,
        });
        return gateway.chatProjectService.updateChatProject(
          projectId,
          {
            ...projectInput,
            workspaceId: scope.workspaceId,
          },
          expectedRevision,
        );
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
        listChatSessionLearnedMemory: async (sessionId, limit) =>
          gateway.memoryLifecycleService.listSessionLearnedMemory(sessionId, limit),
        rebuildChatSessionLearnedMemory: (sessionId) =>
          gateway.memoryLifecycleService.rebuildSessionLearnedMemory(sessionId),
        updateChatSessionLearnedMemory: async (sessionId, itemId, input) =>
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
        getChatResearchRun: async (sessionId, runId) => gateway.researchService.getRun(sessionId, runId),
        runChatResearch: (sessionId, input) => gateway.runChatResearch(sessionId, input),
      },
      specialists: {
        createChatSessionSpecialistCandidate: (sessionId, input) =>
          gateway.createChatSessionSpecialistCandidate(sessionId, input),
        listChatSessionSpecialistCandidates: async (sessionId, limit = 200) => {
          await gateway.getSession(sessionId);
          return {
            items: await gateway.storage.chatSpecialistCandidates.listBySession(sessionId, limit),
          };
        },
        updateChatSessionSpecialistCandidate: async (sessionId, candidateId, input) => {
          await gateway.getSession(sessionId);
          const current = await gateway.storage.chatSpecialistCandidates.get(candidateId);
          if (current.sessionId !== sessionId) {
            throw new Error("Specialist candidate does not belong to this session.");
          }
          return await gateway.storage.chatSpecialistCandidates.patch(candidateId, input);
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
        clearChatSessionGoal: (sessionId, expectedRevision) =>
          handleChatGoalClearRequest({ sessionId, expectedRevision, chatSessionMeta: gateway.storage.chatSessionMeta }),
      },
    },
    chatTools,
  };
}

async function resolveChatRuntimeScope(
  gateway: GatewayRouteCompositionPort,
  source: Parameters<typeof resolveEffectiveRuntimeScopeFromStorage>[1],
): Promise<Awaited<ReturnType<typeof resolveEffectiveRuntimeScopeFromStorage>>> {
  return await resolveEffectiveRuntimeScopeFromStorage(
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
