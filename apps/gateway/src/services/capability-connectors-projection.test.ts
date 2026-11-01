import { describe, expect, it } from "vitest";
import type {
  CapabilityConnectorItem,
  CapabilityConnectorReason,
  CapabilityConnectorState,
  GoogleWorkspaceOAuthStatus,
  IntegrationCatalogEntry,
  IntegrationConnection,
  McpServerPolicy,
  McpServerRecord,
  McpServerTemplateRecord,
  WebSearchCredentialStatus,
} from "@goatcitadel/contracts";
import { INTEGRATION_CATALOG } from "./integration-catalog.js";
import { CONNECTOR_INTEGRATION_CATALOG_IDS } from "./capability-connectors-integrations.js";
import {
  buildCapabilityConnectors,
  EXCLUDED_CONNECTOR_TEMPLATE_IDS,
  type CapabilityConnectorsProjectionInput,
} from "./capability-connectors-projection.js";
import { MCP_SERVER_TEMPLATES } from "./mcp-server-templates.js";

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
    serverId: "server-linear",
    revision: "rev-1",
    connectionRevision: "conn-1",
    label: "Linear",
    transport: "http",
    url: "https://mcp.linear.app/mcp",
    authType: "none",
    enabled: true,
    status: "connected",
    category: "development",
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

function input(overrides: Partial<CapabilityConnectorsProjectionInput> = {}): CapabilityConnectorsProjectionInput {
  return {
    templates: [],
    servers: [],
    integrationCatalog: [],
    connections: [],
    googleStatusByConnectionId: new Map(),
    webSearch: [],
    firecrawl: { enabled: true, selfHosted: false },
    hiddenServerIds: new Set(),
    hiddenConnectionIds: new Set(),
    chat: { staticMcp: true, durableExecution: true },
    ...overrides,
  };
}

function only(items: readonly CapabilityConnectorItem[]): CapabilityConnectorItem {
  expect(items).toHaveLength(1);
  return items[0] as CapabilityConnectorItem;
}

