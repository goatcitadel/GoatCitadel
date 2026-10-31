import type { ChannelRuntimeStatus, NotificationClientPresenceLease, NotificationRule } from "@goatcitadel/contracts";

import type { IntegrationConnection } from "./types.js";

import { request } from "./client-core.js";

/** Compatibility name; OAuth starts require the exact owner binding. */
export { startStagedSlackOAuth as startSlackOAuth } from "./channel-oauth.js";

export async function fetchIntegrationConnections(
  kind?: IntegrationConnection["kind"],
): Promise<{ items: IntegrationConnection[] }> {
  const query = kind ? `?kind=${encodeURIComponent(kind)}&limit=300` : "?limit=300";
  return request(`/api/v1/integrations/connections${query}`);
}

export async function fetchNotificationRules(
  workspaceId: string,
  includeArchived = false,
): Promise<{ items: NotificationRule[] }> {
  const params = new URLSearchParams({ workspaceId });
  if (includeArchived) params.set("includeArchived", "true");
  return request(`/api/v1/notifications/rules?${params.toString()}`);
}

export async function upsertNotificationPresence(input: {
  workspaceId: string;
  leaseId?: string;
  clientId: string;
  sessionId?: string;
  focused: boolean;
  visible: boolean;
  ttlMs?: number;
}): Promise<NotificationClientPresenceLease> {
  return request("/api/v1/notifications/presence", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function fetchChannelRuntimeStatus(connectionId: string): Promise<ChannelRuntimeStatus> {
  return request<ChannelRuntimeStatus>(`/api/v1/comms/runtime/${encodeURIComponent(connectionId)}`);
}

// Optional destination operations retain their public bindings and shared request owner.
export {
  discardChannelSetupDraft,
  fetchIntegrationCatalog,
  fetchChannelSetupDefinitions,
  fetchChannelSetupDefinition,
  fetchChannelSetupDrafts,
  createChannelSetupDraft,
  fetchChannelSetupDraft,
  reviewChannelSetupConnection,
  updateChannelSetupDraft,
  submitChannelSetupDraftSecrets,
  validateChannelSetupDraft,
  testChannelSetupDraft,
  finalizeChannelSetupDraft,
  createChannelRepairDraft,
  createChannelRotateSecretDraft,
  retestChannelConnection,
  fetchSlackOAuthStatus,
  discoverTelegramTargets,
  fetchChannelTargetDirectory,
  fetchChannelPersonalities,
  fetchIntegrationFormSchema,
  fetchExternalSideEffectRuns,
  fetchNotificationTargets,
  createNotificationTarget,
  updateNotificationTarget,
  sendTestNotification,
  createNotificationRule,
  updateNotificationRule,
  fetchNotificationDeliveries,
  fetchExternalConnectorSources,
  fetchExternalConnectorServices,
  fetchExternalConnectorService,
  fetchExternalConnectorAction,
  updateExternalConnectorServiceReviewState,
  updateExternalConnectorActionReviewState,
  stageExternalConnectorAction,
  fetchConnectorRecords,
  createIntegrationConnection,
  updateIntegrationConnection,
  fetchIntegrationConnection,
  deleteIntegrationConnection,
  fetchIntegrationConnectionDiagnostics,
  invokeIntegrationConnectionAction,
  commsSend,
  commsReply,
  commsReact,
  commsUnsend,
  commsTyping,
  fetchChannelCapabilities,
  fetchChannelDiagnostics,
  commsGmailRead,
  commsGmailSend,
  commsCalendarList,
  commsCalendarCreate,
  fetchDiscordPairings,
  approveDiscordPairing,
  revokeDiscordPairing,
  reconnectDiscordRuntime,
  fetchObsidianIntegrationStatus,
  patchObsidianIntegrationConfig,
  testObsidianIntegration,
  searchObsidianNotes,
  readObsidianNote,
  appendObsidianNote,
  captureObsidianInboxEntry,
} from "./integrations-operations.js";
