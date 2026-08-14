import type {
  CalendarCreateEventInput,
  CalendarListQuery,
  ChannelCapabilities,
  ChannelTargetDirectory,
  ChannelTargetResolution,
  ChannelReactInput,
  ChannelReplyInput,
  ChannelRuntimeStatus,
  ChannelSendInput,
  ChannelSetupDefinition,
  ChannelSetupDraft,
  ChannelSetupDraftCreateInput,
  ChannelSetupDraftUpdateInput,
  ChannelSetupFinalizeResult,
  ChannelSetupTestResult,
  ChannelSetupValidationResult,
  ChannelTypingInput,
  ChannelTypingResult,
  ChannelUnsendInput,
  ConnectorDiagnosticReport,
  ConnectorRecord,
  DiscordPairingRecord,
  DiscordRuntimeStatus,
  ExternalConnectorActionSummary,
  ExternalConnectorReviewStatePatchInput,
  ExternalConnectorReviewStateRecord,
  ExternalConnectorServiceDetail,
  ExternalConnectorServiceListQuery,
  ExternalConnectorServiceSummary,
  ExternalConnectorSourceSnapshot,
  ExternalConnectorStageActionInput,
  ExternalConnectorStageActionResult,
  ExternalSideEffectRunListQuery,
  ExternalSideEffectRunListResponse,
  GmailReadQuery,
  GmailSendInput,
  IntegrationActionInvokeInput,
  IntegrationActionInvokeResult,
  IntegrationFormSchema,
  IntegrationPluginRecord,
  ObsidianIntegrationConfig,
  ObsidianIntegrationStatus,
  NotificationClientPresenceLease,
  NotificationDeliveryRecord,
  NotificationDispatchResult,
  NotificationRule,
  NotificationRuleInput,
  NotificationTarget,
  NotificationTargetInput,
  ToolInvokeResult,
  PersonalityPreset,
} from "@goatcitadel/contracts";

import type { IntegrationCatalogEntry, IntegrationConnection } from "./types.js";

import { request } from "./client-core.js";

export async function fetchIntegrationCatalog(
  kind?: IntegrationCatalogEntry["kind"],
): Promise<{ items: IntegrationCatalogEntry[] }> {
  const query = kind ? `?kind=${encodeURIComponent(kind)}` : "";
  return request(`/api/v1/integrations/catalog${query}`);
}

export async function fetchChannelSetupDefinitions(): Promise<{ items: ChannelSetupDefinition[] }> {
  return request<{ items: ChannelSetupDefinition[] }>("/api/v1/channels/setup-definitions");
}

export async function fetchChannelSetupDefinition(catalogId: string): Promise<ChannelSetupDefinition> {
  return request<ChannelSetupDefinition>(`/api/v1/channels/catalog/${encodeURIComponent(catalogId)}/setup-definition`);
}

