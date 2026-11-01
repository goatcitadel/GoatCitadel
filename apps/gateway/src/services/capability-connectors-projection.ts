import {
  CAPABILITY_CONNECTOR_GROUP_ORDER,
  GOOGLE_WORKSPACE_CATALOG_ID,
  hasMcpOAuthEndpointSource,
  type CapabilityConnectorAuth,
  type CapabilityConnectorGroup,
  type CapabilityConnectorItem,
  type CapabilityConnectorReason,
  type CapabilityConnectorState,
  type GoogleWorkspaceOAuthStatus,
  type IntegrationCatalogEntry,
  type IntegrationConnection,
  type McpServerRecord,
  type McpServerTemplateRecord,
  type WebSearchCredentialStatus,
  type WebSearchCredentialTargetId,
} from "@goatcitadel/contracts";
import { isListedIntegration } from "./capability-connectors-integrations.js";
import { isMoneyMovingCatalogServer, mcpServerLabelKey as labelKey } from "./mcp-money-moving.js";

/** Templates that are internal to GoatCitadel or duplicate a built-in tool, so they are not apps to list. */
export const EXCLUDED_CONNECTOR_TEMPLATE_IDS: ReadonlySet<string> = new Set([
  "approval-inbox",
  "durable-tasks",
  "filesystem",
  "fetch",
]);

export interface CapabilityConnectorsProjectionInput {
  /** Already filtered by `isVisibleMcpTemplateRecord`. */
  templates: readonly McpServerTemplateRecord[];
  /** Gateway-owned servers (`GATEWAY_OWNED_MCP_SERVER_IDS`) already removed. */
  servers: readonly McpServerRecord[];
  integrationCatalog: readonly IntegrationCatalogEntry[];
  connections: readonly IntegrationConnection[];
  googleStatusByConnectionId: ReadonlyMap<string, GoogleWorkspaceOAuthStatus>;
  webSearch: readonly WebSearchCredentialStatus[];
  /** `selfHosted`: the Firecrawl address is the operator's own server, which needs no key. */
  firecrawl: { enabled: boolean; selfHosted: boolean };
  hiddenServerIds: ReadonlySet<string>;
  hiddenConnectionIds: ReadonlySet<string>;
  chat: { staticMcp: boolean; durableExecution: boolean };
}

interface Verdict {
  state: CapabilityConnectorState;
  reason: CapabilityConnectorReason;
}

/** Everything an item carries except what the shared finishing step derives from the state and the hidden sets. */
type ItemParts = Omit<CapabilityConnectorItem, "group" | "hiddenInWorkspace">;

const WEB_SEARCH_ROWS: Readonly<Record<WebSearchCredentialTargetId, { name: string; description: string }>> = {
  "search.firecrawl": { name: "Firecrawl", description: "Search the web and read pages with Firecrawl." },
  "search.brave": { name: "Brave Search", description: "Search the web with your Brave Search key." },
  "search.parallel": { name: "Parallel", description: "Search the web with your Parallel key." },
};

const FIRECRAWL_NOT_ALLOWLISTED_MESSAGE = "Firecrawl's address isn't on the allowed list";

/** Lower ranks come first inside a group: things that need attention, then the rest. */
const STATE_RANK: Readonly<Record<CapabilityConnectorState, number>> = {
  broken: 0,
  sign_in_expired: 1,
  needs_sign_in: 2,
  connected: 3,
  available: 3,
  turned_off: 3,
};

/** Merges MCP templates and servers, listed integrations and web search keys into one connector list. Pure: no I/O. */
export function buildCapabilityConnectors(input: CapabilityConnectorsProjectionInput): CapabilityConnectorItem[] {
  const templates = input.templates.filter((template) => !EXCLUDED_CONNECTOR_TEMPLATE_IDS.has(template.templateId));
  const templatesByLabel = new Map<string, McpServerTemplateRecord>();
  for (const template of templates) {
    const key = labelKey(template.label);
    if (!templatesByLabel.has(key)) {
      templatesByLabel.set(key, template);
    }
  }
  const serversPerLabel = new Map<string, number>();
  for (const server of input.servers) {
    const key = labelKey(server.label);
    serversPerLabel.set(key, (serversPerLabel.get(key) ?? 0) + 1);
  }
  const savedLabels = new Set(serversPerLabel.keys());

  const parts: ItemParts[] = [
    ...templates
      .filter((template) => !savedLabels.has(labelKey(template.label)))
      .map((template) => templateParts(template, input)),
    ...input.servers.map((server) => {
      const key = labelKey(server.label);
      // Several servers saved from one template share its label; each is then told apart by its own.
      const sharesTemplateLabel = templatesByLabel.has(key) && (serversPerLabel.get(key) ?? 0) > 1;
      return serverParts(server, templatesByLabel.get(key), input, sharesTemplateLabel);
    }),
    ...integrationParts(input),
    ...input.webSearch.map((status) => webSearchParts(status, input)),
  ];

  return parts.map((item) => finish(item, input)).sort(compareItems);
}

