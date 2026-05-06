import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const commsRouteMethods = [
  "commsCalendarCreate",
  "commsCalendarList",
  "commsGmailRead",
  "commsGmailSend",
  "commsReact",
  "commsReply",
  "commsSend",
  "commsTyping",
  "commsUnsend",
  "getIntegrationConnectionChannelCapabilities",
  "getIntegrationConnectionChannelRuntimeStatus",
  "listChannelDeliveryRuntime",
  "runIntegrationConnectionDiagnostics",
] as const;

export type CommsRouteMethod = (typeof commsRouteMethods)[number];
export type CommsRoutePort = RoutePort<CommsRouteMethod>;
export type CommsRouteService = RouteService<CommsRouteMethod>;
export type CommsPort = CommsRoutePort;

export function createCommsRoutePort(port: CommsPort): CommsRoutePort {
  return {
    commsCalendarCreate: (...args) => port.commsCalendarCreate(...args),
    commsCalendarList: (...args) => port.commsCalendarList(...args),
    commsGmailRead: (...args) => port.commsGmailRead(...args),
    commsGmailSend: (...args) => port.commsGmailSend(...args),
    commsReact: (...args) => port.commsReact(...args),
    commsReply: (...args) => port.commsReply(...args),
    commsSend: (...args) => port.commsSend(...args),
    commsTyping: (...args) => port.commsTyping(...args),
    commsUnsend: (...args) => port.commsUnsend(...args),
    getIntegrationConnectionChannelCapabilities: (...args) => port.getIntegrationConnectionChannelCapabilities(...args),
    getIntegrationConnectionChannelRuntimeStatus: (...args) =>
      port.getIntegrationConnectionChannelRuntimeStatus(...args),
    listChannelDeliveryRuntime: (...args) => port.listChannelDeliveryRuntime(...args),
    runIntegrationConnectionDiagnostics: (...args) => port.runIntegrationConnectionDiagnostics(...args),
  };
}

export function createCommsRouteService(port: CommsRoutePort): CommsRouteService {
  return createRouteService(port, commsRouteMethods);
}
