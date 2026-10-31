import { createChannelOAuthStagingService } from "./channel-oauth-staging-service.js";
import type {
  ExternalSideEffectRunListQuery,
  IntegrationCatalogEntry,
  IntegrationConnection,
  IntegrationKind,
  NotificationEventRecord,
  NotificationTarget,
} from "@goatcitadel/contracts";
import { createChannelSetupRoutePort } from "./channel-setup-route-service.js";
import { resolveChannelConfigTarget } from "./channel-config.js";
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
import { composeChannelSetupHost } from "./channel-setup-host-composition.js";
import { ChannelSecretCustodyService } from "./channel-secret-custody-service.js";
import { createConnectionSecretReferenceResolver } from "./channel-secret-resolution.js";
import { createWhatsAppSetupListener } from "./whatsapp-setup-listener.js";
import * as connectorDiagnosticsHelpers from "./connector-diagnostics-helpers.js";
import {
  createExternalSideEffectReplayRecords,
  sharedExternalSideEffectReplayKeyResolver,
  sharedExternalSideEffectReplayKeyResolverOrThrow,
} from "./external-side-effect-replay-record.js";
import { createCitadelWardRequestVault, type CitadelWardRequestVault } from "./citadel-ward-approval.js";
import type { GatewayRouteCompositionPort, RouteDependencyDomain } from "./gateway-route-composition-port.js";
import { readChatAttachmentContentForGateway } from "./gateway-route-composition-shared.js";
import { getChannelStreamRuntime, provideChannelUpdateDeps } from "./channel-stream-runtime-registry.js";

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
    resolveConnectionSecret: (config, directKey, envKey, catalogId, owner) =>
      gateway.resolveConnectionSecret(config, directKey, envKey, catalogId, owner),
  });
  const externalConnectorCatalog = new ExternalConnectorCatalogService({
    reviewStates: gateway.storage.externalConnectorReviewStates,
    createCapabilityProposal: (input) => gateway.capabilitySystemService.createProposal(input),
  });
  const notificationRouting = createNotificationRoutingServiceForGateway(gateway);
  const channelSetupDeps = createChannelSetupHostForGateway(gateway, integrationDiagnostics, integrationChannel);
  // The one listener for WhatsApp setup drafts made on the Messaging page; the webhook port answers Meta through it.
  const whatsAppSetupListener = createWhatsAppSetupListener(channelSetupDeps);
  const channelOAuth = createChannelOAuthStagingService(gateway, channelSetupDeps);
  const channelSetup = createChannelSetupRoutePort({
    createChannelSetupDraft: (input) => channelSetupService.createChannelSetupDraft(channelSetupDeps, input),
    createChannelSetupRepairDraft: (connectionId) =>
      channelSetupService.createChannelSetupRepairDraft(channelSetupDeps, connectionId),
    createChannelSetupRotateSecretDraft: (connectionId) =>
      channelSetupService.createChannelSetupRotateSecretDraft(channelSetupDeps, connectionId),
    finalizeChannelSetupDraft: (draftId, expectedRevision, onCommitted) =>
      channelSetupService.finalizeChannelSetupDraft(channelSetupDeps, draftId, expectedRevision, onCommitted),
    reviewChannelSetupConnection: (draftId, input) =>
      channelSetupService.reviewChannelSetupConnection(channelSetupDeps, draftId, input),
    setChannelSetupDraftSecrets: (draftId, input) =>
      channelSetupService.setChannelSetupDraftSecrets(channelSetupDeps, draftId, input),
    discardChannelSetupDraft: async (draftId, expectedRevision) => {
      const result = await channelSetupService.discardChannelSetupDraft(channelSetupDeps, draftId, expectedRevision);
      try {
        await channelOAuth.cancelForDraft(draftId);
      } catch {
        throw Object.assign(new Error("The draft was discarded, but staged OAuth cleanup needs recovery."), {
          mutationCommitted: true,
        });
      }
      return result;
    },
    getChannelSetupDefinition: (catalogId) =>
      channelSetupService.getChannelSetupDefinition(channelSetupDeps, catalogId),
    listChannelSetupDefinitions: () => channelSetupService.listChannelSetupDefinitions(channelSetupDeps),
    listChannelSetupDrafts: (options) => channelSetupService.listChannelSetupDrafts(channelSetupDeps, options),
    getChannelSetupDraft: (draftId) => channelSetupService.getChannelSetupDraft(channelSetupDeps, draftId),
    getChannelSetupDraftEvidence: (draftId, expectedRevision) =>
      channelSetupService.getChannelSetupDraftEvidence(channelSetupDeps, draftId, expectedRevision),
    retestChannelConnection: (connectionId) =>
      channelSetupService.retestChannelConnection(channelSetupDeps, connectionId),
    testChannelSetupDraft: (draftId, expectedRevision) =>
      channelSetupService.testChannelSetupDraft(channelSetupDeps, draftId, expectedRevision),
    updateChannelSetupDraft: (draftId, input) =>
      channelSetupService.updateChannelSetupDraft(channelSetupDeps, draftId, input, {
        reconcilePublicProjection: true,
      }),
    validateChannelSetupDraft: (draftId, expectedRevision) =>
      channelSetupService.validateChannelSetupDraft(channelSetupDeps, draftId, expectedRevision),
    discoverChannelSetupTelegramTargets: (input) =>
      channelSetupService.discoverChannelSetupTelegramTargets(channelSetupDeps, input),
    checkDiscordSetup: (input) => channelSetupService.checkDiscordSetup(channelSetupDeps, input),
    checkSlackSetup: (input) => channelSetupService.checkSlackSetup(channelSetupDeps, input),
    checkWhatsAppSetup: (input) =>
      channelSetupService.checkWhatsAppSetup(channelSetupDeps, whatsAppSetupListener, input),
    subscribeWhatsAppSetupApp: (input) => channelSetupService.subscribeWhatsAppSetupApp(channelSetupDeps, input),
    acknowledgeChannelSetupTest: (draftId, input, actorId) =>
      channelSetupService.acknowledgeChannelSetupTest(channelSetupDeps, draftId, input, actorId),
    getChannelSetupJourney: (connectionId) =>
      channelSetupService.getChannelSetupJourney(channelSetupDeps, connectionId),
    startSlackOAuthAttempt: (actor, input, config) => channelOAuth.start(actor, input, config),
    getChannelOAuthAttempt: (actor, input) => channelOAuth.status(actor, input),
    completeSlackOAuthAttempt: (state, config, code, denied) => channelOAuth.callback(state, config, code, denied),
    adoptSlackOAuthAttempt: (actor, input, onCommitted) => channelOAuth.adopt(actor, input, onCommitted),
    cancelChannelOAuthAttempt: (actor, input) => channelOAuth.cancel(actor, input),
    cleanupChannelOAuthAttempts: () => channelOAuth.cleanupExpired(),
    recoverInterruptedChannelOAuthAttempts: () => channelOAuth.recoverInterrupted(),
  });
  const commsDeps = createCommsHostForGateway(gateway, integrationChannel);
  const comms = createCommsRoutePort({
    // `own` is the route's own-delivery option (an operator send), never part of the request body.
    commsCalendarCreate: (input, own) => commsCalendarCreateImpl(commsDeps, input, undefined, own),
    commsCalendarList: (input, own) => commsCalendarListImpl(commsDeps, input, own),
    commsActivity: (input) => commsActivityImpl(commsDeps, input),
    commsGmailRead: (input, own) => commsGmailReadImpl(commsDeps, input, own),
    commsGmailSend: (input, own) => commsGmailSendImpl(commsDeps, input, undefined, own),
    commsReact: (input, own) => commsReactImpl(commsDeps, input, own),
    commsReply: (input, own) => gateway.commsReply(input, own),
    commsSend: (input, own) => gateway.commsSend(input, own),
    commsTyping: (input) => commsTypingImpl(commsDeps, input),
    commsUnsend: (input, own) => commsUnsendImpl(commsDeps, input, own),
    getIntegrationConnectionChannelCapabilities: (connectionId) =>
      integrationChannel.getIntegrationConnectionChannelCapabilities(connectionId),
    getIntegrationConnectionChannelRuntimeStatus: (connectionId) =>
      integrationChannel.getIntegrationConnectionChannelRuntimeStatus(connectionId),
    listChannelDeliveryRuntime: () => gateway.listChannelDeliveryRuntime(),
    runIntegrationConnectionDiagnostics: (connectionId) =>
      integrationChannel.runIntegrationConnectionDiagnostics(connectionId),
  });
  const listIntegrationCatalog = async (kind?: IntegrationKind): Promise<IntegrationCatalogEntry[]> => {
    const mapped: IntegrationCatalogEntry[] = [
      ...INTEGRATION_CATALOG.map((entry) => ({
        ...entry,
        maturity: resolveIntegrationCatalogMaturity(entry),
        runtimeAvailability: resolveIntegrationCatalogRuntimeAvailability(entry),
      })),
      ...externalConnectorCatalog.listIntegrationCatalogEntries(),
    ];
    return kind ? mapped.filter((entry) => entry.kind === kind) : mapped;
  };
  const requireNotificationRouting = () => gateway.requireFeatureEnabled("notificationRoutingV1Enabled");
  const googleSignIn = gateway.googleWorkspaceOAuth;
  const integrations = createIntegrationRoutePort({
    approveDiscordPairing: (connectionId, pairingId) =>
      integrationChannel.approveDiscordPairing(connectionId, pairingId),
    createIntegrationConnection: (input, onCommitted) =>
      integrationChannel.createIntegrationConnection(input, onCommitted),
    deleteIntegrationConnection: (connectionId, expectedRevision, onCommitted) =>
      googleSignIn.deleteConnection(
        connectionId,
        () => integrationChannel.deleteIntegrationConnection(connectionId, expectedRevision, onCommitted),
        (error) => reportGoogleSignInCleanupFailure(gateway, connectionId, error),
      ),
    getIntegrationConnection: (connectionId) => integrationChannel.getIntegrationConnection(connectionId),
    // Resolved per call, like every other dependency here, so a narrow test port need not carry it.
    getGoogleWorkspaceOAuthStatus: (connectionId) => googleSignIn.getStatus(connectionId),
    startGoogleWorkspaceOAuth: (connectionId, input) => googleSignIn.start(connectionId, input),
    completeGoogleWorkspaceOAuth: (connectionId, input) => googleSignIn.complete(connectionId, input),
    disconnectGoogleWorkspaceOAuth: (connectionId) => googleSignIn.disconnect(connectionId),
    getIntegrationFormSchema: async (catalogId) => readIntegrationFormSchema(catalogId),
    getExternalConnectorAction: (sourceId, serviceId, actionId, workspaceId) =>
      externalConnectorCatalog.getAction(sourceId, serviceId, actionId, workspaceId),
    getExternalConnectorService: (sourceId, serviceId, workspaceId) =>
      externalConnectorCatalog.getService(sourceId, serviceId, workspaceId),
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
    listNotificationDeliveries: async (workspaceId, limit) => {
      await requireNotificationRouting();
      return notificationRouting.listDeliveries(workspaceId, limit);
    },
    listNotificationRules: async (workspaceId, includeArchived) => {
      await requireNotificationRouting();
      return notificationRouting.listRules(workspaceId, includeArchived);
    },
    listNotificationTargets: async (workspaceId, includeArchived) => {
      await requireNotificationRouting();
      return notificationRouting.listTargets(workspaceId, includeArchived);
    },
    createNotificationRule: async (workspaceId, input) => {
      await requireNotificationRouting();
      return notificationRouting.createRule(workspaceId, input);
    },
    createNotificationTarget: async (workspaceId, input) => {
      await requireNotificationRouting();
      return notificationRouting.createTarget(workspaceId, input);
    },
    dispatchNotificationEvent: async (workspaceId, input) => {
      await requireNotificationRouting();
      return notificationRouting.dispatch(workspaceId, input);
    },
    requestNotification: async (workspaceId, input) => {
      await requireNotificationRouting();
      return notificationRouting.request(workspaceId, input);
    },
    sendTestNotification: async (workspaceId, targetId) => {
      await requireNotificationRouting();
      return notificationRouting.sendTest(workspaceId, targetId);
    },
    updateNotificationRule: async (workspaceId, ruleId, expectedRevision, input) => {
      await requireNotificationRouting();
      return notificationRouting.updateRule(workspaceId, ruleId, expectedRevision, input);
    },
    updateNotificationTarget: async (workspaceId, targetId, expectedRevision, input) => {
      await requireNotificationRouting();
      return notificationRouting.updateTarget(workspaceId, targetId, expectedRevision, input);
    },
    upsertNotificationPresence: async (input) => {
      await requireNotificationRouting();
      return notificationRouting.upsertPresence(input);
    },
    reconnectDiscordRuntime: (connectionId) => integrationChannel.reconnectDiscordRuntime(connectionId),
    revokeDiscordPairing: (connectionId, pairingId) => integrationChannel.revokeDiscordPairing(connectionId, pairingId),
    runIntegrationConnectionDiagnostics: (connectionId) =>
      integrationChannel.runIntegrationConnectionDiagnostics(connectionId),
    stageExternalConnectorAction: (sourceId, serviceId, actionId, input) =>
      externalConnectorCatalog.stageAction({ sourceId, serviceId, actionId }, input),
    updateExternalConnectorReviewState: (lookup, patch) => externalConnectorCatalog.updateReviewState(lookup, patch),
    updateIntegrationConnection: (connectionId, input, onCommitted) =>
      integrationChannel.updateIntegrationConnection(connectionId, input, onCommitted),
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
      await gateway.publishRealtime("system", "integrations", {
        type: "obsidian_test_completed",
        enabled: status.enabled,
        vaultReachable: status.vaultReachable,
        lastError: status.lastError,
        checkedAt: status.checkedAt,
      });
      return status;
    },
    updateObsidianIntegrationConfig: async (input) => {
      const updated = await gateway.obsidianVaultService.updateConfig(input);
      await gateway.publishRealtime("system", "integrations", {
        type: "obsidian_config_updated",
        enabled: updated.enabled,
        mode: updated.mode,
        vaultPath: updated.vaultPath,
        allowedSubpaths: updated.allowedSubpaths,
      });
      return updated;
    },
  });

  const integrationWebhooks = createIntegrationWebhookRoutePort({
    acceptInboundChannelEvent: (input) => gateway.acceptInboundChannelEvent(input),
    acceptInboundChannelEvents: (inputs) => gateway.acceptInboundChannelEvents(inputs),
    answerWhatsAppSetupCheck: (draftId, query) => whatsAppSetupListener.answerCheck(draftId, query),
    awaitInboundChannelCommandResult: (eventId) => gateway.awaitInboundChannelCommandResult(eventId),
    findRemoteActionTokenId: (token) => gateway.findRemoteActionTokenId(token),
    getIntegrationConnection: (connectionId) => integrationChannel.getIntegrationConnection(connectionId),
    cancelLatestActiveChatTurnForSession: (sessionId, cancelledBy) =>
      gateway.cancelLatestActiveChatTurnForSession(sessionId, cancelledBy),
    hasRunningTurn: (sessionId) => gateway.hasRunningTurn(sessionId),
    hearWhatsAppSetupDelivery: (draftId, rawBody, signature) =>
      whatsAppSetupListener.hearDelivery(draftId, rawBody, signature),
    ingestChannelMessage: (channel, idempotencyKey, input) =>
      gateway.ingestChannelMessage(channel, idempotencyKey, input),
    isVoiceInboundEnabled: async () => (await gateway.isFeatureEnabled("channelVoiceInboundV1Enabled")) === true,
    transcribeChannelVoice: (input, owner) => channelVoiceInbound.transcribe(input, owner),
    parseChatCommand: (sessionId, commandText, options) => gateway.parseChatCommand(sessionId, commandText, options),
    recordDevDiagnostic: (input) => gateway.recordDevDiagnostic(input),
    emitChannelActivity: (input) => gateway.commsActivity(input),
    respondToExistingChatMessage: (sessionId, messageId, input) =>
      gateway.respondToExistingChatMessage(sessionId, messageId, input),
    // A signed webhook is checked against the key the connection saved at setup, never its reference. The port is
    // bound to the connection: another connection's reference, a draft's and plain text all give no key.
    resolveChannelConnectionSecret: (connectionId: string, secretRef: string): string | undefined =>
      createConnectionSecretReferenceResolver(connectionId, (ownReference, owner) =>
        gateway.resolveConnectionSecret({ ref: ownReference }, "ref", "refEnv", "channel.webhook", owner),
      )(secretRef),
    resolveApprovalWithRemoteToken: (input) => gateway.resolveApprovalWithRemoteToken(input),
    resolveApprovalWithRemoteTokenId: (input) => gateway.resolveApprovalWithRemoteTokenId(input),
    // A desk send into a channel conversation; the durable desk question is an inbound channel event.
    sendOperatorDeskMessage: (sessionId, input) => gateway.sendOperatorDeskMessage(sessionId, input),
    setChatSessionBinding: (input) => gateway.setChatSessionBinding(input),
    updateIntegrationConnection: (connectionId, patch) =>
      integrationChannel.updateIntegrationConnection(connectionId, patch),
  });
  // Telegram polling and Slack Socket Mode handle an update exactly as their webhook routes do, through this same port.
  provideChannelUpdateDeps(gateway, {
    webhooks: integrationWebhooks,
    readPersonalityCatalog: async () => gateway.personalityCatalogService.getCatalog(),
  });

  return {
    channelSetup,
    comms,
    connectors: {
      listConnectorRecords: async (connectorType) =>
        filterConnectorRecords(
          buildGatewayConnectorRecords({
            integrationConnections: await gateway.storage.integrationConnections.list(undefined, 1000),
            mcpServers: await gateway.readMcpServers(),
            mcpTools: await gateway.readMcpTools(),
          }),
          connectorType,
        ),
    },
    integrations,
    integrationWebhooks,
    obsidian,
  };
}