function templateParts(template: McpServerTemplateRecord, input: CapabilityConnectorsProjectionInput): ItemParts {
  const verdict = templateVerdict(template);
  const command = stdioCommand(template);
  return {
    id: `mcp-template:${template.templateId}`,
    name: template.label,
    description: template.description,
    kind: "mcp",
    source: "mcp_template",
    category: template.category,
    ...verdict,
    auth: mcpAuth(template.authType),
    runsOnThisDevice: template.transport === "stdio",
    ...(command ? { command } : {}),
    networkHosts: [...(template.networkHosts ?? [])],
    templateId: template.templateId,
    ...(template.riskNotes?.length ? { riskNotes: [...template.riskNotes] } : {}),
    ...(template.movesMoney ? { movesMoney: true } : {}),
    chat: mcpChat(input.chat),
  };
}

function serverParts(
  server: McpServerRecord,
  template: McpServerTemplateRecord | undefined,
  input: CapabilityConnectorsProjectionInput,
  shareTemplateLabel: boolean,
): ItemParts {
  const verdict = serverVerdict(server);
  const command = stdioCommand(server);
  return {
    id: `mcp-server:${server.serverId}`,
    // The template's label names a server only when it is the one server that matches it.
    name: shareTemplateLabel ? server.label : (template?.label ?? server.label),
    description: template?.description ?? "",
    kind: "mcp",
    source: "mcp_server",
    category: template?.category ?? server.category,
    ...verdict,
    auth: mcpAuth(server.authType),
    runsOnThisDevice: server.transport === "stdio",
    ...(command ? { command } : {}),
    networkHosts: savedServerHosts(server, template),
    ...(template ? { templateId: template.templateId } : {}),
    serverId: server.serverId,
    ...(server.revision !== undefined ? { serverRevision: server.revision } : {}),
    ...(server.connectionRevision !== undefined ? { serverConnectionRevision: server.connectionRevision } : {}),
    ...(server.policy.approvalPosture ? { approvalPosture: server.policy.approvalPosture } : {}),
    ...(server.connectionMode === "requester_scoped" ? { requesterScoped: true } : {}),
    // The same rule, against the same whole catalog, as the Gateway's write lock and its decision of a call. Not the
    // visible list, which leaves some templates out.
    ...(isMoneyMovingCatalogServer(server) ? { movesMoney: true } : {}),
    chat: mcpChat(input.chat),
    ...(server.lastError ? { lastError: server.lastError } : {}),
    // The plugin that saved it, from the server's own record; the install that added it stays in the Gateway.
    ...(server.pluginOwner
      ? { fromPlugin: { pluginId: server.pluginOwner.pluginId, name: server.pluginOwner.name } }
      : {}),
  };
}

/**
 * Where a saved server connects. A remote server names the host of its own saved endpoint, which the operator may have
 * pointed away from the template's (a proxy, a self-hosted copy); an endpoint that can't be read names none rather than
 * the template's. A server that runs on this computer has no endpoint, so it keeps the hosts its template declares.
 */
function savedServerHosts(server: McpServerRecord, template: McpServerTemplateRecord | undefined): string[] {
  if (server.transport === "stdio") return [...(template?.networkHosts ?? [])];
  if (!server.url) return [];
  try {
    return [new URL(server.url).host];
  } catch {
    return [];
  }
}

