import { createAddonsRoutePort } from "./addons-route-service.js";
import { createCostsRoutePort } from "./costs-route-service.js";
import { createDaemonRouteService } from "./daemon-route-service.js";
import { createPersonalOpsRouteService } from "./personal-ops-route-service.js";
import { PersonalOpsService } from "./personal-ops-service.js";
import * as settingsAuthService from "./settings-auth-service.js";
import type { GatewayRouteCompositionPort, RouteDependencyDomain } from "./gateway-route-composition-port.js";
import type {
  CommunicationsMailDraftRecovery,
  CommunicationsMailDraftStore,
} from "./communications-dashboard-service.js";
import { COMMUNICATIONS_MAIL_SEND_APPROVAL_KIND } from "./communications-approval-effect-service.js";
import { buildCitadelWardRequestVaultForGateway } from "./gateway-route-composition-integrations.js";
import {
  createSettingsRuntimeDependenciesForGateway,
  createWorkspacesRoutePortForGateway,
} from "./gateway-route-composition-shared.js";

export function composeSystemRouteDependencies(
  gateway: GatewayRouteCompositionPort,
): RouteDependencyDomain<
  | "a2a"
  | "addons"
  | "assembly"
  | "autonomyControl"
  | "costs"
  | "inbox"
  | "media"
  | "personalOps"
  | "settings"
  | "tasks"
  | "voice"
  | "workspaces"
> {
  // Capture each route owner once; retain its receiver when calling methods.
  const {
    storage,
    assemblyService,
    autonomyControlService,
    personalityCatalogService,
    mediaVoiceService,
    taskLifecycleService,
  } = gateway;
  const settingsRuntimeDeps = createSettingsRuntimeDependenciesForGateway(gateway);

  return {
    a2a: {
      config: gateway.config,
      storage,
      tasks: taskLifecycleService,
      createChatSession: (input) => gateway.createChatSession(input),
      chatTurnRuntime: gateway.chatTurnRuntime,
      mutationIdempotencyStore: gateway.mutationIdempotencyStore,
      evidenceEnvelopeService: gateway.evidenceEnvelopeService,
      createApproval: (input) => gateway.createApproval(input),
      citadelWardRequests: buildCitadelWardRequestVaultForGateway(gateway),
    },
    addons: createAddonsRoutePort({
      addonsService: gateway.addonsService,
      slotService: gateway.addonSlotService,
      publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload ?? {}),
      recordDevDiagnostic: (input) => gateway.recordDevDiagnostic(input),
    }),
    assembly: {
      createAssemblyRun: (input) => assemblyService.createRun(input),
      getAssemblyRunDetail: (runId) => assemblyService.getRunDetail(runId),
      listAssemblyReputations: (limit) => assemblyService.listReputations(limit),
      listAssemblyRuns: (limit) => assemblyService.listRuns(limit),
    },
    autonomyControl: {
      getStatus: (recentLimit) => autonomyControlService.getStatus(recentLimit),
      revertAutonomousChangesSince: (sinceIso, opts) =>
        autonomyControlService.revertAutonomousChangesSince(sinceIso, opts),
      setKillSwitch: (disabled, expectedRevision) => autonomyControlService.setKillSwitch(disabled, expectedRevision),
    },
    costs: createCostsRoutePort({
      storage,
    }),
    inbox: {
      storage,
      memory: gateway.memoryLifecycleService,
      memoryProposalsEnabled: () => gateway.isFeatureEnabled("memoryLifecycleAdminV1Enabled"),
      improvement: gateway.improvementService,
      durable: gateway.durableOperatorService,
      runtimeHealth: {
        getDatabaseHealthSnapshot: () => gateway.databaseCutoverService.getHealthSnapshot(),
        getDaemonStatus: () => createDaemonRouteService({ systemSettings: storage.systemSettings }).getDaemonStatus(),
        inspectLatestBackupTrust: () => gateway.backupRetentionService.inspectLatestBackupTrust(),
        listBackups: (limit) => gateway.backupRetentionService.listBackups(limit),
      },
    },
    media: mediaVoiceService,
    personalOps: createPersonalOpsRouteService(new PersonalOpsService(storage.personalOps)),
    settings: {
      createPersonality: (input) => personalityCatalogService.createPersonality(input),
      deletePersonality: (id, expectedRevision) => personalityCatalogService.deletePersonality(id, expectedRevision),
      getAuthRuntimeSettings: () => {
        gateway.readSettingsRevision();
        return settingsAuthService.getAuthRuntimeSettings(settingsRuntimeDeps);
      },
      getPersonalityCatalog: () => personalityCatalogService.getCatalog(),
      getSettings: async () => await settingsAuthService.getSettings(settingsRuntimeDeps),
      setDefaultPersonality: (id, expectedRevision) =>
        personalityCatalogService.setDefaultPersonality(id, expectedRevision),
      updatePersonality: (id, input) => personalityCatalogService.updatePersonality(id, input),
      updateSettings: (input) => gateway.updateSettings(input),
    },
    tasks: taskLifecycleService,
    voice: mediaVoiceService,
    workspaces: createWorkspacesRoutePortForGateway(gateway),
  };
}

/** The durable mail draft store the communications routes persist drafts through. */
export function composeCommunicationsMailDraftStore(
  gateway: GatewayRouteCompositionPort,
): CommunicationsMailDraftStore {
  return gateway.storage.mailDrafts;
}

/** The approval lookup and audit stream an interrupted-draft release checks and records through. */
export function composeCommunicationsMailDraftRecovery(
  gateway: GatewayRouteCompositionPort,
): CommunicationsMailDraftRecovery {
  const { approvals, audit } = gateway.storage;
  return {
    findMailSendApprovals: (draftId) =>
      approvals.listByKindAndPayloadString(COMMUNICATIONS_MAIL_SEND_APPROVAL_KIND, "draftId", draftId),
    recordAudit: (event) => audit.append("approvals", event),
  };
}
