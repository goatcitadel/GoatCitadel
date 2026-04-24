import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const integrationWebhookRouteMethods = [
  "getIntegrationConnection",
  "ingestChannelMessage",
  "recordDevDiagnostic",
  "respondToExistingChatMessage",
  "setChatSessionBinding",
] as const;

export type IntegrationWebhookRouteMethod = (typeof integrationWebhookRouteMethods)[number];
export type IntegrationWebhookRoutePort = RoutePort<IntegrationWebhookRouteMethod>;
export type IntegrationWebhookRouteService = RouteService<IntegrationWebhookRouteMethod>;
export type IntegrationWebhookPort = IntegrationWebhookRoutePort;

export function createIntegrationWebhookRoutePort(port: IntegrationWebhookPort): IntegrationWebhookRoutePort {
  return {
    getIntegrationConnection: (...args) => port.getIntegrationConnection(...args),
    ingestChannelMessage: (...args) => port.ingestChannelMessage(...args),
    recordDevDiagnostic: (...args) => port.recordDevDiagnostic(...args),
    respondToExistingChatMessage: (...args) => port.respondToExistingChatMessage(...args),
    setChatSessionBinding: (...args) => port.setChatSessionBinding(...args),
  };
}

export function createIntegrationWebhookRouteService(
  port: IntegrationWebhookRoutePort,
): IntegrationWebhookRouteService {
  return createRouteService(port, integrationWebhookRouteMethods);
}