export function createNotificationRoutingServiceForGateway(
  gateway: GatewayRouteCompositionPort,
): NotificationRoutingService {
  const integrationChannel = createIntegrationChannelServiceForGateway(gateway);
  return new NotificationRoutingService({
    repository: gateway.storage.notificationRouting,
    normalizeWorkspaceId: (workspaceId) => gateway.normalizeWorkspaceId(workspaceId),
    getIntegrationConnection: (connectionId) => integrationChannel.getIntegrationConnection(connectionId),
    deliver: (target, event, idempotencyKey) => deliverNotificationForGateway(gateway, target, event, idempotencyKey),
    publishRealtime: async (eventType, source, payload, options) => {
      await gateway.publishRealtime(eventType, source, payload, options);
    },
  });
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

export async function deliverNotificationToChannel(
  gateway: Pick<GatewayRouteCompositionPort, "commsSend"> & {
    storage: {
      integrationConnections: Pick<GatewayRouteCompositionPort["storage"]["integrationConnections"], "get">;
    };
  },
  target: NotificationTarget,
  event: NotificationEventRecord,
  idempotencyKey: string,
): Promise<NotificationDeliveryAdapterResult> {
  const connectionId = target.channelConnectionId;
  if (!connectionId) return { status: "failed", lastError: "Channel connection is unavailable." };
  const connection = await gateway.storage.integrationConnections.get(connectionId);
  if (connection.workspaceId && connection.workspaceId !== event.workspaceId) {
    return { status: "failed", lastError: "Channel connection belongs to another workspace." };
  }
  const channelTarget =
    resolveChannelConfigTarget(connection.key, connection.config) ?? readConfiguredChannelTarget(connection.config);
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
    surface: "tools",
  });
  const status = readResultStatus(result);
  if (status === "failed" || status === "blocked") {
    return { status: "failed", attemptCount: 1, lastError: "Channel delivery was rejected or failed." };
  }
  if (status === "queued" || status === "pending") return { status: "pending", attemptCount: 1 };
  return { status: "delivered", attemptCount: 1 };
}

