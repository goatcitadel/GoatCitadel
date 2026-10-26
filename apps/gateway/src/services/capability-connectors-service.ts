import {
  GOOGLE_WORKSPACE_CATALOG_ID,
  type CapabilityConnectorSource,
  type CapabilityConnectorsIssue,
  type CapabilityConnectorsResponse,
  type CapabilityScopeView,
  type GoogleWorkspaceOAuthStatus,
  type IntegrationCatalogEntry,
  type IntegrationConnection,
  type McpServerRecord,
  type McpServerTemplateRecord,
  type WebSearchCredentialStatus,
} from "@goatcitadel/contracts";
import { buildCapabilityConnectors } from "./capability-connectors-projection.js";
import { projectIntegrationConnectionsForPublicResponse } from "./integration-connection-public-projection.js";
import { projectMcpPublicValue } from "./mcp-public-projection.js";
import { GATEWAY_OWNED_MCP_SERVER_IDS } from "./mcp-server-state-helpers.js";

type MaybePromise<T> = T | Promise<T>;

/** Resource types whose workspace selection decides whether a row is hidden. */
export type CapabilityConnectorScopeResource = "mcp_server" | "integration";

/** One reader per place the list is built from. Each is read through its existing owner and none touches the network. */
export interface CapabilityConnectorsSources {
  /** Already limited to the templates the runtime supports. */
  listMcpTemplates(): Promise<readonly McpServerTemplateRecord[]>;
  listMcpServers(): Promise<readonly McpServerRecord[]>;
  listIntegrationCatalog(): Promise<readonly IntegrationCatalogEntry[]>;
  listIntegrationConnections(): Promise<readonly IntegrationConnection[]>;
  /** Local read of the stored Google sign-in; Google is never contacted. */
  getGoogleWorkspaceOAuthStatus(connectionId: string): Promise<GoogleWorkspaceOAuthStatus>;
  listWebSearchStatuses(): MaybePromise<readonly WebSearchCredentialStatus[]>;
  readFirecrawlSettings(): Promise<{ enabled: boolean; baseUrl: string }>;
  readChatAvailability(): Promise<{ staticMcp: boolean; durableExecution: boolean }>;
  /** Whether a saved server's approval setting can let a call run on its own on this install (never on remote_hardened). */
  isApprovalReliefAvailable(): boolean;
  /** The refs the workspace can use once its own selection and its Citadel's are both applied. */
  getWorkspaceScope(
    workspaceId: string,
    resourceType: CapabilityConnectorScopeResource,
  ): Promise<Pick<CapabilityScopeView, "effectiveRefs">>;
}

/** Called with the real error of a failed source read, so the response can carry plain wording only. */
export type CapabilityConnectorsFailureReporter = (source: CapabilityConnectorSource, error: unknown) => void;

const HOSTED_FIRECRAWL_HOST = "api.firecrawl.dev";

const ISSUE_MESSAGES = {
  templates: "Couldn't load the apps you can add.",
  servers: "Couldn't read your saved apps.",
  integrations: "Couldn't read your connected services.",
  google: "Couldn't check your Google sign-in.",
  webSearch: "Couldn't read your web search keys.",
  firecrawl: "Couldn't read the Firecrawl settings.",
  chat: "Couldn't check whether the AI can use these apps in Chat.",
  workspace: "Couldn't check which apps are hidden in this workspace.",
} as const;

/** Reads every connector source, tolerating a failed one, and hands the result to `buildCapabilityConnectors`. */
export class CapabilityConnectorsService {
  public constructor(
    private readonly sources: CapabilityConnectorsSources,
    private readonly reportFailure?: CapabilityConnectorsFailureReporter,
  ) {}

