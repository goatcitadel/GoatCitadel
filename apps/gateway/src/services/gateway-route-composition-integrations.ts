import type { IntegrationCatalogEntry, IntegrationConnection, IntegrationKind } from "@goatcitadel/contracts";
import { createChannelSetupRoutePort } from "./channel-setup-route-service.js";
import { createCommsRoutePort } from "./comms-route-service.js";
import { createIntegrationRoutePort } from "./integration-route-service.js";
import { createIntegrationWebhookRoutePort } from "./integration-webhook-route-service.js";
import { createObsidianRoutePort } from "./obsidian-route-service.js";
import {
  commsCalendarCreate as commsCalendarCreateImpl,
  commsCalendarList as commsCalendarListImpl,
  commsActivity as commsActivityImpl,
  commsGmailRead as commsGmailReadImpl,
  commsGmailSend as commsGmailSendImpl,
  commsReact as commsReactImpl,
  commsTyping as commsTypingImpl,
  commsUnsend as commsUnsendImpl,
  type CommsHost,
} from "./comms-service.js";
import {
  INTEGRATION_CATALOG,
  getIntegrationFormSchema,
  resolveIntegrationCatalogMaturity,
  resolveIntegrationCatalogRuntimeAvailability,
} from "./integration-catalog.js";
import { invokeIntegrationConnectionAction as invokeIntegrationConnectionActionImpl } from "./integration-action-service.js";
import { readIntegrationPlugins, writeIntegrationPlugins } from "./integration-plugin-store.js";
import {
  IntegrationChannelService,
  type IntegrationChannelPort as IntegrationChannelServicePort,
} from "./integration-channel-service.js";
import { IntegrationDiagnosticsService } from "./integration-diagnostics-service.js";
import { buildGatewayConnectorRecords, filterConnectorRecords } from "./connector-registry.js";
import * as channelSetupService from "./channel-setup-service.js";
import * as connectorDiagnosticsHelpers from "./connector-diagnostics-helpers.js";
import type { GatewayRouteCompositionPort, RouteDependencyDomain } from "./gateway-route-composition-port.js";
import { readChatAttachmentContentForGateway } from "./gateway-route-composition-shared.js";

export function composeIntegrationChannelRouteDependencies(
  gateway: GatewayRouteCompositionPort,
): RouteDependencyDomain<
  "channelSetup" | "comms" | "connectors" | "integrations" | "integrationWebhooks" | "obsidian"
