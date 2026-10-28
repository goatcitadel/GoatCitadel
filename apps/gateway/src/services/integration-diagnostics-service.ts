import { runDiscordConnectionLiveChecks } from "./discord-connection-diagnostics.js";
import { buildTokenAndTargetChecks, runGitHubLiveChecks } from "./github-integration-action.js";
import { runNotionLiveChecks } from "./notion-integration-action.js";
import { runConfiguredMatrixChecks } from "./matrix-live-probes.js";
import { runConfiguredNextcloudTalkChecks } from "./nextcloud-talk-live-probes.js";
import { appendQqbotStructuralChecks, runConfiguredQqbotChecks } from "./qqbot-live-probes.js";
import { appendWecomStructuralChecks, runConfiguredWecomChecks } from "./wecom-live-probes.js";
import { describeChannelCapabilities } from "@goatcitadel/gateway-core";
import {
  GOOGLE_WORKSPACE_CATALOG_ID,
  channelAddressHost,
  describeRetiredChannel,
  evaluateChannelInboundAccess,
} from "@goatcitadel/contracts";
import type {
  ChannelProbeReport,
  ConnectorDiagnosticReport,
  DiscordRuntimeStatus,
  GoogleWorkspaceOAuthStatus,
  IntegrationConnection,
} from "@goatcitadel/contracts";
import { buildGoogleWorkspaceConfigChecks, buildGoogleWorkspaceSignInChecks } from "./google-workspace-diagnostics.js";
import {
  runLineBotLiveChecks,
  runMattermostBotLiveChecks,
  runNtfyLiveChecks,
  runSlackBotLiveChecks,
  runTelegramBotLiveChecks,
  runWhatsAppCloudLiveChecks,
  runZaloBotLiveChecks,
} from "./channel-bot-live-probes.js";
import { buildChannelCapabilityDiagnosticChecks } from "./channel-capability-diagnostic-checks.js";
import {
  isChannelSecretReference,
  isSecureStorageReference,
  type ChannelSecretOwner,
} from "./channel-secret-resolution.js";
import { describeChannelFeatureMetadata } from "./channel-diagnostics.js";
import { resolveChannelConfigTarget, resolveDefaultNamedTarget } from "./channel-config.js";
import { runWebhookDestinationLiveChecks } from "./channel-webhook-probes.js";
import * as connectionUrlHelpers from "./connection-url-helpers.js";
import { evaluateHostEgress } from "@goatcitadel/policy-engine";
import { getChannelSetupDefinition, requireChannelSetupDefinition } from "./channel-setup-definitions.js";
import { secretEnvSuffixRule } from "./channel-setup-definitions/common.js";
import { connectionFixedHosts } from "./channel-setup-definitions/picker-hints.js";
import { FORCED_ALLOWLIST_INBOUND_CHANNELS } from "./channel-setup-inbound-access.js";
import {
  isPermittedIntegrationSecretEnvVarName,
  printableEnvVarName,
  refusedEnvVarNameMessage,
} from "./gateway/integration-secret-envvar-guard.js";

const GENERIC_ALLOWLIST_INBOUND_CHANNELS = new Set([
  "slack",
  "whatsapp",
  "line",
  "nextcloud-talk",
  "ntfy",
  "mattermost",
  "matrix",
  "google-chat",
  "qqbot",
  "wecom",
]);

