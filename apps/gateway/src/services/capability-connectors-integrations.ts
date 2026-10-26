import type { IntegrationCatalogEntry } from "@goatcitadel/contracts";

/**
 * Catalog entries the AI can actually call through a saved connection.
 *
 * Every channel here has a `<key>.*` tool in the tool registry (`discord.send`, `google-chat.send` and so on), and
 * every channel with such a tool is here; a test compares both ways. The three automation entries are the Gmail and
 * Calendar tools, `smtp.send` and `webhook.send`. Other catalog entries (model providers, notes apps, platform
 * targets) are configuration without a tool the AI can call, so they are not listed.
 */
export const CONNECTOR_INTEGRATION_CATALOG_IDS: ReadonlySet<string> = new Set([
  "automation.gmail",
  "automation.imap-smtp",
  "automation.webhooks",
  "channel.discord",
  "channel.google-chat",
  "channel.imessage",
  "channel.line",
  "channel.mattermost",
  "channel.nextcloud-talk",
  "channel.signal",
  "channel.slack",
  "channel.teams",
  "channel.telegram",
  "channel.whatsapp",
  "channel.zalo",
  "channel.zalouser",
]);

export function isListedIntegration(entry: IntegrationCatalogEntry): boolean {
  return (
    entry.kind !== "model_provider" &&
    !entry.externalConnector &&
    CONNECTOR_INTEGRATION_CATALOG_IDS.has(entry.catalogId)
  );
}