> {
  const integrationDiagnostics = createIntegrationDiagnosticsServiceForGateway(gateway);
  const integrationChannel = createIntegrationChannelServiceForGateway(gateway, integrationDiagnostics);
  const channelSetupDeps: channelSetupService.ChannelSetupHost = {
    storage: gateway.storage,
    recentChannelSetupTests: gateway.recentChannelSetupTests,
    buildIntegrationConnectionChecks: (connection) =>
      integrationDiagnostics.buildIntegrationConnectionChecks(connection),
    createIntegrationConnection: (input) => integrationChannel.createIntegrationConnection(input),
    getIntegrationConnection: (connectionId) => integrationChannel.getIntegrationConnection(connectionId),
    recordDevDiagnostic: (input) => gateway.recordDevDiagnostic(input),
    runIntegrationConnectionLiveChecks: (connection, options) =>
      integrationDiagnostics.runIntegrationConnectionLiveChecks(connection, options),
    updateIntegrationConnection: (connectionId, patch) =>
      integrationChannel.updateIntegrationConnection(connectionId, patch),
  };
  const channelSetup = createChannelSetupRoutePort({
    createChannelSetupDraft: (input) => channelSetupService.createChannelSetupDraft(channelSetupDeps, input),
    createChannelSetupRepairDraft: (connectionId) =>
      channelSetupService.createChannelSetupRepairDraft(channelSetupDeps, connectionId),
    createChannelSetupRotateSecretDraft: (connectionId) =>
      channelSetupService.createChannelSetupRotateSecretDraft(channelSetupDeps, connectionId),
    finalizeChannelSetupDraft: (draftId) => channelSetupService.finalizeChannelSetupDraft(channelSetupDeps, draftId),
    getChannelSetupDefinition: (catalogId) =>
      channelSetupService.getChannelSetupDefinition(channelSetupDeps, catalogId),
    listChannelSetupDefinitions: () => channelSetupService.listChannelSetupDefinitions(channelSetupDeps),
    listChannelSetupDrafts: (options) => channelSetupService.listChannelSetupDrafts(channelSetupDeps, options),
    retestChannelConnection: (connectionId) =>
      channelSetupService.retestChannelConnection(channelSetupDeps, connectionId),
    testChannelSetupDraft: (draftId) => channelSetupService.testChannelSetupDraft(channelSetupDeps, draftId),
    updateChannelSetupDraft: (draftId, input) =>
      channelSetupService.updateChannelSetupDraft(channelSetupDeps, draftId, input),
    validateChannelSetupDraft: (draftId) => channelSetupService.validateChannelSetupDraft(channelSetupDeps, draftId),
  });
  const commsDeps = createCommsHostForGateway(gateway, integrationChannel);
  const comms = createCommsRoutePort({
    commsCalendarCreate: (input) => commsCalendarCreateImpl(commsDeps, input),
    commsCalendarList: (input) => commsCalendarListImpl(commsDeps, input),
    commsActivity: (input) => commsActivityImpl(commsDeps, input),
    commsGmailRead: (input) => commsGmailReadImpl(commsDeps, input),
    commsGmailSend: (input) => commsGmailSendImpl(commsDeps, input),
    commsReact: (input) => commsReactImpl(commsDeps, input),
    commsReply: (input) => gateway.commsReply(input),
    commsSend: (input) => gateway.commsSend(input),
    commsTyping: (input) => commsTypingImpl(commsDeps, input),
    commsUnsend: (input) => commsUnsendImpl(commsDeps, input),
    getIntegrationConnectionChannelCapabilities: (connectionId) =>
      integrationChannel.getIntegrationConnectionChannelCapabilities(connectionId),
    getIntegrationConnectionChannelRuntimeStatus: (connectionId) =>
      integrationChannel.getIntegrationConnectionChannelRuntimeStatus(connectionId),
    listChannelDeliveryRuntime: () => gateway.listChannelDeliveryRuntime(),
    runIntegrationConnectionDiagnostics: (connectionId) =>
      integrationChannel.runIntegrationConnectionDiagnostics(connectionId),
  });
  const listIntegrationCatalog = (kind?: IntegrationKind): IntegrationCatalogEntry[] => {
    const pluginIds = new Set(
      integrationChannel
        .listIntegrationPlugins()
        .map((item) => item.pluginId.trim().toLowerCase())
        .filter((item) => item.length > 0),
    );
    const mapped = INTEGRATION_CATALOG.map((entry) => ({
      ...entry,
      maturity: resolveIntegrationCatalogMaturity(entry, pluginIds),
      runtimeAvailability: resolveIntegrationCatalogRuntimeAvailability(entry, pluginIds),
    }));
    return kind ? mapped.filter((entry) => entry.kind === kind) : mapped;
  };
  const integrations = createIntegrationRoutePort({
    approveDiscordPairing: (connectionId, pairingId) =>
      integrationChannel.approveDiscordPairing(connectionId, pairingId),
    createIntegrationConnection: (input) => integrationChannel.createIntegrationConnection(input),
    deleteIntegrationConnection: (connectionId) => integrationChannel.deleteIntegrationConnection(connectionId),
    getIntegrationConnection: (connectionId) => integrationChannel.getIntegrationConnection(connectionId),
    getIntegrationFormSchema: (catalogId) => {
      const schema = getIntegrationFormSchema(catalogId);
      if (!schema) {
        throw new Error(`Unknown integration catalog id: ${catalogId}`);
      }
      return schema;
    },
    installIntegrationPlugin: (input) => integrationChannel.installIntegrationPlugin(input),
    invokeIntegrationConnectionAction: (connectionId, actionId, input = {}) =>
      invokeIntegrationConnectionActionImpl(
        {
          storage: gateway.storage,
          fetchWithDiagnosticsTimeout: (url, init) => gateway.fetchWithDiagnosticsTimeout(url, init),
          readConnectionConfigValue: (config, key) => gateway.readConnectionConfigValue(config, key),
          resolveConnectionSecret: (config, directKey, envKey) =>
            gateway.resolveConnectionSecret(config, directKey, envKey),
          publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload),
          evidenceEnvelopeService: gateway.evidenceEnvelopeService,
        },
        connectionId,
        actionId,
        input,
      ),
    listDiscordPairings: (connectionId) => integrationChannel.listDiscordPairings(connectionId),
    listIntegrationCatalog,
    listIntegrationConnections: (kind, limit) => integrationChannel.listIntegrationConnections(kind, limit),
    listIntegrationPlugins: () => integrationChannel.listIntegrationPlugins(),
    reconnectDiscordRuntime: (connectionId) => integrationChannel.reconnectDiscordRuntime(connectionId),
    revokeDiscordPairing: (connectionId, pairingId) => integrationChannel.revokeDiscordPairing(connectionId, pairingId),
    runIntegrationConnectionDiagnostics: (connectionId) =>
      integrationChannel.runIntegrationConnectionDiagnostics(connectionId),
    setIntegrationPluginEnabled: (pluginId, enabled) =>
      integrationChannel.setIntegrationPluginEnabled(pluginId, enabled),
    updateIntegrationConnection: (connectionId, input) =>
      integrationChannel.updateIntegrationConnection(connectionId, input),
  });
  const obsidian = createObsidianRoutePort({
    appendObsidianNote: (relativePath, markdownBlock) =>
      gateway.obsidianVaultService.appendToNote(relativePath, markdownBlock),
    captureObsidianInboxEntry: (input) => gateway.obsidianVaultService.captureInboxEntry(input),
    getObsidianIntegrationStatus: () => gateway.obsidianVaultService.getStatus(),
    readObsidianNote: (relativePath) => gateway.obsidianVaultService.readNote(relativePath),
    searchObsidianNotes: (query, limit) => gateway.obsidianVaultService.searchNotes(query, limit),
    testObsidianIntegration: async () => {
      const status = await gateway.obsidianVaultService.testConnection();
      gateway.publishRealtime("system", "integrations", {
        type: "obsidian_test_completed",
        enabled: status.enabled,
        vaultReachable: status.vaultReachable,
        lastError: status.lastError,
        checkedAt: status.checkedAt,
      });
      return status;
    },
    updateObsidianIntegrationConfig: (input) => {
      const updated = gateway.obsidianVaultService.updateConfig(input);
      gateway.publishRealtime("system", "integrations", {
        type: "obsidian_config_updated",
        enabled: updated.enabled,
        mode: updated.mode,
        vaultPath: updated.vaultPath,
        allowedSubpaths: updated.allowedSubpaths,
      });
      return updated;
    },
  });

  return {
    channelSetup,
    comms,
    connectors: {
      listConnectorRecords: (connectorType) =>
        filterConnectorRecords(
          buildGatewayConnectorRecords({
            integrationConnections: gateway.storage.integrationConnections.list(undefined, 1000),
            mcpServers: gateway.readMcpServers(),
            mcpTools: gateway.readMcpTools(),
          }),
          connectorType,
        ),
    },
    integrations,
    integrationWebhooks: createIntegrationWebhookRoutePort({
      getIntegrationConnection: (connectionId) => integrationChannel.getIntegrationConnection(connectionId),
      cancelLatestActiveChatTurnForSession: (sessionId, cancelledBy) =>
        gateway.cancelLatestActiveChatTurnForSession(sessionId, cancelledBy),
      hasRunningTurn: (sessionId) => gateway.hasRunningTurn(sessionId),
      ingestChannelMessage: (channel, idempotencyKey, input) =>
        gateway.ingestChannelMessage(channel, idempotencyKey, input),
      parseChatCommand: (sessionId, commandText, options) => gateway.parseChatCommand(sessionId, commandText, options),
      recordDevDiagnostic: (input) => gateway.recordDevDiagnostic(input),
      emitChannelActivity: (input) => gateway.commsActivity(input),
      respondToExistingChatMessage: (sessionId, messageId, input) =>
        gateway.respondToExistingChatMessage(sessionId, messageId, input),
      resolveApprovalWithRemoteToken: (input) => gateway.resolveApprovalWithRemoteToken(input),
      resolveApprovalWithRemoteTokenId: (input) => gateway.resolveApprovalWithRemoteTokenId(input),
      setChatSessionBinding: (input) => gateway.setChatSessionBinding(input),
      updateIntegrationConnection: (connectionId, patch) =>
        integrationChannel.updateIntegrationConnection(connectionId, patch),
    }),
    obsidian,
  };
}

