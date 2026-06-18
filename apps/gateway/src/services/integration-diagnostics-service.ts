import { describeChannelCapabilities } from "@goatcitadel/gateway-core";
import { evaluateChannelInboundAccess } from "@goatcitadel/contracts";
import type {
  ChannelProbeReport,
  ConnectorDiagnosticReport,
  DiscordRuntimeStatus,
  IntegrationConnection,
} from "@goatcitadel/contracts";
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
import { resolveChannelConfigTarget, resolveDefaultNamedTarget } from "./channel-config.js";
import { runWebhookDestinationLiveChecks } from "./channel-webhook-probes.js";
import * as connectionUrlHelpers from "./connection-url-helpers.js";

const GENERIC_ALLOWLIST_INBOUND_CHANNELS = new Set(["slack", "whatsapp", "line", "nextcloud-talk"]);

export interface IntegrationDiagnosticsPort {
  readonly config: {
    toolPolicy: {
      tools: {
        profile: string;
      };
      sandbox: {
        networkAllowlist: string[];
      };
    };
  };
  fetchWithDiagnosticsTimeout(url: string, init?: RequestInit): Promise<Response>;
  getDiscordRuntimeStatus(
    connectionId: string,
  ): Pick<DiscordRuntimeStatus, "ready" | "lastError" | "connectedBotTag"> | undefined;
  isConnectionUrlAllowlisted(urlValue: string): boolean;
  readConnectionConfigValue(config: Record<string, unknown>, key: string): string | undefined;
  resolveConnectionSecret(config: Record<string, unknown>, directKey: string, envKey: string): string | undefined;
}

export class IntegrationDiagnosticsService {
  public constructor(private readonly deps: IntegrationDiagnosticsPort) {}

  public buildIntegrationConnectionChecks(connection: IntegrationConnection): ConnectorDiagnosticReport["checks"] {
    return buildIntegrationConnectionChecks(this.deps, connection);
  }

  public runIntegrationConnectionLiveChecks(
    connection: IntegrationConnection,
    options: {
      includeSandboxSend: boolean;
    },
  ): Promise<{ checks: ConnectorDiagnosticReport["checks"]; probe?: ChannelProbeReport }> {
    return runIntegrationConnectionLiveChecks(this.deps, connection, options);
  }
}