export async function fetchChannelSetupDrafts(query?: {
  catalogId?: string;
  connectionId?: string;
  limit?: number;
}): Promise<{ items: ChannelSetupDraft[] }> {
  const params = new URLSearchParams();
  if (query?.catalogId) {
    params.set("catalogId", query.catalogId);
  }
  if (query?.connectionId) {
    params.set("connectionId", query.connectionId);
  }
  if (typeof query?.limit === "number") {
    params.set("limit", String(query.limit));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return request<{ items: ChannelSetupDraft[] }>(`/api/v1/channels/drafts${suffix}`);
}

export async function createChannelSetupDraft(input: ChannelSetupDraftCreateInput): Promise<ChannelSetupDraft> {
  return request<ChannelSetupDraft>("/api/v1/channels/drafts", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateChannelSetupDraft(
  draftId: string,
  input: ChannelSetupDraftUpdateInput,
): Promise<ChannelSetupDraft> {
  return request<ChannelSetupDraft>(`/api/v1/channels/drafts/${encodeURIComponent(draftId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function submitChannelSetupDraftSecrets(
  draftId: string,
  input: { expectedRevision: number; values: Record<string, string> },
): Promise<ChannelSetupDraft> {
  return request<ChannelSetupDraft>(`/api/v1/channels/drafts/${encodeURIComponent(draftId)}/secure-fields`, {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify(input),
  });
}

export async function validateChannelSetupDraft(
  draftId: string,
  expectedRevision: number,
): Promise<ChannelSetupValidationResult> {
  return request<ChannelSetupValidationResult>(`/api/v1/channels/drafts/${encodeURIComponent(draftId)}/validate`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision }),
  });
}

export async function testChannelSetupDraft(
  draftId: string,
  expectedRevision: number,
): Promise<ChannelSetupTestResult> {
  return request<ChannelSetupTestResult>(`/api/v1/channels/drafts/${encodeURIComponent(draftId)}/test`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision }),
  });
}

export async function finalizeChannelSetupDraft(
  draftId: string,
  expectedRevision: number,
): Promise<ChannelSetupFinalizeResult> {
  return request<ChannelSetupFinalizeResult>(`/api/v1/channels/drafts/${encodeURIComponent(draftId)}/finalize`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision }),
  });
}

export async function createChannelRepairDraft(connectionId: string): Promise<ChannelSetupDraft> {
  return request<ChannelSetupDraft>(`/api/v1/channels/connections/${encodeURIComponent(connectionId)}/repair-draft`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function createChannelRotateSecretDraft(connectionId: string): Promise<ChannelSetupDraft> {
  return request<ChannelSetupDraft>(
    `/api/v1/channels/connections/${encodeURIComponent(connectionId)}/rotate-secret-draft`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function retestChannelConnection(connectionId: string): Promise<ChannelSetupTestResult> {
  return request<ChannelSetupTestResult>(`/api/v1/channels/connections/${encodeURIComponent(connectionId)}/retest`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchSlackOAuthStatus(): Promise<{
  configured: boolean;
  mode: "hosted" | "self_owned" | "missing";
  scopes: string[];
  missing: string[];
  connections: Array<{ connection: IntegrationConnection; install: Record<string, unknown> }>;
}> {
  return request("/api/v1/integrations/slack/oauth/status");
}

export async function startSlackOAuth(): Promise<{
  authorizationUrl: string;
  state: string;
  configured: boolean;
  mode: "hosted" | "self_owned";
  scopes: string[];
}> {
  return request("/api/v1/integrations/slack/oauth/start", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function discoverTelegramTargets(input: {
  connectionId?: string;
  botToken?: string;
  botTokenEnv?: string;
  setupCode?: string;
}): Promise<{ items: Array<{ id: string; label: string; chatId: string; kind: string; setupCodeMatched?: boolean }> }> {
  return request("/api/v1/integrations/telegram/discover-targets", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchChannelTargetDirectory(
  connectionId: string,
  query?: { refresh?: boolean; query?: string },
): Promise<{ directory: ChannelTargetDirectory; resolution?: ChannelTargetResolution }> {
  const params = new URLSearchParams();
  if (query?.refresh) {
    params.set("refresh", "true");
  }
  if (query?.query) {
    params.set("query", query.query);
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return request(`/api/v1/channels/connections/${encodeURIComponent(connectionId)}/target-directory${suffix}`);
}

export async function fetchChannelPersonalities(): Promise<{ items: PersonalityPreset[] }> {
  return request("/api/v1/channels/personalities");
}

export async function fetchIntegrationFormSchema(catalogId: string): Promise<IntegrationFormSchema> {
  return request<IntegrationFormSchema>(`/api/v1/integrations/catalog/${encodeURIComponent(catalogId)}/form-schema`);
}

export async function fetchIntegrationConnections(
  kind?: IntegrationConnection["kind"],
): Promise<{ items: IntegrationConnection[] }> {
  const query = kind ? `?kind=${encodeURIComponent(kind)}&limit=300` : "?limit=300";
  return request(`/api/v1/integrations/connections${query}`);
}

export async function fetchExternalSideEffectRuns(
  query?: ExternalSideEffectRunListQuery,
): Promise<ExternalSideEffectRunListResponse> {
  const params = new URLSearchParams();
  if (query?.workspaceId) {
    params.set("workspaceId", query.workspaceId);
  }
  if (query?.connectionId) {
    params.set("connectionId", query.connectionId);
  }
  if (typeof query?.limit === "number") {
    params.set("limit", String(Math.min(Math.max(Math.trunc(query.limit), 1), 500)));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return request<ExternalSideEffectRunListResponse>(`/api/v1/integrations/external-side-effects${suffix}`);
}

export async function fetchNotificationTargets(
  workspaceId: string,
  includeArchived = false,
): Promise<{ items: NotificationTarget[] }> {
  const params = new URLSearchParams({ workspaceId });
  if (includeArchived) params.set("includeArchived", "true");
  return request(`/api/v1/notifications/targets?${params.toString()}`);
}

export async function createNotificationTarget(
  workspaceId: string,
  target: NotificationTargetInput,
): Promise<NotificationTarget> {
  return request("/api/v1/notifications/targets", {
    method: "POST",
    body: JSON.stringify({ workspaceId, target }),
  });
}

export async function updateNotificationTarget(
  workspaceId: string,
  targetId: string,
  expectedRevision: number,
  target: NotificationTargetInput,
): Promise<NotificationTarget> {
  return request(`/api/v1/notifications/targets/${encodeURIComponent(targetId)}`, {
    method: "PATCH",
    body: JSON.stringify({ workspaceId, expectedRevision, target }),
  });
}

export async function sendTestNotification(workspaceId: string, targetId: string): Promise<NotificationDispatchResult> {
  return request(`/api/v1/notifications/targets/${encodeURIComponent(targetId)}/test`, {
    method: "POST",
    body: JSON.stringify({ workspaceId }),
  });
}

export async function fetchNotificationRules(workspaceId: string): Promise<{ items: NotificationRule[] }> {
  return request(`/api/v1/notifications/rules?workspaceId=${encodeURIComponent(workspaceId)}`);
}

export async function createNotificationRule(
  workspaceId: string,
  rule: NotificationRuleInput,
): Promise<NotificationRule> {
  return request("/api/v1/notifications/rules", {
    method: "POST",
    body: JSON.stringify({ workspaceId, rule }),
  });
}

export async function updateNotificationRule(
  workspaceId: string,
  ruleId: string,
  expectedRevision: number,
  rule: NotificationRuleInput,
): Promise<NotificationRule> {
  return request(`/api/v1/notifications/rules/${encodeURIComponent(ruleId)}`, {
    method: "PATCH",
    body: JSON.stringify({ workspaceId, expectedRevision, rule }),
  });
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

export async function fetchNotificationDeliveries(
  workspaceId: string,
  limit = 50,
): Promise<{ items: NotificationDeliveryRecord[] }> {
  const params = new URLSearchParams({ workspaceId, limit: String(limit) });
  return request(`/api/v1/notifications/deliveries?${params.toString()}`);
}

export async function fetchExternalConnectorSources(): Promise<{ items: ExternalConnectorSourceSnapshot[] }> {
  return request<{ items: ExternalConnectorSourceSnapshot[] }>("/api/v1/integrations/external-connectors/sources");
}

export async function fetchExternalConnectorServices(
  query?: ExternalConnectorServiceListQuery,
): Promise<{ items: ExternalConnectorServiceSummary[] }> {
  const params = new URLSearchParams();
  if (query?.workspaceId) {
    params.set("workspaceId", query.workspaceId);
  }
  if (query?.search) {
    params.set("search", query.search);
  }
  if (query?.status) {
    params.set("status", query.status);
  }
  if (query?.includeActions !== undefined) {
    params.set("includeActions", query.includeActions ? "true" : "false");
  }
  if (typeof query?.limit === "number") {
    params.set("limit", String(Math.min(Math.max(Math.trunc(query.limit), 1), 1000)));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return request<{ items: ExternalConnectorServiceSummary[] }>(
    `/api/v1/integrations/external-connectors/services${suffix}`,
  );
}

export async function fetchExternalConnectorService(
  sourceId: string,
  serviceId: string,
  query?: { workspaceId?: string },
): Promise<ExternalConnectorServiceDetail> {
  const params = new URLSearchParams();
  if (query?.workspaceId) {
    params.set("workspaceId", query.workspaceId);
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return request<ExternalConnectorServiceDetail>(
    `/api/v1/integrations/external-connectors/services/${encodeURIComponent(sourceId)}/${encodeURIComponent(serviceId)}${suffix}`,
  );
}

export async function fetchExternalConnectorAction(
  sourceId: string,
  serviceId: string,
  actionId: string,
  query?: { workspaceId?: string },
): Promise<ExternalConnectorActionSummary> {
  const params = new URLSearchParams();
  if (query?.workspaceId) {
    params.set("workspaceId", query.workspaceId);
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return request<ExternalConnectorActionSummary>(
    `/api/v1/integrations/external-connectors/services/${encodeURIComponent(sourceId)}/${encodeURIComponent(serviceId)}/actions/${encodeURIComponent(actionId)}${suffix}`,
  );
}

export async function updateExternalConnectorServiceReviewState(
  sourceId: string,
  serviceId: string,
  input: ExternalConnectorReviewStatePatchInput,
): Promise<ExternalConnectorReviewStateRecord> {
  return request<ExternalConnectorReviewStateRecord>(
    `/api/v1/integrations/external-connectors/services/${encodeURIComponent(sourceId)}/${encodeURIComponent(serviceId)}/review`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
}

export async function updateExternalConnectorActionReviewState(
  sourceId: string,
  serviceId: string,
  actionId: string,
  input: ExternalConnectorReviewStatePatchInput,
): Promise<ExternalConnectorReviewStateRecord> {
  return request<ExternalConnectorReviewStateRecord>(
    `/api/v1/integrations/external-connectors/services/${encodeURIComponent(sourceId)}/${encodeURIComponent(serviceId)}/actions/${encodeURIComponent(actionId)}/review`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
}

export async function stageExternalConnectorAction(
  sourceId: string,
  serviceId: string,
  actionId: string,
  input: ExternalConnectorStageActionInput = {},
): Promise<ExternalConnectorStageActionResult> {
  return request<ExternalConnectorStageActionResult>(
    `/api/v1/integrations/external-connectors/services/${encodeURIComponent(sourceId)}/${encodeURIComponent(serviceId)}/actions/${encodeURIComponent(actionId)}/stage`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function fetchConnectorRecords(
  connectorType?: ConnectorRecord["connectorType"],
): Promise<{ items: ConnectorRecord[] }> {
  const query = connectorType ? `?connectorType=${encodeURIComponent(connectorType)}` : "";
  return request<{ items: ConnectorRecord[] }>(`/api/v1/connectors${query}`);
}

export async function createIntegrationConnection(input: {
  catalogId: string;
  label?: string;
  enabled?: boolean;
  status?: IntegrationConnection["status"];
  config?: Record<string, unknown>;
}): Promise<IntegrationConnection> {
  return request("/api/v1/integrations/connections", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateIntegrationConnection(
  connectionId: string,
  input: {
    label?: string;
    enabled?: boolean;
    status?: IntegrationConnection["status"];
    config?: Record<string, unknown>;
    lastSyncAt?: string;
    lastError?: string;
  },
): Promise<IntegrationConnection> {
  return request(`/api/v1/integrations/connections/${encodeURIComponent(connectionId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deleteIntegrationConnection(connectionId: string): Promise<{ deleted: boolean }> {
  return request(`/api/v1/integrations/connections/${encodeURIComponent(connectionId)}`, {
    method: "DELETE",
    body: JSON.stringify({}),
  });
}

export async function fetchIntegrationConnectionDiagnostics(connectionId: string): Promise<ConnectorDiagnosticReport> {
  return request<ConnectorDiagnosticReport>(
    `/api/v1/integrations/connections/${encodeURIComponent(connectionId)}/diagnostics`,
  );
}

export async function invokeIntegrationConnectionAction(
  connectionId: string,
  actionId: string,
  input: IntegrationActionInvokeInput = {},
): Promise<IntegrationActionInvokeResult> {
  return request<IntegrationActionInvokeResult>(
    `/api/v1/integrations/connections/${encodeURIComponent(connectionId)}/actions/${encodeURIComponent(actionId)}`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function commsSend(input: ChannelSendInput): Promise<ToolInvokeResult | Record<string, unknown>> {
  return request<ToolInvokeResult | Record<string, unknown>>("/api/v1/comms/send", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function commsReply(input: ChannelReplyInput): Promise<ToolInvokeResult | Record<string, unknown>> {
  return request<ToolInvokeResult | Record<string, unknown>>("/api/v1/comms/reply", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function commsReact(input: ChannelReactInput): Promise<ToolInvokeResult | Record<string, unknown>> {
  return request<ToolInvokeResult | Record<string, unknown>>("/api/v1/comms/react", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function commsUnsend(input: ChannelUnsendInput): Promise<ToolInvokeResult | Record<string, unknown>> {
  return request<ToolInvokeResult | Record<string, unknown>>("/api/v1/comms/unsend", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function commsTyping(input: ChannelTypingInput): Promise<ChannelTypingResult> {
  return request<ChannelTypingResult>("/api/v1/comms/typing", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchChannelCapabilities(connectionId: string): Promise<ChannelCapabilities> {
  return request<ChannelCapabilities>(`/api/v1/comms/capabilities/${encodeURIComponent(connectionId)}`);
}

export async function fetchChannelRuntimeStatus(connectionId: string): Promise<ChannelRuntimeStatus> {
  return request<ChannelRuntimeStatus>(`/api/v1/comms/runtime/${encodeURIComponent(connectionId)}`);
}

export async function fetchChannelDiagnostics(connectionId: string): Promise<ConnectorDiagnosticReport> {
  return request<ConnectorDiagnosticReport>(`/api/v1/comms/diagnostics/${encodeURIComponent(connectionId)}`);
}

export async function commsGmailRead(input: GmailReadQuery): Promise<ToolInvokeResult | Record<string, unknown>> {
  return request<ToolInvokeResult | Record<string, unknown>>("/api/v1/comms/gmail/read", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function commsGmailSend(input: GmailSendInput): Promise<ToolInvokeResult | Record<string, unknown>> {
  return request<ToolInvokeResult | Record<string, unknown>>("/api/v1/comms/gmail/send", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function commsCalendarList(input: CalendarListQuery): Promise<ToolInvokeResult | Record<string, unknown>> {
  return request<ToolInvokeResult | Record<string, unknown>>("/api/v1/comms/calendar/list", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function commsCalendarCreate(
  input: CalendarCreateEventInput,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  return request<ToolInvokeResult | Record<string, unknown>>("/api/v1/comms/calendar/create", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchDiscordPairings(connectionId: string): Promise<{
  runtime?: DiscordRuntimeStatus;
  items: DiscordPairingRecord[];
}> {
  return request<{
    runtime?: DiscordRuntimeStatus;
    items: DiscordPairingRecord[];
  }>(`/api/v1/integrations/connections/${encodeURIComponent(connectionId)}/discord/pairings`);
}

export async function approveDiscordPairing(connectionId: string, pairingId: string): Promise<DiscordPairingRecord> {
  return request<DiscordPairingRecord>(
    `/api/v1/integrations/connections/${encodeURIComponent(connectionId)}/discord/pairings/${encodeURIComponent(pairingId)}/approve`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function revokeDiscordPairing(connectionId: string, pairingId: string): Promise<DiscordPairingRecord> {
  return request<DiscordPairingRecord>(
    `/api/v1/integrations/connections/${encodeURIComponent(connectionId)}/discord/pairings/${encodeURIComponent(pairingId)}/revoke`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function reconnectDiscordRuntime(connectionId: string): Promise<DiscordRuntimeStatus | undefined> {
  return request<DiscordRuntimeStatus | undefined>(
    `/api/v1/integrations/connections/${encodeURIComponent(connectionId)}/discord/reconnect`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function fetchIntegrationPlugins(): Promise<{ items: IntegrationPluginRecord[] }> {
  return request<{ items: IntegrationPluginRecord[] }>("/api/v1/integrations/plugins");
}

export async function installIntegrationPlugin(input: {
  source: string;
  pluginId?: string;
  sourceType?: "local" | "npm" | "git" | "url" | "manual" | "unknown";
  expectedIntegrity?: string;
}): Promise<IntegrationPluginRecord> {
  return request<IntegrationPluginRecord>("/api/v1/integrations/plugins/install", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function enableIntegrationPlugin(pluginId: string): Promise<IntegrationPluginRecord> {
  return request<IntegrationPluginRecord>(`/api/v1/integrations/plugins/${encodeURIComponent(pluginId)}/enable`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function disableIntegrationPlugin(pluginId: string): Promise<IntegrationPluginRecord> {
  return request<IntegrationPluginRecord>(`/api/v1/integrations/plugins/${encodeURIComponent(pluginId)}/disable`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchObsidianIntegrationStatus(): Promise<ObsidianIntegrationStatus> {
  return request<ObsidianIntegrationStatus>("/api/v1/integrations/obsidian/status");
}

export async function patchObsidianIntegrationConfig(
  input: Partial<ObsidianIntegrationConfig>,
): Promise<ObsidianIntegrationConfig> {
  return request<ObsidianIntegrationConfig>("/api/v1/integrations/obsidian/config", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function testObsidianIntegration(): Promise<ObsidianIntegrationStatus> {
  return request<ObsidianIntegrationStatus>("/api/v1/integrations/obsidian/test", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function searchObsidianNotes(input: {
  query: string;
  limit?: number;
}): Promise<{ items: Array<{ relativePath: string; title: string; snippet: string; score: number }> }> {
  return request<{ items: Array<{ relativePath: string; title: string; snippet: string; score: number }> }>(
    "/api/v1/integrations/obsidian/search",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function readObsidianNote(pathValue: string): Promise<{ relativePath: string; content: string }> {
  return request<{ relativePath: string; content: string }>(
    `/api/v1/integrations/obsidian/note?path=${encodeURIComponent(pathValue)}`,
  );
}

export async function appendObsidianNote(input: {
  path: string;
  markdownBlock: string;
}): Promise<{ relativePath: string; appendedAt: string }> {
  return request<{ relativePath: string; appendedAt: string }>("/api/v1/integrations/obsidian/append", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function captureObsidianInboxEntry(input: {
  id: string;
  request: string;
  type?: string;
  priority?: string;
  neededBy?: string;
  owner?: string;
  state?: string;
  taskLink?: string;
  decisionLink?: string;
  notes?: string;
}): Promise<{ relativePath: string; appendedAt: string; row: string }> {
  return request<{ relativePath: string; appendedAt: string; row: string }>(
    "/api/v1/integrations/obsidian/inbox/capture",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}
