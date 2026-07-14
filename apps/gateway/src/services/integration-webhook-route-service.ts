import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const integrationWebhookRouteMethods = [
  "acceptInboundChannelEvent",
  "acceptInboundChannelEvents",
  "awaitInboundChannelCommandResult",
  "findRemoteActionTokenId",
  "getIntegrationConnection",
  "cancelLatestActiveChatTurnForSession",
  "hasRunningTurn",
  "emitChannelActivity",
  "ingestChannelMessage",
  "isVoiceInboundEnabled",
  "parseChatCommand",
  "recordDevDiagnostic",
  "respondToExistingChatMessage",
  "resolveApprovalWithRemoteToken",
  "resolveApprovalWithRemoteTokenId",
  "setChatSessionBinding",
  "transcribeChannelVoice",
  "updateIntegrationConnection",
] as const;

export type IntegrationWebhookRouteMethod = (typeof integrationWebhookRouteMethods)[number];
export type IntegrationWebhookRoutePort = RoutePort<IntegrationWebhookRouteMethod>;
export type IntegrationWebhookRouteService = RouteService<IntegrationWebhookRouteMethod>;
export type IntegrationWebhookPort = IntegrationWebhookRoutePort;

export function createIntegrationWebhookRoutePort(port: IntegrationWebhookPort): IntegrationWebhookRoutePort {
  return {
    acceptInboundChannelEvent: (...args) => port.acceptInboundChannelEvent(...args),
    acceptInboundChannelEvents: (...args) => port.acceptInboundChannelEvents(...args),
    awaitInboundChannelCommandResult: (...args) => port.awaitInboundChannelCommandResult(...args),
    findRemoteActionTokenId: (...args) => port.findRemoteActionTokenId(...args),
    getIntegrationConnection: (...args) => port.getIntegrationConnection(...args),
    cancelLatestActiveChatTurnForSession: (...args) => port.cancelLatestActiveChatTurnForSession(...args),
    emitChannelActivity: (...args) => port.emitChannelActivity(...args),
    hasRunningTurn: (...args) => port.hasRunningTurn(...args),
    ingestChannelMessage: (...args) => port.ingestChannelMessage(...args),
    isVoiceInboundEnabled: (...args) => port.isVoiceInboundEnabled(...args),
    parseChatCommand: (...args) => port.parseChatCommand(...args),
    recordDevDiagnostic: (...args) => port.recordDevDiagnostic(...args),
    respondToExistingChatMessage: (...args) => port.respondToExistingChatMessage(...args),
    resolveApprovalWithRemoteToken: (...args) => port.resolveApprovalWithRemoteToken(...args),
    resolveApprovalWithRemoteTokenId: (...args) => port.resolveApprovalWithRemoteTokenId(...args),
    setChatSessionBinding: (...args) => port.setChatSessionBinding(...args),
    transcribeChannelVoice: (...args) => port.transcribeChannelVoice(...args),
    updateIntegrationConnection: (...args) => port.updateIntegrationConnection(...args),
  };
}

export function createIntegrationWebhookRouteService(
  port: IntegrationWebhookRoutePort,
): IntegrationWebhookRouteService {
  return createRouteService(port, integrationWebhookRouteMethods);
}