export async function deliverNotificationToWebhook(
  gateway: GatewayRouteCompositionPort,
  target: NotificationTarget,
  event: NotificationEventRecord,
  idempotencyKey: string,
): Promise<NotificationDeliveryAdapterResult> {
  const secretStore = gateway.secretStore;
  if (!secretStore?.isAvailable()) return { status: "failed", lastError: "OS keychain is unavailable." };
  if (!target.webhookUrlSecretRef) return { status: "failed", lastError: "Webhook destination is unavailable." };
  // Both references are checked before any keychain read: a target never reaches a non-notification entry.
  const urlAccount = accountFromNotificationSecretRef(target.webhookUrlSecretRef, "webhookUrlSecretRef");
  const credentialAccount = target.credentialSecretRef
    ? accountFromNotificationSecretRef(target.credentialSecretRef, "credentialSecretRef")
    : undefined;
  const urlValue = secretStore.getSecret(urlAccount);
  if (!urlValue) return { status: "failed", lastError: "Webhook destination secret is unavailable." };
  const url = parseAllowedNotificationWebhookUrl(urlValue, (candidate) =>
    gateway.isConnectionUrlAllowlisted(candidate),
  );
  const credential = credentialAccount ? secretStore.getSecret(credentialAccount) : undefined;

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
        await claim.markExternalCallStarted();
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
    resolveConnectionSecret: (config, directKey, envKey, catalogId, owner) =>
      gateway.resolveConnectionSecret(config, directKey, envKey, catalogId, owner),
    getGoogleWorkspaceOAuthStatus: (connectionId) => gateway.googleWorkspaceOAuth.getStatus(connectionId),
  });
}