describe("buildCapabilityConnectors", () => {
  it("drops internal and duplicate-of-builtin templates", () => {
    const items = buildCapabilityConnectors(input({ templates: MCP_SERVER_TEMPLATES }));
    const templateIds = new Set(items.map((item) => item.templateId));

    expect([...EXCLUDED_CONNECTOR_TEMPLATE_IDS].sort()).toEqual([
      "approval-inbox",
      "durable-tasks",
      "fetch",
      "filesystem",
    ]);
    for (const excluded of EXCLUDED_CONNECTOR_TEMPLATE_IDS) {
      expect(
        MCP_SERVER_TEMPLATES.some((candidate) => candidate.templateId === excluded),
        `${excluded} is a real template`,
      ).toBe(true);
      expect(templateIds.has(excluded), `${excluded} is dropped`).toBe(false);
    }
    expect(templateIds.has("playwright")).toBe(true);
    expect(templateIds.has("github")).toBe(true);
  });

  it("merges a saved server with its template by label ignoring case", () => {
    const items = buildCapabilityConnectors(
      input({
        templates: [template({ templateId: "linear", label: "Linear", description: "From the template." })],
        servers: [server({ serverId: "srv-1", label: "linear" })],
      }),
    );

    const item = only(items);
    expect(item.id).toBe("mcp-server:srv-1");
    expect(item.templateId).toBe("linear");
    expect(item.serverId).toBe("srv-1");
    expect(item.source).toBe("mcp_server");
    expect(item.description).toBe("From the template.");
    expect(item.name).toBe("Linear");
  });

  it("reports a saved remote server's own endpoint host, not the template's", () => {
    const stripe = template({
      templateId: "stripe",
      label: "Stripe",
      url: "https://mcp.stripe.com",
      networkHosts: ["mcp.stripe.com"],
    });
    const proxied = only(
      buildCapabilityConnectors(
        input({
          templates: [stripe],
          servers: [server({ label: "Stripe", url: "https://proxy.example.test:8443/mcp" })],
        }),
      ),
    );
    expect(proxied.networkHosts).toEqual(["proxy.example.test:8443"]);

    // An endpoint that can't be read names no host rather than the template's.
    const unreadable = only(
      buildCapabilityConnectors(
        input({ templates: [stripe], servers: [server({ label: "Stripe", url: "not a url" })] }),
      ),
    );
    expect(unreadable.networkHosts).toEqual([]);
  });

  it("keeps the template's hosts for a saved server that runs on this computer", () => {
    const local = template({
      templateId: "context7",
      label: "Context7",
      transport: "stdio",
      url: undefined,
      command: "npx",
      args: ["-y", "@upstash/context7-mcp@1.0.31"],
      networkHosts: ["context7.com"],
    });
    const item = only(
      buildCapabilityConnectors(
        input({
          templates: [local],
          servers: [
            server({
              label: "Context7",
              transport: "stdio",
              url: undefined,
              command: "npx",
              args: ["-y", "@upstash/context7-mcp@1.0.31"],
            }),
          ],
        }),
      ),
    );
    expect(item.networkHosts).toEqual(["context7.com"]);
  });

  it("names saved servers by their own label when several match one template", () => {
    const items = buildCapabilityConnectors(
      input({
        templates: [template({ templateId: "linear", label: "Linear", description: "From the template." })],
        servers: [server({ serverId: "srv-work", label: "Linear" }), server({ serverId: "srv-home", label: "linear" })],
      }),
    );

    const saved = items.filter((item) => item.source === "mcp_server");
    expect(Object.fromEntries(saved.map((item) => [item.serverId, item.name]))).toEqual({
      "srv-work": "Linear",
      "srv-home": "linear",
    });
    // The template still lends both servers its description and id.
    expect(saved.map((item) => [item.templateId, item.description])).toEqual([
      ["linear", "From the template."],
      ["linear", "From the template."],
    ]);
  });

  it("does not merge a saved server into an excluded template", () => {
    const items = buildCapabilityConnectors(
      input({
        templates: [template({ templateId: "filesystem", label: "Filesystem (Local)" })],
        servers: [server({ serverId: "srv-fs", label: "Filesystem (Local)" })],
      }),
    );

    const item = only(items);
    expect(item.id).toBe("mcp-server:srv-fs");
    expect(item.templateId).toBeUndefined();
  });

  it("lists a saved server that matches no template with the server's own category", () => {
    const item = only(
      buildCapabilityConnectors(
        input({
          templates: [template()],
          servers: [server({ serverId: "srv-own", label: "Our wiki", category: "data" })],
        }),
      ).filter((candidate) => candidate.source === "mcp_server"),
    );

    expect(item.id).toBe("mcp-server:srv-own");
    expect(item.name).toBe("Our wiki");
    expect(item.category).toBe("data");
    expect(item.description).toBe("");
    expect(item.templateId).toBeUndefined();
  });

  it("carries the server revisions so a later switch or remove can send them", () => {
    const item = only(
      buildCapabilityConnectors(input({ servers: [server({ revision: "r-9", connectionRevision: "c-4" })] })),
    );

    expect(item.serverRevision).toBe("r-9");
    expect(item.serverConnectionRevision).toBe("c-4");
  });

  it("marks a saved server a plugin added with the plugin's name, from the server's own record", () => {
    const fromPlugin = only(
      buildCapabilityConnectors(
        input({
          servers: [
            server({ pluginOwner: { pluginId: "browser-checks", name: "Browser checks", installPlanId: "plan-1" } }),
          ],
        }),
      ),
    );
    const mine = only(buildCapabilityConnectors(input({ servers: [server()] })));

    // Only the plugin and its name: the install that added it stays in the Gateway.
    expect(fromPlugin.fromPlugin).toEqual({ pluginId: "browser-checks", name: "Browser checks" });
    expect("fromPlugin" in mine).toBe(false);
  });

  it("carries a saved server's approval setting so the panel can show what asks first", () => {
    const relaxed = only(
      buildCapabilityConnectors(
        input({ servers: [server({ policy: { ...policy(), approvalPosture: "nothing_asks" } })] }),
      ),
    );
    const unset = only(buildCapabilityConnectors(input({ servers: [server()] })));

    expect(relaxed.approvalPosture).toBe("nothing_asks");
    expect(unset.approvalPosture).toBeUndefined();
    expect("approvalPosture" in unset).toBe(false);
  });

  it("marks the apps that can move money, as templates and as saved servers found by host or label", () => {
    const pay = template({
      templateId: "paypal",
      label: "PayPal",
      url: "https://mcp.paypal.com/sse",
      transport: "sse",
      networkHosts: ["mcp.paypal.com"],
      movesMoney: true,
    });
    const listed = only(buildCapabilityConnectors(input({ templates: [pay] })));
    const renamed = only(
      buildCapabilityConnectors(
        input({ templates: [pay], servers: [server({ label: "Team wallet", url: "https://mcp.paypal.com/sse" })] }),
      ).filter((item) => item.source === "mcp_server"),
    );
    const sameLabel = only(
      buildCapabilityConnectors(
        input({ templates: [pay], servers: [server({ label: "PayPal", url: "https://proxy.example/mcp" })] }),
      ),
    );
    const other = buildCapabilityConnectors(input({ templates: [pay, template()], servers: [server()] }));

    expect(listed.movesMoney).toBe(true);
    expect(renamed.movesMoney).toBe(true);
    expect(sameLabel.movesMoney).toBe(true);
    expect(other.find((item) => item.id === "mcp-server:server-linear")?.movesMoney).toBeUndefined();
    expect("movesMoney" in other.find((item) => item.id === "mcp-server:server-linear")!).toBe(false);
    expect(other.find((item) => item.id === "mcp-template:paypal")?.movesMoney).toBe(true);
  });

  it("marks a saved money server from the whole catalog, even when the list shows no such template", () => {
    // The visible list names no money template here (a template left out of the list is such a case). The Gateway's
    // write lock and its decision still count it, so the row must say so too.
    const items = buildCapabilityConnectors(
      input({
        templates: [],
        servers: [
          server({ serverId: "server-wallet", label: "Team wallet", url: "https://mcp.paypal.com/sse" }),
          server({ serverId: "server-proxy", label: "Square", url: "https://proxy.example/mcp" }),
          server({ serverId: "server-linear" }),
        ],
      }),
    );
    const byServer = (serverId: string) => items.find((item) => item.id === `mcp-server:${serverId}`)!;

    expect(byServer("server-wallet").movesMoney).toBe(true);
    expect(byServer("server-proxy").movesMoney).toBe(true);
    expect("movesMoney" in byServer("server-linear")).toBe(false);
  });

  it("marks a saved server that lists its tools per chat", () => {
    const perChat = only(
      buildCapabilityConnectors(input({ servers: [server({ connectionMode: "requester_scoped" })] })),
    );
    const fixed = only(buildCapabilityConnectors(input({ servers: [server({ connectionMode: "static" })] })));
    const legacy = only(buildCapabilityConnectors(input({ servers: [server()] })));

    expect(perChat.requesterScoped).toBe(true);
    expect(fixed.requesterScoped).toBeUndefined();
    expect(legacy.requesterScoped).toBeUndefined();
  });

  it("places unsaved stdio templates on this device with the exact command", () => {
    const item = only(
      buildCapabilityConnectors(
        input({
          templates: [
            template({
              templateId: "context7",
              label: "Context7",
              transport: "stdio",
              url: undefined,
              command: "npx",
              args: ["-y", "@upstash/context7-mcp@1.2.3"],
              category: "research",
            }),
          ],
        }),
      ),
    );

    expect(item.id).toBe("mcp-template:context7");
    expect(item.group).toBe("on_this_device");
    expect(item.runsOnThisDevice).toBe(true);
    expect(item.command).toBe("npx -y @upstash/context7-mcp@1.2.3");
  });

  it("carries a template's risk notes, and none when it has none", () => {
    const [plain, payments] = buildCapabilityConnectors(
      input({
        templates: [
          template({ riskNotes: [] }),
          template({ templateId: "stripe", label: "Stripe", riskNotes: ["Can create charges and refunds."] }),
        ],
      }),
    );

    expect(plain?.templateId).toBe("linear");
    expect(plain).not.toHaveProperty("riskNotes");
    expect(payments?.riskNotes).toEqual(["Can create charges and refunds."]);
  });

  it("keeps a remote template in the available group without a command", () => {
    const item = only(
      buildCapabilityConnectors(input({ templates: [template({ networkHosts: ["mcp.linear.app"] })] })),
    );

    expect(item.group).toBe("available");
    expect(item.runsOnThisDevice).toBe(false);
    expect(item.command).toBeUndefined();
    expect(item.networkHosts).toEqual(["mcp.linear.app"]);
  });

  it("shows a saved stdio server's command and keeps it in the state's group", () => {
    const item = only(
      buildCapabilityConnectors(
        input({ servers: [server({ transport: "stdio", url: undefined, command: "uvx", args: ["openspec-mcp"] })] }),
      ),
    );

    expect(item.runsOnThisDevice).toBe(true);
    expect(item.command).toBe("uvx openspec-mcp");
    expect(item.group).toBe("connected");
  });

  it("lists only callable integrations", () => {
    const providerLookalike: IntegrationCatalogEntry = {
      ...catalogEntry("model_provider.openai"),
      catalogId: "automation.gmail",
    };
    const externalLookalike: IntegrationCatalogEntry = {
      ...catalogEntry("automation.webhooks"),
      kind: "external_connector",
      externalConnector: {
        sourceId: "fixture-source",
        serviceId: "fixture-service",
        sourceCommit: "0000000",
        actionCount: 3,
        activeActionCount: 0,
        runtimePosture: "catalog_only",
        callable: false,
      },
    };

    const items = buildCapabilityConnectors(input({ integrationCatalog: INTEGRATION_CATALOG }));
    const ids = items.map((item) => item.id);

    expect(ids).toContain("integration:automation.gmail");
    expect(ids).not.toContain("integration:productivity.notion");
    expect(ids.some((id) => id.startsWith("integration:model_provider."))).toBe(false);
    expect(ids.sort()).toEqual([...CONNECTOR_INTEGRATION_CATALOG_IDS].map((id) => `integration:${id}`).sort());
    expect(buildCapabilityConnectors(input({ integrationCatalog: [providerLookalike, externalLookalike] }))).toEqual(
      [],
    );
  });

  it("names Gmail for both mail and calendar and signs in with Google", () => {
    const item = only(buildCapabilityConnectors(input({ integrationCatalog: [catalogEntry("automation.gmail")] })));

    expect(item.name).toBe("Gmail and Google Calendar");
    expect(item.auth).toBe("google");
    expect(item.kind).toBe("built_in");
    expect(item.category).toBe("automation");
    expect(item.source).toBe("integration");
    expect(item.catalogId).toBe("automation.gmail");
    expect(item.description).toBe(catalogEntry("automation.gmail").description);
  });

  it("gives channels the channel kind and the messaging category", () => {
    const item = only(buildCapabilityConnectors(input({ integrationCatalog: [catalogEntry("channel.discord")] })));

    expect(item.kind).toBe("channel");
    expect(item.category).toBe("messaging");
    expect(item.name).toBe("Discord");
    expect(item.auth).toBe("bot_token");
  });

  it("lets a connection row replace its catalog row", () => {
    const entry = catalogEntry("channel.slack");
    const items = buildCapabilityConnectors(
      input({
        integrationCatalog: [entry],
        connections: [
          connection("channel.slack", { connectionId: "slack-1", lastError: "token revoked", status: "error" }),
        ],
      }),
    );

    const item = only(items);
    expect(item.id).toBe("integration:slack-1");
    expect(item.connectionId).toBe("slack-1");
    expect(item.catalogId).toBe("channel.slack");
    expect(item.name).toBe("Slack");
    expect(item.lastError).toBe("token revoked");
  });

  it("lists every connection of one catalog entry and ignores connections of unlisted entries", () => {
    const items = buildCapabilityConnectors(
      input({
        integrationCatalog: [catalogEntry("channel.slack"), catalogEntry("productivity.notion")],
        connections: [
          connection("channel.slack", { connectionId: "slack-a" }),
          connection("channel.slack", { connectionId: "slack-b" }),
          connection("productivity.notion", { connectionId: "notion-1" }),
        ],
      }),
    );

    expect(items.map((item) => item.id).sort()).toEqual(["integration:slack-a", "integration:slack-b"]);
  });

  it("tells apart two connections of one catalog entry by their own labels", () => {
    const items = buildCapabilityConnectors(
      input({
        integrationCatalog: [catalogEntry("channel.slack")],
        connections: [
          connection("channel.slack", { connectionId: "slack-work", label: "Work" }),
          connection("channel.slack", { connectionId: "slack-home", label: "Home" }),
        ],
      }),
    );

    expect(items.map((item) => [item.id, item.name])).toEqual([
      ["integration:slack-home", "Slack · Home"],
      ["integration:slack-work", "Slack · Work"],
    ]);
  });

  it("falls back to the last 6 characters of the connection id when a label is blank", () => {
    const items = buildCapabilityConnectors(
      input({
        integrationCatalog: [catalogEntry("channel.slack")],
        connections: [
          connection("channel.slack", { connectionId: "conn-0123456789", label: "  " }),
          connection("channel.slack", { connectionId: "conn-abcdefghij", label: "" }),
        ],
      }),
    );

    expect(items.map((item) => item.name).sort()).toEqual(["Slack · 456789", "Slack · efghij"]);
  });

  it("keeps the catalog name when an entry has one connection", () => {
    const items = buildCapabilityConnectors(
      input({
        integrationCatalog: [catalogEntry("channel.slack"), catalogEntry("channel.discord")],
        connections: [
          connection("channel.slack", { connectionId: "slack-1", label: "Work" }),
          connection("channel.discord", { connectionId: "discord-1", label: "Work" }),
        ],
      }),
    );

    expect(items.map((item) => item.name).sort()).toEqual(["Discord", "Slack"]);
  });

  it("keeps catalog names for entries with no connection beside an entry with several", () => {
    const items = buildCapabilityConnectors(
      input({
        integrationCatalog: [catalogEntry("channel.slack"), catalogEntry("channel.discord")],
        connections: [
          connection("channel.slack", { connectionId: "slack-a", label: "Work" }),
          connection("channel.slack", { connectionId: "slack-b", label: "Home" }),
        ],
      }),
    );

    expect(items.map((item) => item.name).sort()).toEqual(["Discord", "Slack · Home", "Slack · Work"]);
  });

  it("gives non-channel integrations the automation category and built-in kind", () => {
    const items = buildCapabilityConnectors(
      input({ integrationCatalog: [catalogEntry("automation.imap-smtp"), catalogEntry("automation.webhooks")] }),
    );

    expect(items.map((item) => [item.catalogId, item.kind, item.category]).sort()).toEqual([
      ["automation.imap-smtp", "built_in", "automation"],
      ["automation.webhooks", "built_in", "automation"],
    ]);
  });

  it("lists one row per web search key and not the native engines", () => {
    const items = buildCapabilityConnectors(
      input({
        webSearch: [searchStatus("search.firecrawl"), searchStatus("search.brave"), searchStatus("search.parallel")],
      }),
    );

    expect(items.map((item) => [item.id, item.name]).sort()).toEqual([
      ["web-search:search.brave", "Brave Search"],
      ["web-search:search.firecrawl", "Firecrawl"],
      ["web-search:search.parallel", "Parallel"],
    ]);
    for (const item of items) {
      expect(item).toMatchObject({
        kind: "built_in",
        source: "web_search",
        category: "search",
        auth: "api_key",
        runsOnThisDevice: false,
        hiddenInWorkspace: false,
        chat: { available: true },
      });
    }
  });

  it("names the host a web search key is sent to", () => {
    const item = only(
      buildCapabilityConnectors(
        input({ webSearch: [searchStatus("search.brave", { endpointHost: "api.search.brave.com" })] }),
      ),
    );

    expect(item.networkHosts).toEqual(["api.search.brave.com"]);
  });

  it("says why Firecrawl is broken when its address is not on the allowed list", () => {
    const item = only(
      buildCapabilityConnectors(
        input({
          webSearch: [searchStatus("search.firecrawl", { endpointAllowlisted: false })],
          firecrawl: { enabled: true, selfHosted: false },
        }),
      ),
    );

    expect(item.state).toBe("broken");
    expect(item.group).toBe("connected");
    expect(item.lastError).toBe("Firecrawl's address isn't on the allowed list");
  });

  it("says why a self-hosted Firecrawl without a key is broken when its address is not allowed", () => {
    const item = only(
      buildCapabilityConnectors(
        input({
          webSearch: [searchStatus("search.firecrawl", { activeSource: "none", endpointAllowlisted: false })],
          firecrawl: { enabled: true, selfHosted: true },
        }),
      ),
    );

    expect(item.state).toBe("broken");
    expect(item.lastError).toBe("Firecrawl's address isn't on the allowed list");
  });

  it("puts Firecrawl switched off in the turned-off group with no error text", () => {
    const item = only(
      buildCapabilityConnectors(
        input({
          webSearch: [searchStatus("search.firecrawl", { endpointAllowlisted: false })],
          firecrawl: { enabled: false, selfHosted: false },
        }),
      ),
    );

    expect(item.state).toBe("turned_off");
    expect(item.group).toBe("turned_off");
    expect(item.lastError).toBeUndefined();
  });

  it("shows no error text for web search that is ready or has no key", () => {
    const items = buildCapabilityConnectors(
      input({
        webSearch: [
          searchStatus("search.firecrawl"),
          searchStatus("search.brave", { activeSource: "none" }),
          searchStatus("search.parallel"),
        ],
      }),
    );

    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.lastError).toBeUndefined();
    }
  });

  it("marks a server hidden in the workspace", () => {
    const items = buildCapabilityConnectors(
      input({
        servers: [server({ serverId: "srv-hidden" }), server({ serverId: "srv-shown", label: "Other" })],
        hiddenServerIds: new Set(["srv-hidden"]),
      }),
    );

    expect(items.find((item) => item.serverId === "srv-hidden")?.hiddenInWorkspace).toBe(true);
    expect(items.find((item) => item.serverId === "srv-shown")?.hiddenInWorkspace).toBe(false);
  });

  it("marks an integration connection hidden in the workspace", () => {
    const items = buildCapabilityConnectors(
      input({
        integrationCatalog: [catalogEntry("channel.slack")],
        connections: [connection("channel.slack", { connectionId: "slack-hidden" })],
        hiddenConnectionIds: new Set(["slack-hidden"]),
      }),
    );

    expect(only(items).hiddenInWorkspace).toBe(true);
  });

  describe("Chat reach", () => {
    it("explains why Chat can't reach MCP", () => {
      const item = only(
        buildCapabilityConnectors(input({ servers: [server()], chat: { staticMcp: false, durableExecution: true } })),
      );

      expect(item.chat).toEqual({ available: false, blockedBy: "mcp_in_chat_off" });
    });

    it("blames background runs when they are off", () => {
      const items = buildCapabilityConnectors(
        input({
          templates: [template({ templateId: "other", label: "Other" })],
          servers: [server()],
          chat: { staticMcp: false, durableExecution: false },
        }),
      );

      expect(items).toHaveLength(2);
      for (const item of items) {
        expect(item.chat).toEqual({ available: false, blockedBy: "background_runs_off" });
      }
    });

    it("reaches MCP in Chat when static MCP is on", () => {
      expect(only(buildCapabilityConnectors(input({ servers: [server()] }))).chat).toEqual({ available: true });
    });

    it("keeps integrations and web search available in Chat when MCP is off", () => {
      const items = buildCapabilityConnectors(
        input({
          integrationCatalog: [catalogEntry("channel.slack")],
          webSearch: [searchStatus("search.brave")],
          chat: { staticMcp: false, durableExecution: false },
        }),
      );

      expect(items).toHaveLength(2);
      for (const item of items) {
        expect(item.chat).toEqual({ available: true });
      }
    });
  });

  describe("ordering", () => {
    it("orders broken before healthy inside connected", () => {
      const items = buildCapabilityConnectors(
        input({
          servers: [
            server({ serverId: "ok-a", label: "Alpha" }),
            server({ serverId: "ok-b", label: "Bravo", authState: { authType: "oauth2", readiness: "ready" } }),
            server({ serverId: "needs", label: "Charlie", authState: { authType: "oauth2", readiness: "needs_auth" } }),
            server({ serverId: "expired", label: "Delta", authState: { authType: "oauth2", readiness: "expired" } }),
            server({ serverId: "bad", label: "Echo", status: "error" }),
          ],
        }),
      );

      expect(items.map((item) => item.serverId)).toEqual(["bad", "expired", "needs", "ok-a", "ok-b"]);
    });

    it("sorts by name ignoring case within the same rank", () => {
      const items = buildCapabilityConnectors(
        input({
          servers: [
            server({ serverId: "z", label: "zeta" }),
            server({ serverId: "a", label: "Alpha" }),
            server({ serverId: "m", label: "mu" }),
          ],
        }),
      );

      expect(items.map((item) => item.name)).toEqual(["Alpha", "mu", "zeta"]);
    });

    it("lists groups in display order", () => {
      const items = buildCapabilityConnectors(
        input({
          templates: [
            template({ templateId: "remote", label: "Remote" }),
            template({ templateId: "local", label: "Local", transport: "stdio", url: undefined, command: "npx" }),
          ],
          servers: [server({ serverId: "off", label: "Off", enabled: false }), server({ serverId: "on", label: "On" })],
        }),
      );

      expect(items.map((item) => item.group)).toEqual(["connected", "on_this_device", "available", "turned_off"]);
    });
  });

  describe("state and reason by source", () => {
    interface StateRow {
      readonly condition: string;
      readonly expected: string;
      readonly state: CapabilityConnectorState;
      readonly reason: CapabilityConnectorReason;
      readonly build: () => CapabilityConnectorsProjectionInput;
    }

    const rows: StateRow[] = [
      {
        condition: "unsaved template with a token",
        expected: "available / needs_api_key",
        state: "available",
        reason: "needs_api_key",
        build: () => input({ templates: [template({ authType: "token" })] }),
      },
      {
        condition: "unsaved template with OAuth and no endpoint source",
        expected: "available / missing_sign_in_setup",
        state: "available",
        reason: "missing_sign_in_setup",
        build: () => input({ templates: [template({ authType: "oauth2" })] }),
      },
      {
        condition: "unsaved template with OAuth and saved endpoints",
        expected: "available / not_installed",
        state: "available",
        reason: "not_installed",
        build: () =>
          input({
            templates: [
              template({
                authType: "oauth2",
                oauth: { authorizationUrl: "https://example.test/auth", tokenUrl: "https://example.test/token" },
              }),
            ],
          }),
      },
      {
        condition: "unsaved template with OAuth discovery",
        expected: "available / not_installed",
        state: "available",
        reason: "not_installed",
        build: () => input({ templates: [template({ authType: "oauth2", oauth: { metadataDiscovery: true } })] }),
      },
      {
        condition: "unsaved template with no sign-in",
        expected: "available / not_installed",
        state: "available",
        reason: "not_installed",
        build: () => input({ templates: [template()] }),
      },
      {
        condition: "saved server that is turned off",
        expected: "turned_off / turned_off",
        state: "turned_off",
        reason: "turned_off",
        build: () => input({ servers: [server({ enabled: false })] }),
      },
      {
        condition: "saved server that is turned off and has an error",
        expected: "turned_off / turned_off",
        state: "turned_off",
        reason: "turned_off",
        build: () => input({ servers: [server({ enabled: false, status: "error" })] }),
      },
      {
        condition: "saved server that needs sign-in",
        expected: "needs_sign_in / sign_in_needed",
        state: "needs_sign_in",
        reason: "sign_in_needed",
        build: () => input({ servers: [server({ authState: { authType: "oauth2", readiness: "needs_auth" } })] }),
      },
      {
        condition: "saved server whose sign-in expired",
        expected: "sign_in_expired / sign_in_expired",
        state: "sign_in_expired",
        reason: "sign_in_expired",
        build: () => input({ servers: [server({ authState: { authType: "oauth2", readiness: "expired" } })] }),
      },
      {
        condition: "saved server whose sign-in expired and has an error",
        expected: "sign_in_expired / sign_in_expired",
        state: "sign_in_expired",
        reason: "sign_in_expired",
        build: () =>
          input({ servers: [server({ status: "error", authState: { authType: "oauth2", readiness: "expired" } })] }),
      },
      {
        condition: "saved server in error",
        expected: "broken / error",
        state: "broken",
        reason: "error",
        build: () => input({ servers: [server({ status: "error" })] }),
      },
      {
        condition: "saved server with no sign-in setup",
        expected: "broken / missing_sign_in_setup",
        state: "broken",
        reason: "missing_sign_in_setup",
        build: () =>
          input({ servers: [server({ authState: { authType: "oauth2", readiness: "missing_oauth_config" } })] }),
      },
      {
        condition: "saved server with no sign-in setup that reads as connected",
        expected: "broken / missing_sign_in_setup",
        state: "broken",
        reason: "missing_sign_in_setup",
        build: () =>
          input({
            servers: [
              server({ status: "connected", authState: { authType: "oauth2", readiness: "missing_oauth_config" } }),
            ],
          }),
      },
      {
        condition: "saved server with no sign-in setup and an error",
        expected: "broken / missing_sign_in_setup",
        state: "broken",
        reason: "missing_sign_in_setup",
        build: () =>
          input({
            servers: [
              server({ status: "error", authState: { authType: "oauth2", readiness: "missing_oauth_config" } }),
            ],
          }),
      },
      {
        condition: "saved server with no sign-in setup that is turned off",
        expected: "turned_off / turned_off",
        state: "turned_off",
        reason: "turned_off",
        build: () =>
          input({
            servers: [server({ enabled: false, authState: { authType: "oauth2", readiness: "missing_oauth_config" } })],
          }),
      },
      {
        condition: "saved server that is ready",
        expected: "connected / ready",
        state: "connected",
        reason: "ready",
        build: () => input({ servers: [server({ authState: { authType: "oauth2", readiness: "ready" } })] }),
      },
      {
        condition: "saved server that is disconnected with ready sign-in",
        expected: "connected / ready",
        state: "connected",
        reason: "ready",
        build: () =>
          input({
            servers: [server({ status: "disconnected", authState: { authType: "oauth2", readiness: "ready" } })],
          }),
      },
      {
        condition: "saved server that is connecting with ready sign-in",
        expected: "connected / ready",
        state: "connected",
        reason: "ready",
        build: () =>
          input({
            servers: [server({ status: "connecting", authState: { authType: "oauth2", readiness: "ready" } })],
          }),
      },
      {
        condition: "saved server that is idle with no problem",
        expected: "connected / ready",
        state: "connected",
        reason: "ready",
        build: () => input({ servers: [server({ status: "disconnected" })] }),
      },
      {
        condition: "integration connection that is turned off",
        expected: "turned_off / turned_off",
        state: "turned_off",
        reason: "turned_off",
        build: () =>
          input({
            integrationCatalog: [catalogEntry("channel.slack")],
            connections: [connection("channel.slack", { enabled: false })],
          }),
      },
      {
        condition: "integration connection that is paused",
        expected: "turned_off / turned_off",
        state: "turned_off",
        reason: "turned_off",
        build: () =>
          input({
            integrationCatalog: [catalogEntry("channel.slack")],
            connections: [connection("channel.slack", { status: "paused" })],
          }),
      },
      {
        condition: "integration connection in error",
        expected: "broken / error",
        state: "broken",
        reason: "error",
        build: () =>
          input({
            integrationCatalog: [catalogEntry("channel.slack")],
            connections: [connection("channel.slack", { status: "error" })],
          }),
      },
      {
        condition: "integration connection that is disconnected",
        expected: "needs_sign_in / not_connected",
        state: "needs_sign_in",
        reason: "not_connected",
        build: () =>
          input({
            integrationCatalog: [catalogEntry("channel.slack")],
            connections: [connection("channel.slack", { status: "disconnected" })],
          }),
      },
      {
        condition: "integration connection that is connected",
        expected: "connected / ready",
        state: "connected",
        reason: "ready",
        build: () =>
          input({ integrationCatalog: [catalogEntry("channel.slack")], connections: [connection("channel.slack")] }),
      },
      {
        condition: "Google connection that needs a new sign-in",
        expected: "sign_in_expired / sign_in_expired",
        state: "sign_in_expired",
        reason: "sign_in_expired",
        build: () =>
          input({
            integrationCatalog: [catalogEntry("automation.gmail")],
            connections: [connection("automation.gmail", { connectionId: "conn-gmail" })],
            googleStatusByConnectionId: new Map([
              ["conn-gmail", googleStatus({ connected: false, requiresReauth: true })],
            ]),
          }),
      },
      {
        condition: "Google connection that is not signed in",
        expected: "needs_sign_in / sign_in_needed",
        state: "needs_sign_in",
        reason: "sign_in_needed",
        build: () =>
          input({
            integrationCatalog: [catalogEntry("automation.gmail")],
            connections: [connection("automation.gmail", { connectionId: "conn-gmail", status: "disconnected" })],
            googleStatusByConnectionId: new Map([["conn-gmail", googleStatus({ connected: false })]]),
          }),
      },
      {
        condition: "Google connection that is signed in",
        expected: "connected / ready",
        state: "connected",
        reason: "ready",
        build: () =>
          input({
            integrationCatalog: [catalogEntry("automation.gmail")],
            connections: [connection("automation.gmail", { connectionId: "conn-gmail" })],
            googleStatusByConnectionId: new Map([["conn-gmail", googleStatus()]]),
          }),
      },
      {
        condition: "Google connection that is turned off and needs a new sign-in",
        expected: "turned_off / turned_off",
        state: "turned_off",
        reason: "turned_off",
        build: () =>
          input({
            integrationCatalog: [catalogEntry("automation.gmail")],
            connections: [connection("automation.gmail", { connectionId: "conn-gmail", enabled: false })],
            googleStatusByConnectionId: new Map([
              ["conn-gmail", googleStatus({ connected: false, requiresReauth: true })],
            ]),
          }),
      },
      {
        condition: "Google connection with no sign-in status to read, connected",
        expected: "connected / ready",
        state: "connected",
        reason: "ready",
        build: () =>
          input({
            integrationCatalog: [catalogEntry("automation.gmail")],
            connections: [connection("automation.gmail", { connectionId: "conn-gmail", status: "connected" })],
          }),
      },
      {
        condition: "Google connection with no sign-in status to read, disconnected",
        expected: "needs_sign_in / not_connected",
        state: "needs_sign_in",
        reason: "not_connected",
        build: () =>
          input({
            integrationCatalog: [catalogEntry("automation.gmail")],
            connections: [connection("automation.gmail", { connectionId: "conn-gmail", status: "disconnected" })],
          }),
      },
      {
        condition: "Google connection with no sign-in status to read, in error",
        expected: "broken / error",
        state: "broken",
        reason: "error",
        build: () =>
          input({
            integrationCatalog: [catalogEntry("automation.gmail")],
            connections: [connection("automation.gmail", { connectionId: "conn-gmail", status: "error" })],
          }),
      },
      {
        condition: "Google connection with no sign-in status to read, paused",
        expected: "turned_off / turned_off",
        state: "turned_off",
        reason: "turned_off",
        build: () =>
          input({
            integrationCatalog: [catalogEntry("automation.gmail")],
            connections: [connection("automation.gmail", { connectionId: "conn-gmail", status: "paused" })],
          }),
      },
      {
        condition: "Google connection whose sign-in status belongs to another connection, disconnected",
        expected: "needs_sign_in / not_connected",
        state: "needs_sign_in",
        reason: "not_connected",
        build: () =>
          input({
            integrationCatalog: [catalogEntry("automation.gmail")],
            connections: [connection("automation.gmail", { connectionId: "conn-gmail", status: "disconnected" })],
            googleStatusByConnectionId: new Map([["conn-other", googleStatus({ connectionId: "conn-other" })]]),
          }),
      },
      {
        condition: "catalog entry with no connection",
        expected: "available / not_installed",
        state: "available",
        reason: "not_installed",
        build: () => input({ integrationCatalog: [catalogEntry("channel.slack")] }),
      },
      {
        condition: "web search with a key",
        expected: "connected / ready",
        state: "connected",
        reason: "ready",
        build: () => input({ webSearch: [searchStatus("search.brave", { activeSource: "env" })] }),
      },
      {
        condition: "web search with no key",
        expected: "available / needs_api_key",
        state: "available",
        reason: "needs_api_key",
        build: () => input({ webSearch: [searchStatus("search.parallel", { activeSource: "none" })] }),
      },
      {
        condition: "Firecrawl with a key, turned on and allowed",
        expected: "connected / ready",
        state: "connected",
        reason: "ready",
        build: () =>
          input({ webSearch: [searchStatus("search.firecrawl")], firecrawl: { enabled: true, selfHosted: false } }),
      },
      {
        condition: "Firecrawl with a key but switched off",
        expected: "turned_off / turned_off",
        state: "turned_off",
        reason: "turned_off",
        build: () =>
          input({ webSearch: [searchStatus("search.firecrawl")], firecrawl: { enabled: false, selfHosted: false } }),
      },
      {
        condition: "Firecrawl with a key, switched on, but its address not allowed",
        expected: "broken / error",
        state: "broken",
        reason: "error",
        build: () =>
          input({
            webSearch: [searchStatus("search.firecrawl", { endpointAllowlisted: false })],
            firecrawl: { enabled: true, selfHosted: false },
          }),
      },
      {
        condition: "Firecrawl with no key, switched on",
        expected: "available / needs_api_key",
        state: "available",
        reason: "needs_api_key",
        build: () =>
          input({
            webSearch: [searchStatus("search.firecrawl", { activeSource: "none" })],
            firecrawl: { enabled: true, selfHosted: false },
          }),
      },
      {
        condition: "Firecrawl with no key, switched off",
        expected: "available / needs_api_key",
        state: "available",
        reason: "needs_api_key",
        build: () =>
          input({
            webSearch: [searchStatus("search.firecrawl", { activeSource: "none" })],
            firecrawl: { enabled: false, selfHosted: false },
          }),
      },
      {
        condition: "Firecrawl with no key and its address not allowed",
        expected: "available / needs_api_key",
        state: "available",
        reason: "needs_api_key",
        build: () =>
          input({
            webSearch: [searchStatus("search.firecrawl", { activeSource: "none", endpointAllowlisted: false })],
            firecrawl: { enabled: true, selfHosted: false },
          }),
      },
      {
        condition: "self-hosted Firecrawl with no key, switched on and allowed",
        expected: "connected / ready",
        state: "connected",
        reason: "ready",
        build: () =>
          input({
            webSearch: [searchStatus("search.firecrawl", { activeSource: "none" })],
            firecrawl: { enabled: true, selfHosted: true },
          }),
      },
      {
        condition: "self-hosted Firecrawl with no key, switched off",
        expected: "turned_off / turned_off",
        state: "turned_off",
        reason: "turned_off",
        build: () =>
          input({
            webSearch: [searchStatus("search.firecrawl", { activeSource: "none" })],
            firecrawl: { enabled: false, selfHosted: true },
          }),
      },
      {
        condition: "self-hosted Firecrawl with no key, switched on, but its address not allowed",
        expected: "broken / error",
        state: "broken",
        reason: "error",
        build: () =>
          input({
            webSearch: [searchStatus("search.firecrawl", { activeSource: "none", endpointAllowlisted: false })],
            firecrawl: { enabled: true, selfHosted: true },
          }),
      },
      {
        condition: "self-hosted Firecrawl with a key, switched on and allowed",
        expected: "connected / ready",
        state: "connected",
        reason: "ready",
        build: () =>
          input({ webSearch: [searchStatus("search.firecrawl")], firecrawl: { enabled: true, selfHosted: true } }),
      },
      {
        condition: "Brave Search with no key while Firecrawl is self-hosted",
        expected: "available / needs_api_key",
        state: "available",
        reason: "needs_api_key",
        build: () =>
          input({
            webSearch: [searchStatus("search.brave", { activeSource: "none" })],
            firecrawl: { enabled: true, selfHosted: true },
          }),
      },
      {
        condition: "Parallel with no key while Firecrawl is self-hosted and switched off",
        expected: "available / needs_api_key",
        state: "available",
        reason: "needs_api_key",
        build: () =>
          input({
            webSearch: [searchStatus("search.parallel", { activeSource: "none" })],
            firecrawl: { enabled: false, selfHosted: true },
          }),
      },
      {
        condition: "Brave Search with a key while Firecrawl is switched off",
        expected: "connected / ready",
        state: "connected",
        reason: "ready",
        build: () =>
          input({ webSearch: [searchStatus("search.brave")], firecrawl: { enabled: false, selfHosted: false } }),
      },
      {
        condition: "Brave Search with a key and its address not allowed",
        expected: "connected / ready",
        state: "connected",
        reason: "ready",
        build: () => input({ webSearch: [searchStatus("search.brave", { endpointAllowlisted: false })] }),
      },
    ];

    it.each(rows)("maps $condition to $expected", ({ state, reason, build }) => {
      const item = only(buildCapabilityConnectors(build()));

      expect(item.state).toBe(state);
      expect(item.reason).toBe(reason);
    });

    it.each([
      ["connected", "connected"],
      ["needs_sign_in", "connected"],
      ["sign_in_expired", "connected"],
      ["broken", "connected"],
      ["turned_off", "turned_off"],
    ] as const)("puts a saved server that is %s in the %s group", (state, group) => {
      const overrides: Record<string, Partial<McpServerRecord>> = {
        connected: {},
        needs_sign_in: { authState: { authType: "oauth2", readiness: "needs_auth" } },
        sign_in_expired: { authState: { authType: "oauth2", readiness: "expired" } },
        broken: { status: "error" },
        turned_off: { enabled: false },
      };
      const item = only(buildCapabilityConnectors(input({ servers: [server(overrides[state])] })));

      expect(item.state).toBe(state);
      expect(item.group).toBe(group);
    });
  });

  describe("how each connector signs in", () => {
    it.each([
      ["none", "none"],
      ["token", "api_key"],
      ["oauth2", "oauth"],
    ] as const)("maps the %s MCP auth type to %s", (authType, auth) => {
      const item = only(buildCapabilityConnectors(input({ templates: [template({ authType })] })));

      expect(item.auth).toBe(auth);
    });

    it("uses the saved server's auth type once a server exists", () => {
      const item = only(
        buildCapabilityConnectors(
          input({ templates: [template({ authType: "none" })], servers: [server({ authType: "token" })] }),
        ),
      );

      expect(item.auth).toBe("api_key");
    });
  });
});