export function buildIntegrationConnectionChecks(
  deps: IntegrationDiagnosticsPort,
  connection: IntegrationConnection,
): ConnectorDiagnosticReport["checks"] {
  const checks: ConnectorDiagnosticReport["checks"] = [];
  const config = connection.config;
  const channelFeatures =
    connection.kind === "channel" ? describeChannelFeatureMetadata(connection.key, config) : undefined;
  const channelCapabilities =
    connection.kind === "channel" ? describeChannelCapabilities(connection.key, config) : undefined;
  const requireSecretRef = (key: string, label: string, directKey: string, envKey: string) => {
    const direct = deps.readConnectionConfigValue(config, directKey);
    const envName = deps.readConnectionConfigValue(config, envKey);
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
    const allowlisted = !urlValue || deps.isConnectionUrlAllowlisted(urlValue);
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

  // Check for "*" wildcard in any connection-level allowlist configuration fields
  for (const [configKey, configValue] of Object.entries(config)) {
    if (configKey.toLowerCase().includes("allowlist") || configKey.toLowerCase().includes("whitelist")) {
      const list = Array.isArray(configValue)
        ? configValue.map(String)
        : typeof configValue === "string"
          ? configValue.split(",").map((s) => s.trim())
          : [];
      if (list.includes("*")) {
        checks.push({
          key: `allowlist_wildcard_${configKey}`,
          status: "warn",
          message: `Connection-level ${configKey} contains a wildcard "*". Wildcard rules only widen access to public hosts, and do not bypass local/private network protections.`,
        });
      }
    }
  }

  // Check if global network allowlist contains wildcard
  const globalAllowlist = deps.config.toolPolicy.sandbox.networkAllowlist ?? [];
  if (globalAllowlist.includes("*")) {
    checks.push({
      key: "global_allowlist_wildcard",
      status: "warn",
      message:
        "Global network allowlist contains '*'. This enables outbound connections to all public hosts, but local/private addresses remain protected by sandbox guards.",
    });
  }

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
      checks.push(...buildChannelInboundAccessDiagnosticChecks(connection.key, config, channelCapabilities));
    }
    switch (connection.key) {
      case "slack":
        checks.push({
          key: "auth",
          status:
            deps.readConnectionConfigValue(config, "webhookUrl") ||
            deps.readConnectionConfigValue(config, "botToken") ||
            hasConnectionEnvValue(deps, config, "botTokenEnv")
              ? "pass"
              : "fail",
          message:
            deps.readConnectionConfigValue(config, "webhookUrl") ||
            deps.readConnectionConfigValue(config, "botToken") ||
            hasConnectionEnvValue(deps, config, "botTokenEnv")
              ? "Slack bot token or webhook is configured."
              : "Slack bot token or webhook is missing.",
        });
        checkUrl("url", "Slack webhook URL", deps.readConnectionConfigValue(config, "webhookUrl"), false);
        requireText("target", "Default Slack channel", resolveChannelConfigTarget(connection.key, config), "warn");
        break;
      case "discord":
        checks.push({
          key: "auth",
          status:
            deps.readConnectionConfigValue(config, "webhookUrl") ||
            deps.readConnectionConfigValue(config, "botToken") ||
            hasConnectionEnvValue(deps, config, "botTokenEnv")
              ? "pass"
              : "fail",
          message:
            deps.readConnectionConfigValue(config, "webhookUrl") ||
            deps.readConnectionConfigValue(config, "botToken") ||
            hasConnectionEnvValue(deps, config, "botTokenEnv")
              ? "Discord bot token or webhook is configured."
              : "Discord bot token or webhook is missing.",
        });
        checkUrl("url", "Discord webhook URL", deps.readConnectionConfigValue(config, "webhookUrl"), false);
        requireText("target", "Default Discord channel", resolveChannelConfigTarget(connection.key, config), "warn");
        break;
      case "telegram":
        requireSecretRef("auth", "Telegram bot token", "botToken", "botTokenEnv");
        requireText("target", "Default Telegram chat", resolveChannelConfigTarget(connection.key, config), "warn");
        checks.push({
          key: "url",
          status: isHostAllowlisted(deps, "api.telegram.org") ? "pass" : "warn",
          message: isHostAllowlisted(deps, "api.telegram.org")
            ? "Telegram API host is allowlisted."
            : "Telegram API host is not allowlisted.",
        });
        break;
      case "google-chat":
        checkUrl("url", "Google Chat webhook URL", deps.readConnectionConfigValue(config, "webhookUrl"), true);
        requireText(
          "target",
          "Default Google Chat thread key",
          resolveChannelConfigTarget(connection.key, config),
          "warn",
        );
        break;
      case "teams":
        checkUrl("url", "Teams webhook URL", deps.readConnectionConfigValue(config, "webhookUrl"), true);
        break;
      case "whatsapp":
        requireSecretRef("auth", "WhatsApp access token", "accessToken", "accessTokenEnv");
        requireText(
          "sender",
          "WhatsApp phone number id",
          deps.readConnectionConfigValue(config, "phoneNumberId"),
          "warn",
        );
        requireText("target", "Default WhatsApp recipient", resolveChannelConfigTarget(connection.key, config), "warn");
        break;
      case "signal":
        checkUrl(
          "url",
          "Signal bridge URL",
          deps.readConnectionConfigValue(config, "baseUrl") ?? deps.readConnectionConfigValue(config, "bridgeUrl"),
          true,
        );
        requireText("target", "Default Signal recipient", resolveChannelConfigTarget(connection.key, config), "warn");
        break;
      case "mattermost":
        checkUrl("url", "Mattermost server URL", deps.readConnectionConfigValue(config, "serverUrl"), true);
        requireSecretRef("auth", "Mattermost bot token", "botToken", "botTokenEnv");
        requireText("target", "Default Mattermost channel", resolveChannelConfigTarget(connection.key, config), "warn");
        break;
      case "imessage":
        checkUrl(
          "url",
          "iMessage bridge URL",
          deps.readConnectionConfigValue(config, "bridgeUrl") ?? deps.readConnectionConfigValue(config, "baseUrl"),
          true,
        );
        requireSecretRef("auth", "iMessage bridge password", "password", "passwordEnv");
        requireText("target", "Default iMessage handle", resolveChannelConfigTarget(connection.key, config), "warn");
        break;
      case "nextcloud-talk":
        checkUrl("url", "Nextcloud base URL", deps.readConnectionConfigValue(config, "baseUrl"), true);
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
          deps.readConnectionConfigValue(config, "baseUrl") ??
          deps.readConnectionConfigValue(config, "bridgeUrl") ??
          deps.readConnectionConfigValue(config, "serverUrl");
        checkUrl("url", "Zalo User bridge URL", baseUrl, true);
        const hasAuth = Boolean(
          deps.readConnectionConfigValue(config, "authToken") ||
          hasConnectionEnvValue(deps, config, "authTokenEnv") ||
          deps.readConnectionConfigValue(config, "authorization") ||
          hasConnectionEnvValue(deps, config, "authorizationEnv") ||
          deps.readConnectionConfigValue(config, "basicAuth") ||
          hasConnectionEnvValue(deps, config, "basicAuthEnv") ||
          deps.readConnectionConfigValue(config, "accessToken") ||
          hasConnectionEnvValue(deps, config, "accessTokenEnv"),
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
    checkUrl("url", "Provider base URL", deps.readConnectionConfigValue(config, "baseUrl"), true);
    requireText("target", "Default model", deps.readConnectionConfigValue(config, "model"), "warn");
    const isLocal = connectionUrlHelpers.isConnectionValueLocalUrl(deps.readConnectionConfigValue(config, "baseUrl"));
    checks.push({
      key: "auth",
      status:
        isLocal || deps.readConnectionConfigValue(config, "apiKey") || hasConnectionEnvValue(deps, config, "apiKeyEnv")
          ? "pass"
          : "fail",
      message: isLocal
        ? "Local model endpoint does not require an API key."
        : deps.readConnectionConfigValue(config, "apiKey") || hasConnectionEnvValue(deps, config, "apiKeyEnv")
          ? "API key is configured."
          : "API key is missing.",
    });
  } else if (connection.kind === "automation") {
    if (connection.key === "webhooks") {
      checkUrl("url", "Webhook base URL", deps.readConnectionConfigValue(config, "baseUrl"), true);
    }
    if (connection.key === "gmail") {
      requireText("auth", "Gmail refresh token handle", deps.readConnectionConfigValue(config, "refreshTokenHandle"));
      checks.push({
        key: "auth_mode",
        status:
          hasConnectionEnvValue(deps, config, "clientIdEnv") && hasConnectionEnvValue(deps, config, "clientSecretEnv")
            ? "pass"
            : "warn",
        message:
          hasConnectionEnvValue(deps, config, "clientIdEnv") && hasConnectionEnvValue(deps, config, "clientSecretEnv")
            ? "OAuth client env references are configured."
            : "OAuth client env references are not fully configured yet.",
      });
    }
    if (connection.key === "gif-search") {
      requireText("provider", "GIF search provider", deps.readConnectionConfigValue(config, "provider"), "warn");
      checks.push({
        key: "auth",
        status:
          hasConnectionEnvValue(deps, config, "apiKeyEnv") || deps.readConnectionConfigValue(config, "apiKey")
            ? "pass"
            : "fail",
        message:
          hasConnectionEnvValue(deps, config, "apiKeyEnv") || deps.readConnectionConfigValue(config, "apiKey")
            ? "GIF search API key is configured."
            : "GIF search API key is missing.",
      });
    }
    if (connection.key === "peekaboo-screen" || connection.key === "camera-photo-video") {
      const bridgeUrl =
        deps.readConnectionConfigValue(config, "bridgeUrl") ?? deps.readConnectionConfigValue(config, "baseUrl");
      checkUrl("url", "Local bridge URL", bridgeUrl, true);
      checks.push({
        key: "bridge_auth",
        status:
          connectionUrlHelpers.isConnectionValueLocalUrl(bridgeUrl) ||
          deps.readConnectionConfigValue(config, "authToken") ||
          hasConnectionEnvValue(deps, config, "authTokenEnv")
            ? "pass"
            : "warn",
        message: connectionUrlHelpers.isConnectionValueLocalUrl(bridgeUrl)
          ? "Local bridge URL is configured."
          : deps.readConnectionConfigValue(config, "authToken") || hasConnectionEnvValue(deps, config, "authTokenEnv")
            ? "Remote bridge authentication is configured."
            : "Remote bridge authentication is not configured.",
      });
    }
  } else if (connection.kind === "productivity") {
    if (connection.key === "trello") {
      checks.push({
        key: "auth",
        status:
          hasConnectionEnvValue(deps, config, "apiKeyEnv") && hasConnectionEnvValue(deps, config, "tokenEnv")
            ? "pass"
            : "fail",
        message:
          hasConnectionEnvValue(deps, config, "apiKeyEnv") && hasConnectionEnvValue(deps, config, "tokenEnv")
            ? "Trello API credentials are configured."
            : "Trello API credentials are missing.",
      });
      requireText("target", "Default Trello board", deps.readConnectionConfigValue(config, "defaultBoardId"), "warn");
    }
    if (["apple-notes", "apple-reminders", "things3", "bear"].includes(connection.key)) {
      const bridgeUrl =
        deps.readConnectionConfigValue(config, "bridgeUrl") ?? deps.readConnectionConfigValue(config, "baseUrl");
      checkUrl("url", "Local bridge URL", bridgeUrl, true);
      checks.push({
        key: "host_requirement",
        status: connectionUrlHelpers.isConnectionValueLocalUrl(bridgeUrl) ? "pass" : "warn",
        message: connectionUrlHelpers.isConnectionValueLocalUrl(bridgeUrl)
          ? "Local bridge host requirement is satisfied."
          : "This productivity integration expects a local bridge or agent on the same trusted network.",
      });
    }
  } else if (connection.kind === "platform") {
    if (connection.key === "macos-menubar-voice") {
      const bridgeUrl =
        deps.readConnectionConfigValue(config, "bridgeUrl") ?? deps.readConnectionConfigValue(config, "baseUrl");
      checkUrl("url", "macOS bridge URL", bridgeUrl, true);
      checks.push({
        key: "host_requirement",
        status: connectionUrlHelpers.isConnectionValueLocalUrl(bridgeUrl) ? "pass" : "warn",
        message: connectionUrlHelpers.isConnectionValueLocalUrl(bridgeUrl)
          ? "macOS bridge is configured on a local host"
          : "macOS Menu Bar + Voice expects a trusted local bridge or agent host",
      });
    }
    if (connection.key === "ios-canvas-camera-voice") {
      requireText("device", "Device ID", deps.readConnectionConfigValue(config, "deviceId"), "warn");
      checks.push({
        key: "companion",
        status:
          deps.readConnectionConfigValue(config, "companionSessionId") ||
          deps.readConnectionConfigValue(config, "bridgeUrl")
            ? "pass"
            : "warn",
        message:
          deps.readConnectionConfigValue(config, "companionSessionId") ||
          deps.readConnectionConfigValue(config, "bridgeUrl")
            ? "A companion session or bridge target is configured."
            : "Pair an iOS companion session or bridge target before claiming this capability as ready.",
      });
    }
  }

  return checks;
}

function buildChannelInboundAccessDiagnosticChecks(
  channelKey: string,
  config: Record<string, unknown>,
  channelCapabilities: ReturnType<typeof describeChannelCapabilities>,
): ConnectorDiagnosticReport["checks"] {
  if (!GENERIC_ALLOWLIST_INBOUND_CHANNELS.has(channelKey)) {
    return [];
  }
  if (!channelCapabilities.inboundModes.some((mode) => mode !== "none")) {
    return [];
  }
  const decision = evaluateChannelInboundAccess({ config });
  if (decision.legacyWarning) {
    return [
      {
        key: "inbound_access_legacy_open",
        status: "warn",
        message: decision.legacyWarning,
      },
    ];
  }
  if (decision.mode === "allowlist" && decision.allowedSenders.length === 0) {
    return [
      {
        key: "inbound_access_allowlist_empty",
        status: "warn",
        message:
          "Inbound allowlist mode is enabled, but no allowedSenders are configured. Inbound messages will be dropped until a sender is added.",
      },
    ];
  }
  return [
    {
      key: "inbound_access",
      status: "pass",
      message: `Inbound allowlist mode is active with ${decision.allowedSenders.length} permitted sender${decision.allowedSenders.length === 1 ? "" : "s"}.`,
    },
  ];
}

export async function runIntegrationConnectionLiveChecks(
  deps: IntegrationDiagnosticsPort,
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
        deps.resolveConnectionSecret(config, "botToken", "botTokenEnv") ??
        deps.resolveConnectionSecret(config, "token", "tokenEnv");
      if (!token) {
        return {
          checks: [
            {
              key: "auth_live",
              status: deps.readConnectionConfigValue(config, "webhookUrl") ? "warn" : "fail",
              message: deps.readConnectionConfigValue(config, "webhookUrl")
                ? "Webhook-mode Slack connections cannot be probed non-destructively without a bot token."
                : "Slack live auth probe skipped because no bot token is configured.",
            },
          ],
        };
      }
      return runSlackBotLiveChecks({
        token,
        channel: resolveChannelConfigTarget(connection.key, config),
        threadTs:
          readTargetString(resolveDefaultNamedTarget(config), "threadTs") ??
          deps.readConnectionConfigValue(config, "defaultThreadTs"),
        includeSandboxSend: options.includeSandboxSend,
        fetcher: (url, init) => deps.fetchWithDiagnosticsTimeout(url, init),
      });
    }
    case "discord":
      return runDiscordConnectionLiveChecks(deps, connection, options.includeSandboxSend);
    case "telegram": {
      const token =
        deps.resolveConnectionSecret(config, "botToken", "botTokenEnv") ??
        deps.resolveConnectionSecret(config, "token", "tokenEnv");
      if (!token) {
        return { checks: [] };
      }
      return runTelegramBotLiveChecks({
        token,
        chatId: resolveChannelConfigTarget(connection.key, config),
        parseMode: deps.readConnectionConfigValue(config, "parseMode"),
        includeSandboxSend: options.includeSandboxSend,
        fetcher: (url, init) => deps.fetchWithDiagnosticsTimeout(url, init),
      });
    }
    case "whatsapp": {
      const accessToken =
        deps.resolveConnectionSecret(config, "accessToken", "accessTokenEnv") ??
        deps.resolveConnectionSecret(config, "token", "tokenEnv");
      const phoneNumberId =
        deps.readConnectionConfigValue(config, "phoneNumberId") ?? deps.readConnectionConfigValue(config, "senderId");
      if (!accessToken || !phoneNumberId) {
        return { checks: [] };
      }
      return runWhatsAppCloudLiveChecks({
        accessToken,
        phoneNumberId,
        defaultTarget: deps.readConnectionConfigValue(config, "defaultTarget"),
        baseUrl: deps.readConnectionConfigValue(config, "baseUrl"),
        apiVersion: deps.readConnectionConfigValue(config, "apiVersion"),
        includeSandboxSend: options.includeSandboxSend,
        fetcher: (url, init) => deps.fetchWithDiagnosticsTimeout(url, init),
      });
    }
    case "signal": {
      const baseUrl =
        deps.readConnectionConfigValue(config, "baseUrl") ?? deps.readConnectionConfigValue(config, "bridgeUrl");
      if (!baseUrl) {
        return { checks: [] };
      }
      return runSignalBridgeLiveChecks({
        baseUrl,
        accountId:
          deps.readConnectionConfigValue(config, "accountId") ?? deps.readConnectionConfigValue(config, "account"),
        defaultTarget: resolveChannelConfigTarget(connection.key, config),
        includeSandboxSend: options.includeSandboxSend,
        fetcher: (url, init) => deps.fetchWithDiagnosticsTimeout(url, init),
      });
    }
    case "google-chat":
      return runWebhookDestinationLiveChecks({
        channelKey: "google-chat",
        webhookUrl: deps.readConnectionConfigValue(config, "webhookUrl"),
        includeSandboxSend: options.includeSandboxSend,
        defaultThreadKey: deps.readConnectionConfigValue(config, "defaultThreadKey"),
        fetcher: (url, init) => deps.fetchWithDiagnosticsTimeout(url, init),
      });
    case "teams":
      return runWebhookDestinationLiveChecks({
        channelKey: "teams",
        webhookUrl: deps.readConnectionConfigValue(config, "webhookUrl"),
        includeSandboxSend: options.includeSandboxSend,
        cardTitle: deps.readConnectionConfigValue(config, "cardTitle"),
        fetcher: (url, init) => deps.fetchWithDiagnosticsTimeout(url, init),
      });
    case "mattermost": {
      const token =
        deps.resolveConnectionSecret(config, "botToken", "botTokenEnv") ??
        deps.resolveConnectionSecret(config, "token", "tokenEnv");
      const serverUrl =
        deps.readConnectionConfigValue(config, "serverUrl") ?? deps.readConnectionConfigValue(config, "baseUrl");
      if (!token || !serverUrl) {
        return { checks: [] };
      }
      return runMattermostBotLiveChecks({
        serverUrl,
        token,
        defaultChannel: deps.readConnectionConfigValue(config, "defaultChannel"),
        defaultTeam: deps.readConnectionConfigValue(config, "defaultTeam"),
        includeSandboxSend: options.includeSandboxSend,
        fetcher: (url, init) => deps.fetchWithDiagnosticsTimeout(url, init),
      });
    }
    case "imessage": {
      const bridgeUrl =
        deps.readConnectionConfigValue(config, "bridgeUrl") ??
        deps.readConnectionConfigValue(config, "baseUrl") ??
        deps.readConnectionConfigValue(config, "serverUrl");
      const password =
        deps.resolveConnectionSecret(config, "password", "passwordEnv") ??
        deps.resolveConnectionSecret(config, "apiPassword", "apiPasswordEnv");
      if (!bridgeUrl || !password) {
        return { checks: [] };
      }
      return runIMessageBridgeLiveChecks({
        bridgeUrl,
        password,
        defaultHandle:
          deps.readConnectionConfigValue(config, "defaultHandle") ??
          deps.readConnectionConfigValue(config, "defaultTarget"),
        includeSandboxSend: options.includeSandboxSend,
        fetcher: (url, init) => deps.fetchWithDiagnosticsTimeout(url, init),
      });
    }
    case "line": {
      const channelAccessToken =
        deps.resolveConnectionSecret(config, "channelAccessToken", "channelAccessTokenEnv") ??
        deps.resolveConnectionSecret(config, "accessToken", "accessTokenEnv") ??
        deps.resolveConnectionSecret(config, "token", "tokenEnv");
      if (!channelAccessToken) {
        return { checks: [] };
      }
      return runLineBotLiveChecks({
        channelAccessToken,
        defaultTarget: deps.readConnectionConfigValue(config, "defaultTarget"),
        includeSandboxSend: options.includeSandboxSend,
        fetcher: (url, init) => deps.fetchWithDiagnosticsTimeout(url, init),
      });
    }
    case "zalo": {
      const accessToken =
        deps.resolveConnectionSecret(config, "accessToken", "accessTokenEnv") ??
        deps.resolveConnectionSecret(config, "token", "tokenEnv");
      if (!accessToken) {
        return { checks: [] };
      }
      return runZaloBotLiveChecks({
        accessToken,
        defaultTarget: resolveChannelConfigTarget(connection.key, config),
        includeSandboxSend: options.includeSandboxSend,
        fetcher: (url, init) => deps.fetchWithDiagnosticsTimeout(url, init),
      });
    }
    case "zalouser": {
      const baseUrl =
        deps.readConnectionConfigValue(config, "baseUrl") ??
        deps.readConnectionConfigValue(config, "bridgeUrl") ??
        deps.readConnectionConfigValue(config, "serverUrl");
      if (!baseUrl) {
        return { checks: [] };
      }
      return runZaloUserBridgeLiveChecks({
        baseUrl,
        authorizationHeader: resolveZaloUserConnectionAuthorizationHeader(deps, config),
        profile: deps.readConnectionConfigValue(config, "profile"),
        defaultTarget: resolveChannelConfigTarget(connection.key, config),
        includeSandboxSend: options.includeSandboxSend,
        fetcher: (url, init) => deps.fetchWithDiagnosticsTimeout(url, init),
      });
    }
    default:
      return { checks: [] };
  }
}