function integrationParts(input: CapabilityConnectorsProjectionInput): ItemParts[] {
  return input.integrationCatalog.filter(isListedIntegration).flatMap((entry) => {
    const connections = input.connections.filter((connection) => connection.catalogId === entry.catalogId);
    if (connections.length === 0) {
      return [integrationEntryParts(entry)];
    }
    const tellApart = connections.length > 1;
    return connections.map((connection) =>
      integrationConnectionParts(
        entry,
        connection,
        input.googleStatusByConnectionId.get(connection.connectionId),
        tellApart,
      ),
    );
  });
}

/** Rows of one catalog entry share its name, so several connections are told apart by their own label. */
function connectionRowName(entry: IntegrationCatalogEntry, connection: IntegrationConnection): string {
  const label = connection.label.trim() || connection.connectionId.slice(-6);
  return `${entry.label} · ${label}`;
}

function integrationEntryParts(entry: IntegrationCatalogEntry): ItemParts {
  return {
    ...integrationBaseParts(entry),
    id: `integration:${entry.catalogId}`,
    state: "available",
    reason: "not_installed",
  };
}

function integrationConnectionParts(
  entry: IntegrationCatalogEntry,
  connection: IntegrationConnection,
  google: GoogleWorkspaceOAuthStatus | undefined,
  tellApart: boolean,
): ItemParts {
  return {
    ...integrationBaseParts(entry),
    ...(tellApart ? { name: connectionRowName(entry, connection) } : {}),
    id: `integration:${connection.connectionId}`,
    ...connectionVerdict(connection, entry.catalogId === GOOGLE_WORKSPACE_CATALOG_ID ? google : undefined),
    connectionId: connection.connectionId,
    ...(connection.lastError ? { lastError: connection.lastError } : {}),
  };
}

/** What a catalog row and a connection row share. The caller sets the id, state and reason. */
function integrationBaseParts(entry: IntegrationCatalogEntry): Omit<ItemParts, "id" | "state" | "reason"> {
  const isChannel = entry.kind === "channel";
  return {
    name: entry.label,
    description: entry.description,
    kind: isChannel ? "channel" : "built_in",
    source: "integration",
    category: isChannel ? "messaging" : "automation",
    auth: integrationAuth(entry),
    runsOnThisDevice: false,
    networkHosts: [],
    catalogId: entry.catalogId,
    chat: { available: true },
  };
}

function webSearchParts(status: WebSearchCredentialStatus, input: CapabilityConnectorsProjectionInput): ItemParts {
  const row = WEB_SEARCH_ROWS[status.targetId];
  return {
    id: `web-search:${status.targetId}`,
    name: row.name,
    description: row.description,
    kind: "built_in",
    source: "web_search",
    category: "search",
    ...webSearchVerdict(status, input.firecrawl),
    auth: "api_key",
    runsOnThisDevice: false,
    networkHosts: status.endpointHost ? [status.endpointHost] : [],
    chat: { available: true },
  };
}

function templateVerdict(template: McpServerTemplateRecord): Verdict {
  if (template.authType === "token") {
    return { state: "available", reason: "needs_api_key" };
  }
  if (template.authType === "oauth2" && !hasMcpOAuthEndpointSource(template.oauth)) {
    return { state: "available", reason: "missing_sign_in_setup" };
  }
  return { state: "available", reason: "not_installed" };
}

function serverVerdict(server: McpServerRecord): Verdict {
  if (!server.enabled) {
    return { state: "turned_off", reason: "turned_off" };
  }
  const readiness = server.authState?.readiness;
  if (readiness === "needs_auth") {
    return { state: "needs_sign_in", reason: "sign_in_needed" };
  }
  if (readiness === "expired") {
    return { state: "sign_in_expired", reason: "sign_in_expired" };
  }
  // The saved server has no way to sign in at all, so it can never work until its sign-in setup is fixed.
  if (readiness === "missing_oauth_config") {
    return { state: "broken", reason: "missing_sign_in_setup" };
  }
  if (server.status === "error") {
    return { state: "broken", reason: "error" };
  }
  return { state: "connected", reason: "ready" };
}

/**
 * A connection the operator turned off or paused stays turned off, whatever its sign-in says. A Google connection
 * then reports its own sign-in before the generic connection status, because Google keeps that outside the row. With
 * no Google status to read, the generic connection status decides, so a disconnected or failing one is not hidden.
 */
