import type { IntegrationConnection, ConnectorDiagnosticReport, ChannelProbeReport } from "@goatcitadel/contracts";
import type {
  IntegrationDiagnosticsPort,
  runGovernedWebhookLiveChecks as runGovernedWebhook,
} from "./integration-diagnostics-service.js";
import { runDiscordBotLiveChecks } from "./channel-bot-live-probes.js";
/** Runtime and webhook diagnostics retain their existing network and secret owners. */
export async function runDiscordConnectionLiveChecks(
  deps: IntegrationDiagnosticsPort,
  connection: IntegrationConnection,
  options: {
    includeSandboxSend: boolean;
    discordRuntimeReadiness?: "required" | "deferred";
  },
  runGovernedWebhookLiveChecks: typeof runGovernedWebhook,
): Promise<{ checks: ConnectorDiagnosticReport["checks"]; probe: ChannelProbeReport }> {
  const config = connection.config;
  const token =
    deps.resolveConnectionSecret(config, "botToken", "botTokenEnv", connection.catalogId, connection) ??
    deps.resolveConnectionSecret(config, "token", "tokenEnv", connection.catalogId, connection);
  const runtimeMode = deps.readConnectionConfigValue(config, "runtimeMode") === "gateway" ? "gateway" : "bridge";
  const webhookUrl = deps.resolveConnectionSecret(
    config,
    "webhookUrl",
    "webhookUrlEnv",
    connection.catalogId,
    connection,
  );
  if (!token && webhookUrl && runtimeMode === "bridge")
    return runGovernedWebhookLiveChecks(deps, {
      channelKey: "discord",
      webhookUrl,
      includeSandboxSend: options.includeSandboxSend,
      fetcher: (url, init) => deps.fetchWithDiagnosticsTimeout(url, init),
    });
  return runDiscordBotLiveChecks({
    token,
    channelId: deps.readConnectionConfigValue(config, "defaultChannelId"),
    guildId: deps.readConnectionConfigValue(config, "defaultGuildId"),
    runtimeMode,
    webhookUrl,
    includeSandboxSend: options.includeSandboxSend,
    runtimeReadiness: options.discordRuntimeReadiness,
    deferDestination:
      runtimeMode === "gateway" &&
      deps.readConnectionConfigValue(config, "guildPolicy") === "off" &&
      !deps.readConnectionConfigValue(config, "defaultChannelId"),
    runtimeStatus:
      runtimeMode === "gateway" && options.discordRuntimeReadiness !== "deferred"
        ? deps.getDiscordRuntimeStatus(connection.connectionId)
        : undefined,
    fetcher: (url, init) => deps.fetchWithDiagnosticsTimeout(url, init),
  });
}
