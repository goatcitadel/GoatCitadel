import { describe, expect, it, vi } from "vitest";
import type {
  CapabilityConnectorItem,
  GoogleWorkspaceOAuthStatus,
  IntegrationCatalogEntry,
  IntegrationConnection,
  McpServerPolicy,
  McpServerRecord,
  McpServerTemplateRecord,
  WebSearchCredentialStatus,
} from "@goatcitadel/contracts";
import { CapabilityConnectorsService, type CapabilityConnectorsSources } from "./capability-connectors-service.js";
import { INTEGRATION_CATALOG } from "./integration-catalog.js";

function policy(): McpServerPolicy {
  return { requireFirstToolApproval: true, redactionMode: "basic", allowedToolPatterns: [], blockedToolPatterns: [] };
}

function template(overrides: Partial<McpServerTemplateRecord> = {}): McpServerTemplateRecord {
  return {
    templateId: "linear",
    label: "Linear",
    description: "Issues and projects.",
    transport: "http",
    url: "https://mcp.linear.app/mcp",
    authType: "none",
    category: "development",
    trustTier: "restricted",
    costTier: "free",
    policy: policy(),
    enabledByDefault: false,
    ...overrides,
  };
}

function server(overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    serverId: "server-notes",
    revision: "rev-1",
    connectionRevision: "conn-1",
    label: "Notes",
    transport: "http",
    url: "https://notes.example.test/mcp",
    authType: "none",
    enabled: true,
    status: "connected",
    category: "research",
    trustTier: "restricted",
    costTier: "free",
    policy: policy(),
    createdAt: "2026-10-25T00:00:00.000Z",
    updatedAt: "2026-10-25T00:00:00.000Z",
    ...overrides,
  };
}

function catalogEntry(catalogId: string): IntegrationCatalogEntry {
  const entry = INTEGRATION_CATALOG.find((candidate) => candidate.catalogId === catalogId);
  if (!entry) {
    throw new Error(`${catalogId} is not in INTEGRATION_CATALOG`);
  }
  return entry;
}

function connection(catalogId: string, overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  const entry = catalogEntry(catalogId);
  return {
    connectionId: `conn-${entry.key}`,
    revision: "rev-1",
    catalogId,
    kind: entry.kind,
    key: entry.key,
    label: `My ${entry.label}`,
    enabled: true,
    status: "connected",
    config: {},
    createdAt: "2026-10-25T00:00:00.000Z",
    updatedAt: "2026-10-25T00:00:00.000Z",
    ...overrides,
  };
}

function googleStatus(overrides: Partial<GoogleWorkspaceOAuthStatus> = {}): GoogleWorkspaceOAuthStatus {
  return {
    connectionId: "conn-gmail",
    keychainAvailable: true,
    clientIdConfigured: true,
    clientSecretSource: "keychain",
    redirectUri: "http://127.0.0.1:8787/oauth/google/callback",
    connected: true,
    requiresReauth: false,
    grantedScopes: [],
    capabilities: [],
    legacyAccessTokenConfigured: false,
    ...overrides,
  };
}

function searchStatus(
  targetId: WebSearchCredentialStatus["targetId"],
  overrides: Partial<WebSearchCredentialStatus> = {},
): WebSearchCredentialStatus {
  return {
    targetId,
    label: targetId,
    endpointHost: "api.example.test",
    endpointAllowlisted: true,
    keychainAvailable: true,
    keychainConfigured: true,
    envNames: [],
    envConfigured: false,
    activeSource: "keychain",
    acquisitionUrl: "https://example.test/keys",
    ...overrides,
  };
}

