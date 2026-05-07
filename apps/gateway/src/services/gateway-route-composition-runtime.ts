import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import { createCronRoutePort } from "./cron-route-service.js";
import { createDashboardRoutePort } from "./dashboard-route-service.js";
import { createFilesRoutePort } from "./files-route-service.js";
import { createHooksRoutePort } from "./hooks-route-service.js";
import { createLlamaCppRoutePort } from "./llama-cpp-route-service.js";
import { createMeshRoutePort } from "./mesh-route-service.js";
import { createNpuRoutePort } from "./npu-route-service.js";
import { createSessionsListRoutePort } from "./sessions-list-route-service.js";
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
  | "llamaCpp"
  | "mesh"
  | "npu"
  | "onboarding"
  | "orchestration"
  | "promptPacks"
  | "realtimeEvents"
  | "runtimeLifecycle"
  | "sessionsList"
> {
  const settingsRuntimeDeps = createSettingsRuntimeDependenciesForGateway(gateway);
  const settingsAuthDeps = createSettingsAuthRuntimeDependenciesForGateway(gateway);
  const workspaces = createWorkspacesRoutePortForGateway(gateway);
  const workflowRecipes = new WorkflowRecipeService({
    listSkills: () => gateway.listSkills(),
    listToolNames: () => {
      const catalog = gateway.policyEngine?.listCatalog?.() ?? [];
      return catalog.map((entry: { name?: string; toolName?: string; id?: string }) =>
        String(entry.name ?? entry.toolName ?? entry.id ?? ""),
      );
    },
    createOrchestrationPlan: (plan) => gateway.createOrchestrationPlan(plan),
  });
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
    cron: createCronRoutePort(gateway.cronAutomationService),
    dashboard: createDashboardRoutePort({
      backupRetentionService: gateway.backupRetentionService,
      isFeatureEnabled: (flag) => gateway.isFeatureEnabled(flag as keyof RuntimeSettings["features"]),
      memoryLifecycleService: gateway.memoryLifecycleService,
      operatorSummaryCache: gateway.operatorSummaryCache,
      realtimeEventService: gateway.realtimeEventService,
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
    llamaCpp: createLlamaCppRoutePort({
      llamaCppRuntime: gateway.llamaCppRuntime,
      publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload),
    }),
    mesh: createMeshRoutePort({
      meshService: gateway.meshService,
      publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload),
    }),
    npu: createNpuRoutePort({
      npuSidecar: gateway.npuSidecar,
      publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload),
    }),
    onboarding: {
      bootstrapOnboarding: (input) => onboardingStateService.bootstrapOnboarding(gateway, input),
      getOnboardingStartupState: () => onboardingStateService.getOnboardingStartupState(gateway),
      getOnboardingState: () => onboardingStateService.getOnboardingState(gateway),
      markOnboardingComplete: (completedBy) => onboardingStateService.markOnboardingComplete(gateway, completedBy),
    },
    orchestration: {
      createOrchestrationPlan: (plan) => gateway.createOrchestrationPlan(plan),
      createPlanFromRecipe: (input) => workflowRecipes.createPlanFromRecipe(input),
      listRecipeTemplates: () => ({ items: workflowRecipes.listTemplates() }),
      previewRecipe: (input) => workflowRecipes.previewRecipe(input),
      runOrchestrationPlan: (planId) => gateway.runOrchestrationPlan(planId),
      approvePhase: (runId, phaseId, approvedBy, costIncrementUsd) =>
        gateway.approvePhase(runId, phaseId, approvedBy, costIncrementUsd),
      getRun: (runId) => gateway.getRun(runId),
      listRunCheckpoints: (runId) => gateway.listRunCheckpoints(runId),
      listRunContexts: (runId) => gateway.memoryLifecycleService.listRunContexts(runId),
    },
    promptPacks: gateway.promptPackService,
    realtimeEvents: gateway.realtimeEventService,
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
  };
}