  public async list(workspaceId: string): Promise<CapabilityConnectorsResponse> {
    const issues: CapabilityConnectorsIssue[] = [];
    const read = async <T, F>(
      source: CapabilityConnectorSource,
      message: string,
      fallback: F,
      load: () => MaybePromise<T>,
    ): Promise<T | F> => {
      try {
        return await load();
      } catch (error) {
        this.reportFailure?.(source, error);
        if (!issues.some((issue) => issue.source === source && issue.message === message)) {
          issues.push({ source, message });
        }
        return fallback;
      }
    };

    const [
      templates,
      rawServers,
      integrationCatalog,
      rawConnections,
      webSearch,
      firecrawl,
      chat,
      serverScope,
      connectionScope,
    ] = await Promise.all([
      read("mcp_template", ISSUE_MESSAGES.templates, [], () => this.sources.listMcpTemplates()),
      read("mcp_server", ISSUE_MESSAGES.servers, [], () => this.sources.listMcpServers()),
      read("integration", ISSUE_MESSAGES.integrations, [], () => this.sources.listIntegrationCatalog()),
      read("integration", ISSUE_MESSAGES.integrations, [], () => this.sources.listIntegrationConnections()),
      read("web_search", ISSUE_MESSAGES.webSearch, [], () => this.sources.listWebSearchStatuses()),
      read("web_search", ISSUE_MESSAGES.firecrawl, { enabled: false, baseUrl: "" }, () =>
        this.sources.readFirecrawlSettings(),
      ),
      // When Chat availability is unknown, no MCP row may claim the AI can use it there.
      read("mcp_server", ISSUE_MESSAGES.chat, { staticMcp: false, durableExecution: false }, () =>
        this.sources.readChatAvailability(),
      ),
      read("mcp_server", ISSUE_MESSAGES.workspace, undefined, () =>
        this.sources.getWorkspaceScope(workspaceId, "mcp_server"),
      ),
      read("integration", ISSUE_MESSAGES.workspace, undefined, () =>
        this.sources.getWorkspaceScope(workspaceId, "integration"),
      ),
    ]);

    // The same secret removal as the MCP and integration list routes: saved commands, URLs and errors can carry keys.
    const servers = projectMcpPublicValue({
      items: rawServers.filter((server) => !GATEWAY_OWNED_MCP_SERVER_IDS.has(server.serverId)),
    }).items;
    const connections = projectIntegrationConnectionsForPublicResponse([...rawConnections]);

    const googleStatusByConnectionId = new Map<string, GoogleWorkspaceOAuthStatus>();
    await Promise.all(
      connections
        .filter((connection) => connection.catalogId === GOOGLE_WORKSPACE_CATALOG_ID)
        .map(async (connection) => {
          const status = await read("integration", ISSUE_MESSAGES.google, undefined, () =>
            this.sources.getGoogleWorkspaceOAuthStatus(connection.connectionId),
          );
          if (status) {
            googleStatusByConnectionId.set(connection.connectionId, status);
          }
        }),
    );

    const items = buildCapabilityConnectors({
      templates: projectMcpPublicValue({ items: templates }).items,
      servers,
      integrationCatalog,
      connections,
      googleStatusByConnectionId,
      webSearch,
      firecrawl: { enabled: firecrawl.enabled, selfHosted: isSelfHostedFirecrawl(firecrawl.baseUrl) },
      hiddenServerIds: hiddenRefs(
        servers.map((server) => server.serverId),
        serverScope,
      ),
      hiddenConnectionIds: hiddenRefs(
        connections.map((connection) => connection.connectionId),
        connectionScope,
      ),
      chat,
    });

    // The reads finish in whatever order they like; the lines the operator sees should not shuffle between refreshes.
    issues.sort(compareIssues);

    return {
      workspaceId,
      items,
      issues,
      approvalReliefAvailable: this.sources.isApprovalReliefAvailable(),
      generatedAt: new Date().toISOString(),
    };
  }
}

/** Source first, then message. Plain code-unit order, so the result does not depend on the machine's locale. */
function compareIssues(a: CapabilityConnectorsIssue, b: CapabilityConnectorsIssue): number {
  if (a.source !== b.source) {
    return a.source < b.source ? -1 : 1;
  }
  return a.message === b.message ? 0 : a.message < b.message ? -1 : 1;
}

/**
 * A ref is hidden when the workspace's effective set leaves it out. That covers a workspace that turned it off and a
 * Citadel that never offered it, which a per-item `enabled` flag would not show. An unreadable selection hides nothing.
 */
function hiddenRefs(
  knownRefs: readonly string[],
  scope: Pick<CapabilityScopeView, "effectiveRefs"> | undefined,
): Set<string> {
  if (!scope) {
    return new Set();
  }
  const effective = new Set(scope.effectiveRefs);
  return new Set(knownRefs.filter((ref) => !effective.has(ref)));
}

/** A Firecrawl address that is not the hosted API is the operator's own server, which needs no key. */
function isSelfHostedFirecrawl(baseUrl: string): boolean {
  if (!baseUrl.trim()) {
    return false;
  }
  try {
    return new URL(baseUrl).hostname !== HOSTED_FIRECRAWL_HOST;
  } catch {
    return false;
  }
}