export function createIntegrationDiagnosticsServiceForGateway(
  gateway: GatewayRouteCompositionPort,
): IntegrationDiagnosticsService {
  return new IntegrationDiagnosticsService({
    get config() {
      return {
        toolPolicy: {
          tools: {
            profile: gateway.config.toolPolicy.tools.profile ?? "",
          },
          sandbox: {
            networkAllowlist: gateway.config.toolPolicy.sandbox.networkAllowlist,
          },
        },
      };
    },
    fetchWithDiagnosticsTimeout: (url, init) => gateway.fetchWithDiagnosticsTimeout(url, init),
    getDiscordRuntimeStatus: (connectionId) => gateway.discordRuntimeService.getConnectionStatus(connectionId),
    isConnectionUrlAllowlisted: (urlValue) => gateway.isConnectionUrlAllowlisted(urlValue),
    readConnectionConfigValue: (config, key) => gateway.readConnectionConfigValue(config, key),
    resolveConnectionSecret: (config, directKey, envKey) => gateway.resolveConnectionSecret(config, directKey, envKey),
  });
}

export function createIntegrationChannelServiceForGateway(
  gateway: GatewayRouteCompositionPort,
  integrationDiagnostics = createIntegrationDiagnosticsServiceForGateway(gateway),
): IntegrationChannelService {
  return new IntegrationChannelService(createIntegrationChannelPortForGateway(gateway, integrationDiagnostics));
}

