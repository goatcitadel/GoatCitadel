import { describeChannelCapabilities } from "@goatcitadel/gateway-core";
import type { ChannelProbeReport, ConnectorDiagnosticReport, IntegrationConnection } from "@goatcitadel/contracts";
import {
  runDiscordBotLiveChecks,
  runIMessageBridgeLiveChecks,
  runLineBotLiveChecks,
  runMattermostBotLiveChecks,
  runSignalBridgeLiveChecks,
  runSlackBotLiveChecks,
  runTelegramBotLiveChecks,
  runWhatsAppCloudLiveChecks,
  runZaloBotLiveChecks,
  runZaloUserBridgeLiveChecks,
} from "./channel-bot-live-probes.js";
import { buildChannelCapabilityDiagnosticChecks } from "./channel-capability-diagnostic-checks.js";
import { describeChannelFeatureMetadata } from "./channel-diagnostics.js";
import { resolveChannelConfigTarget } from "./channel-config.js";
import { runWebhookDestinationLiveChecks } from "./channel-webhook-probes.js";
import * as connectionUrlHelpers from "./connection-url-helpers.js";
import type { GatewayService } from "./gateway-service.js";

export interface IntegrationDiagnosticsHost extends Pick<
  GatewayService,
  | "fetchWithDiagnosticsTimeout"
  | "getDiscordRuntimeStatus"
  | "isConnectionUrlAllowlisted"
  | "readConnectionConfigValue"
  | "resolveConnectionSecret"
> {
  config: Pick<GatewayService["config"], "toolPolicy">;
}

