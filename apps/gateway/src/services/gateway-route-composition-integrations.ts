import type {
  ExternalSideEffectRunListQuery,
  IntegrationCatalogEntry,
  IntegrationConnection,
  IntegrationKind,
  NotificationEventRecord,
  NotificationTarget,
} from "@goatcitadel/contracts";
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
import {
  invokeIntegrationConnectionAction as invokeIntegrationConnectionActionImpl,
  type IntegrationActionHost,
} from "./integration-action-service.js";
import { readIntegrationPlugins, writeIntegrationPlugins } from "./integration-plugin-store.js";
import {
  IntegrationChannelService,
  type IntegrationChannelPort as IntegrationChannelServicePort,
} from "./integration-channel-service.js";
import { ChannelVoiceInboundService } from "./channel-voice-inbound-service.js";
import { IntegrationDiagnosticsService } from "./integration-diagnostics-service.js";
import { buildGatewayConnectorRecords, filterConnectorRecords } from "./connector-registry.js";
import { ExternalConnectorCatalogService } from "./external-connector-catalog-service.js";
import {
  NotificationRoutingService,
  accountFromNotificationSecretRef,
  notificationDestinationFingerprint,
  parseAllowedNotificationWebhookUrl,
  type NotificationDeliveryAdapterResult,
} from "./notification-routing-service.js";
import { runIdempotentExternalSideEffect } from "./external-side-effect-runner-service.js";
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
  const channelVoiceInbound = new ChannelVoiceInboundService({
    fetchWithTimeout: (url, init) => gateway.fetchWithDiagnosticsTimeout(url, init),
    transcribeVoice: (input) => gateway.mediaVoiceService.transcribeVoice(input),
    isConnectionUrlAllowlisted: (urlValue) => gateway.isConnectionUrlAllowlisted(urlValue),
    resolveConnectionSecret: (config, directKey, envKey) => gateway.resolveConnectionSecret(config, directKey, envKey),
  });
  const externalConnectorCatalog = new ExternalConnectorCatalogService({
    reviewStates: gateway.storage.externalConnectorReviewStates,
    createCapabilityProposal: (input) => gateway.capabilitySystemService.createProposal(input),
  });
  const notificationRouting = new NotificationRoutingService({
    repository: gateway.storage.notificationRouting,
    normalizeWorkspaceId: (workspaceId) => gateway.normalizeWorkspaceId(workspaceId),
    getIntegrationConnection: (connectionId) => integrationChannel.getIntegrationConnection(connectionId),
    deliver: (target, event, idempotencyKey) => deliverNotificationForGateway(gateway, target, event, idempotencyKey),
    publishRealtime: (eventType, source, payload, options) =>
      gateway.publishRealtime(eventType, source, payload, options),
  });
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
      channelSetupService.updateChannelSetupDraft(channelSetupDeps, draftId, input, {
        reconcilePublicProjection: true,
      }),
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
    const mapped: IntegrationCatalogEntry[] = [
      ...INTEGRATION_CATALOG.map((entry) => ({
        ...entry,
        maturity: resolveIntegrationCatalogMaturity(entry, pluginIds),
        runtimeAvailability: resolveIntegrationCatalogRuntimeAvailability(entry, pluginIds),
      })),
      ...externalConnectorCatalog.listIntegrationCatalogEntries(),
    ];
    return kind ? mapped.filter((entry) => entry.kind === kind) : mapped;
  };
  const integrations = createIntegrationRoutePort({
    approveDiscordPairing: (connectionId, pairingId) =>
      integrationChannel.approveDiscordPairing(connectionId, pairingId),
    createIntegrationConnection: (input) => integrationChannel.createIntegrationConnection(input),
    deleteIntegrationConnection: (connectionId) => integrationChannel.deleteIntegrationConnection(connectionId),
    getIntegrationConnection: (connectionId) => integrationChannel.getIntegrationConnection(connectionId),
    getIntegrationFormSchema: (catalogId) => {
      if (catalogId.startsWith("external_connector.")) {
        throw new Error(
          `External connector catalog entries are review-only and do not expose connection forms: ${catalogId}`,
        );
      }
      const schema = getIntegrationFormSchema(catalogId);
      if (!schema) {
        throw new Error(`Unknown integration catalog id: ${catalogId}`);
      }
      return schema;
    },
    getExternalConnectorAction: (sourceId, serviceId, actionId, workspaceId) =>
      externalConnectorCatalog.getAction(sourceId, serviceId, actionId, workspaceId),
    getExternalConnectorService: (sourceId, serviceId, workspaceId) =>
      externalConnectorCatalog.getService(sourceId, serviceId, workspaceId),
    installIntegrationPlugin: (input) => integrationChannel.installIntegrationPlugin(input),
    invokeIntegrationConnectionAction: (connectionId, actionId, input = {}) =>
      invokeIntegrationConnectionActionImpl(
        buildIntegrationActionHostForGateway(gateway),
        connectionId,
        actionId,
        input,
      ),
    listDiscordPairings: (connectionId) => integrationChannel.listDiscordPairings(connectionId),
    listExternalSideEffectRuns: (query: ExternalSideEffectRunListQuery = {}) =>
      query.connectionId
        ? gateway.storage.externalSideEffectRuns.listByConnection(query.connectionId, {
            workspaceId: query.workspaceId,
            limit: query.limit,
          })
        : gateway.storage.externalSideEffectRuns.listByWorkspace(query.workspaceId ?? "default", query.limit),
    listExternalConnectorServices: (query) => externalConnectorCatalog.listServices(query),
    listExternalConnectorSources: () => externalConnectorCatalog.listSources(),
    listIntegrationCatalog,
    listIntegrationConnections: (kind, limit) => integrationChannel.listIntegrationConnections(kind, limit),
    listIntegrationPlugins: () => integrationChannel.listIntegrationPlugins(),
    listNotificationDeliveries: (workspaceId, limit) => {
      gateway.requireFeatureEnabled("notificationRoutingV1Enabled");
      return notificationRouting.listDeliveries(workspaceId, limit);
    },
    listNotificationRules: (workspaceId, includeArchived) => {
      gateway.requireFeatureEnabled("notificationRoutingV1Enabled");
      return notificationRouting.listRules(workspaceId, includeArchived);
    },
    listNotificationTargets: (workspaceId, includeArchived) => {
      gateway.requireFeatureEnabled("notificationRoutingV1Enabled");
      return notificationRouting.listTargets(workspaceId, includeArchived);
    },
    createNotificationRule: (workspaceId, input) => {
      gateway.requireFeatureEnabled("notificationRoutingV1Enabled");
      return notificationRouting.createRule(workspaceId, input);
    },
    createNotificationTarget: (workspaceId, input) => {
      gateway.requireFeatureEnabled("notificationRoutingV1Enabled");
      return notificationRouting.createTarget(workspaceId, input);
    },
    dispatchNotificationEvent: (workspaceId, input) => {
      gateway.requireFeatureEnabled("notificationRoutingV1Enabled");
      return notificationRouting.dispatch(workspaceId, input);
    },
    requestNotification: (workspaceId, input) => {
      gateway.requireFeatureEnabled("notificationRoutingV1Enabled");
      return notificationRouting.request(workspaceId, input);
    },
    sendTestNotification: (workspaceId, targetId) => {
      gateway.requireFeatureEnabled("notificationRoutingV1Enabled");
      return notificationRouting.sendTest(workspaceId, targetId);
    },
    updateNotificationRule: (workspaceId, ruleId, expectedRevision, input) => {
      gateway.requireFeatureEnabled("notificationRoutingV1Enabled");
      return notificationRouting.updateRule(workspaceId, ruleId, expectedRevision, input);
    },
    updateNotificationTarget: (workspaceId, targetId, expectedRevision, input) => {
      gateway.requireFeatureEnabled("notificationRoutingV1Enabled");
      return notificationRouting.updateTarget(workspaceId, targetId, expectedRevision, input);
    },
    upsertNotificationPresence: (input) => {
      gateway.requireFeatureEnabled("notificationRoutingV1Enabled");
      return notificationRouting.upsertPresence(input);
    },
    reconnectDiscordRuntime: (connectionId) => integrationChannel.reconnectDiscordRuntime(connectionId),
    revokeDiscordPairing: (connectionId, pairingId) => integrationChannel.revokeDiscordPairing(connectionId, pairingId),
    runIntegrationConnectionDiagnostics: (connectionId) =>
      integrationChannel.runIntegrationConnectionDiagnostics(connectionId),
    stageExternalConnectorAction: (sourceId, serviceId, actionId, input) =>
      externalConnectorCatalog.stageAction({ sourceId, serviceId, actionId }, input),
    updateExternalConnectorReviewState: (lookup, patch) => externalConnectorCatalog.updateReviewState(lookup, patch),
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
      acceptInboundChannelEvent: (input) => gateway.acceptInboundChannelEvent(input),
      acceptInboundChannelEvents: (inputs) => gateway.acceptInboundChannelEvents(inputs),
      awaitInboundChannelCommandResult: (eventId) => gateway.awaitInboundChannelCommandResult(eventId),
      findRemoteActionTokenId: (token) => gateway.findRemoteActionTokenId(token),
      getIntegrationConnection: (connectionId) => integrationChannel.getIntegrationConnection(connectionId),
      cancelLatestActiveChatTurnForSession: (sessionId, cancelledBy) =>
        gateway.cancelLatestActiveChatTurnForSession(sessionId, cancelledBy),
      hasRunningTurn: (sessionId) => gateway.hasRunningTurn(sessionId),
      ingestChannelMessage: (channel, idempotencyKey, input) =>
        gateway.ingestChannelMessage(channel, idempotencyKey, input),
      isVoiceInboundEnabled: () => gateway.isFeatureEnabled("channelVoiceInboundV1Enabled") === true,
      transcribeChannelVoice: (input) => channelVoiceInbound.transcribe(input),
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

async function deliverNotificationForGateway(
  gateway: GatewayRouteCompositionPort,
  target: NotificationTarget,
  event: NotificationEventRecord,
  idempotencyKey: string,
): Promise<NotificationDeliveryAdapterResult> {
  if (target.kind === "channel_connection") {
    return deliverNotificationToChannel(gateway, target, event, idempotencyKey);
  }
  return deliverNotificationToWebhook(gateway, target, event, idempotencyKey);
}

async function deliverNotificationToChannel(
  gateway: GatewayRouteCompositionPort,
  target: NotificationTarget,
  event: NotificationEventRecord,
  idempotencyKey: string,
): Promise<NotificationDeliveryAdapterResult> {
  const connectionId = target.channelConnectionId;
  if (!connectionId) return { status: "failed", lastError: "Channel connection is unavailable." };
  const connection = gateway.storage.integrationConnections.get(connectionId);
  if (connection.workspaceId && connection.workspaceId !== event.workspaceId) {
    return { status: "failed", lastError: "Channel connection belongs to another workspace." };
  }
  const channelTarget = readConfiguredChannelTarget(connection.config);
  if (!channelTarget) return { status: "failed", lastError: "Channel connection has no configured destination." };
  const result = await gateway.commsSend({
    connectionId,
    target: channelTarget,
    message: `${event.title}\n\n${event.message}`,
    workspaceId: event.workspaceId,
    sessionId: event.sessionId,
    taskId: event.turnId,
    operatorId: "notification-routing",
    effectId: idempotencyKey,
    surface: "settings",
  });
  const status = readResultStatus(result);
  if (status === "failed" || status === "blocked") {
    return { status: "failed", attemptCount: 1, lastError: "Channel delivery was rejected or failed." };
  }
  if (status === "queued" || status === "pending") return { status: "pending", attemptCount: 1 };
  return { status: "delivered", attemptCount: 1 };
}

async function deliverNotificationToWebhook(
  gateway: GatewayRouteCompositionPort,
  target: NotificationTarget,
  event: NotificationEventRecord,
  idempotencyKey: string,
): Promise<NotificationDeliveryAdapterResult> {
  const secretStore = gateway.secretStore;
  if (!secretStore?.isAvailable()) return { status: "failed", lastError: "OS keychain is unavailable." };
  if (!target.webhookUrlSecretRef) return { status: "failed", lastError: "Webhook destination is unavailable." };
  const urlValue = secretStore.getSecret(accountFromNotificationSecretRef(target.webhookUrlSecretRef));
  if (!urlValue) return { status: "failed", lastError: "Webhook destination secret is unavailable." };
  const url = parseAllowedNotificationWebhookUrl(urlValue, (candidate) =>
    gateway.isConnectionUrlAllowlisted(candidate),
  );
  const credential = target.credentialSecretRef
    ? secretStore.getSecret(accountFromNotificationSecretRef(target.credentialSecretRef))
    : undefined;

  const maxAttempts = 3;
  let lastRunId: string | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runIdempotentExternalSideEffect({
      mutationStore: gateway.mutationIdempotencyStore,
      sideEffectRunStore: gateway.storage.externalSideEffectRuns,
      runClaimTransaction: (work) => gateway.storage.runImmediateTransaction(work),
      requireDurableBoundaryRecord: true,
      requireMutationClaimOwnership: true,
      workspaceId: event.workspaceId,
      boundary: "notification_webhook",
      catalogId: "notification.https_webhook",
      connectionId: target.targetId,
      actionId: "notification.deliver",
      checkedAt: new Date().toISOString(),
      externalDestinationFingerprint: notificationDestinationFingerprint(url.origin + url.pathname),
      idempotencyKey: `${idempotencyKey}:attempt:${attempt}`,
      actorScope: `workspace:${event.workspaceId}`,
      payload: { eventId: event.eventId, eventType: event.eventType, targetId: target.targetId, attempt },
      label: "Notification webhook delivery",
      execute: async (claim) => {
        claim.markExternalCallStarted();
        const response = await gateway.fetchWithDiagnosticsTimeout(url.toString(), {
          method: "POST",
          redirect: "manual",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
            ...(credential ? { authorization: `Bearer ${credential}` } : {}),
          },
          body: JSON.stringify({
            eventId: event.eventId,
            eventType: event.eventType,
            sessionId: event.sessionId,
            turnId: event.turnId,
            title: event.title,
            message: event.message,
            createdAt: event.createdAt,
          }),
        });
        return { ok: response.ok, status: response.status };
      },
    });
    lastRunId = result.claim.sideEffectRunId;
    if (result.status === "executed" && result.value.ok) {
      return { status: "delivered", attemptCount: attempt, externalSideEffectRunId: lastRunId };
    }
    if (result.status === "failed" && result.claim.resumeState === "manual_review_unknown_external_outcome") {
      return {
        status: "unknown_after_send",
        attemptCount: attempt,
        externalSideEffectRunId: lastRunId,
        lastError: "Webhook outcome is unknown after send; automatic retry stopped.",
      };
    }
    if (result.status === "blocked") {
      return {
        status: "failed",
        attemptCount: attempt,
        externalSideEffectRunId: lastRunId,
        lastError: "Webhook delivery was blocked by idempotency or policy.",
      };
    }
  }
  return {
    status: "failed",
    attemptCount: maxAttempts,
    externalSideEffectRunId: lastRunId,
    lastError: "Webhook returned an unsuccessful response after retry attempts.",
  };
}