/** Shared construction point for routes, Change Plan adapters, and startup reconciliation. */
export function createChannelSetupHostForGateway(
  gateway: GatewayRouteCompositionPort,
  integrationDiagnostics = createIntegrationDiagnosticsServiceForGateway(gateway),
  integrationChannel = createIntegrationChannelServiceForGateway(gateway, integrationDiagnostics),
): channelSetupService.ChannelSetupHost {
  return {
    ...composeChannelSetupHost(gateway, integrationDiagnostics, integrationChannel),
    fetchWithTimeout: (url, init) => gateway.fetchWithDiagnosticsTimeout(url, init),
    isConnectionUrlAllowlisted: (url) => gateway.isConnectionUrlAllowlisted(url),
    resolveConnectionSecret: (config, directKey, envKey, catalogId, owner) =>
      gateway.resolveConnectionSecret(config, directKey, envKey, catalogId, owner),
    getChannelCapabilities: (id) => integrationChannel.getIntegrationConnectionChannelCapabilities(id),
    getChannelRuntimeStatus: (id) => integrationChannel.getIntegrationConnectionChannelRuntimeStatus(id),
    listChannelDeliveries: async (id) =>
      (await gateway.storage.commsDeliveries.list(id, 100)).map((item) => ({
        deliveryId: item.deliveryId,
        status: item.deliveryStatus ?? item.status,
        providerMessageId: item.providerMessageId,
        updatedAt: item.updatedAt,
      })),
  };
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
  const storage = gateway.storage;
  const discordRuntimeService = gateway.discordRuntimeService;
  const channelSecretStore = gateway.channelSecretStore;
  const streams = getChannelStreamRuntime(gateway);
  return {
    storage,
    ...(channelSecretStore ? { channelSecrets: new ChannelSecretCustodyService(channelSecretStore) } : {}),
    publishRealtime: async (eventType, source, payload, options) => {
      await gateway.publishRealtime(eventType, source, payload, options);
    },
    requireFeatureEnabled: async (flag) => {
      await gateway.requireFeatureEnabled(flag);
    },
    isFeatureEnabled: async (flag) => await gateway.isFeatureEnabled(flag),
    buildIntegrationConnectionChecks: (connection) =>
      integrationDiagnostics.buildIntegrationConnectionChecks(connection),
    runIntegrationConnectionLiveChecks: (connection, options) =>
      integrationDiagnostics.runIntegrationConnectionLiveChecks(connection, options),
    pickConnectorDiagnosticAction: (checks) => connectorDiagnosticsHelpers.pickConnectorDiagnosticAction(checks),
    recordConnectorHealthRun: async (report) => {
      await connectorDiagnosticsHelpers.recordConnectorHealthRun({ gatewaySql: storage.gatewaySql }, report);
    },
    syncChannelRuntimes: async () => {
      await gateway.syncDiscordRuntime();
      try {
        await streams.sync();
      } catch (error) {
        gateway.recordDevDiagnostic({
          level: "warn",
          category: "channels",
          event: "channel.stream.sync_failed",
          message: "Channel stream runtime sync failed.",
          context: { error: (error as Error).message },
        });
      }
    },
    getChannelStreamRuntimeStatus: (connectionId) => streams.getStatus(connectionId),
    getDiscordRuntimeStatus: (connectionId) => discordRuntimeService.getConnectionStatus(connectionId),
    latestAcceptedInboundAt: (channelKey, connectionId) =>
      storage.inboundChannelEvents.latestAcceptedAt(channelKey, connectionId),
    getIntegrationConnection: (connectionId) => storage.integrationConnections.get(connectionId),
    assertDiscordConnection,
    readDiscordPairings: async () => gateway.readDiscordPairings(),
    writeDiscordPairings: async (records) => {
      await gateway.writeDiscordPairings(records);
    },
    discordRuntimeService,
    resolveConnectionSecret: (config, directKey, envKey, catalogId, owner) =>
      gateway.resolveConnectionSecret(config, directKey, envKey, catalogId, owner),
    readConnectionConfigValue: (config, key) => gateway.readConnectionConfigValue(config, key),
    isConnectionUrlAllowlisted: (urlValue) => gateway.isConnectionUrlAllowlisted(urlValue),
    fetchWithDiagnosticsTimeout: (url, init) => gateway.fetchWithDiagnosticsTimeout(url, init),
    recordDevDiagnostic: (entry) => gateway.recordDevDiagnostic(entry),
  };
}

