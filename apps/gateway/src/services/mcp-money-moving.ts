import type { McpServerRecord, McpServerTemplateRecord } from "@goatcitadel/contracts";
import { MCP_SERVER_TEMPLATES } from "./mcp-server-templates.js";

/** How a saved server is paired with a template: by label, ignoring case. The connector list pairs them the same way. */
export function mcpServerLabelKey(label: string): string {
  return label.toLowerCase();
}

/**
 * Whether a saved server can move or spend money, or reach bank data: its endpoint's host is a host of a template
 * marked `movesMoney`, or its label is that template's label. Matching the host means renaming the server doesn't lift
 * it; a server pointed at a money vendor under some other host is not caught and follows the app's own labels.
 */
export function isMoneyMovingMcpServer(
  server: Pick<McpServerRecord, "url" | "label">,
  templates: readonly Pick<McpServerTemplateRecord, "label" | "networkHosts" | "movesMoney">[],
): boolean {
  const moneyTemplates = templates.filter((template) => template.movesMoney === true);
  if (moneyTemplates.length === 0) return false;
  const label = mcpServerLabelKey(server.label);
  const host = server.url ? readHostName(server.url) : undefined;
  return moneyTemplates.some(
    (template) =>
      mcpServerLabelKey(template.label) === label ||
      (host !== undefined && (template.networkHosts ?? []).some((entry) => readHostName(`https://${entry}`) === host)),
  );
}

/**
 * The same question against the whole shipped catalog, whether or not the connector list shows a template. The write
 * lock, the decision that caps a saved setting and the connector list all ask here, so they can't disagree on which
 * templates count.
 */
export function isMoneyMovingCatalogServer(server: Pick<McpServerRecord, "url" | "label">): boolean {
  return isMoneyMovingMcpServer(server, MCP_SERVER_TEMPLATES);
}

/** The lowercase host name without a port or a trailing dot, so a port or spelling variant names the same host. */
function readHostName(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/\.$/u, "") || undefined;
  } catch {
    return undefined;
  }
}
