import type {
  CapabilityScopeView,
  DeploymentProfile,
  GoogleWorkspaceOAuthStatus,
  IntegrationCatalogEntry,
  IntegrationConnection,
  McpServerRecord,
  McpServerTemplateRecord,
  WebSearchCredentialStatus,
} from "@goatcitadel/contracts";
import type { GatewayDevDiagnosticsService } from "../dev-diagnostics/service.js";
import { CapabilityConnectorsService } from "./capability-connectors-service.js";
import { isMcpApprovalReliefAvailable } from "./mcp-approval-relief.js";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";

/** Bounds the integration connections read; the workspace selection registry reads the same number. */
const CONNECTION_READ_LIMIT = 1000;

/** The existing owner of each source the Capabilities app list reads. Each is read-only here. */
export interface CapabilityConnectorsOwners {
  mcp: {
    listMcpTemplates(): Promise<readonly McpServerTemplateRecord[]>;
    listMcpServers(): Promise<readonly McpServerRecord[]>;
  };
  integrations: {
    listIntegrationCatalog(): Promise<readonly IntegrationCatalogEntry[]>;
    listIntegrationConnections(kind: undefined, limit: number): Promise<readonly IntegrationConnection[]>;
    getGoogleWorkspaceOAuthStatus(connectionId: string): Promise<GoogleWorkspaceOAuthStatus>;
  };
  webSearchCredentials: { listStatuses(): readonly WebSearchCredentialStatus[] };
  settings: { getSettings(): Promise<Pick<RuntimeSettings, "chatFeatureAvailability" | "web">> };
  capabilityScope: {
    getView(
      scopeKind: "workspace",
      scopeId: string,
      resourceType: "mcp_server" | "integration",
    ): Promise<CapabilityScopeView>;
  };
  /** The install's deployment profile, read on every list. */
  deploymentProfile(): DeploymentProfile;
  recordDevDiagnostic(input: Parameters<GatewayDevDiagnosticsService["record"]>[0]): void;
}

/** Wires the Capabilities app list to its owners. A failed source read is logged here and shown as plain wording. */
export function composeCapabilityConnectors({
  mcp,
  integrations,
  webSearchCredentials,
  settings,
  capabilityScope,
  deploymentProfile,
  recordDevDiagnostic,
}: CapabilityConnectorsOwners): CapabilityConnectorsService {
  return new CapabilityConnectorsService(
    {
      listMcpTemplates: () => mcp.listMcpTemplates(),
      listMcpServers: () => mcp.listMcpServers(),
      listIntegrationCatalog: () => integrations.listIntegrationCatalog(),
      listIntegrationConnections: () => integrations.listIntegrationConnections(undefined, CONNECTION_READ_LIMIT),
      getGoogleWorkspaceOAuthStatus: (connectionId) => integrations.getGoogleWorkspaceOAuthStatus(connectionId),
      listWebSearchStatuses: () => webSearchCredentials.listStatuses(),
      readFirecrawlSettings: async () => (await settings.getSettings()).web.firecrawl,
      readChatAvailability: async () =>
        (await settings.getSettings()).chatFeatureAvailability ?? { staticMcp: false, durableExecution: false },
      getWorkspaceScope: (workspaceId, resourceType) => capabilityScope.getView("workspace", workspaceId, resourceType),
      isApprovalReliefAvailable: () => isMcpApprovalReliefAvailable(deploymentProfile()),
    },
    (source, error) =>
      recordDevDiagnostic({
        level: "warn",
        category: "gateway",
        event: "capability_connectors.source_unreadable",
        message: "A source of the Capabilities app list could not be read.",
        context: { source, error: error instanceof Error ? error.message : String(error) },
      }),
  );
}