export interface IntegrationDiagnosticsPort {
  readonly config: {
    toolPolicy: {
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
  /** `owner` is the connection the config belongs to: a saved key is read only for the connection that saved it. */
  resolveConnectionSecret(
    config: Record<string, unknown>,
    directKey: string,
    envKey: string,
    catalogId: string,
    owner: ChannelSecretOwner,
  ): string | undefined;
  /** Google sign-in readiness for a Gmail and Google Calendar connection, read from the OS keychain. */
  getGoogleWorkspaceOAuthStatus?(connectionId: string): Promise<GoogleWorkspaceOAuthStatus>;
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
      discordRuntimeReadiness?: "required" | "deferred";
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
  // Presence is decided by the resolver the live probes use, so a variable whose name the Gateway refuses to read does
  // not pass here and then give a live check with nothing to check. Only names are reported, never a resolved value.
  const requireSecretRef = (key: string, label: string, directKey: string, envKey: string) => {
    const envName = deps.readConnectionConfigValue(config, envKey);
    if (deps.resolveConnectionSecret(config, directKey, envKey, connection.catalogId, connection)) {
      // The name is printed only when the variable is what answered, and only when it has the shape of a name: an old
      // connection can hold a token in the name field, and a direct value can answer while a stale name sits there.
      const via = deps.readConnectionConfigValue(config, directKey) ? undefined : printableEnvVarName(envName);
      checks.push({ key, status: "pass", message: `${label} is configured${via ? ` via ${via}` : ""}.` });
      return;
    }
    const refused = envName !== undefined && !isPermittedIntegrationSecretEnvVarName(envName, connection.catalogId);
    checks.push({
      key,
      status: "fail",
      message: refused ? refusedVariableNameMessage(connection, envKey) : `${label} is missing.`,
    });
  };
  const requireText = (key: string, label: string, value: string | undefined, status: "warn" | "fail" = "fail") => {
    checks.push({
      key,
      status: value ? "pass" : status,
      message: value ? `${label} is set.` : `${label} is missing.`,
    });
  };
  // The hosts of the addresses `checkUrl` has reported on, so the provider hosts check doesn't report them twice.
  const addressHosts = new Set<string>();
  const checkUrl = (key: string, label: string, urlValue: string | undefined, required = false) => {
    if (!urlValue && !required) {
      return;
    }
    const addressHost = channelAddressHost(urlValue);
    if (addressHost) {
      addressHosts.add(addressHost);
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
            ? `${label} host is on the network allowlist.`
            : `${label} host is not in the current outbound allowlist.`,
    });
  };
  // A pasted webhook address is a secret: it is kept in secure storage and the config holds a reference to it. The
  // address check reads the address that a channel reference points to, for this connection only. Any other reference
  // (or one that gives no address) is a missing address, never an insecure one, and the check then runs as required
  // even when the channel's webhook is optional: a saved address that can't be read must not pass silently. Only the
  // check sees the address; nothing here reports it.
  const checkSavedAddress = (key: string, label: string, field: string, required: boolean) => {
    const value = deps.readConnectionConfigValue(config, field);
    const wasReference = value !== undefined && isSecureStorageReference(value);
    const address = !wasReference
      ? value
      : isChannelSecretReference(value)
        ? deps.resolveConnectionSecret(config, field, `${field}Env`, connection.catalogId, connection)
        : undefined;
    checkUrl(key, label, address, required || wasReference);
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

  const retiredReason = connection.kind === "channel" ? describeRetiredChannel(connection.key) : undefined;
  if (retiredReason) {
    checks.push({ key: "retired", status: "fail", message: retiredReason });
    return checks;
  }

  if (connection.kind === "channel") {
    checks.push({
      key: "actions",
      status: "pass",
      message: `Supported delivery actions: ${(channelFeatures?.supportedDeliveryActions ?? ["channel.send"]).join(", ")}.`,
    });
    // A channel with no attachment source simply sends text. That is a fact about the channel, not a setup problem the
    // operator can fix, so it is a plain statement (like the outbound-only inbound mode) and never blocks Finalize.
    const attachmentSources = channelFeatures?.supportedAttachmentSources ?? [];
    checks.push({
      key: "attachments",
      status: "pass",
      message:
        attachmentSources.length > 0
          ? `Supported attachment sources: ${attachmentSources.join(", ")}.`
          : "This channel sends text. Attachments aren't supported.",
    });
    if (channelCapabilities) {
      checks.push(...buildChannelCapabilityDiagnosticChecks(channelCapabilities));
      checks.push(...buildChannelInboundAccessDiagnosticChecks(connection.key, config, channelCapabilities));
    }
    switch (connection.key) {
      case "slack": {
        // The legacy `token` / `tokenEnv` pair is a bot token too: Slack's sends read it after `botToken`.
        const slackBotToken = Boolean(
          deps.readConnectionConfigValue(config, "botToken") ||
          hasConnectionEnvValue(deps, connection, "botTokenEnv") ||
          deps.readConnectionConfigValue(config, "token") ||
          hasConnectionEnvValue(deps, connection, "tokenEnv"),
        );
        const slackAuthSet = slackBotToken || Boolean(deps.readConnectionConfigValue(config, "webhookUrl"));
        checks.push({
          key: "auth",
          status: slackAuthSet ? "pass" : "fail",
          message: slackAuthSet
            ? "Slack bot token or webhook is configured."
            : "Slack bot token or webhook is missing.",
        });
        checkSavedAddress("url", "Slack webhook URL", "webhookUrl", false);
        // An incoming webhook posts to the one channel it was made for, so only a bot token needs a default channel.
        if (slackBotToken) {
          requireText("target", "Default Slack channel", resolveChannelConfigTarget(connection.key, config), "warn");
        }
        break;
      }
      case "discord":
        checks.push({
          key: "auth",
          status:
            deps.readConnectionConfigValue(config, "webhookUrl") ||
            deps.readConnectionConfigValue(config, "botToken") ||
            hasConnectionEnvValue(deps, connection, "botTokenEnv")
              ? "pass"
              : "fail",
          message:
            deps.readConnectionConfigValue(config, "webhookUrl") ||
            deps.readConnectionConfigValue(config, "botToken") ||
            hasConnectionEnvValue(deps, connection, "botTokenEnv")
              ? "Discord bot token or webhook is configured."
              : "Discord bot token or webhook is missing.",
        });
        checkSavedAddress("url", "Discord webhook URL", "webhookUrl", false);
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
        checks.push({
          key: "rich_message_policy",
          status: "pass",
          message:
            "Telegram rich-message policy: Bot API photo/document delivery is preflighted, caption limits are recorded, metadata-only attachments are blocked, and rich batches are capped at 10 attachments.",
        });
        break;
      case "ntfy":
        checkUrl("url", "ntfy server URL", deps.readConnectionConfigValue(config, "baseUrl"), true);
        requireText(
          "target",
          "ntfy topic",
          deps.readConnectionConfigValue(config, "topic") ?? deps.readConnectionConfigValue(config, "defaultTopic"),
        );
        checks.push({
          key: "delivery_posture",
          status: "pass",
          message:
            "The guided test publishes the ntfy test message at most once; you confirm yourself that it arrived. Inbound is a separate opt-in topic subscription (inboundStreamEnabled with a token); anyone able to publish to the subscribed topic can start turns.",
        });
        break;
      case "google-chat":
        if (isGoogleChatAppConfig(deps, config)) {
          requireSecretRef("auth", "Google Chat service-account key", "serviceAccountKey", "serviceAccountKeyEnv");
          requireText(
            "audience",
            "Google Chat app audience",
            deps.readConnectionConfigValue(config, "audience"),
            "warn",
          );
          requireText(
            "target",
            "Default Google Chat space",
            deps.readConnectionConfigValue(config, "defaultSpace"),
            "warn",
          );
          break;
        }
        // An incoming webhook is already bound to its space, and its thread key is optional, so nothing asks for one.
        checkSavedAddress("url", "Google Chat webhook URL", "webhookUrl", true);
        break;
      case "teams":
        checkSavedAddress("url", "Teams webhook URL", "webhookUrl", true);
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
        checks.push({
          key: "rich_message_policy",
          status: "pass",
          message:
            "WhatsApp rich-message policy: Cloud API image/video/audio/document delivery is preflighted, text-only fallbacks are labeled, pending attachment hydration is visible, and rich batches are capped at 10 attachments.",
        });
        break;
      case "mattermost":
        checkUrl("url", "Mattermost server URL", deps.readConnectionConfigValue(config, "serverUrl"), true);
        requireSecretRef("auth", "Mattermost bot token", "botToken", "botTokenEnv");
        requireText("target", "Default Mattermost channel", resolveChannelConfigTarget(connection.key, config), "warn");
        break;
      case "matrix":
        checkUrl("url", "Matrix homeserver URL", deps.readConnectionConfigValue(config, "homeserverUrl"), true);
        requireSecretRef("auth", "Matrix access token", "accessToken", "accessTokenEnv");
        requireText("target", "Default Matrix room", resolveChannelConfigTarget(connection.key, config), "warn");
        checks.push({
          key: "delivery_posture",
          status: "pass",
          message:
            "Matrix outbound is text-only. Inbound is a separate opt-in /sync long-poll (inboundStreamEnabled); inbound is default-deny and only allowlisted Matrix user ids can start turns. If the homeserver rejects the stored sync token the runtime re-primes and messages in that gap are skipped.",
        });
        break;
      case "qqbot":
        appendQqbotStructuralChecks({
          deps,
          config,
          target: resolveChannelConfigTarget(connection.key, config),
          checks,
          requireText,
          requireSecretRef,
        });
        break;
      case "wecom":
        appendWecomStructuralChecks({
          deps,
          config,
          target: resolveChannelConfigTarget(connection.key, config),
          checks,
          requireText,
          requireSecretRef,
        });
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
        requireText("target", "Default OA user ID", resolveChannelConfigTarget(connection.key, config), "warn");
        break;
      default:
        requireText("target", "Default target", resolveChannelConfigTarget(connection.key, config), "warn");
        requireSecretRef("auth", "Channel token", "token", "tokenEnv");
        break;
    }
    const providerHosts = buildProviderHostsCheck(deps, connection, addressHosts);
    if (providerHosts) {
      checks.push(providerHosts);
    }
  } else if (connection.kind === "model_provider") {
    checkUrl("url", "Provider base URL", deps.readConnectionConfigValue(config, "baseUrl"), true);
    requireText("target", "Default model", deps.readConnectionConfigValue(config, "model"), "warn");
    const isLocal = connectionUrlHelpers.isConnectionValueLocalUrl(deps.readConnectionConfigValue(config, "baseUrl"));
    // No resolver reads a model provider connection's key variable, and its form suggests the provider's own variable
    // (OPENAI_API_KEY), which the credential guard forbids. So this one stays a plain check that the variable is set.
    const apiKeySet = deps.readConnectionConfigValue(config, "apiKey") || hasProcessEnvValue(deps, config, "apiKeyEnv");
    checks.push({
      key: "auth",
      status: isLocal || apiKeySet ? "pass" : "fail",
      message: isLocal
        ? "Local model endpoint does not require an API key."
        : apiKeySet
          ? "API key is configured."
          : "API key is missing.",
    });
  } else if (connection.kind === "automation") {
    if (connection.key === "webhooks") {
      checkUrl("url", "Webhook base URL", deps.readConnectionConfigValue(config, "baseUrl"), true);
    }
    if (connection.key === "gmail") {
      checks.push(...buildGoogleWorkspaceConfigChecks(config));
    }
    if (connection.key === "gif-search") {
      requireText("provider", "GIF search provider", deps.readConnectionConfigValue(config, "provider"), "warn");
      checks.push({
        key: "auth",
        status:
          hasConnectionEnvValue(deps, connection, "apiKeyEnv") || deps.readConnectionConfigValue(config, "apiKey")
            ? "pass"
            : "fail",
        message:
          hasConnectionEnvValue(deps, connection, "apiKeyEnv") || deps.readConnectionConfigValue(config, "apiKey")
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
          hasConnectionEnvValue(deps, connection, "authTokenEnv")
            ? "pass"
            : "warn",
        message: connectionUrlHelpers.isConnectionValueLocalUrl(bridgeUrl)
          ? "Local bridge URL is configured."
          : deps.readConnectionConfigValue(config, "authToken") ||
              hasConnectionEnvValue(deps, connection, "authTokenEnv")
            ? "Remote bridge authentication is configured."
            : "Remote bridge authentication is not configured.",
      });
    }
  } else if (connection.kind === "productivity") {
    if (connection.key === "trello") {
      checks.push({
        key: "auth",
        status:
          hasConnectionEnvValue(deps, connection, "apiKeyEnv") && hasConnectionEnvValue(deps, connection, "tokenEnv")
            ? "pass"
            : "fail",
        message:
          hasConnectionEnvValue(deps, connection, "apiKeyEnv") && hasConnectionEnvValue(deps, connection, "tokenEnv")
            ? "Trello API credentials are configured."
            : "Trello API credentials are missing.",
      });
      requireText("target", "Default Trello board", deps.readConnectionConfigValue(config, "defaultBoardId"), "warn");
    }
    if (connection.key === "notion") {
      checks.push(
        ...buildTokenAndTargetChecks(deps, connection, {
          tokenLabel: "Notion integration token",
          suggestedEnv: "NOTION_INTEGRATION_TOKEN",
          targetKey: "defaultParentPageId",
          targetLabel: "Default Notion parent page",
          targetMissingStatus: "warn",
        }),
      );
    }
    if (connection.key === "github") {
      checks.push(
        ...buildTokenAndTargetChecks(deps, connection, {
          tokenLabel: "GitHub token",
          suggestedEnv: "GITHUB_INTEGRATION_TOKEN",
          targetKey: "defaultRepo",
          targetLabel: "Default GitHub repository",
          targetMissingStatus: "fail",
        }),
      );
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

function isGoogleChatAppConfig(
  deps: Pick<IntegrationDiagnosticsPort, "readConnectionConfigValue">,
  config: Record<string, unknown>,
): boolean {
  return Boolean(
    deps.readConnectionConfigValue(config, "serviceAccountKeyEnv") ??
    deps.readConnectionConfigValue(config, "serviceAccountKey"),
  );
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
  if (FORCED_ALLOWLIST_INBOUND_CHANNELS.has(channelKey)) {
    return buildForcedAllowlistInboundChecks(config);
  }
  const decision = evaluateChannelInboundAccess({ config });
  if (decision.legacyWarning) {
    const migratedAt = typeof config.inboundAccessMigratedAt === "string" ? config.inboundAccessMigratedAt : undefined;
    return [
      {
        key: "inbound_access_legacy_open",
        status: "warn",
        message: migratedAt
          ? `This connection was auto-migrated from the legacy open default on ${migratedAt}; it still accepts every sender. Configure allowedSenders and switch inboundAccessMode to "allowlist" to lock it down. ${decision.legacyWarning}`
          : decision.legacyWarning,
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

/**
 * Stream and Google Chat app inbound always run with a forced allowlist (the runtime overrides any stored
 * open_legacy), so report that posture instead of evaluating the stored mode.
 */
function buildForcedAllowlistInboundChecks(config: Record<string, unknown>): ConnectorDiagnosticReport["checks"] {
  const decision = evaluateChannelInboundAccess({ config: { ...config, inboundAccessMode: "allowlist" } });
  if (decision.allowedSenders.length === 0) {
    return [
      {
        key: "inbound_access_allowlist_empty",
        status: "warn",
        message:
          "Inbound on this channel is always allowlist-only. No senders are listed, so all inbound is dropped until a sender is added to allowedSenders.",
      },
    ];
  }
  return [
    {
      key: "inbound_access",
      status: "pass",
      message: `Inbound on this channel is always allowlist-only; ${decision.allowedSenders.length} permitted sender${decision.allowedSenders.length === 1 ? "" : "s"}.`,
    },
  ];
}

export async function runIntegrationConnectionLiveChecks(
  deps: IntegrationDiagnosticsPort,
  connection: IntegrationConnection,
  options: {
    includeSandboxSend: boolean;
    discordRuntimeReadiness?: "required" | "deferred";
  },
): Promise<{ checks: ConnectorDiagnosticReport["checks"]; probe?: ChannelProbeReport }> {
  if (connection.catalogId === "productivity.notion") {
    return { checks: await runNotionLiveChecks(deps, connection) };
  }
  if (connection.catalogId === "productivity.github") {
    return { checks: await runGitHubLiveChecks(deps, connection) };
  }
  if (connection.catalogId === GOOGLE_WORKSPACE_CATALOG_ID) {
    const readGoogleSignIn = deps.getGoogleWorkspaceOAuthStatus;
    if (readGoogleSignIn) {
      return { checks: buildGoogleWorkspaceSignInChecks(await readGoogleSignIn.call(deps, connection.connectionId)) };
    }
  }
  if (connection.kind !== "channel") {
    return { checks: [] };
  }
  const config = connection.config;
  const resolveSecret = (directKey: string, envKey: string) =>
    deps.resolveConnectionSecret(config, directKey, envKey, connection.catalogId, connection);
  switch (connection.key) {
    case "slack": {
      const token = resolveSecret("botToken", "botTokenEnv") ?? resolveSecret("token", "tokenEnv");
      if (!token) {
        const webhookUrl = resolveSecret("webhookUrl", "webhookUrlEnv");
        if (webhookUrl)
          return runGovernedWebhookLiveChecks(deps, {
            channelKey: "slack",
            webhookUrl,
            includeSandboxSend: options.includeSandboxSend,
            fetcher: (url, init) => deps.fetchWithDiagnosticsTimeout(url, init),
          });
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
      return runDiscordConnectionLiveChecks(deps, connection, options, runGovernedWebhookLiveChecks);
    case "telegram": {
      const token = resolveSecret("botToken", "botTokenEnv") ?? resolveSecret("token", "tokenEnv");
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
    case "ntfy": {
      const baseUrl = deps.readConnectionConfigValue(config, "baseUrl");
      const topic =
        deps.readConnectionConfigValue(config, "topic") ?? deps.readConnectionConfigValue(config, "defaultTopic");
      if (!baseUrl || !topic) {
        return { checks: [] };
      }
      return runNtfyLiveChecks({
        baseUrl,
        topic,
        token: resolveSecret("token", "tokenEnv"),
        priority: deps.readConnectionConfigValue(config, "priority"),
        dryRun: readBoolean(config.dryRun),
        includeSandboxSend: options.includeSandboxSend,
        fetcher: (url, init) => deps.fetchWithDiagnosticsTimeout(url, init),
      });
    }
    case "whatsapp": {
      const accessToken = resolveSecret("accessToken", "accessTokenEnv") ?? resolveSecret("token", "tokenEnv");
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
    case "google-chat":
      if (isGoogleChatAppConfig(deps, config)) {
        return {
          checks: [
            {
              key: "google_chat_app_live_send",
              status: "warn",
              message:
                "GoatCitadel can't send a test message in Chat app mode. After you finish, message the app from an allowed sender and check that it replies.",
            },
          ],
        };
      }
      return runGovernedWebhookLiveChecks(deps, {
        channelKey: "google-chat",
        webhookUrl: resolveSecret("webhookUrl", "webhookUrlEnv"),
        includeSandboxSend: options.includeSandboxSend,
        defaultThreadKey: deps.readConnectionConfigValue(config, "defaultThreadKey"),
        fetcher: (url, init) => deps.fetchWithDiagnosticsTimeout(url, init),
      });
    case "teams":
      return runGovernedWebhookLiveChecks(deps, {
        channelKey: "teams",
        webhookUrl: resolveSecret("webhookUrl", "webhookUrlEnv"),
        includeSandboxSend: options.includeSandboxSend,
        cardTitle: deps.readConnectionConfigValue(config, "cardTitle"),
        fetcher: (url, init) => deps.fetchWithDiagnosticsTimeout(url, init),
      });
    case "mattermost": {
      const token = resolveSecret("botToken", "botTokenEnv") ?? resolveSecret("token", "tokenEnv");
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
    case "matrix":
      return runConfiguredMatrixChecks(deps, connection, options.includeSandboxSend);
    case "qqbot":
      return runConfiguredQqbotChecks(deps, connection, options.includeSandboxSend);
    case "wecom":
      return runConfiguredWecomChecks(deps, connection, options.includeSandboxSend);
    case "nextcloud-talk": {
      return runConfiguredNextcloudTalkChecks(deps, connection, options.includeSandboxSend);
    }
    case "line": {
      const channelAccessToken =
        resolveSecret("channelAccessToken", "channelAccessTokenEnv") ??
        resolveSecret("accessToken", "accessTokenEnv") ??
        resolveSecret("token", "tokenEnv");
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
      const accessToken = resolveSecret("accessToken", "accessTokenEnv") ?? resolveSecret("token", "tokenEnv");
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
    default:
      return { checks: [] };
  }
}

function readTargetString(target: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = target?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean {
  return value === true || (typeof value === "string" && value.trim().toLowerCase() === "true");
}

/**
 * Whether the variable the config names under `key` can be read: it asks the resolver the live probes use, with only
 * that variable's name, so a name the Gateway refuses counts as missing and a direct value never answers for it.
 */
function hasConnectionEnvValue(
  deps: IntegrationDiagnosticsPort,
  connection: IntegrationConnection,
  key: string,
): boolean {
  const envName = deps.readConnectionConfigValue(connection.config, key);
  if (!envName) return false;
  return Boolean(deps.resolveConnectionSecret({ [key]: envName }, "", key, connection.catalogId, connection)?.trim());
}

/** Whether the variable the config names under `key` is set, whatever its name. Only for a field no resolver reads. */
function hasProcessEnvValue(
  deps: Pick<IntegrationDiagnosticsPort, "readConnectionConfigValue">,
  config: Record<string, unknown>,
  key: string,
): boolean {
  const envName = deps.readConnectionConfigValue(config, key);
  return Boolean(envName && process.env[envName]?.trim());
}

/** What to tell the operator about a variable name the Gateway will not read, from the same rule the setup guide gives. */
function refusedVariableNameMessage(
  connection: Pick<IntegrationConnection, "catalogId" | "key">,
  envKey: string,
): string {
  const rule = refusedEnvVarNameMessage(connection.catalogId);
  const suffixRule = secretEnvSuffixRule(connection.key, envKey);
  return suffixRule ? `${rule} ${suffixRule}` : rule;
}

function isHostAllowlisted(deps: IntegrationDiagnosticsPort, hostname: string): boolean {
  return connectionUrlHelpers.isHostAllowlistedInList(hostname, deps.config.toolPolicy.sandbox.networkAllowlist);
}

/** "a", "a and b", "a, b and c". */
function listHosts(hosts: readonly string[]): string {
  return hosts.length > 1 ? `${hosts.slice(0, -1).join(", ")} and ${hosts[hosts.length - 1]}` : (hosts[0] ?? "");
}

/**
 * Whether the network allowlist has the fixed provider hosts a real send to this channel needs. The setup test reaches
 * the provider through a fetcher that allows any public host, so without this check it passes and then the first real
 * send is blocked. The hosts are the ones the guide's "Allow these hosts" button adds for this connection
 * (`connectionFixedHosts`), so one click clears the warning. A host the operator gave as an address is left to the
 * address check (`reportedAddressHosts`: a Discord webhook is on discord.com, which is also Discord's fixed host), and
 * Telegram keeps its own check on `api.telegram.org`.
 */
function buildProviderHostsCheck(
  deps: IntegrationDiagnosticsPort,
  connection: IntegrationConnection,
  reportedAddressHosts: ReadonlySet<string>,
): ConnectorDiagnosticReport["checks"][number] | undefined {
  if (connection.key === "telegram" || !getChannelSetupDefinition(connection.catalogId)) {
    return undefined;
  }
  const hosts = connectionFixedHosts(requireChannelSetupDefinition(connection.catalogId), connection).filter(
    (host) => !reportedAddressHosts.has(host),
  );
  if (hosts.length === 0) {
    return undefined;
  }
  const missing = hosts.filter((host) => !isHostAllowlisted(deps, host));
  if (missing.length === 0) {
    return {
      key: "provider_hosts",
      status: "pass",
      message: `Provider ${hosts.length === 1 ? "host" : "hosts"} ${listHosts(hosts)} ${hosts.length === 1 ? "is" : "are"} on the network allowlist.`,
    };
  }
  return {
    key: "provider_hosts",
    status: "warn",
    message: `Real sends need ${listHosts(missing)} on the network allowlist. Use Allow these hosts in the guide, or add ${missing.length === 1 ? "it" : "them"} in Settings.`,
  };
}

/**
 * Egress posture for operator-driven diagnostics. It mirrors
 * `GatewayService.fetchWithDiagnosticsTimeout`, which fetches through
 * `fetchAllowlisted` with the operator allowlist followed by `"*"`: any public
 * host is reachable, while loopback/private/metadata hosts need an explicit
 * operator allowlist entry. Diagnostics additionally require HTTPS unless the
 * destination is loopback. The sandbox allowlist itself (`isConnectionUrlAllowlisted`)
 * keeps governing Code Mode egress and is intentionally not consulted here.
 */
export function isDiagnosticsDestinationAllowed(urlValue: string, operatorAllowlist: readonly string[]): boolean {
  return (
    connectionUrlHelpers.isConnectionUrlRemoteSafe(urlValue) &&
    evaluateHostEgress(urlValue, [...operatorAllowlist, "*"]).allowed
  );
}

export async function runGovernedWebhookLiveChecks(
  deps: IntegrationDiagnosticsPort,
  input: Parameters<typeof runWebhookDestinationLiveChecks>[0],
): Promise<{ checks: ConnectorDiagnosticReport["checks"]; probe: ChannelProbeReport }> {
  if (
    input.webhookUrl &&
    !isDiagnosticsDestinationAllowed(input.webhookUrl, deps.config.toolPolicy.sandbox.networkAllowlist)
  ) {
    const step = {
      key: input.channelKey.replace(/-/g, "_") + "_sandbox_send",
      label: "Webhook destination",
      status: "fail" as const,
      disposition: "blocking" as const,
      message:
        "The webhook destination must be a public HTTPS endpoint. Private, loopback, and reserved hosts stay blocked unless the operator allowlists them explicitly.",
    };
    return {
      checks: [{ key: step.key, status: "fail", message: step.message }],
      probe: { kind: input.channelKey + "_webhook", checkedAt: new Date().toISOString(), steps: [step] },
    };
  }
  return runWebhookDestinationLiveChecks(input);
}