export function buildIntegrationConnectionChecks(
  host: IntegrationDiagnosticsHost,
  connection: IntegrationConnection,
): ConnectorDiagnosticReport["checks"] {
  const checks: ConnectorDiagnosticReport["checks"] = [];
  const config = connection.config;
  const channelFeatures =
    connection.kind === "channel" ? describeChannelFeatureMetadata(connection.key, config) : undefined;
  const channelCapabilities =
    connection.kind === "channel" ? describeChannelCapabilities(connection.key, config) : undefined;
  const requireSecretRef = (key: string, label: string, directKey: string, envKey: string) => {
    const direct = host.readConnectionConfigValue(config, directKey);
    const envName = host.readConnectionConfigValue(config, envKey);
    const envPresent = envName ? Boolean(process.env[envName]) : false;
    checks.push({
      key,
      status: direct || envPresent ? "pass" : "fail",
      message:
        direct || envPresent ? `${label} is configured${envName ? ` via ${envName}` : ""}.` : `${label} is missing.`,
    });
  };
  const requireText = (key: string, label: string, value: string | undefined, status: "warn" | "fail" = "fail") => {
    checks.push({
      key,
      status: value ? "pass" : status,
      message: value ? `${label} is set.` : `${label} is missing.`,
    });
  };
  const checkUrl = (key: string, label: string, urlValue: string | undefined, required = false) => {
    if (!urlValue && !required) {
      return;
    }
    const safeRemote = !urlValue || connectionUrlHelpers.isConnectionUrlRemoteSafe(urlValue);
    const allowlisted = !urlValue || host.isConnectionUrlAllowlisted(urlValue);
    checks.push({
      key,
      status: !urlValue ? "fail" : !safeRemote ? "fail" : allowlisted ? "pass" : "warn",
      message: !urlValue
        ? `${label} is missing.`
        : !safeRemote
          ? `${label} uses non-local plain HTTP.`
          : allowlisted
            ? `${label} is reachable under current allowlist posture.`
            : `${label} host is not in the current outbound allowlist.`,
    });
  };

  if (connection.kind === "channel") {
    checks.push({
      key: "actions",
      status: "pass",
      message: `Supported delivery actions: ${(channelFeatures?.supportedDeliveryActions ?? ["channel.send"]).join(", ")}.`,
    });
    checks.push({
      key: "attachments",
      status: (channelFeatures?.supportedAttachmentSources.length ?? 0) > 0 ? "pass" : "warn",
      message:
        (channelFeatures?.supportedAttachmentSources.length ?? 0) > 0
          ? `Supported attachment sources: ${channelFeatures?.supportedAttachmentSources.join(", ")}.`
          : "No rich attachment source is advertised for this connector.",
    });
    if (channelCapabilities) {
      checks.push(...buildChannelCapabilityDiagnosticChecks(channelCapabilities));
    }
    switch (connection.key) {
      case "slack":
        checks.push({
          key: "auth",
          status:
            host.readConnectionConfigValue(config, "webhookUrl") ||
            host.readConnectionConfigValue(config, "botToken") ||
            hasConnectionEnvValue(host, config, "botTokenEnv")
              ? "pass"
              : "fail",
          message:
            host.readConnectionConfigValue(config, "webhookUrl") ||
            host.readConnectionConfigValue(config, "botToken") ||
            hasConnectionEnvValue(host, config, "botTokenEnv")
              ? "Slack bot token or webhook is configured."
              : "Slack bot token or webhook is missing.",
        });
        checkUrl("url", "Slack webhook URL", host.readConnectionConfigValue(config, "webhookUrl"), false);
        requireText("target", "Default Slack channel", resolveChannelConfigTarget(connection.key, config), "warn");
        break;
      case "discord":
        checks.push({
          key: "auth",
          status:
            host.readConnectionConfigValue(config, "webhookUrl") ||
            host.readConnectionConfigValue(config, "botToken") ||
            hasConnectionEnvValue(host, config, "botTokenEnv")
              ? "pass"
              : "fail",
          message:
            host.readConnectionConfigValue(config, "webhookUrl") ||
            host.readConnectionConfigValue(config, "botToken") ||
            hasConnectionEnvValue(host, config, "botTokenEnv")
              ? "Discord bot token or webhook is configured."
              : "Discord bot token or webhook is missing.",
        });
        checkUrl("url", "Discord webhook URL", host.readConnectionConfigValue(config, "webhookUrl"), false);
        requireText("target", "Default Discord channel", resolveChannelConfigTarget(connection.key, config), "warn");
        break;
      case "telegram":
        requireSecretRef("auth", "Telegram bot token", "botToken", "botTokenEnv");
        requireText("target", "Default Telegram chat", resolveChannelConfigTarget(connection.key, config), "warn");
        checks.push({
          key: "url",
          status: isHostAllowlisted(host, "api.telegram.org") ? "pass" : "warn",
          message: isHostAllowlisted(host, "api.telegram.org")
            ? "Telegram API host is allowlisted."
            : "Telegram API host is not allowlisted.",
        });
        break;
      case "google-chat":
        checkUrl("url", "Google Chat webhook URL", host.readConnectionConfigValue(config, "webhookUrl"), true);
        requireText(
          "target",
          "Default Google Chat thread key",
          resolveChannelConfigTarget(connection.key, config),
          "warn",
        );
        break;
      case "teams":
        checkUrl("url", "Teams webhook URL", host.readConnectionConfigValue(config, "webhookUrl"), true);
        break;
      case "whatsapp":
        requireSecretRef("auth", "WhatsApp access token", "accessToken", "accessTokenEnv");
        requireText(
          "sender",
          "WhatsApp phone number id",
          host.readConnectionConfigValue(config, "phoneNumberId"),
          "warn",
        );
        requireText("target", "Default WhatsApp recipient", resolveChannelConfigTarget(connection.key, config), "warn");
        break;
      case "signal":
        checkUrl(
          "url",
          "Signal bridge URL",
          host.readConnectionConfigValue(config, "baseUrl") ?? host.readConnectionConfigValue(config, "bridgeUrl"),
          true,
        );
        requireText("target", "Default Signal recipient", resolveChannelConfigTarget(connection.key, config), "warn");
        break;
      case "mattermost":
        checkUrl("url", "Mattermost server URL", host.readConnectionConfigValue(config, "serverUrl"), true);
        requireSecretRef("auth", "Mattermost bot token", "botToken", "botTokenEnv");
        requireText("target", "Default Mattermost channel", resolveChannelConfigTarget(connection.key, config), "warn");
        break;
      case "imessage":
        checkUrl(
          "url",
          "iMessage bridge URL",
          host.readConnectionConfigValue(config, "bridgeUrl") ?? host.readConnectionConfigValue(config, "baseUrl"),
          true,
        );
        requireSecretRef("auth", "iMessage bridge password", "password", "passwordEnv");
        requireText("target", "Default iMessage handle", resolveChannelConfigTarget(connection.key, config), "warn");
        break;
      case "nextcloud-talk":
        checkUrl("url", "Nextcloud base URL", host.readConnectionConfigValue(config, "baseUrl"), true);
        requireSecretRef("auth", "Nextcloud Talk token", "token", "tokenEnv");
        requireText(
          "target",
          "Default Nextcloud Talk room",
          resolveChannelConfigTarget(connection.key, config),
          "warn",
        );
        break;
      case "line":
        requireSecretRef("auth", "LINE channel access token", "channelAccessToken", "channelAccessTokenEnv");
        requireText("target", "Default LINE target", resolveChannelConfigTarget(connection.key, config), "warn");
        break;
      case "zalo":
        requireSecretRef("auth", "Zalo access token", "accessToken", "accessTokenEnv");
        requireText("target", "Default Zalo recipient", resolveChannelConfigTarget(connection.key, config), "warn");
        break;
      case "zalouser": {
        const baseUrl =
          host.readConnectionConfigValue(config, "baseUrl") ??
          host.readConnectionConfigValue(config, "bridgeUrl") ??
          host.readConnectionConfigValue(config, "serverUrl");
        checkUrl("url", "Zalo User bridge URL", baseUrl, true);
        const hasAuth = Boolean(
          host.readConnectionConfigValue(config, "authToken") ||
          hasConnectionEnvValue(host, config, "authTokenEnv") ||
          host.readConnectionConfigValue(config, "authorization") ||
          hasConnectionEnvValue(host, config, "authorizationEnv") ||
          host.readConnectionConfigValue(config, "basicAuth") ||
          hasConnectionEnvValue(host, config, "basicAuthEnv") ||
          host.readConnectionConfigValue(config, "accessToken") ||
          hasConnectionEnvValue(host, config, "accessTokenEnv"),
        );
        checks.push({
          key: "auth",
          status: connectionUrlHelpers.isConnectionValueLocalUrl(baseUrl) || hasAuth ? "pass" : "warn",
          message: connectionUrlHelpers.isConnectionValueLocalUrl(baseUrl)
            ? "Local zca bridge does not require authentication."
            : hasAuth
              ? "Zalo User bridge authentication is configured."
              : "Bridge authentication is not configured.",
        });
        requireText(
          "target",
          "Default Zalo User recipient",
          resolveChannelConfigTarget(connection.key, config),
          "warn",
        );
        break;
      }
      default:
        requireText("target", "Default target", resolveChannelConfigTarget(connection.key, config), "warn");
        requireSecretRef("auth", "Channel token", "token", "tokenEnv");
        break;
    }
  } else if (connection.kind === "model_provider") {
    checkUrl("url", "Provider base URL", host.readConnectionConfigValue(config, "baseUrl"), true);
    requireText("target", "Default model", host.readConnectionConfigValue(config, "model"), "warn");
    const isLocal = connectionUrlHelpers.isConnectionValueLocalUrl(host.readConnectionConfigValue(config, "baseUrl"));
    checks.push({
      key: "auth",
      status:
        isLocal || host.readConnectionConfigValue(config, "apiKey") || hasConnectionEnvValue(host, config, "apiKeyEnv")
          ? "pass"
          : "fail",
      message: isLocal
        ? "Local model endpoint does not require an API key."
        : host.readConnectionConfigValue(config, "apiKey") || hasConnectionEnvValue(host, config, "apiKeyEnv")
          ? "API key is configured."
          : "API key is missing.",
    });
  } else if (connection.kind === "automation") {
    if (connection.key === "webhooks") {
      checkUrl("url", "Webhook base URL", host.readConnectionConfigValue(config, "baseUrl"), true);
    }
    if (connection.key === "gmail") {
      requireText("auth", "Gmail refresh token handle", host.readConnectionConfigValue(config, "refreshTokenHandle"));
    }
  }

  return checks;
}

