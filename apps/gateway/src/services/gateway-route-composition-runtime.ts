import { ModelComparisonRunRepository } from "@goatcitadel/storage";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import { createCronRoutePort } from "./cron-route-service.js";
import { createDashboardRoutePort } from "./dashboard-route-service.js";
import { createFilesRoutePort } from "./files-route-service.js";
import { createHooksRoutePort } from "./hooks-route-service.js";
import { createLocalAiRouteService } from "./local-ai-route-service.js";
import { createLlamaCppRoutePort } from "./llama-cpp-route-service.js";
import { createMeshRoutePort } from "./mesh-route-service.js";
import { createMobileRoutePort } from "./mobile-route-service.js";
import { ModelComparisonService } from "./model-comparison-service.js";
import { createNpuRoutePort } from "./npu-route-service.js";
import { ResearchSearchBrokerService } from "./research-search-broker-service.js";
import { createSessionsListRoutePort } from "./sessions-list-route-service.js";
import { UpdateScoutService } from "./update-scout-service.js";
import { WorkflowRecipeService } from "./workflow-recipe-service.js";
import * as onboardingStateService from "./onboarding-state-service.js";
import * as settingsAuthService from "./settings-auth-service.js";
import { serializePathWithinRoot } from "./security-utils.js";
import type { GatewayRouteCompositionPort, RouteDependencyDomain } from "./gateway-route-composition-port.js";
import {
  createSettingsAuthRuntimeDependenciesForGateway,
  createSettingsRuntimeDependenciesForGateway,
  createWorkspacesRoutePortForGateway,
  getLlmConfigForGateway,
  getProviderSecretStatusForGateway,
} from "./gateway-route-composition-shared.js";

export function composeRuntimeAdminRouteDependencies(
  gateway: GatewayRouteCompositionPort,
): RouteDependencyDomain<
  | "authAdmin"
  | "approvals"
  | "citadels"
  | "masonInterpret"
  | "cron"
  | "dashboard"
  | "daemon"
  | "devDiagnostics"
  | "devVerification"
  | "durable"
  | "files"
  | "gatewayEvents"
  | "health"
  | "hooks"
  | "localAi"
  | "llamaCpp"
  | "mesh"
  | "mobile"
  | "modelComparisons"
  | "npu"
  | "onboarding"
  | "orchestration"
  | "promptPacks"
  | "realtimeEvents"
  | "researchSearch"
  | "runtimeLifecycle"
  | "sessionsList"
  | "updateScout"