/** Healthy sources by default: one saved server, one Gmail connection, no web search keys. */
function sources(overrides: Partial<CapabilityConnectorsSources> = {}): CapabilityConnectorsSources {
  return {
    listMcpTemplates: vi.fn(async () => [template()]),
    listMcpServers: vi.fn(async () => [server()]),
    listIntegrationCatalog: vi.fn(async () => [catalogEntry("automation.gmail")]),
    listIntegrationConnections: vi.fn(async () => [connection("automation.gmail")]),
    getGoogleWorkspaceOAuthStatus: vi.fn(async () => googleStatus()),
    listWebSearchStatuses: vi.fn(() => [searchStatus("search.brave")]),
    readFirecrawlSettings: vi.fn(async () => ({ enabled: true, baseUrl: "https://api.firecrawl.dev" })),
    readChatAvailability: vi.fn(async () => ({ staticMcp: true, durableExecution: true })),
    getWorkspaceScope: vi.fn(async (_workspaceId, resourceType) => ({
      effectiveRefs: resourceType === "mcp_server" ? ["server-notes"] : ["conn-gmail"],
    })),
    ...overrides,
  };
}

function byId(items: readonly CapabilityConnectorItem[], id: string): CapabilityConnectorItem {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) {
    throw new Error(`no item ${id} in ${items.map((candidate) => candidate.id).join(", ")}`);
  }
  return item;
}