export async function runIntegrationConnectionLiveChecks(
  host: IntegrationDiagnosticsHost,
  connection: IntegrationConnection,
  options: {
    includeSandboxSend: boolean;
  },
): Promise<{ checks: ConnectorDiagnosticReport["checks"]; probe?: ChannelProbeReport }> {
  if (connection.kind !== "channel") {
    return { checks: [] };
  }
  const config = connection.config;
  switch (connection.key) {
    case "slack": {
      const token =
        host.resolveConnectionSecret(config, "botToken", "botTokenEnv") ??
        host.resolveConnectionSecret(config, "token", "tokenEnv");
      if (!token) {
        return {
          checks: [
            {
              key: "auth_live",
              status: host.readConnectionConfigValue(config, "webhookUrl") ? "warn" : "fail",
              message: host.readConnectionConfigValue(config, "webhookUrl")
                ? "Webhook-mode Slack connections cannot be probed non-destructively without a bot token."
                : "Slack live auth probe skipped because no bot token is configured.",
            },
          ],
        };
      }
      return runSlackBotLiveChecks({
        token,
        channel: host.readConnectionConfigValue(config, "defaultChannel"),
        threadTs: host.readConnectionConfigValue(config, "defaultThreadTs"),
        includeSandboxSend: options.includeSandboxSend,
        fetcher: (url, init) => host.fetchWithDiagnosticsTimeout(url, init),
      });
    }
    case "discord":
      return runDiscordConnectionLiveChecks(host, connection, options.includeSandboxSend);
    case "telegram": {
      const token =
        host.resolveConnectionSecret(config, "botToken", "botTokenEnv") ??
        host.resolveConnectionSecret(config, "token", "tokenEnv");
      if (!token) {
        return { checks: [] };
      }
      return runTelegramBotLiveChecks({
        token,
        chatId: host.readConnectionConfigValue(config, "defaultChatId"),
        parseMode: host.readConnectionConfigValue(config, "parseMode"),
        includeSandboxSend: options.includeSandboxSend,
        fetcher: (url, init) => host.fetchWithDiagnosticsTimeout(url, init),
      });
    }
    case "whatsapp": {
      const accessToken =
        host.resolveConnectionSecret(config, "accessToken", "accessTokenEnv") ??
        host.resolveConnectionSecret(config, "token", "tokenEnv");
      const phoneNumberId =
        host.readConnectionConfigValue(config, "phoneNumberId") ?? host.readConnectionConfigValue(config, "senderId");
      if (!accessToken || !phoneNumberId) {
        return { checks: [] };
      }
      return runWhatsAppCloudLiveChecks({
        accessToken,
        phoneNumberId,
        defaultTarget: host.readConnectionConfigValue(config, "defaultTarget"),
        baseUrl: host.readConnectionConfigValue(config, "baseUrl"),
        apiVersion: host.readConnectionConfigValue(config, "apiVersion"),
        includeSandboxSend: options.includeSandboxSend,
        fetcher: (url, init) => host.fetchWithDiagnosticsTimeout(url, init),
      });
    }
    case "signal": {
      const baseUrl =
        host.readConnectionConfigValue(config, "baseUrl") ?? host.readConnectionConfigValue(config, "bridgeUrl");
      if (!baseUrl) {
        return { checks: [] };
      }
      return runSignalBridgeLiveChecks({
        baseUrl,
        accountId:
          host.readConnectionConfigValue(config, "accountId") ?? host.readConnectionConfigValue(config, "account"),
        defaultTarget: resolveChannelConfigTarget(connection.key, config),
        includeSandboxSend: options.includeSandboxSend,
        fetcher: (url, init) => host.fetchWithDiagnosticsTimeout(url, init),
      });
    }
    case "google-chat":
      return runWebhookDestinationLiveChecks({
        channelKey: "google-chat",
        webhookUrl: host.readConnectionConfigValue(config, "webhookUrl"),
        includeSandboxSend: options.includeSandboxSend,
        defaultThreadKey: host.readConnectionConfigValue(config, "defaultThreadKey"),
        fetcher: (url, init) => host.fetchWithDiagnosticsTimeout(url, init),
      });
    case "teams":
      return runWebhookDestinationLiveChecks({
        channelKey: "teams",
        webhookUrl: host.readConnectionConfigValue(config, "webhookUrl"),
        includeSandboxSend: options.includeSandboxSend,
        cardTitle: host.readConnectionConfigValue(config, "cardTitle"),
        fetcher: (url, init) => host.fetchWithDiagnosticsTimeout(url, init),
      });
    case "mattermost": {
      const token =
        host.resolveConnectionSecret(config, "botToken", "botTokenEnv") ??
        host.resolveConnectionSecret(config, "token", "tokenEnv");
      const serverUrl =
        host.readConnectionConfigValue(config, "serverUrl") ?? host.readConnectionConfigValue(config, "baseUrl");
      if (!token || !serverUrl) {
        return { checks: [] };
      }
      return runMattermostBotLiveChecks({
        serverUrl,
        token,
        defaultChannel: host.readConnectionConfigValue(config, "defaultChannel"),
        defaultTeam: host.readConnectionConfigValue(config, "defaultTeam"),
        includeSandboxSend: options.includeSandboxSend,
        fetcher: (url, init) => host.fetchWithDiagnosticsTimeout(url, init),
      });
    }
    case "imessage": {
      const bridgeUrl =
        host.readConnectionConfigValue(config, "bridgeUrl") ??
        host.readConnectionConfigValue(config, "baseUrl") ??
        host.readConnectionConfigValue(config, "serverUrl");
      const password =
        host.resolveConnectionSecret(config, "password", "passwordEnv") ??
        host.resolveConnectionSecret(config, "apiPassword", "apiPasswordEnv");
      if (!bridgeUrl || !password) {
        return { checks: [] };
      }
      return runIMessageBridgeLiveChecks({
        bridgeUrl,
        password,
        defaultHandle:
          host.readConnectionConfigValue(config, "defaultHandle") ??
          host.readConnectionConfigValue(config, "defaultTarget"),
        includeSandboxSend: options.includeSandboxSend,
        fetcher: (url, init) => host.fetchWithDiagnosticsTimeout(url, init),
      });
    }
    case "line": {
      const channelAccessToken =
        host.resolveConnectionSecret(config, "channelAccessToken", "channelAccessTokenEnv") ??
        host.resolveConnectionSecret(config, "accessToken", "accessTokenEnv") ??
        host.resolveConnectionSecret(config, "token", "tokenEnv");
      if (!channelAccessToken) {
        return { checks: [] };
      }
      return runLineBotLiveChecks({
        channelAccessToken,
        defaultTarget: host.readConnectionConfigValue(config, "defaultTarget"),
        includeSandboxSend: options.includeSandboxSend,
        fetcher: (url, init) => host.fetchWithDiagnosticsTimeout(url, init),
      });
    }
    case "zalo": {
      const accessToken =
        host.resolveConnectionSecret(config, "accessToken", "accessTokenEnv") ??
        host.resolveConnectionSecret(config, "token", "tokenEnv");
      if (!accessToken) {
        return { checks: [] };
      }
      return runZaloBotLiveChecks({
        accessToken,
        defaultTarget: resolveChannelConfigTarget(connection.key, config),
        includeSandboxSend: options.includeSandboxSend,
        fetcher: (url, init) => host.fetchWithDiagnosticsTimeout(url, init),
      });
    }
    case "zalouser": {
      const baseUrl =
        host.readConnectionConfigValue(config, "baseUrl") ??
        host.readConnectionConfigValue(config, "bridgeUrl") ??
        host.readConnectionConfigValue(config, "serverUrl");
      if (!baseUrl) {
        return { checks: [] };
      }
      return runZaloUserBridgeLiveChecks({
        baseUrl,
        authorizationHeader: resolveZaloUserConnectionAuthorizationHeader(host, config),
        profile: host.readConnectionConfigValue(config, "profile"),
        defaultTarget: resolveChannelConfigTarget(connection.key, config),
        includeSandboxSend: options.includeSandboxSend,
        fetcher: (url, init) => host.fetchWithDiagnosticsTimeout(url, init),
      });
    }
    default:
      return { checks: [] };
  }
}

