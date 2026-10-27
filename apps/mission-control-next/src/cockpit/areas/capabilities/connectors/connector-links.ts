import type { CapabilityConnectorItem } from "@goatcitadel/contracts";

/** Where each kind of connector's detailed setup lives in Settings. */
const MCP_SERVERS_HREF = "/settings/connections#mcp-servers";

/**
 * Where an operator turns MCP in Chat on. The cockpit has no switch for that feature of its own; the MCP section is
 * where each server shows whether Chat can reach it.
 */
export const CHAT_CONNECTORS_SETTINGS_HREF = MCP_SERVERS_HREF;

/** Where an operator lets this workspace's AI use an app the workspace hides. */
export const WORKSPACE_CAPABILITIES_HREF = "/settings/citadel#workspace-capabilities";

/** The Connectors tab, without a panel open. */
export const CONNECTORS_HREF = "/capabilities/connectors";

/** The Settings section that owns a connector's detailed setup ("Advanced setup in Settings"). */
export function connectorSettingsHref(item: CapabilityConnectorItem): string {
  switch (item.source) {
    case "mcp_template":
    case "mcp_server":
      return MCP_SERVERS_HREF;
    case "web_search":
      return "/settings/connections#web-search";
    case "integration":
      return item.kind === "channel"
        ? "/settings/connections#channels"
        : "/settings/connections#integration-connections";
  }
}

const TEMPLATE_ID_PREFIX = "mcp-template:";

/**
 * The saved server installed from the template a connector id names ("mcp-template:<templateId>"), when the list
 * holds one. Once a template is installed the list shows the saved server in its place, so a panel or an address that
 * still names the template opens the saved server.
 */
export function savedConnectorForTemplate(
  items: readonly CapabilityConnectorItem[] | undefined,
  id: string,
): CapabilityConnectorItem | undefined {
  if (!id.startsWith(TEMPLATE_ID_PREFIX)) return undefined;
  const templateId = id.slice(TEMPLATE_ID_PREFIX.length);
  return items?.find((entry) => entry.source === "mcp_server" && entry.templateId === templateId);
}

/** The address that opens one connector's panel. */
export function connectorItemHref(id: string): string {
  return `${CONNECTORS_HREF}?item=${encodeURIComponent(id)}`;
}

/** The connector an address names with `?item=`, or null. Whether it exists is for the loaded list to say. */
export function readLinkedConnectorId(search: string | undefined): string | null {
  return new URLSearchParams(search ?? "").get("item") || null;
}

const SOURCE_PREFIX = "capabilities:";

/** The inspector source of a connector's panel. */
export function connectorPanelSource(id: string): string {
  return `${SOURCE_PREFIX}${id}`;
}

/** The connector id inside an inspector source, or null when the source is another page's. */
export function connectorIdFromSource(source: string | undefined): string | null {
  return source?.startsWith(SOURCE_PREFIX) && source.length > SOURCE_PREFIX.length
    ? source.slice(SOURCE_PREFIX.length)
    : null;
}
