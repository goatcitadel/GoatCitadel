import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const channelSetupRouteMethods = [
  "createChannelSetupDraft",
  "discardChannelSetupDraft",
  "createChannelSetupRepairDraft",
  "createChannelSetupRotateSecretDraft",
  "finalizeChannelSetupDraft",
  "reviewChannelSetupConnection",
  "getChannelSetupDefinition",
  "getChannelSetupDraft",
  "getChannelSetupDraftEvidence",
  "listChannelSetupDefinitions",
  "listChannelSetupDrafts",
  "setChannelSetupDraftSecrets",
  "retestChannelConnection",
  "testChannelSetupDraft",
  "updateChannelSetupDraft",
  "validateChannelSetupDraft",
  "discoverChannelSetupTelegramTargets",
  "acknowledgeChannelSetupTest",
  "getChannelSetupJourney",
  "startSlackOAuthAttempt",
  "getChannelOAuthAttempt",
  "completeSlackOAuthAttempt",
  "adoptSlackOAuthAttempt",
  "cancelChannelOAuthAttempt",
  "cleanupChannelOAuthAttempts",
  "recoverInterruptedChannelOAuthAttempts",
] as const;

export type ChannelSetupRouteMethod = (typeof channelSetupRouteMethods)[number];
export type ChannelSetupRoutePort = RoutePort<ChannelSetupRouteMethod>;
export type ChannelSetupRouteService = RouteService<ChannelSetupRouteMethod>;
export type ChannelSetupPort = ChannelSetupRoutePort;

export function createChannelSetupRoutePort(port: ChannelSetupPort): ChannelSetupRoutePort {
  return {
    createChannelSetupDraft: (...args) => port.createChannelSetupDraft(...args),
    discardChannelSetupDraft: (...args) => port.discardChannelSetupDraft(...args),
    createChannelSetupRepairDraft: (...args) => port.createChannelSetupRepairDraft(...args),
    createChannelSetupRotateSecretDraft: (...args) => port.createChannelSetupRotateSecretDraft(...args),
    finalizeChannelSetupDraft: (...args) => port.finalizeChannelSetupDraft(...args),
    reviewChannelSetupConnection: (...args) => port.reviewChannelSetupConnection(...args),
    getChannelSetupDefinition: (...args) => port.getChannelSetupDefinition(...args),
    getChannelSetupDraft: (...args) => port.getChannelSetupDraft(...args),
    getChannelSetupDraftEvidence: (...args) => port.getChannelSetupDraftEvidence(...args),
    listChannelSetupDefinitions: (...args) => port.listChannelSetupDefinitions(...args),
    listChannelSetupDrafts: (...args) => port.listChannelSetupDrafts(...args),
    setChannelSetupDraftSecrets: (...args) => port.setChannelSetupDraftSecrets(...args),
    retestChannelConnection: (...args) => port.retestChannelConnection(...args),
    testChannelSetupDraft: (...args) => port.testChannelSetupDraft(...args),
    updateChannelSetupDraft: (...args) => port.updateChannelSetupDraft(...args),
    validateChannelSetupDraft: (...args) => port.validateChannelSetupDraft(...args),
    discoverChannelSetupTelegramTargets: (...args) => port.discoverChannelSetupTelegramTargets(...args),
    acknowledgeChannelSetupTest: (...args) => port.acknowledgeChannelSetupTest(...args),
    getChannelSetupJourney: (...args) => port.getChannelSetupJourney(...args),
    startSlackOAuthAttempt: (...args) => port.startSlackOAuthAttempt(...args),
    getChannelOAuthAttempt: (...args) => port.getChannelOAuthAttempt(...args),
    completeSlackOAuthAttempt: (...args) => port.completeSlackOAuthAttempt(...args),
    adoptSlackOAuthAttempt: (...args) => port.adoptSlackOAuthAttempt(...args),
    cancelChannelOAuthAttempt: (...args) => port.cancelChannelOAuthAttempt(...args),
    cleanupChannelOAuthAttempts: (...args) => port.cleanupChannelOAuthAttempts(...args),
    recoverInterruptedChannelOAuthAttempts: (...args) => port.recoverInterruptedChannelOAuthAttempts(...args),
  };
}

export function createChannelSetupRouteService(port: ChannelSetupRoutePort): ChannelSetupRouteService {
  return createRouteService(port, channelSetupRouteMethods);
}
