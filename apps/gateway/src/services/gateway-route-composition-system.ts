import { createAddonsRoutePort } from "./addons-route-service.js";
import { createCostsRoutePort } from "./costs-route-service.js";
import * as settingsAuthService from "./settings-auth-service.js";
import type { GatewayRouteCompositionPort, RouteDependencyDomain } from "./gateway-route-composition-port.js";
import {
  createSettingsRuntimeDependenciesForGateway,
  createWorkspacesRoutePortForGateway,
} from "./gateway-route-composition-shared.js";

export function composeSystemRouteDependencies(
  gateway: GatewayRouteCompositionPort,
): RouteDependencyDomain<"addons" | "assembly" | "costs" | "media" | "settings" | "tasks" | "voice" | "workspaces"> {
  const settingsRuntimeDeps = createSettingsRuntimeDependenciesForGateway(gateway);

  return {
    addons: createAddonsRoutePort({
      addonsService: gateway.addonsService,
      publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload ?? {}),
      recordDevDiagnostic: (input) => gateway.recordDevDiagnostic(input),
    }),
    assembly: {
      createAssemblyRun: (input) => gateway.assemblyService.createRun(input),
      getAssemblyRunDetail: (runId) => gateway.assemblyService.getRunDetail(runId),
      listAssemblyReputations: (limit) => gateway.assemblyService.listReputations(limit),
      listAssemblyRuns: (limit) => gateway.assemblyService.listRuns(limit),
    },
    costs: createCostsRoutePort({
      storage: gateway.storage,
    }),
    media: gateway.mediaVoiceService,
    settings: {
      createPersonality: (input) => gateway.personalityCatalogService.createPersonality(input),
      deletePersonality: (id) => gateway.personalityCatalogService.deletePersonality(id),
      getAuthRuntimeSettings: () => settingsAuthService.getAuthRuntimeSettings(settingsRuntimeDeps),
      getPersonalityCatalog: () => gateway.personalityCatalogService.getCatalog(),
      getSettings: () => settingsAuthService.getSettings(settingsRuntimeDeps),
      setDefaultPersonality: (id) => gateway.personalityCatalogService.setDefaultPersonality(id),
      updatePersonality: (id, input) => gateway.personalityCatalogService.updatePersonality(id, input),
      updateSettings: (input) => settingsAuthService.updateSettings(settingsRuntimeDeps, input),
    },
    tasks: gateway.taskLifecycleService,
    voice: gateway.mediaVoiceService,
    workspaces: createWorkspacesRoutePortForGateway(gateway),
  };
}