function createIntegrationChannelPortForGateway(
  gateway: GatewayRouteCompositionPort,
  integrationDiagnostics: IntegrationDiagnosticsService,
): IntegrationChannelServicePort {
  return {
    storage: gateway.storage,
    publishRealtime: (eventType, source, payload, options) =>
      gateway.publishRealtime(eventType, source, payload, options),
    requireFeatureEnabled: (flag) => gateway.requireFeatureEnabled(flag),
    buildIntegrationConnectionChecks: (connection) =>
      integrationDiagnostics.buildIntegrationConnectionChecks(connection),
    runIntegrationConnectionLiveChecks: (connection, options) =>
      integrationDiagnostics.runIntegrationConnectionLiveChecks(connection, options),
    pickConnectorDiagnosticAction: (checks) => connectorDiagnosticsHelpers.pickConnectorDiagnosticAction(checks),
    recordConnectorHealthRun: (report) =>
      connectorDiagnosticsHelpers.recordConnectorHealthRun({ gatewaySql: gateway.storage.gatewaySql }, report),
    syncDiscordRuntime: () => gateway.syncDiscordRuntime(),
    getDiscordRuntimeStatus: (connectionId) => gateway.discordRuntimeService.getConnectionStatus(connectionId),
    getIntegrationConnection: (connectionId) => gateway.storage.integrationConnections.get(connectionId),
    assertDiscordConnection,
    readDiscordPairings: () => gateway.readDiscordPairings(),
    writeDiscordPairings: (records) => gateway.writeDiscordPairings(records),
    discordRuntimeService: gateway.discordRuntimeService,
    resolveConnectionSecret: (config, directKey, envKey) => gateway.resolveConnectionSecret(config, directKey, envKey),
    readConnectionConfigValue: (config, key) => gateway.readConnectionConfigValue(config, key),
    isConnectionUrlAllowlisted: (urlValue) => gateway.isConnectionUrlAllowlisted(urlValue),
    fetchWithDiagnosticsTimeout: (url, init) => gateway.fetchWithDiagnosticsTimeout(url, init),
    readIntegrationPlugins: () => readIntegrationPlugins(gateway.storage),
    writeIntegrationPlugins: (plugins) => writeIntegrationPlugins(gateway.storage, plugins),
  };
}

export function createCommsHostForGateway(
  gateway: GatewayRouteCompositionPort,
  integrationChannel = createIntegrationChannelServiceForGateway(gateway),
): CommsHost {
  return {
    invokeAndUnwrap: (request, realtimeType) => gateway.invokeAndUnwrap(request, realtimeType),
    readChatAttachmentContent: (attachmentId) => readChatAttachmentContentForGateway(gateway, attachmentId),
    getIntegrationConnection: (connectionId) => integrationChannel.getIntegrationConnection(connectionId),
    emitDiscordTyping: (connection, input) =>
      gateway.discordRuntimeService.sendTyping(connection.connectionId, input.target, input.durationMs, input.signal),
    emitTelegramTyping: (connection, input) => integrationChannel.emitTelegramTyping(connection, input),
    emitChannelActivity: (connection, input, options) =>
      integrationChannel.emitChannelActivity(connection, input, options),
  };
}

function assertDiscordConnection(connection: IntegrationConnection): void {
  if (connection.kind !== "channel" || connection.key !== "discord") {
    throw new Error("Integration connection is not a Discord channel");
  }
}