function connectionVerdict(connection: IntegrationConnection, google: GoogleWorkspaceOAuthStatus | undefined): Verdict {
  if (!connection.enabled || connection.status === "paused") {
    return { state: "turned_off", reason: "turned_off" };
  }
  if (google?.requiresReauth) {
    return { state: "sign_in_expired", reason: "sign_in_expired" };
  }
  if (google && !google.connected) {
    return { state: "needs_sign_in", reason: "sign_in_needed" };
  }
  if (connection.status === "error") {
    return { state: "broken", reason: "error" };
  }
  if (connection.status === "disconnected") {
    return { state: "needs_sign_in", reason: "not_connected" };
  }
  return { state: "connected", reason: "ready" };
}

/**
 * A key makes a search engine ready. Firecrawl is different: a self-hosted Firecrawl needs no key, and it also has an
 * on/off switch and a configurable address. Once usable, it reads turned off when the switch is off and broken when the
 * address is not on the network allowlist.
 */
function webSearchVerdict(
  status: WebSearchCredentialStatus,
  firecrawl: CapabilityConnectorsProjectionInput["firecrawl"],
): Verdict & { lastError?: string } {
  const hasKey = status.activeSource !== "none";
  if (status.targetId !== "search.firecrawl") {
    return hasKey ? { state: "connected", reason: "ready" } : { state: "available", reason: "needs_api_key" };
  }
  if (!hasKey && !firecrawl.selfHosted) {
    return { state: "available", reason: "needs_api_key" };
  }
  if (!firecrawl.enabled) {
    return { state: "turned_off", reason: "turned_off" };
  }
  if (!status.endpointAllowlisted) {
    return { state: "broken", reason: "error", lastError: FIRECRAWL_NOT_ALLOWLISTED_MESSAGE };
  }
  return { state: "connected", reason: "ready" };
}

function stdioCommand(definition: Pick<McpServerRecord, "transport" | "command" | "args">): string | undefined {
  if (definition.transport !== "stdio" || !definition.command) {
    return undefined;
  }
  return [definition.command, ...(definition.args ?? [])].join(" ");
}

function mcpAuth(authType: McpServerRecord["authType"]): CapabilityConnectorAuth {
  if (authType === "token") {
    return "api_key";
  }
  return authType === "oauth2" ? "oauth" : "none";
}

function integrationAuth(entry: IntegrationCatalogEntry): CapabilityConnectorAuth {
  if (entry.catalogId === GOOGLE_WORKSPACE_CATALOG_ID) {
    return "google";
  }
  // Channels connect with a bot token or webhook secret; IMAP/SMTP and webhooks keep a saved secret too.
  return entry.kind === "channel" ? "bot_token" : "api_key";
}

function mcpChat(chat: CapabilityConnectorsProjectionInput["chat"]): CapabilityConnectorItem["chat"] {
  if (chat.staticMcp) {
    return { available: true };
  }
  return { available: false, blockedBy: chat.durableExecution ? "mcp_in_chat_off" : "background_runs_off" };
}

function finish(parts: ItemParts, input: CapabilityConnectorsProjectionInput): CapabilityConnectorItem {
  const hiddenServer = parts.serverId !== undefined && input.hiddenServerIds.has(parts.serverId);
  const hiddenConnection = parts.connectionId !== undefined && input.hiddenConnectionIds.has(parts.connectionId);
  return {
    ...parts,
    group: groupFor(parts.state, parts.runsOnThisDevice),
    hiddenInWorkspace: hiddenServer || hiddenConnection,
  };
}

function groupFor(state: CapabilityConnectorState, runsOnThisDevice: boolean): CapabilityConnectorGroup {
  if (state === "turned_off") {
    return "turned_off";
  }
  if (state === "available") {
    return runsOnThisDevice ? "on_this_device" : "available";
  }
  return "connected";
}

function compareItems(left: CapabilityConnectorItem, right: CapabilityConnectorItem): number {
  return (
    CAPABILITY_CONNECTOR_GROUP_ORDER.indexOf(left.group) - CAPABILITY_CONNECTOR_GROUP_ORDER.indexOf(right.group) ||
    STATE_RANK[left.state] - STATE_RANK[right.state] ||
    left.name.localeCompare(right.name, "en", { sensitivity: "base" }) ||
    left.id.localeCompare(right.id, "en")
  );
}