function readConfiguredChannelTarget(config: Record<string, unknown>): string | undefined {
  for (const key of ["defaultTarget", "target", "channelId", "chatId", "roomId"]) {
    const value = config[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function readResultStatus(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const outcome = Reflect.get(result, "outcome");
  if (typeof outcome === "string") return outcome;
  const direct = Reflect.get(result, "status");
  if (typeof direct === "string") return direct;
  const nested = Reflect.get(result, "result");
  if (nested && typeof nested === "object") {
    const nestedStatus = Reflect.get(nested, "status");
    if (typeof nestedStatus === "string") return nestedStatus;
  }
  return undefined;
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
    isFeatureEnabled: (flag) => gateway.isFeatureEnabled(flag),
    buildIntegrationConnectionChecks: (connection) =>
      integrationDiagnostics.buildIntegrationConnectionChecks(connection),
    runIntegrationConnectionLiveChecks: (connection, options) =>
      integrationDiagnostics.runIntegrationConnectionLiveChecks(connection, options),
    pickConnectorDiagnosticAction: (checks) => connectorDiagnosticsHelpers.pickConnectorDiagnosticAction(checks),
    recordConnectorHealthRun: (report) =>
      connectorDiagnosticsHelpers.recordConnectorHealthRun({ gatewaySql: gateway.storage.gatewaySql }, report),
    syncDiscordRuntime: () => gateway.syncDiscordRuntime(),
    syncSignalInboundRuntime: () => gateway.syncSignalInboundRuntime(),
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
    mutationStore: gateway.mutationIdempotencyStore,
    sideEffectRunStore: gateway.storage.externalSideEffectRuns,
  };
}

function assertDiscordConnection(connection: IntegrationConnection): void {
  if (connection.kind !== "channel" || connection.key !== "discord") {
    throw new Error("Integration connection is not a Discord channel");
  }
}

/**
 * The single construction site for the integration-action host. Used by the route
 * composition above AND by the gateway's approved dry-run commit replay, so the two
 * callers can never drift apart on which gateway capabilities the action runtime sees.
 */
export function buildIntegrationActionHostForGateway(gateway: GatewayRouteCompositionPort): IntegrationActionHost {
  return {
    storage: gateway.storage,
    fetchWithDiagnosticsTimeout: (url, init) => gateway.fetchWithDiagnosticsTimeout(url, init),
    readConnectionConfigValue: (config, key) => gateway.readConnectionConfigValue(config, key),
    resolveConnectionSecret: (config, directKey, envKey) => gateway.resolveConnectionSecret(config, directKey, envKey),
    publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload),
    evidenceEnvelopeService: gateway.evidenceEnvelopeService,
    mutationStore: gateway.mutationIdempotencyStore,
    sideEffectRunStore: gateway.storage.externalSideEffectRuns,
    createApproval: (input) => gateway.createApproval(input),
  };
}
