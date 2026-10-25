import type { IntegrationCatalogEntry } from "@goatcitadel/contracts";

/**
 * Catalog entries the AI can actually call through a saved connection.
 *
 * Each channel here has a `<key>.*` tool in the tool registry (`discord.send`, `slack.send` and so on). The three
 * automation entries are the Gmail and Calendar tools, `smtp.send` and `webhook.send`. Other catalog entries (model
 * providers, notes apps, platform targets) are configuration without a tool the AI can call, so they are not listed.
 */
export const CONNECTOR_INTEGRATION_CATALOG_IDS: ReadonlySet<string> = new Set([
  "automation.gmail",
  "automation.imap-smtp",
  "automation.webhooks",
  "channel.discord",
  "channel.slack",
  "channel.telegram",
  "channel.mattermost",
  "channel.imessage",
  "channel.whatsapp",
  "channel.zalo",
  "channel.zalouser",
  "channel.teams",
]);

export function isListedIntegration(entry: IntegrationCatalogEntry): boolean {
  return (
    entry.kind !== "model_provider" &&
    !entry.externalConnector &&
    CONNECTOR_INTEGRATION_CATALOG_IDS.has(entry.catalogId)
  );
}
