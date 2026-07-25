import { PersonalOpsStorageRepository } from "@goatcitadel/storage";
import { createAddonsRoutePort } from "./addons-route-service.js";
import { createCostsRoutePort } from "./costs-route-service.js";
import { createPersonalOpsRouteService } from "./personal-ops-route-service.js";
import { PersonalOpsService } from "./personal-ops-service.js";
import * as settingsAuthService from "./settings-auth-service.js";
import type { GatewayRouteCompositionPort, RouteDependencyDomain } from "./gateway-route-composition-port.js";
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
  | "media"
  | "personalOps"
  | "settings"
  | "tasks"
  | "voice"
  | "workspaces"
> {
  const settingsRuntimeDeps = createSettingsRuntimeDependenciesForGateway(gateway);

  return {
    a2a: {
      config: gateway.config,
      storage: gateway.storage,
      tasks: gateway.taskLifecycleService,
      createChatSession: (input) => gateway.createChatSession(input),
      chatTurnRuntime: gateway.chatTurnRuntime,
      mutationIdempotencyStore: gateway.mutationIdempotencyStore,
      evidenceEnvelopeService: gateway.evidenceEnvelopeService,
    },
    addons: createAddonsRoutePort({
      addonsService: gateway.addonsService,
      slotService: gateway.addonSlotService,
      publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload ?? {}),
      recordDevDiagnostic: (input) => gateway.recordDevDiagnostic(input),
    }),
    assembly: {
      createAssemblyRun: (input) => gateway.assemblyService.createRun(input),
      getAssemblyRunDetail: (runId) => gateway.assemblyService.getRunDetail(runId),
      listAssemblyReputations: (limit) => gateway.assemblyService.listReputations(limit),
      listAssemblyRuns: (limit) => gateway.assemblyService.listRuns(limit),
    },
    autonomyControl: {
      getStatus: (recentLimit) => gateway.autonomyControlService.getStatus(recentLimit),
      revertAutonomousChangesSince: (sinceIso, opts) =>
        gateway.autonomyControlService.revertAutonomousChangesSince(sinceIso, opts),
      setKillSwitch: (disabled, expectedRevision) =>
        gateway.autonomyControlService.setKillSwitch(disabled, expectedRevision),
    },
    costs: createCostsRoutePort({
      storage: gateway.storage,
    }),
    media: gateway.mediaVoiceService,
    personalOps: createPersonalOpsRouteService(
      new PersonalOpsService(new PersonalOpsStorageRepository(gateway.storage.db)),
    ),
    settings: {
      createPersonality: (input) => gateway.personalityCatalogService.createPersonality(input),
      deletePersonality: (id) => gateway.personalityCatalogService.deletePersonality(id),
      getAuthRuntimeSettings: () => {
        gateway.readSettingsRevision();
        return settingsAuthService.getAuthRuntimeSettings(settingsRuntimeDeps);
      },
      getPersonalityCatalog: () => gateway.personalityCatalogService.getCatalog(),
      getSettings: () => settingsAuthService.getSettings(settingsRuntimeDeps),
      setDefaultPersonality: (id) => gateway.personalityCatalogService.setDefaultPersonality(id),
      updatePersonality: (id, input) => gateway.personalityCatalogService.updatePersonality(id, input),
      updateSettings: (input) => gateway.updateSettings(input),
    },
    tasks: gateway.taskLifecycleService,
    voice: gateway.mediaVoiceService,
    workspaces: createWorkspacesRoutePortForGateway(gateway),
  };
}