function hasConnectionEnvValue(
  host: IntegrationDiagnosticsHost,
  config: Record<string, unknown>,
  key: string,
): boolean {
  const envName = host.readConnectionConfigValue(config, key);
  return Boolean(envName && process.env[envName]?.trim());
}

function isHostAllowlisted(host: IntegrationDiagnosticsHost, hostname: string): boolean {
  if (host.config.toolPolicy.tools.profile === "danger") {
    return true;
  }
  return connectionUrlHelpers.isHostAllowlistedInList(hostname, host.config.toolPolicy.sandbox.networkAllowlist);
}

function resolveZaloUserConnectionAuthorizationHeader(
  host: IntegrationDiagnosticsHost,
  config: Record<string, unknown>,
): string | undefined {
  const explicit = host.resolveConnectionSecret(config, "authorization", "authorizationEnv");
  if (explicit) {
    return explicit;
  }
  const bearer =
    host.resolveConnectionSecret(config, "authToken", "authTokenEnv") ??
    host.resolveConnectionSecret(config, "accessToken", "accessTokenEnv");
  if (bearer) {
    return `Bearer ${bearer}`;
  }
  const basic = host.resolveConnectionSecret(config, "basicAuth", "basicAuthEnv");
  if (basic) {
    return /^Basic\s+/i.test(basic) ? basic : `Basic ${Buffer.from(basic, "utf8").toString("base64")}`;
  }
  return undefined;
}

async function runDiscordConnectionLiveChecks(
  host: IntegrationDiagnosticsHost,
  connection: IntegrationConnection,
  includeSandboxSend: boolean,
): Promise<{ checks: ConnectorDiagnosticReport["checks"]; probe: ChannelProbeReport }> {
  const config = connection.config;
  const token =
    host.resolveConnectionSecret(config, "botToken", "botTokenEnv") ??
    host.resolveConnectionSecret(config, "token", "tokenEnv");
  const runtimeMode = host.readConnectionConfigValue(config, "runtimeMode") === "gateway" ? "gateway" : "bridge";
  return runDiscordBotLiveChecks({
    token,
    channelId: host.readConnectionConfigValue(config, "defaultChannelId"),
    runtimeMode,
    webhookUrl: host.readConnectionConfigValue(config, "webhookUrl"),
    includeSandboxSend,
    runtimeStatus: runtimeMode === "gateway" ? host.getDiscordRuntimeStatus(connection.connectionId) : undefined,
    fetcher: (url, init) => host.fetchWithDiagnosticsTimeout(url, init),
  });
}
