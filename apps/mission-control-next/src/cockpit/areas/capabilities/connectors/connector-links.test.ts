import type { CapabilityConnectorItem } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import {
  CHAT_CONNECTORS_SETTINGS_HREF,
  connectorIdFromSource,
  connectorItemHref,
  connectorSettingsHref,
  readLinkedConnectorId,
  savedConnectorForTemplate,
} from "./connector-links";

function item(overrides: Partial<CapabilityConnectorItem>): CapabilityConnectorItem {
  return {
    id: "mcp-template:example",
    name: "Example",
    description: "An example app.",
    kind: "mcp",
    source: "mcp_template",
    category: "automation",
    state: "available",
    reason: "not_installed",
    group: "available",
    auth: "none",
    runsOnThisDevice: false,
    networkHosts: [],
    chat: { available: true },
    hiddenInWorkspace: false,
    ...overrides,
  };
}

describe("connectorSettingsHref", () => {
  it.each<[Partial<CapabilityConnectorItem>, string]>([
    [{ source: "mcp_template" }, "/capabilities/connectors/advanced#mcp-servers"],
    [{ source: "mcp_server", id: "mcp-server:linear" }, "/capabilities/connectors/advanced#mcp-servers"],
    [{ source: "integration", kind: "channel" }, "/chat/messaging/advanced"],
    [{ source: "integration", kind: "built_in" }, "/capabilities/connectors/advanced#integration-connections"],
    [{ source: "web_search", kind: "built_in" }, "/capabilities/connectors/advanced#web-search"],
  ])("sends %j to %s", (overrides, href) => {
    expect(connectorSettingsHref(item(overrides))).toBe(href);
  });
});

describe("settings links", () => {
  it("points the Chat line at the MCP section, where Chat availability is shown", () => {
    expect(CHAT_CONNECTORS_SETTINGS_HREF).toBe("/capabilities/connectors/advanced#mcp-servers");
  });
});

describe("connector item links", () => {
  it("writes the item into the query of the Connectors tab address", () => {
    expect(connectorItemHref("mcp-server:abc 1")).toBe("/capabilities/connectors?item=mcp-server%3Aabc%201");
  });

  it("reads the item back from a query string", () => {
    expect(readLinkedConnectorId(`?item=${encodeURIComponent("mcp-server:abc 1")}&shell=cockpit`)).toBe(
      "mcp-server:abc 1",
    );
  });

  it.each(["", "?", "?item=", "?shell=cockpit"])("reads no item from %j", (search) => {
    expect(readLinkedConnectorId(search)).toBeNull();
  });

  it("tolerates a missing query string", () => {
    expect(readLinkedConnectorId(undefined)).toBeNull();
  });

  it("reads the connector id out of an inspector source", () => {
    expect(connectorIdFromSource("capabilities:mcp-server:abc")).toBe("mcp-server:abc");
    expect(connectorIdFromSource("inbox:approval:1")).toBeNull();
    expect(connectorIdFromSource("capabilities:")).toBeNull();
    expect(connectorIdFromSource(undefined)).toBeNull();
  });
});

describe("savedConnectorForTemplate", () => {
  const saved = item({ id: "mcp-server:srv-1", source: "mcp_server", serverId: "srv-1", templateId: "linear" });
  const template = item({ id: "mcp-template:linear", templateId: "linear" });

  it("finds the saved server installed from the template the id names", () => {
    expect(savedConnectorForTemplate([template, saved], "mcp-template:linear")).toBe(saved);
  });

  it("finds nothing for another template, a saved server's own id, or no list", () => {
    expect(savedConnectorForTemplate([saved], "mcp-template:notion")).toBeUndefined();
    expect(savedConnectorForTemplate([saved], "mcp-server:srv-1")).toBeUndefined();
    expect(savedConnectorForTemplate(undefined, "mcp-template:linear")).toBeUndefined();
  });
});

describe("web search key links", () => {
  it("links Brave Search's Advanced setup to its key field", () => {
    const brave = item({ id: "web-search:search.brave", source: "web_search" });
    expect(connectorSettingsHref(brave)).toBe("/capabilities/connectors/advanced#web-search-key-brave");
    const parallel = item({ id: "web-search:search.parallel", source: "web_search" });
    expect(connectorSettingsHref(parallel)).toBe("/capabilities/connectors/advanced#web-search-key-parallel");
    const firecrawl = item({ id: "web-search:search.firecrawl", source: "web_search" });
    expect(connectorSettingsHref(firecrawl)).toBe("/capabilities/connectors/advanced#web-search");
  });
});

describe("add an integration links", () => {
  it("opens the add form for a catalog row that is not saved yet", () => {
    const gmail = item({
      id: "integration:automation.gmail",
      source: "integration",
      kind: "built_in",
      reason: "not_installed",
      catalogId: "automation.gmail",
    });
    expect(connectorSettingsHref(gmail)).toBe(
      "/capabilities/connectors/advanced?addIntegration=automation.gmail#integration-connections",
    );
    expect(connectorSettingsHref({ ...gmail, reason: "ready" })).toBe(
      "/capabilities/connectors/advanced#integration-connections",
    );
  });
});