export function createCommsHostForGateway(
  gateway: GatewayRouteCompositionPort,
  integrationChannel = createIntegrationChannelServiceForGateway(gateway),
): CommsHost {
  return {
    invokeAndUnwrap: (...args) => gateway.invokeAndUnwrap(...args),
    readChatAttachmentContent: (attachmentId) => readChatAttachmentContentForGateway(gateway, attachmentId),
    getIntegrationConnection: (connectionId) => integrationChannel.getIntegrationConnection(connectionId),
    emitDiscordTyping: (connection, input) =>
      gateway.discordRuntimeService.sendTyping(connection.connectionId, input.target, input.durationMs, input.signal),
    emitProviderTyping: (connection, input) => integrationChannel.emitProviderTyping(connection, input),
    emitChannelActivity: (connection, input, options) =>
      integrationChannel.emitChannelActivity(connection, input, options),
    mutationStore: gateway.mutationIdempotencyStore,
    sideEffectRunStore: gateway.storage.externalSideEffectRuns,
  };
}

function readIntegrationFormSchema(catalogId: string) {
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
}

function assertDiscordConnection(connection: IntegrationConnection): void {
  if (connection.kind !== "channel" || connection.key !== "discord") {
    throw new Error("Integration connection is not a Discord channel");
  }
}