function readTargetString(target: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = target?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function hasConnectionEnvValue(
  deps: IntegrationDiagnosticsPort,
  config: Record<string, unknown>,
  key: string,
): boolean {
  const envName = deps.readConnectionConfigValue(config, key);
  return Boolean(envName && process.env[envName]?.trim());
}

function isHostAllowlisted(deps: IntegrationDiagnosticsPort, hostname: string): boolean {
  return connectionUrlHelpers.isHostAllowlistedInList(hostname, deps.config.toolPolicy.sandbox.networkAllowlist);
}

function resolveZaloUserConnectionAuthorizationHeader(
  deps: IntegrationDiagnosticsPort,
  config: Record<string, unknown>,
): string | undefined {
  const explicit = deps.resolveConnectionSecret(config, "authorization", "authorizationEnv");
  if (explicit) {
    return explicit;
  }
  const bearer =
    deps.resolveConnectionSecret(config, "authToken", "authTokenEnv") ??
    deps.resolveConnectionSecret(config, "accessToken", "accessTokenEnv");
  if (bearer) {
    return `Bearer ${bearer}`;
  }
  const basic = deps.resolveConnectionSecret(config, "basicAuth", "basicAuthEnv");
  if (basic) {
    return /^Basic\s+/i.test(basic) ? basic : `Basic ${Buffer.from(basic, "utf8").toString("base64")}`;
  }
  return undefined;
}

async function runDiscordConnectionLiveChecks(
  deps: IntegrationDiagnosticsPort,
  connection: IntegrationConnection,
  includeSandboxSend: boolean,
): Promise<{ checks: ConnectorDiagnosticReport["checks"]; probe: ChannelProbeReport }> {
  const config = connection.config;
  const token =
    deps.resolveConnectionSecret(config, "botToken", "botTokenEnv") ??
    deps.resolveConnectionSecret(config, "token", "tokenEnv");
  const runtimeMode = deps.readConnectionConfigValue(config, "runtimeMode") === "gateway" ? "gateway" : "bridge";
  return runDiscordBotLiveChecks({
    token,
    channelId: deps.readConnectionConfigValue(config, "defaultChannelId"),
    runtimeMode,
    webhookUrl: deps.readConnectionConfigValue(config, "webhookUrl"),
    includeSandboxSend,
    runtimeStatus: runtimeMode === "gateway" ? deps.getDiscordRuntimeStatus(connection.connectionId) : undefined,
    fetcher: (url, init) => deps.fetchWithDiagnosticsTimeout(url, init),
  });
}