> {
  const settingsRuntimeDeps = createSettingsRuntimeDependenciesForGateway(gateway);
  const settingsAuthDeps = createSettingsAuthRuntimeDependenciesForGateway(gateway);
  const workspaces = createWorkspacesRoutePortForGateway(gateway);
  const onboardingStateHost = gateway.onboardingStateHost;
  const workflowRecipes = new WorkflowRecipeService({
    listSkills: () => gateway.listSkills(),
    listToolNames: () => {
      const catalog = gateway.policyEngine?.listCatalog?.() ?? [];
      return catalog.map((entry: { name?: string; toolName?: string; id?: string }) =>
        String(entry.name ?? entry.toolName ?? entry.id ?? ""),
      );
    },
    createOrchestrationPlan: (plan, policyContext) => gateway.createOrchestrationPlan(plan, policyContext),
  });
  const researchSearch = new ResearchSearchBrokerService();
  const updateScout = new UpdateScoutService();
  const warnedOutsideRootPathFingerprints = new Set<string>();

  return {
    authAdmin: {
      getAuthCredentialPlan: () => settingsAuthService.getAuthRuntimeSettings(settingsRuntimeDeps).plan,
      createDeviceAccessRequest: (input, metadata) =>
        settingsAuthService.createDeviceAccessRequest(settingsAuthDeps, input, metadata),
      exchangeCompanionSessionFromDeviceGrant: (grantId, input) =>
        settingsAuthService.exchangeCompanionSessionFromDeviceGrant(settingsAuthDeps, grantId, input),
      getCompanionSessionInfo: (sessionId) => settingsAuthService.getCompanionSessionInfo(settingsAuthDeps, sessionId),
      getCompanionSessionRecord: (sessionId) =>
        settingsAuthService.getCompanionSessionRecord(settingsAuthDeps, sessionId),
      getDeviceAccessRequestStatus: (requestId, secret) =>
        settingsAuthService.getDeviceAccessRequestStatus(settingsAuthDeps, requestId, secret),
      getRetentionPolicy: () => gateway.backupRetentionService.getRetentionPolicy(),
      listBackups: (limit) => gateway.backupRetentionService.listBackups(limit),
      listCompanionAuditEvents: (input) => settingsAuthService.listCompanionAuditEvents(settingsAuthDeps, input),
      listCompanionSessions: (input) => settingsAuthService.listCompanionSessions(settingsAuthDeps, input),
      listDeviceAccessGrants: () => settingsAuthService.listDeviceAccessGrants(settingsAuthDeps),
      pruneRetention: (input) => gateway.backupRetentionService.pruneRetention(input),
      resolveGatewayInstallToken: (input) => gateway.resolveGatewayInstallToken(input),
      revokeCompanionSession: (sessionId, actorId) =>
        settingsAuthService.revokeCompanionSession(settingsAuthDeps, sessionId, actorId),
      revokeDeviceAccessGrant: (grantId, actorId) =>
        settingsAuthService.revokeDeviceAccessGrant(settingsAuthDeps, grantId, actorId),
      rotateCompanionSession: (input) => settingsAuthService.rotateCompanionSession(settingsAuthDeps, input),
      runDatabaseCutover: (input) => gateway.runDatabaseCutover(input),
      updateRetentionPolicy: (patch) => gateway.backupRetentionService.updateRetentionPolicy(patch),
      createBackup: (input) => gateway.backupRetentionService.createBackup(input),
      verifyBackup: (input) => gateway.verifyBackup(input),
      verifyDatabaseCutover: (input) => gateway.verifyDatabaseCutover(input),
    },
    approvals: gateway.approvalRuntime,
    citadels: gateway.storage.citadels,
    masonInterpret: async (prompt: string): Promise<string> => {
      // Best-effort extraction. If no model/provider is configured, chatCompletions
      // throws — we swallow it so the Mason degrades to the structured answers path.
      try {
        const response = await gateway.llmService.chatCompletions({
          messages: [{ role: "user", content: prompt }],
        });
        const content = response.choices?.[0]?.message?.content;
        return typeof content === "string" ? content : "";
      } catch {
        return "";
      }
    },
    cron: createCronRoutePort(gateway.cronAutomationService),
    dashboard: createDashboardRoutePort({
      backupRetentionService: gateway.backupRetentionService,
      durableOperatorService: gateway.durableOperatorService,
      isFeatureEnabled: (flag) => gateway.isFeatureEnabled(flag as keyof RuntimeSettings["features"]),
      memoryLifecycleService: gateway.memoryLifecycleService,
      operatorSummaryCache: gateway.operatorSummaryCache,
      promptPackService: gateway.promptPackService,
      realtimeEventService: gateway.realtimeEventService,
      rootDir: gateway.config.rootDir,
      runtimeLifecycleReadService: gateway.runtimeLifecycleReadService,
      storage: gateway.storage,
    }),
    daemon: {
      systemSettings: gateway.storage.systemSettings,
    },
    devDiagnostics: {
      isDevDiagnosticsEnabled: () => gateway.devDiagnostics.isEnabled(),
      listDevDiagnostics: (input) => gateway.devDiagnostics.list(input),
      subscribeDevDiagnostics: (listener) => gateway.devDiagnostics.subscribe(listener),
    },
    devVerification: {
      storage: gateway.storage,
      createApproval: (input) => gateway.createApproval(input),
      createChatCompletion: (input) => gateway.createChatCompletion(input),
      createChatCompletionStream: (input) => gateway.createChatCompletionStream(input),
      createChatSession: (input) => gateway.createChatSession(input),
      createWorkspace: (input) => workspaces.createWorkspace(input),
      getLlmConfig: () => getLlmConfigForGateway(gateway),
      getProviderSecretStatus: (providerId) => getProviderSecretStatusForGateway(gateway, providerId),
      getRealtimeEventSequenceBounds: () => gateway.realtimeEventService.getRealtimeEventSequenceBounds(),
      isDevDiagnosticsEnabled: () => gateway.devDiagnostics.isEnabled(),
      listDevDiagnostics: (input) => gateway.devDiagnostics.list(input),
      publishRealtime: (eventType, source, payload, options) =>
        gateway.publishRealtime(eventType, source, payload, options),
    },
    durable: gateway.durableOperatorService,
    files: createFilesRoutePort({
      rootDir: gateway.config.rootDir,
      workspaceDir: gateway.config.assistant.workspaceDir,
      writeJailRoots: gateway.config.toolPolicy.sandbox.writeJailRoots,
      readOnlyRoots: gateway.config.toolPolicy.sandbox.readOnlyRoots,
      serializeRootPath: (fullPath) =>
        serializePathWithinRoot(gateway.config.rootDir, fullPath, warnedOutsideRootPathFingerprints, (warning) => {
          gateway.recordDevDiagnostic({
            level: "warn",
            category: "security",
            event: "filesystem.outside_root_path_redacted",
            message: "Refused to expose a filesystem path outside the workspace root.",
            context: {
              fingerprint: warning.fingerprint,
              baseName: warning.baseName,
            },
          });
        }),
      publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload ?? {}),
    }),
    gatewayEvents: {
      ingestEvent: (idempotencyKey, payload) => gateway.ingestEvent(idempotencyKey, payload),
    },
    health: {
      getDatabaseHealthSnapshot: () => gateway.databaseCutoverService.getHealthSnapshot(),
    },
    hooks: createHooksRoutePort({
      hooksService: gateway.hooksService,
      normalizeWorkspaceId: (workspaceId) => gateway.normalizeWorkspaceId(workspaceId),
    }),
    localAi: createLocalAiRouteService({
      createApproval: (input) => gateway.createApproval(input),
    }),
    llamaCpp: createLlamaCppRoutePort({
      llamaCppRuntime: gateway.llamaCppRuntime,
      publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload),
    }),
    mesh: createMeshRoutePort({
      meshService: gateway.meshService,
      publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload),
    }),
    mobile: createMobileRoutePort({
      storage: gateway.storage,
      publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload),
    }),
    modelComparisons: new ModelComparisonService({
      repository: new ModelComparisonRunRepository(gateway.storage.db),
      listPromptPackTests: (packId, limit) => gateway.promptPackService.listPromptPackTests(packId, limit),
      listPromptPackRunsByTest: (testId, limit) => gateway.storage.promptPackRuns.listByTest(testId, limit),
    }),
    npu: createNpuRoutePort({
      npuSidecar: gateway.npuSidecar,
      publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload),
    }),
    onboarding: {
      bootstrapOnboarding: (input) => onboardingStateService.bootstrapOnboarding(onboardingStateHost, input),
      getOnboardingStartupState: () => onboardingStateService.getOnboardingStartupState(onboardingStateHost),
      getOnboardingState: () => onboardingStateService.getOnboardingState(onboardingStateHost),
      markOnboardingComplete: (completedBy) =>
        onboardingStateService.markOnboardingComplete(onboardingStateHost, completedBy),
    },
    orchestration: {
      createOrchestrationPlan: (plan, policyContext) => gateway.createOrchestrationPlan(plan, policyContext),
      createPlanFromRecipe: (input, policyContext) => workflowRecipes.createPlanFromRecipe(input, policyContext),
      draftAutomationRecipe: (input) => workflowRecipes.draftAutomationRecipe(input),
      exportActivepiecesTemplate: (input) => workflowRecipes.exportActivepiecesTemplate(input),
      exportN8nTemplate: (input) => workflowRecipes.exportN8nTemplate(input),
      listRecipeTemplates: () => ({ items: workflowRecipes.listTemplates() }),
      previewRecipe: (input) => workflowRecipes.previewRecipe(input),
      runOrchestrationPlan: (planId, policyContext) => gateway.runOrchestrationPlan(planId, policyContext),
      cancelOrchestrationRun: (runId, actorId, workspaceId) =>
        gateway.cancelOrchestrationRun(runId, actorId, workspaceId),
      approvePhase: (runId, phaseId, approvedBy, costIncrementUsd, workspaceId) =>
        gateway.approvePhase(runId, phaseId, approvedBy, costIncrementUsd, workspaceId),
      getRun: (runId, workspaceId) => gateway.getRun(runId, workspaceId),
      listRunCheckpoints: (runId, workspaceId) => gateway.listRunCheckpoints(runId, workspaceId),
      listRunContexts: (runId) => gateway.memoryLifecycleService.listRunContexts(runId),
    },
    promptPacks: gateway.promptPackService,
    realtimeEvents: gateway.realtimeEventService,
    researchSearch: {
      search: (input) => researchSearch.search(input),
    },
    runtimeLifecycle: {
      getRuntimeLifecycle: (input) => gateway.runtimeLifecycleReadService.getRuntimeLifecycle(input),
      getTranscript: (sessionId) => gateway.getTranscript(sessionId),
      listSessionTimeline: (sessionId, limit) => gateway.listSessionTimeline(sessionId, limit),
    },
    sessionsList: createSessionsListRoutePort({
      storage: gateway.storage,
      getSessionSummary: (sessionId) => gateway.getSessionSummary(sessionId),
      listSessionTimeline: (sessionId, limit) => gateway.listSessionTimeline(sessionId, limit),
    }),
    updateScout: {
      scout: (input) => updateScout.scout(input),
    },
  };
}