describe("CapabilityConnectorsService", () => {
  it("returns items from healthy sources and an issue for the failing one", async () => {
    const service = new CapabilityConnectorsService(
      sources({
        listWebSearchStatuses: vi.fn(() => {
          throw new Error("keychain locked: sk-live-secret-value");
        }),
      }),
    );

    const response = await service.list("default");

    expect(response.workspaceId).toBe("default");
    expect(response.items.some((item) => item.source === "mcp_server")).toBe(true);
    expect(response.items.some((item) => item.source === "mcp_template")).toBe(true);
    expect(response.items.some((item) => item.source === "web_search")).toBe(false);
    expect(response.issues).toEqual([{ source: "web_search", message: expect.any(String) }]);
    expect(JSON.stringify(response)).not.toContain("sk-live-secret-value");
    expect(Number.isNaN(Date.parse(response.generatedAt))).toBe(false);
  });

  it("reports a failed source to the server log with the real error", async () => {
    const failure = new Error("catalog exploded");
    const report = vi.fn();
    const service = new CapabilityConnectorsService(
      sources({ listIntegrationCatalog: vi.fn(async () => Promise.reject(failure)) }),
      report,
    );

    const response = await service.list("default");

    expect(report).toHaveBeenCalledWith("integration", failure);
    expect(response.issues).toEqual([{ source: "integration", message: expect.any(String) }]);
  });

  it("reads Google status only for Gmail connections", async () => {
    const getGoogleWorkspaceOAuthStatus = vi.fn(async () => googleStatus({ connected: false }));
    const service = new CapabilityConnectorsService(
      sources({
        listIntegrationCatalog: vi.fn(async () => [catalogEntry("automation.gmail"), catalogEntry("channel.slack")]),
        listIntegrationConnections: vi.fn(async () => [connection("automation.gmail"), connection("channel.slack")]),
        getGoogleWorkspaceOAuthStatus,
      }),
    );

    const response = await service.list("default");

    expect(getGoogleWorkspaceOAuthStatus).toHaveBeenCalledTimes(1);
    expect(getGoogleWorkspaceOAuthStatus).toHaveBeenCalledWith("conn-gmail");
    expect(byId(response.items, "integration:conn-gmail")).toMatchObject({ state: "needs_sign_in" });
    expect(byId(response.items, "integration:conn-slack")).toMatchObject({ state: "connected" });
  });

  it("falls back to the connection status and adds an issue when a Google status read fails", async () => {
    const service = new CapabilityConnectorsService(
      sources({
        getGoogleWorkspaceOAuthStatus: vi.fn(async () => Promise.reject(new Error("keychain locked"))),
      }),
    );

    const response = await service.list("default");

    expect(byId(response.items, "integration:conn-gmail")).toMatchObject({ state: "connected", reason: "ready" });
    expect(response.issues).toEqual([{ source: "integration", message: expect.any(String) }]);
  });

  it("lists one issue when several Google status reads fail the same way", async () => {
    const service = new CapabilityConnectorsService(
      sources({
        listIntegrationConnections: vi.fn(async () => [
          connection("automation.gmail"),
          connection("automation.gmail", { connectionId: "conn-gmail-2", label: "Work" }),
        ]),
        getGoogleWorkspaceOAuthStatus: vi.fn(async () => Promise.reject(new Error("keychain locked"))),
      }),
    );

    const response = await service.list("default");

    expect(response.issues).toHaveLength(1);
  });

  it("lists issues by source, then message, whatever order the reads finish in", async () => {
    const later = async (): Promise<never> => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      throw new Error("slow source failed");
    };
    const service = new CapabilityConnectorsService(
      sources({
        // The slowest read fails last, and the fastest ones fail in the reverse of the sorted order.
        listMcpServers: vi.fn(later),
        readChatAvailability: vi.fn(async () => Promise.reject(new Error("settings unreadable"))),
        listWebSearchStatuses: vi.fn(() => {
          throw new Error("keychain locked");
        }),
        listIntegrationCatalog: vi.fn(async () => Promise.reject(new Error("catalog exploded"))),
      }),
    );

    const response = await service.list("default");

    expect(response.issues).toEqual([
      { source: "integration", message: "Couldn't read your connected services." },
      { source: "mcp_server", message: "Couldn't check whether the AI can use these apps in Chat." },
      { source: "mcp_server", message: "Couldn't read your saved apps." },
      { source: "web_search", message: "Couldn't read your web search keys." },
    ]);
  });

  it("leaves Gateway-owned servers out of the list", async () => {
    const service = new CapabilityConnectorsService(
      sources({
        listMcpServers: vi.fn(async () => [
          server(),
          server({ serverId: "goatcitadel-internal-approval-inbox", label: "Approval inbox" }),
          server({ serverId: "goatcitadel-internal-durable-tasks", label: "Durable tasks" }),
        ]),
      }),
    );

    const response = await service.list("default");

    expect(response.items.filter((item) => item.source === "mcp_server").map((item) => item.serverId)).toEqual([
      "server-notes",
    ]);
  });

  it("marks servers and connections the workspace does not allow as hidden", async () => {
    const getWorkspaceScope = vi.fn(async (_workspaceId: string, resourceType: "mcp_server" | "integration") => ({
      effectiveRefs: resourceType === "mcp_server" ? [] : ["conn-gmail"],
    }));
    const service = new CapabilityConnectorsService(sources({ getWorkspaceScope }));

    const response = await service.list("ws-1");

    expect(getWorkspaceScope).toHaveBeenCalledWith("ws-1", "mcp_server");
    expect(getWorkspaceScope).toHaveBeenCalledWith("ws-1", "integration");
    expect(byId(response.items, "mcp-server:server-notes").hiddenInWorkspace).toBe(true);
    expect(byId(response.items, "integration:conn-gmail").hiddenInWorkspace).toBe(false);
    expect(byId(response.items, "mcp-template:linear").hiddenInWorkspace).toBe(false);
  });

  it("hides nothing and adds an issue when a workspace selection cannot be read", async () => {
    const service = new CapabilityConnectorsService(
      sources({
        getWorkspaceScope: vi.fn(async (_workspaceId, resourceType) =>
          resourceType === "mcp_server" ? Promise.reject(new Error("scope unreadable")) : { effectiveRefs: [] },
        ),
      }),
    );

    const response = await service.list("default");

    expect(byId(response.items, "mcp-server:server-notes").hiddenInWorkspace).toBe(false);
    expect(byId(response.items, "integration:conn-gmail").hiddenInWorkspace).toBe(true);
    expect(response.issues).toEqual([{ source: "mcp_server", message: expect.any(String) }]);
  });

  it("carries the Chat availability onto saved MCP servers", async () => {
    const service = new CapabilityConnectorsService(
      sources({ readChatAvailability: vi.fn(async () => ({ staticMcp: false, durableExecution: true })) }),
    );

    const response = await service.list("default");

    expect(byId(response.items, "mcp-server:server-notes").chat).toEqual({
      available: false,
      blockedBy: "mcp_in_chat_off",
    });
  });

  it("never claims MCP apps work in Chat when the Chat availability cannot be read", async () => {
    const service = new CapabilityConnectorsService(
      sources({ readChatAvailability: vi.fn(async () => Promise.reject(new Error("settings unreadable"))) }),
    );

    const response = await service.list("default");

    expect(byId(response.items, "mcp-server:server-notes").chat.available).toBe(false);
    expect(response.issues).toEqual([{ source: "mcp_server", message: expect.any(String) }]);
  });

  it("removes secrets from saved servers before building rows", async () => {
    const service = new CapabilityConnectorsService(
      sources({
        listMcpServers: vi.fn(async () => [
          server({
            serverId: "server-local",
            label: "Local notes",
            transport: "stdio",
            url: undefined,
            command: "node",
            args: ["notes.js", "--api-key", "sk-live-argv-secret"],
            lastError: "Request to https://notes.example.test/mcp?token=url-secret-value failed",
          }),
        ]),
      }),
    );

    const response = await service.list("default");

    const body = JSON.stringify(byId(response.items, "mcp-server:server-local"));
    expect(body).not.toContain("sk-live-argv-secret");
    expect(body).not.toContain("url-secret-value");
    expect(byId(response.items, "mcp-server:server-local").command).toMatch(/^node notes\.js/);
  });

  it("removes secrets from connection errors before building rows", async () => {
    const service = new CapabilityConnectorsService(
      sources({
        listIntegrationCatalog: vi.fn(async () => [catalogEntry("channel.slack")]),
        listIntegrationConnections: vi.fn(async () => [
          connection("channel.slack", {
            status: "error",
            lastError: "Slack rejected https://hooks.example.test/in?api_key=conn-secret-value",
          }),
        ]),
      }),
    );

    const response = await service.list("default");

    expect(JSON.stringify(byId(response.items, "integration:conn-slack"))).not.toContain("conn-secret-value");
  });

  describe("Firecrawl", () => {
    function firecrawlItem(items: readonly CapabilityConnectorItem[]): CapabilityConnectorItem {
      return byId(items, "web-search:search.firecrawl");
    }
    const keyless = searchStatus("search.firecrawl", { activeSource: "none", keychainConfigured: false });

    it.each([
      ["a self-hosted address on the local network", "http://192.168.0.199:3002", "connected"],
      ["a self-hosted address with a path", "https://crawl.example.test/v2", "connected"],
      ["Firecrawl's hosted address", "https://api.firecrawl.dev", "available"],
      ["Firecrawl's hosted address in capitals with a path", "https://API.Firecrawl.dev/v2", "available"],
      ["no address", "", "available"],
      ["an address that is not a URL", "not a url", "available"],
    ])("treats %s as keyless only when self-hosted", async (_label, baseUrl, state) => {
      const service = new CapabilityConnectorsService(
        sources({
          listWebSearchStatuses: vi.fn(() => [keyless]),
          readFirecrawlSettings: vi.fn(async () => ({ enabled: true, baseUrl })),
        }),
      );

      const response = await service.list("default");

      expect(firecrawlItem(response.items).state).toBe(state);
    });

    it("reads turned off when the Firecrawl switch is off", async () => {
      const service = new CapabilityConnectorsService(
        sources({
          listWebSearchStatuses: vi.fn(() => [searchStatus("search.firecrawl")]),
          readFirecrawlSettings: vi.fn(async () => ({ enabled: false, baseUrl: "https://api.firecrawl.dev" })),
        }),
      );

      const response = await service.list("default");

      expect(firecrawlItem(response.items)).toMatchObject({ state: "turned_off", reason: "turned_off" });
    });

    it("reads turned off and adds an issue when the Firecrawl settings cannot be read", async () => {
      const service = new CapabilityConnectorsService(
        sources({
          listWebSearchStatuses: vi.fn(() => [searchStatus("search.firecrawl")]),
          readFirecrawlSettings: vi.fn(async () => Promise.reject(new Error("settings unreadable"))),
        }),
      );

      const response = await service.list("default");

      expect(firecrawlItem(response.items).state).toBe("turned_off");
      expect(response.issues).toEqual([{ source: "web_search", message: expect.any(String) }]);
    });
  });
});
