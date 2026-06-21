import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const integrationRouteMethods = [
  "approveDiscordPairing",
  "createIntegrationConnection",
  "deleteIntegrationConnection",
  "getIntegrationConnection",
  "getIntegrationFormSchema",
  "getExternalConnectorAction",
  "getExternalConnectorService",
  "installIntegrationPlugin",
  "invokeIntegrationConnectionAction",
  "listExternalConnectorServices",
  "listExternalConnectorSources",
  "listExternalSideEffectRuns",
  "listDiscordPairings",
  "listIntegrationCatalog",
  "listIntegrationConnections",
  "listIntegrationPlugins",
  "reconnectDiscordRuntime",
  "revokeDiscordPairing",
  "runIntegrationConnectionDiagnostics",
  "stageExternalConnectorAction",
  "updateExternalConnectorReviewState",
  "setIntegrationPluginEnabled",
  "updateIntegrationConnection",
] as const;

export type IntegrationRouteMethod = (typeof integrationRouteMethods)[number];
export type IntegrationRoutePort = RoutePort<IntegrationRouteMethod>;
export type IntegrationRouteService = RouteService<IntegrationRouteMethod>;
export type IntegrationChannelPort = IntegrationRoutePort;

export function createIntegrationRoutePort(port: IntegrationChannelPort): IntegrationRoutePort {
  return {
    approveDiscordPairing: (...args) => port.approveDiscordPairing(...args),
    createIntegrationConnection: (...args) => port.createIntegrationConnection(...args),
    deleteIntegrationConnection: (...args) => port.deleteIntegrationConnection(...args),
    getIntegrationConnection: (...args) => port.getIntegrationConnection(...args),
    getIntegrationFormSchema: (...args) => port.getIntegrationFormSchema(...args),
    getExternalConnectorAction: (...args) => port.getExternalConnectorAction(...args),
    getExternalConnectorService: (...args) => port.getExternalConnectorService(...args),
    installIntegrationPlugin: (...args) => port.installIntegrationPlugin(...args),
    invokeIntegrationConnectionAction: (...args) => port.invokeIntegrationConnectionAction(...args),
    listExternalConnectorServices: (...args) => port.listExternalConnectorServices(...args),
    listExternalConnectorSources: (...args) => port.listExternalConnectorSources(...args),
    listExternalSideEffectRuns: (...args) => port.listExternalSideEffectRuns(...args),
    listDiscordPairings: (...args) => port.listDiscordPairings(...args),
    listIntegrationCatalog: (...args) => port.listIntegrationCatalog(...args),
    listIntegrationConnections: (...args) => port.listIntegrationConnections(...args),
    listIntegrationPlugins: (...args) => port.listIntegrationPlugins(...args),
    reconnectDiscordRuntime: (...args) => port.reconnectDiscordRuntime(...args),
    revokeDiscordPairing: (...args) => port.revokeDiscordPairing(...args),
    runIntegrationConnectionDiagnostics: (...args) => port.runIntegrationConnectionDiagnostics(...args),
    stageExternalConnectorAction: (...args) => port.stageExternalConnectorAction(...args),
    updateExternalConnectorReviewState: (...args) => port.updateExternalConnectorReviewState(...args),
    setIntegrationPluginEnabled: (...args) => port.setIntegrationPluginEnabled(...args),
    updateIntegrationConnection: (...args) => port.updateIntegrationConnection(...args),
  };
}

export function createIntegrationRouteService(port: IntegrationRoutePort): IntegrationRouteService {
  return createRouteService(port, integrationRouteMethods);
}