/** The connection is already gone; its Google sign-in could not be revoked or removed from the OS keychain. */
function reportGoogleSignInCleanupFailure(
  gateway: GatewayRouteCompositionPort,
  connectionId: string,
  error: unknown,
): void {
  gateway.recordDevDiagnostic({
    level: "warn",
    category: "integrations",
    event: "google_workspace.sign_in_cleanup_failed",
    message: "A deleted Google connection left its sign-in in the OS keychain or at Google.",
    context: { connectionId, errorName: error instanceof Error ? error.name : "unknown" },
  });
}

/**
 * The replay key (shared by integration replay records and the Citadel Ward request vault) stays out
 * of the OS keychain until the operator approves minting it there. Its sealed-record guard counts
 * replay records but not sealed Ward approvals, so a lookup miss after a restart could replace the key
 * and strand pending Ward approvals. Until then nothing is sealed: replays cannot be rebuilt and
 * Ward-gated actions stay blocked, as before.
 */
const HELD_REPLAY_KEY_STORE = undefined;

/**
 * The single construction site for the integration-action host. Used by the route
 * composition above AND by the gateway's approved dry-run commit replay, so the two
 * callers can never drift apart on which gateway capabilities the action runtime sees.
 */
export function buildIntegrationActionHostForGateway(gateway: GatewayRouteCompositionPort): IntegrationActionHost {
  const { storage } = gateway;
  return {
    storage,
    fetchWithDiagnosticsTimeout: (url, init) => gateway.fetchWithDiagnosticsTimeout(url, init),
    readConnectionConfigValue: (config, key) => gateway.readConnectionConfigValue(config, key),
    resolveConnectionSecret: (config, directKey, envKey, catalogId, owner) =>
      gateway.resolveConnectionSecret(config, directKey, envKey, catalogId, owner),
    publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload),
    resolveGoogleWorkspaceAccessToken: (connectionId, capability) =>
      gateway.googleWorkspaceOAuth.resolveAccessToken(connectionId, capability),
    evidenceEnvelopeService: gateway.evidenceEnvelopeService,
    mutationStore: gateway.mutationIdempotencyStore,
    sideEffectRunStore: storage.externalSideEffectRuns,
    replayRecords: createExternalSideEffectReplayRecords({
      resolveKey: sharedExternalSideEffectReplayKeyResolver(HELD_REPLAY_KEY_STORE, storage.externalSideEffectRuns),
      runs: storage.externalSideEffectRuns,
    }),
    createApproval: (input) => gateway.createApproval(input),
    citadelWardRequests: buildCitadelWardRequestVaultForGateway(gateway),
  };
}

/**
 * The single construction site for the Citadel Ward request vault: it seals ward approval
 * requests under the same replay key custody (secret store + sealed-record guard) as the
 * integration host's replay records, for the integration host, the A2A route service and
 * the approval executor alike. Its key resolver rethrows a key-store failure, so opening an
 * approved request retries a transient outage instead of failing the approval.
 */
export function buildCitadelWardRequestVaultForGateway(gateway: GatewayRouteCompositionPort): CitadelWardRequestVault {
  return createCitadelWardRequestVault(
    sharedExternalSideEffectReplayKeyResolverOrThrow(HELD_REPLAY_KEY_STORE, gateway.storage.externalSideEffectRuns),
  );
}
