import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const integrationWebhookRouteMethods = [
  "getIntegrationConnection",
  "cancelLatestActiveChatTurnForSession",
  "hasRunningTurn",
  "emitChannelActivity",
  "ingestChannelMessage",
  "parseChatCommand",
  "recordDevDiagnostic",
  "respondToExistingChatMessage",
  "resolveApprovalWithRemoteToken",
  "resolveApprovalWithRemoteTokenId",
  "setChatSessionBinding",
  "updateIntegrationConnection",
] as const;

export type IntegrationWebhookRouteMethod = (typeof integrationWebhookRouteMethods)[number];
export type IntegrationWebhookRoutePort = RoutePort<IntegrationWebhookRouteMethod>;
export type IntegrationWebhookRouteService = RouteService<IntegrationWebhookRouteMethod>;
export type IntegrationWebhookPort = IntegrationWebhookRoutePort;

export function createIntegrationWebhookRoutePort(port: IntegrationWebhookPort): IntegrationWebhookRoutePort {
  return {
    getIntegrationConnection: (...args) => port.getIntegrationConnection(...args),
    cancelLatestActiveChatTurnForSession: (...args) => port.cancelLatestActiveChatTurnForSession(...args),
    emitChannelActivity: (...args) => port.emitChannelActivity(...args),
    hasRunningTurn: (...args) => port.hasRunningTurn(...args),
    ingestChannelMessage: (...args) => port.ingestChannelMessage(...args),
    parseChatCommand: (...args) => port.parseChatCommand(...args),
    recordDevDiagnostic: (...args) => port.recordDevDiagnostic(...args),
    respondToExistingChatMessage: (...args) => port.respondToExistingChatMessage(...args),
    resolveApprovalWithRemoteToken: (...args) => port.resolveApprovalWithRemoteToken(...args),
    resolveApprovalWithRemoteTokenId: (...args) => port.resolveApprovalWithRemoteTokenId(...args),
    setChatSessionBinding: (...args) => port.setChatSessionBinding(...args),
    updateIntegrationConnection: (...args) => port.updateIntegrationConnection(...args),
  };
}

export function createIntegrationWebhookRouteService(
  port: IntegrationWebhookRoutePort,
): IntegrationWebhookRouteService {
  return createRouteService(port, integrationWebhookRouteMethods);
}
