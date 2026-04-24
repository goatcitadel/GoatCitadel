import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const channelSetupRouteMethods = [
  "createChannelSetupDraft",
  "createChannelSetupRepairDraft",
  "createChannelSetupRotateSecretDraft",
  "finalizeChannelSetupDraft",
  "getChannelSetupDefinition",
  "listChannelSetupDefinitions",
  "listChannelSetupDrafts",
  "retestChannelConnection",
  "testChannelSetupDraft",
  "updateChannelSetupDraft",
  "validateChannelSetupDraft",
] as const;

export type ChannelSetupRouteMethod = (typeof channelSetupRouteMethods)[number];
export type ChannelSetupRoutePort = RoutePort<ChannelSetupRouteMethod>;
export type ChannelSetupRouteService = RouteService<ChannelSetupRouteMethod>;
export type ChannelSetupPort = ChannelSetupRoutePort;

export function createChannelSetupRoutePort(port: ChannelSetupPort): ChannelSetupRoutePort {
  return {
    createChannelSetupDraft: (...args) => port.createChannelSetupDraft(...args),
    createChannelSetupRepairDraft: (...args) => port.createChannelSetupRepairDraft(...args),
    createChannelSetupRotateSecretDraft: (...args) => port.createChannelSetupRotateSecretDraft(...args),
    finalizeChannelSetupDraft: (...args) => port.finalizeChannelSetupDraft(...args),
    getChannelSetupDefinition: (...args) => port.getChannelSetupDefinition(...args),
    listChannelSetupDefinitions: (...args) => port.listChannelSetupDefinitions(...args),
    listChannelSetupDrafts: (...args) => port.listChannelSetupDrafts(...args),
    retestChannelConnection: (...args) => port.retestChannelConnection(...args),
    testChannelSetupDraft: (...args) => port.testChannelSetupDraft(...args),
    updateChannelSetupDraft: (...args) => port.updateChannelSetupDraft(...args),
    validateChannelSetupDraft: (...args) => port.validateChannelSetupDraft(...args),
  };
}

export function createChannelSetupRouteService(port: ChannelSetupRoutePort): ChannelSetupRouteService {
  return createRouteService(port, channelSetupRouteMethods);
}
