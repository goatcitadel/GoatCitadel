import type {
  CalendarCreateEventInput,
  CalendarListQuery,
  ChannelCapabilities,
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
  GmailReadQuery,
  GmailSendInput,
  IntegrationActionInvokeInput,
  IntegrationActionInvokeResult,
  IntegrationFormSchema,
  IntegrationPluginRecord,
  ObsidianIntegrationConfig,
  ObsidianIntegrationStatus,
  ToolInvokeResult,
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

export async function validateChannelSetupDraft(draftId: string): Promise<ChannelSetupValidationResult> {
  return request<ChannelSetupValidationResult>(`/api/v1/channels/drafts/${encodeURIComponent(draftId)}/validate`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function testChannelSetupDraft(draftId: string): Promise<ChannelSetupTestResult> {
  return request<ChannelSetupTestResult>(`/api/v1/channels/drafts/${encodeURIComponent(draftId)}/test`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function finalizeChannelSetupDraft(draftId: string): Promise<ChannelSetupFinalizeResult> {
  return request<ChannelSetupFinalizeResult>(`/api/v1/channels/drafts/${encodeURIComponent(draftId)}/finalize`, {
    method: "POST",
    body: JSON.stringify({}),
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

export async function fetchIntegrationFormSchema(catalogId: string): Promise<IntegrationFormSchema> {
  return request<IntegrationFormSchema>(`/api/v1/integrations/catalog/${encodeURIComponent(catalogId)}/form-schema`);
}

export async function fetchIntegrationConnections(
  kind?: IntegrationConnection["kind"],
): Promise<{ items: IntegrationConnection[] }> {
  const query = kind ? `?kind=${encodeURIComponent(kind)}&limit=300` : "?limit=300";
  return request(`/api/v1/integrations/connections${query}`);
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
