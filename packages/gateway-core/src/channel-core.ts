import type {
  ChannelActionName,
  ChannelActivityCapabilities,
  ChannelActivityPhase,
  ChannelAttachmentInput,
  ChannelAttachmentSource,
  ChannelCapabilities,
  ChannelChunkingMode,
  ChannelInboundMode,
  ChannelRuntimePolicy,
  ChannelRuntimePosture,
  ChannelThreadCapabilities,
} from "@goatcitadel/contracts";

import { CHANNEL_PLATFORM_UNSUPPORTED_ACTIONS } from "@goatcitadel/contracts";

type ChannelRule = {
  supportedActions?: ChannelActionName[];
  resolveSupportedActions?: (config: Record<string, unknown>) => ChannelActionName[];
  supportedAttachmentSources?: ChannelAttachmentSource[];
  resolveSupportedAttachmentSources?: (config: Record<string, unknown>) => ChannelAttachmentSource[];
  inboundModes?: ChannelInboundMode[];
  resolveInboundModes?: (config: Record<string, unknown>) => ChannelInboundMode[];
  threadCapabilities?: Partial<ChannelThreadCapabilities>;
  runtimePolicy?: Partial<ChannelRuntimePolicy>;
  resolveRuntimePolicy?: (config: Record<string, unknown>) => Partial<ChannelRuntimePolicy>;
  runtimePosture?: ChannelRuntimePosture;
  resolveRuntimePosture?: (config: Record<string, unknown>) => ChannelRuntimePosture;
  chunkingMode: ChannelChunkingMode;
  supportsStreaming: boolean;
  supportNotes?: string[];
  resolveSupportNotes?: (config: Record<string, unknown>) => string[];
  /** Actions the platform itself cannot do (reason per action); static map or per-config resolver. */
  platformUnsupportedActions?: Partial<Record<ChannelActionName, string>>;
  resolvePlatformUnsupportedActions?: (config: Record<string, unknown>) => Partial<Record<ChannelActionName, string>>;
  /** Extra setup diagnostics beyond the requiredAnyOf groups. */
  resolveSetupDiagnostics?: (config: Record<string, unknown>) => string[];
  requiredAnyOf: string[][];
};

export type ChannelDeliveryRichFormat = "plain_text" | "html" | "markdown" | "provider_native";

export interface ChannelTextDeliveryPlan {
  channelKey: string;
  chunkingMode: ChannelChunkingMode;
  maxChunkCodeUnits: number;
  chunks: string[];
  richFormatPosture: "preserved" | "plain_text_fallback";
  notes: string[];
}

export type ChannelRichMessageProvider = "telegram_bot_api" | "whatsapp_cloud_api";
export type ChannelRichMessagePlanStatus = "preserved" | "degraded" | "blocked";
export type ChannelRichMessageTextPosture = "text_only" | "caption" | "separate_text_then_media" | "media_only";
export type ChannelRichAttachmentSource = "url" | "inline" | "pending_attachment_id" | "metadata_only";
export type ChannelRichMediaKind = "image" | "video" | "audio" | "document" | "unknown";
export type ChannelRichProviderKind = "photo" | "image" | "video" | "audio" | "document";
export type ChannelRichAttachmentDisposition =
  | "native_media"
  | "document_fallback"
  | "text_fallback"
  | "pending_hydration"
  | "blocked";

export interface ChannelRichAttachmentPlan {
  index: number;
  source: ChannelRichAttachmentSource;
  mediaKind: ChannelRichMediaKind;
  providerKind?: ChannelRichProviderKind;
  disposition: ChannelRichAttachmentDisposition;
  mimeType?: string;
  title?: string;
  reason?: string;
}

export interface ChannelRichMessageEvidence {
  owner: "gateway";
  source: "channel_rich_message_plan";
  status: ChannelRichMessagePlanStatus;
  provider: ChannelRichMessageProvider;
  evidenceId: string;
}

export interface ChannelRichMessageDeliveryPlan {
  channelKey: string;
  provider: ChannelRichMessageProvider;
  capabilityLabel: string;
  status: ChannelRichMessagePlanStatus;
  textPosture: ChannelRichMessageTextPosture;
  attachmentCount: number;
  nativeAttachmentCount: number;
  fallbackAttachmentCount: number;
  blockedAttachmentCount: number;
  pendingAttachmentIdCount: number;
  providerAttachmentLimit: number;
  captionMaxCodeUnits: number;
  notes: string[];
  evidence: ChannelRichMessageEvidence;
  attachments: ChannelRichAttachmentPlan[];
}

const DEFAULT_THREAD_CAPABILITIES: ChannelThreadCapabilities = {
  rooms: false,
  threads: false,
  replies: false,
  direct: false,
  groups: false,
};

const DEFAULT_RUNTIME_POLICY: ChannelRuntimePolicy = {
  pairing: false,
  allowlist: false,
  mentionGating: false,
  typing: false,
  activity: false,
  presence: false,
};

const CHANNEL_ACTIVITY_EMOJI: Partial<Record<ChannelActivityPhase, string>> = {
  seen: "👀",
  thinking: "🧠",
  tooling: "🔧",
  waiting_approval: "⚠️",
  failed: "❌",
};

const CHANNEL_ACTIVITY_PHASES: ChannelActivityPhase[] = [
  "seen",
  "thinking",
  "tooling",
  "waiting_approval",
  "failed",
  "clear",
];

const CHANNEL_TEXT_LIMITS: Record<string, number> = {
  discord: 2000,
  telegram: 4096,
  whatsapp: 4096,
  slack: 40000,
};

const CHANNEL_RICH_MESSAGE_PROFILES: Record<
  string,
  {
    provider: ChannelRichMessageProvider;
    capabilityLabel: string;
    providerAttachmentLimit: number;
    captionMaxCodeUnits: number;
  }
> = {
  telegram: {
    provider: "telegram_bot_api",
    capabilityLabel: "Telegram Bot API rich media",
    providerAttachmentLimit: 10,
    captionMaxCodeUnits: 1024,
  },
  whatsapp: {
    provider: "whatsapp_cloud_api",
    capabilityLabel: "WhatsApp Cloud API rich media",
    providerAttachmentLimit: 10,
    captionMaxCodeUnits: 0,
  },
};

const CHANNEL_RULES: Record<string, ChannelRule> = {
  slack: {
    platformUnsupportedActions: CHANNEL_PLATFORM_UNSUPPORTED_ACTIONS.slack,
    resolveSupportedActions: (config) =>
      hasAnyConfigured(config, ["botTokenEnv", "botToken", "tokenEnv", "token"])
        ? ["channel.send", "channel.reply", "channel.react", "channel.unsend"]
        : ["channel.send"],
    resolveSupportedAttachmentSources: (config) =>
      hasAnyConfigured(config, ["botTokenEnv", "botToken", "tokenEnv", "token"]) ? ["url", "inline"] : ["url"],
    threadCapabilities: {
      rooms: true,
      threads: true,
      replies: true,
      direct: true,
      groups: true,
    },
    resolveInboundModes: (config) =>
      hasAnyConfigured(config, ["signingSecret", "signingSecretEnv"]) ? ["webhook"] : ["none"],
    chunkingMode: "fallback",
    supportsStreaming: false,
    resolveRuntimePosture: (config) =>
      hasAnyConfigured(config, ["botTokenEnv", "botToken", "tokenEnv", "token"])
        ? {
            outboundTransport: "api",
            inboundTransport: hasAnyConfigured(config, ["signingSecret", "signingSecretEnv"]) ? "webhook" : undefined,
            lifecycle: "stateless",
            inboundReadiness: hasAnyConfigured(config, ["signingSecret", "signingSecretEnv"]) ? "ready" : "unsupported",
            operatorSummary: hasAnyConfigured(config, ["signingSecret", "signingSecretEnv"])
              ? "Slack bot-token delivery is normalized as a stateless API bridge with signed webhook ingress. Rich outbound actions and inbound event routing are both available in the current runtime."
              : "Slack bot-token delivery is normalized as a stateless outbound API bridge. Rich outbound actions are available, but inbound routing is still disabled until a signing secret is configured.",
          }
        : {
            outboundTransport: "webhook",
            inboundTransport: hasAnyConfigured(config, ["signingSecret", "signingSecretEnv"]) ? "webhook" : undefined,
            lifecycle: "stateless",
            inboundReadiness: hasAnyConfigured(config, ["signingSecret", "signingSecretEnv"]) ? "ready" : "unsupported",
            operatorSummary: hasAnyConfigured(config, ["signingSecret", "signingSecretEnv"])
              ? "Slack webhook delivery is normalized as a stateless send path with signed webhook ingress. Inbound event routing is available, but replies, reactions, unsend, and inline uploads still require a bot token."
              : "Slack webhook delivery is normalized as a stateless outbound-only path. Replies, reactions, unsend, and inline uploads require a bot-token connection.",
          },
    resolveSupportNotes: (config) =>
      hasAnyConfigured(config, ["botTokenEnv", "botToken", "tokenEnv", "token"])
        ? [
            "Interactive actions use the Slack Web API and require the bot to have the needed chat and reactions scopes.",
            "Slack bot-token connections support URL-backed attachment previews and uploaded inline files when the app has files:write and can reach Slack upload hosts.",
            hasAnyConfigured(config, ["signingSecret", "signingSecretEnv"])
              ? "Slack inbound event routing is enabled through the signed Events API webhook path."
              : "Slack inbound routing remains disabled until a signing secret is configured.",
            ...(hasAnyConfigured(config, ["signingSecret", "signingSecretEnv"])
              ? [
                  "When inbound channel voice is enabled, Slack audio file shares are transcribed: the gateway downloads the file from files.slack.com with the bot token (needs the files:read scope, 8 MB cap) and routes the transcript as an untrusted voice turn. files.slack.com must be in the network allowlist (toolPolicy.sandbox.networkAllowlist); otherwise the download is refused and the turn runs on the [voice message] fallback.",
                ]
              : []),
            "Guided setup can run a sandbox send/delete probe on the bot-token path before finalize.",
          ]
        : [
            "Webhook-only Slack connections support send only plus URL-backed attachment previews. Reactions, unsend, replies, and inline file uploads require a bot token.",
            hasAnyConfigured(config, ["signingSecret", "signingSecretEnv"])
              ? "Webhook-only Slack fallback can ingest signed Slack events, but rich outbound actions still require a bot token."
              : "Webhook-only Slack fallback is outbound only and does not provide inbound routing.",
            "Webhook-only Slack fallback still relies on manual confirmation after finalize.",
          ],
    requiredAnyOf: [["botTokenEnv", "botToken", "webhookUrl", "url"]],
  },
  discord: {
    resolvePlatformUnsupportedActions: (config) =>
      !hasAnyConfigured(config, ["botTokenEnv", "botToken", "tokenEnv", "token"]) &&
      hasAnyConfigured(config, ["webhookUrl", "url"])
        ? {
            "channel.react": "Discord webhooks cannot add reactions.",
            "channel.typing": "Discord webhooks cannot send typing indicators.",
          }
        : {},
    resolveSupportedActions: (config) => {
      if (hasAnyConfigured(config, ["botTokenEnv", "botToken", "tokenEnv", "token"])) {
        return ["channel.send", "channel.reply", "channel.react", "channel.unsend", "channel.typing"];
      }
      if (hasAnyConfigured(config, ["webhookUrl", "url"])) {
        return ["channel.send", "channel.unsend"];
      }
      return ["channel.send"];
    },
    supportedAttachmentSources: ["url", "inline"],
    resolveInboundModes: (config) =>
      readConfigString(config, "runtimeMode") === "gateway" &&
      hasAnyConfigured(config, ["botTokenEnv", "botToken", "tokenEnv", "token"])
        ? ["gateway"]
        : ["none"],
    threadCapabilities: {
      rooms: true,
      threads: true,
      replies: true,
      direct: true,
      groups: true,
    },
    resolveRuntimePolicy: (config) =>
      readConfigString(config, "runtimeMode") === "gateway"
        ? {
            pairing: (readConfigString(config, "inboundDmPolicy") ?? "pairing") === "pairing",
            allowlist: (readConfigString(config, "guildPolicy") ?? "allowlist") === "allowlist",
            mentionGating: (readConfigString(config, "guildPolicy") ?? "allowlist") === "allowlist",
            typing: true,
            presence: true,
          }
        : {},
    resolveRuntimePosture: (config) =>
      (readConfigString(config, "runtimeMode") ?? "bridge") === "gateway"
        ? {
            outboundTransport: "api",
            inboundTransport: "gateway",
            lifecycle: "persistent",
            inboundReadiness: "ready",
            operatorSummary:
              "Discord gateway mode is normalized as a persistent runtime: the bot stays online, paired DMs can route inbound, and allowlisted guild traffic can be policy-gated in-process.",
          }
        : hasAnyConfigured(config, ["botTokenEnv", "botToken", "tokenEnv", "token"])
          ? {
              outboundTransport: "api",
              lifecycle: "stateless",
              inboundReadiness: "unsupported",
              operatorSummary:
                "Discord bridge mode is normalized as a stateless outbound REST bridge. Rich outbound actions work, but inbound routing and online presence are not active.",
            }
          : {
              outboundTransport: "webhook",
              lifecycle: "stateless",
              inboundReadiness: "unsupported",
              operatorSummary:
                "Discord webhook mode is normalized as a stateless outbound-only path. It can send and delete webhook-authored messages, but it does not accept inbound traffic or maintain presence.",
            },
    chunkingMode: "fallback",
    supportsStreaming: false,
    resolveSupportNotes: (config) =>
      (readConfigString(config, "runtimeMode") ?? "bridge") === "gateway"
        ? [
            "Gateway-mode Discord connections keep a persistent Discord gateway session, so the bot can appear online and route inbound DMs or allowlisted guild messages.",
            "When inbound channel voice is enabled, Discord voice messages and audio attachments that pass the same pairing and guild allowlist gates as text are downloaded from the Discord CDN (8 MB cap) and transcribed into an untrusted voice turn. Voice messages cannot mention the bot, so in mention-gated guild channels they are not routed. cdn.discordapp.com and media.discordapp.net must be in the network allowlist (toolPolicy.sandbox.networkAllowlist; discord.com does not cover them); otherwise the download is refused and the turn runs on the [voice message] fallback.",
            "Outbound replies still use the shared Discord send bridge, so reactions and unsend follow the same REST constraints as bridge mode.",
            "Guided setup can run token, channel, sandbox send/delete, and runtime-readiness probes before finalize.",
          ]
        : hasAnyConfigured(config, ["botTokenEnv", "botToken", "tokenEnv", "token"])
          ? [
              "Bridge-mode Discord connections are outbound REST bridges. They support reactions, deleting messages in channels the bot can manage, and typing indicators through the REST typing endpoint, but they do not create a persistent online presence.",
              "Discord rich sends support uploaded inline files and URL-backed embeds.",
              "Guided setup can run token, channel, and sandbox send/delete probes before finalize.",
            ]
          : hasAnyConfigured(config, ["webhookUrl", "url"])
            ? [
                "Webhook-only Discord connections can unsend webhook-authored messages, but cannot add reactions, send typing indicators, or accept inbound traffic.",
                "Webhook-mode Discord sends support uploaded inline files and URL-backed embeds.",
                "Webhook-only fallback skips the bot-token probe path and still needs manual confirmation after finalize.",
              ]
            : [],
    requiredAnyOf: [["botTokenEnv", "botToken", "webhookUrl", "url"]],
  },
  telegram: {
    supportedActions: ["channel.send", "channel.reply", "channel.react", "channel.unsend", "channel.typing"],
    supportedAttachmentSources: ["url", "inline"],
    resolveInboundModes: (config) => {
      const receiveMode = readTelegramReceiveMode(config);
      if (receiveMode === "poll") {
        return ["poll"];
      }
      if (receiveMode === "off") {
        return ["none"];
      }
      return hasTelegramWebhookSecret(config) ? ["webhook"] : ["none"];
    },
    threadCapabilities: {
      replies: true,
      direct: true,
      groups: true,
    },
    chunkingMode: "fallback",
    supportsStreaming: false,
    resolveRuntimePosture: (config) => {
      const receiveMode = readTelegramReceiveMode(config);
      if (receiveMode === "poll") {
        return {
          outboundTransport: "api",
          inboundTransport: "poll",
          lifecycle: "persistent",
          inboundReadiness: "ready",
          operatorSummary:
            "Telegram is normalized as a bot bridge that receives by asking Telegram for new messages, so no public web address is needed. Sends, replies, reactions, deletes, typing indicators, and inbound message routing are available in the current runtime.",
        };
      }
      if (receiveMode === "off") {
        return {
          outboundTransport: "api",
          lifecycle: "stateless",
          inboundReadiness: "unsupported",
          operatorSummary:
            "Telegram is normalized as a stateless outbound bot bridge. Sends, replies, reactions, deletes, and typing indicators are supported, but receiving messages is turned off for this connection.",
        };
      }
      const hasWebhookIngress = hasTelegramWebhookSecret(config);
      return {
        outboundTransport: "api",
        inboundTransport: hasWebhookIngress ? "webhook" : undefined,
        lifecycle: "stateless",
        inboundReadiness: hasWebhookIngress ? "ready" : "unsupported",
        operatorSummary: hasWebhookIngress
          ? "Telegram is normalized as a stateless bot bridge with Bot API secret-token webhook ingress. Sends, replies, reactions, deletes, typing indicators, and inbound message routing are available in the current runtime."
          : "Telegram is normalized as a stateless outbound bot bridge. Sends, replies, reactions, deletes, and typing indicators are supported, but inbound message routing stays disabled until a webhook secret is configured.",
      };
    },
    resolveSupportNotes: (config) => [
      "Telegram bot connections can add reactions, delete sent messages, and emit typing indicators when the bot has access to the target chat.",
      "Telegram rich sends use photo/document delivery and apply the message body as the first caption when it fits provider limits.",
      "Telegram rich-message preflight blocks metadata-only attachments, caps rich batches at 10 attachments, and records provider delivery evidence before send.",
      resolveTelegramInboundNote(config),
      "Guided setup can run a sandbox send/delete probe before finalize.",
    ],
    requiredAnyOf: [["botTokenEnv", "botToken", "tokenEnv", "token"]],
  },
  ntfy: {
    platformUnsupportedActions: CHANNEL_PLATFORM_UNSUPPORTED_ACTIONS.ntfy,
    supportedActions: ["channel.send", "channel.unsend"],
    supportedAttachmentSources: ["url"],
    resolveInboundModes: (config) => (isNtfyInboundEnabled(config) ? ["stream"] : ["none"]),
    threadCapabilities: {
      rooms: true,
    },
    chunkingMode: "fallback",
    supportsStreaming: false,
    resolveRuntimePosture: (config) =>
      isNtfyInboundEnabled(config)
        ? {
            outboundTransport: "api",
            inboundTransport: "stream",
            lifecycle: "persistent",
            inboundReadiness: "ready",
            operatorSummary:
              "ntfy publishes notifications to a configured topic and, when inbound is enabled, subscribes to that topic's JSON stream. The sender is the topic itself: the token gates reading, but anyone able to publish to the subscribed topic can start turns, so use a topic whose write access is limited to trusted publishers. Messages published while the gateway is disconnected or restarting are skipped. Outbound publishes are tagged and ignored on the way back in.",
          }
        : {
            outboundTransport: "api",
            lifecycle: "stateless",
            inboundReadiness: "unsupported",
            operatorSummary:
              "ntfy is normalized as a stateless outbound-only notification path. Inbound topic subscription is opt-in: enable inboundStreamEnabled with a token to subscribe to the topic's JSON stream, on a topic whose write access is limited to trusted publishers.",
          },
    resolveSupportNotes: (config) => [
      ...(isNtfyInboundEnabled(config)
        ? [
            "ntfy inbound subscribes to the topic's JSON stream and the sender is the topic itself. The token gates reading the topic; anyone able to publish to the subscribed topic can start turns, so use a topic whose write access (ACL) is limited to trusted publishers. Outbound publishes are tagged and ignored on the way back in.",
            "Messages published while the gateway is disconnected or restarting are skipped: a reconnect within one gateway run resumes after the last accepted message, but no history is fetched after a gateway restart or a connection edit. A stream silent for 2 minutes (ntfy keepalives arrive about every 45 seconds) is treated as dropped and reconnected.",
          ]
        : [
            "ntfy inbound is off; set inboundStreamEnabled with a token to subscribe to the topic's JSON stream. Webhook and remote-command inbound are not supported.",
          ]),
      "Token-backed topics should use tokenEnv so secrets are resolved at the tool host boundary.",
      "ntfy unsend deletes a published notification with DELETE /<topic>/<message id>, using the id ntfy returned on publish; subscribed clients receive a message_delete event.",
      "Dry-run mode validates routing without publishing to the ntfy server.",
    ],
    resolveSetupDiagnostics: (config) =>
      isNtfyInboundRequested(config) && !hasNtfyToken(config)
        ? ["ntfy inbound requires a token to read the topic (tokenEnv)"]
        : [],
    requiredAnyOf: [["baseUrl"], ["topic", "defaultTopic"]],
  },
  "google-chat": {
    resolvePlatformUnsupportedActions: (config) => ({
      ...CHANNEL_PLATFORM_UNSUPPORTED_ACTIONS["google-chat"],
      ...(isGoogleChatServiceAccountMode(config)
        ? {}
        : {
            "channel.unsend":
              "Google Chat webhook-authored messages cannot be deleted; unsend needs Chat app (service-account) mode.",
          }),
    }),
    resolveSupportedActions: (config) =>
      isGoogleChatServiceAccountMode(config) ? ["channel.send", "channel.reply", "channel.unsend"] : ["channel.send"],
    supportedAttachmentSources: ["url"],
    resolveInboundModes: (config) => (isGoogleChatAppInboundEnabled(config) ? ["webhook"] : ["none"]),
    threadCapabilities: {
      rooms: true,
      threads: true,
    },
    resolveRuntimePolicy: (config) => ({ allowlist: isGoogleChatAppInboundEnabled(config) }),
    chunkingMode: "fallback",
    supportsStreaming: false,
    resolveRuntimePosture: (config) =>
      isGoogleChatAppInboundEnabled(config)
        ? {
            outboundTransport: "api",
            inboundTransport: "webhook",
            lifecycle: "stateless",
            inboundReadiness: "ready",
            operatorSummary:
              "Google Chat runs as a Chat app: inbound events arrive on the app's HTTP endpoint with Google-signed bearer tokens verified against the configured audience, and replies, sends and deletes use the Chat API with the service account. App messages can be deleted, but only the app's own messages.",
          }
        : isGoogleChatServiceAccountMode(config)
          ? {
              outboundTransport: "api",
              lifecycle: "stateless",
              inboundReadiness: "unsupported",
              operatorSummary:
                "Google Chat sends through the Chat API as a Chat app (service account); only the app's own messages can be deleted. Inbound needs audienceType and audience so Google-signed requests can be verified.",
            }
          : {
              outboundTransport: "webhook",
              lifecycle: "stateless",
              inboundReadiness: "unsupported",
              operatorSummary:
                "Google Chat is normalized as a stateless outbound webhook destination. Rich card sends work; inbound requires Chat app (service-account) mode.",
            },
    resolveSupportNotes: (config) =>
      isGoogleChatServiceAccountMode(config)
        ? [
            isGoogleChatAppInboundEnabled(config)
              ? "Google Chat app inbound verifies Google's bearer token (RS256, issuer, audience, expiry) before anything is accepted; allow the Google Chat user resource names (users/...) that may start turns, because inbound is default-deny."
              : "Google Chat app inbound is off until audienceType (project_number or endpoint_url) and audience are configured.",
            "Chat app sends, replies and deletes use the service-account key resolved at the tool host boundary; allow chat.googleapis.com and oauth2.googleapis.com in the network allowlist.",
            "Google Chat unsend deletes only messages this app sent.",
          ]
        : [
            "Google Chat webhook sends support URL-backed rich cards for image and link attachments.",
            "Google Chat webhook mode is outbound; inbound requires Chat app (service-account) mode.",
            "Guided setup can run a sandbox webhook probe before finalize, but destination confirmation is still manual.",
          ],
    requiredAnyOf: [["webhookUrl", "url", "serviceAccountKeyEnv", "serviceAccountKey"]],
  },
  teams: {
    platformUnsupportedActions: CHANNEL_PLATFORM_UNSUPPORTED_ACTIONS.teams,
    supportedActions: ["channel.send"],
    supportedAttachmentSources: ["url"],
    inboundModes: ["none"],
    threadCapabilities: {
      rooms: true,
      threads: true,
    },
    chunkingMode: "fallback",
    supportsStreaming: false,
    runtimePosture: {
      outboundTransport: "webhook",
      lifecycle: "stateless",
      inboundReadiness: "unsupported",
      operatorSummary:
        "Teams is normalized as a stateless outbound webhook destination. Adaptive-card sends work, but inbound routing is not available in the current runtime.",
    },
    supportNotes: [
      "Teams webhook sends support URL-backed adaptive card attachments for images and links.",
      "Teams webhook mode is outbound only and does not provide inbound routing.",
      "Guided setup can run a sandbox webhook probe before finalize, but destination confirmation is still manual.",
    ],
    requiredAnyOf: [["webhookUrl", "url"]],
  },
  whatsapp: {
    platformUnsupportedActions: CHANNEL_PLATFORM_UNSUPPORTED_ACTIONS.whatsapp,
    supportedActions: ["channel.send", "channel.reply", "channel.react", "channel.typing"],
    supportedAttachmentSources: ["url", "inline"],
    resolveInboundModes: (config) =>
      hasAnyConfigured(config, ["appSecret", "appSecretEnv"]) &&
      hasAnyConfigured(config, ["webhookVerifyToken", "webhookVerifyTokenEnv", "verifyToken", "verifyTokenEnv"])
        ? ["webhook"]
        : ["none"],
    threadCapabilities: {
      direct: true,
      groups: true,
      replies: true,
    },
    chunkingMode: "fallback",
    supportsStreaming: false,
    resolveRuntimePosture: (config) => {
      const hasWebhookIngress =
        hasAnyConfigured(config, ["appSecret", "appSecretEnv"]) &&
        hasAnyConfigured(config, ["webhookVerifyToken", "webhookVerifyTokenEnv", "verifyToken", "verifyTokenEnv"]);
      return {
        outboundTransport: "api",
        inboundTransport: hasWebhookIngress ? "webhook" : undefined,
        lifecycle: "stateless",
        inboundReadiness: hasWebhookIngress ? "ready" : "unsupported",
        operatorSummary: hasWebhookIngress
          ? "WhatsApp Cloud API is normalized as a stateless bridge with signed webhook ingress. Rich outbound media, reactions, and inbound message routing are available. The platform has no message-delete endpoint, so unsend is not offered."
          : "WhatsApp Cloud API is normalized as a stateless outbound bridge. Rich outbound media and reactions are supported; inbound routing needs the app secret and webhook verify token, and the platform has no message-delete endpoint, so unsend is not offered.",
      };
    },
    resolveSupportNotes: (config) => [
      "WhatsApp Cloud API rich sends support public URL media and uploaded inline files for supported image, video, audio, and document types.",
      "WhatsApp rich-message preflight labels native media, text fallbacks, pending attachment hydration, and Cloud API provider evidence before send.",
      "WhatsApp reactions are sent through the Cloud API. Unsend is not offered because the Cloud API has no endpoint for deleting a sent message.",
      "WhatsApp typing indicators are tied to an inbound message: they are sent with a read receipt for that message id and last up to 25 seconds, so a typing request without an inbound message id is reported as unsupported.",
      hasAnyConfigured(config, ["appSecret", "appSecretEnv"]) &&
      hasAnyConfigured(config, ["webhookVerifyToken", "webhookVerifyTokenEnv", "verifyToken", "verifyTokenEnv"])
        ? "WhatsApp inbound routing is enabled through the signed Cloud API webhook path when both the app secret and webhook verify token are configured."
        : "WhatsApp inbound routing remains disabled until both the app secret and webhook verify token are configured.",
    ],
    requiredAnyOf: [["phoneNumberId"], ["accessTokenEnv", "accessToken", "tokenEnv", "token"]],
  },
  signal: {
    supportedActions: ["channel.send", "channel.react", "channel.unsend", "channel.typing"],
    resolveInboundModes: (config) => (isSignalInboundEnabled(config) ? ["stream"] : ["none"]),
    threadCapabilities: {
      direct: true,
      groups: true,
    },
    chunkingMode: "fallback",
    supportsStreaming: false,
    resolveRuntimePosture: (config) =>
      isSignalInboundEnabled(config)
        ? {
            outboundTransport: "api",
            inboundTransport: "stream",
            lifecycle: "persistent",
            inboundReadiness: "ready",
            operatorSummary:
              "Signal sends through the signal-cli JSON-RPC bridge and, with receiveEvents enabled, keeps a persistent subscription to the signal-cli HTTP daemon event stream. Self-echo, receipts and typing events are ignored, and the sender plus message timestamp dedupes any reconnect overlap.",
          }
        : {
            outboundTransport: "api",
            lifecycle: "stateless",
            inboundReadiness: "unsupported",
            operatorSummary:
              "Signal sends through the configured signal-cli JSON-RPC bridge. Inbound is opt-in: enable receiveEvents on a signal-cli daemon --http bridge to receive messages from its event stream.",
          },
    resolveSupportNotes: (config) => [
      "Outbound Signal sends use the configured bridge JSON-RPC send path.",
      "Signal typing indicators use the bridge JSON-RPC sendTyping method for a recipient or a group: target.",
      "Signal reactions use sendReaction with the target message timestamp as messageId; group reactions also need targetAuthor.",
      "Signal remote delete (unsend) uses remoteDelete and works only on messages this account sent.",
      isSignalInboundEnabled(config)
        ? "Signal inbound subscribes to the signal-cli daemon --http event stream (/api/v1/events); allow the sender UUIDs (or numbers for senders without a UUID) that may start turns, because inbound is default-deny."
        : "Signal inbound is off; set receiveEvents on a signal-cli daemon --http bridge to receive messages from its event stream (/api/v1/events).",
      "signal-cli acknowledges messages to the Signal server itself, so messages that arrive while the gateway's event stream is disconnected are not replayed and are lost.",
      ...(isSignalInboundEnabled(config)
        ? [
            "signal-cli sends an SSE keepalive (every 15 seconds by default, --sse-keepalive-interval); an event stream silent for 90 seconds is treated as dropped and reconnected, so keep that interval well below 90 seconds.",
          ]
        : []),
    ],
    requiredAnyOf: [["baseUrl", "bridgeUrl"]],
  },
  mattermost: {
    supportedActions: ["channel.send", "channel.reply", "channel.react", "channel.unsend", "channel.typing"],
    supportedAttachmentSources: ["url", "inline"],
    resolveInboundModes: (config) => (isMattermostInboundEnabled(config) ? ["stream"] : ["none"]),
    threadCapabilities: {
      rooms: true,
      replies: true,
      direct: true,
      groups: true,
    },
    chunkingMode: "fallback",
    supportsStreaming: false,
    resolveRuntimePosture: (config) =>
      isMattermostInboundEnabled(config)
        ? {
            outboundTransport: "api",
            inboundTransport: "stream",
            lifecycle: "persistent",
            inboundReadiness: "ready",
            operatorSummary:
              "Mattermost sends through the bot REST API and, when inbound is enabled, keeps a persistent bot WebSocket open for posted events. The bot's own posts and system posts are ignored. Mattermost has no replay: posts sent while the socket is disconnected or backing off, or that fail durable acceptance, are not recovered.",
          }
        : {
            outboundTransport: "api",
            lifecycle: "stateless",
            inboundReadiness: "unsupported",
            operatorSummary:
              "Mattermost is normalized as a stateless outbound bot bridge. Inbound is opt-in: enable inboundStreamEnabled with a bot token to receive posted events over the bot WebSocket.",
          },
    resolveSupportNotes: (config) => [
      isMattermostInboundEnabled(config)
        ? "Mattermost inbound uses the bot WebSocket (/api/v4/websocket); allow the Mattermost user ids that may start turns, because inbound is default-deny. Posts sent while the socket is disconnected, or that fail acceptance, are not recovered."
        : "Mattermost inbound is off; set inboundStreamEnabled with a bot token to receive posted events over the bot WebSocket.",
      ...(isMattermostInboundEnabled(config)
        ? [
            "The bot pings the WebSocket every 30 seconds; a socket that answers nothing for 90 seconds is treated as dropped and reconnected.",
          ]
        : []),
      "Mattermost unsend deletes the original post and typically applies only to posts the bot can remove.",
      "Mattermost typing posts the bot typing event to a channel id (optionally within a thread root); channel names and user targets are not resolved for typing.",
      "Mattermost rich sends upload files to the resolved channel before creating the post.",
    ],
    requiredAnyOf: [["serverUrl"], ["botTokenEnv", "botToken"]],
  },
  matrix: {
    supportedActions: ["channel.send", "channel.reply", "channel.react", "channel.unsend", "channel.typing"],
    supportedAttachmentSources: [],
    resolveInboundModes: (config) => (isMatrixInboundEnabled(config) ? ["stream"] : ["none"]),
    threadCapabilities: {
      rooms: true,
      threads: true,
      replies: true,
      direct: true,
      groups: true,
    },
    chunkingMode: "fallback",
    supportsStreaming: false,
    resolveRuntimePosture: (config) =>
      isMatrixInboundEnabled(config)
        ? {
            outboundTransport: "api",
            inboundTransport: "stream",
            lifecycle: "persistent",
            inboundReadiness: "ready",
            operatorSummary:
              "Matrix uses the client-server API with an access token; optional inbound long-polls /sync and resumes from a stored sync token after restarts.",
          }
        : {
            outboundTransport: "api",
            lifecycle: "stateless",
            inboundReadiness: "unsupported",
            operatorSummary:
              "Matrix uses the client-server API with an access token; optional inbound long-polls /sync and resumes from a stored sync token after restarts. Inbound is off until inboundStreamEnabled is set.",
          },
    resolveSupportNotes: (config) => [
      isMatrixInboundEnabled(config)
        ? "Matrix inbound long-polls /sync and stores the sync token after each accepted batch, so a restart resumes without replaying history. Allow the Matrix user ids that may start turns, because inbound is default-deny."
        : "Matrix inbound is off; set inboundStreamEnabled with an access token to long-poll /sync.",
      "Matrix is text-only in v1: attachments are not uploaded to the media repository.",
      "End-to-end encrypted rooms are not supported: inbound ignores encrypted events and outbound sends unencrypted messages; use an unencrypted room.",
      "Matrix unsend redacts the original event; the bot can redact its own events, and other users' events only with the redact power level.",
      "Matrix typing sets the bot typing state in a room id target (the bot user id is resolved with whoami).",
      "Matrix room messages are plain m.text bodies, so mentions are not rendered by the server.",
    ],
    requiredAnyOf: [["homeserverUrl"], ["accessTokenEnv", "accessToken"]],
  },
  qqbot: {
    platformUnsupportedActions: CHANNEL_PLATFORM_UNSUPPORTED_ACTIONS.qqbot,
    supportedActions: ["channel.send", "channel.reply"],
    supportedAttachmentSources: [],
    resolveInboundModes: (config) => (isQqbotInboundEnabled(config) ? ["webhook"] : ["none"]),
    threadCapabilities: {
      rooms: true,
      replies: true,
      direct: true,
      groups: true,
    },
    resolveRuntimePolicy: (config) => ({ allowlist: isQqbotInboundEnabled(config) }),
    chunkingMode: "fallback",
    supportsStreaming: false,
    resolveRuntimePosture: (config) =>
      isQqbotInboundEnabled(config)
        ? {
            outboundTransport: "api",
            inboundTransport: "webhook",
            lifecycle: "stateless",
            inboundReadiness: "ready",
            operatorSummary:
              "QQBot sends text through the QQ Bot Open Platform API with an app access token; inbound events arrive on a signed webhook (ed25519 over the bot secret) and are default-deny by sender openid.",
          }
        : {
            outboundTransport: "api",
            lifecycle: "stateless",
            inboundReadiness: "unsupported",
            operatorSummary:
              "QQBot sends text through the QQ Bot Open Platform API with an app access token. Inbound needs the app secret so signed webhook events can be verified.",
          },
    resolveSupportNotes: (config) => [
      isQqbotInboundEnabled(config)
        ? "QQBot inbound verifies the ed25519 request signature before anything is accepted; allow the QQ openids that may start turns, because inbound is default-deny (a dropped message's sender_not_allowlisted diagnostic shows the openid)."
        : "QQBot inbound is off until the app secret is configured so signed webhook events can be verified.",
      "QQ allows active (unprompted) group and C2C messages only within platform quotas, so replies sent soon after an inbound message (within about 5 minutes) are passive replies that carry the inbound msg_id on every chunk of a split reply (QQ allows 4 passive replies per C2C message and 5 per group message, and a reply that would need more is refused before sending); replies fail after QQ's passive window and never fall back to active sends, which stay under QQ's quotas. QQ openids differ by scope (group member_openid is not the C2C user_openid), so allowlist each scope's id.",
      "QQBot delivery is text-only in v1: attachments are rejected rather than dropped. Replies are split into 2,000-character chunks as a conservative guess; the exact QQ text limit is unverified.",
      "Targets are group:<openid>, user:<openid>, channel:<id> or dm:<guild id>.",
      "QQBot reactions and unsend are not supported by this adapter.",
    ],
    requiredAnyOf: [["appId"], ["appSecretEnv", "appSecret"]],
  },
  wecom: {
    platformUnsupportedActions: CHANNEL_PLATFORM_UNSUPPORTED_ACTIONS.wecom,
    supportedActions: ["channel.send"],
    supportedAttachmentSources: [],
    resolveInboundModes: (config) => (isWecomInboundEnabled(config) ? ["webhook"] : ["none"]),
    threadCapabilities: {
      direct: true,
      groups: true,
    },
    resolveRuntimePolicy: (config) => ({ allowlist: isWecomInboundEnabled(config) }),
    chunkingMode: "fallback",
    supportsStreaming: false,
    resolveRuntimePosture: (config) =>
      isWecomInboundEnabled(config)
        ? {
            outboundTransport: "api",
            inboundTransport: "webhook",
            lifecycle: "stateless",
            inboundReadiness: "ready",
            operatorSummary:
              "WeCom sends application text messages with a corp access token; inbound arrives on the encrypted callback (SHA-1 signature and AES-256-CBC decryption) and is default-deny by sender userid.",
          }
        : {
            outboundTransport: "api",
            lifecycle: "stateless",
            inboundReadiness: "unsupported",
            operatorSummary:
              "WeCom sends application text messages with a corp access token. Inbound needs the callback token and EncodingAESKey so encrypted callbacks can be verified.",
          },
    resolveSupportNotes: (config) => [
      isWecomInboundEnabled(config)
        ? "WeCom inbound verifies the callback signature and decrypts with the EncodingAESKey (and checks the CorpID) before anything is accepted; allow the WeCom userids that may start turns, because inbound is default-deny."
        : "WeCom inbound is off until the callback token and EncodingAESKey are configured for the encrypted callback.",
      "WeCom delivery is text-only in v1: attachments are rejected rather than dropped. Text above 2,048 bytes is refused (WeCom would truncate it), so replies are split into small chunks.",
      "Targets are user:<userid>, party:<departmentid>, tag:<tagid> or a bare userid; the application must be visible to the recipient.",
      "The server IP must be on the WeCom application's trusted IP list or sends fail with errcode 60020.",
      "WeCom reactions and unsend are not supported by this adapter.",
    ],
    requiredAnyOf: [["corpId"], ["agentId"], ["secretEnv", "secret"]],
  },
  imessage: {
    supportedActions: ["channel.send", "channel.reply", "channel.react", "channel.unsend", "channel.typing"],
    supportedAttachmentSources: ["url", "inline"],
    inboundModes: ["none"],
    threadCapabilities: {
      replies: true,
      direct: true,
      groups: true,
    },
    chunkingMode: "fallback",
    supportsStreaming: false,
    runtimePosture: {
      outboundTransport: "api",
      lifecycle: "stateless",
      inboundReadiness: "unsupported",
      operatorSummary:
        "iMessage defaults to a BlueBubbles local bridge. Photon/Spectrum is tracked as a third-party sidecar provider, but it is not the default runtime path and must be explicitly configured with a runnable adapter.",
    },
    supportNotes: [
      "BlueBubbles is the local-first callable provider for this Gateway build.",
      "Photon/Spectrum provider metadata is recognized for diagnostics, but sends fail closed until a Photon adapter is installed.",
      "Attachment sends to brand-new handles require BlueBubbles chat creation support.",
      "Reactions, unsend, and typing indicators require BlueBubbles Private API support.",
      "Typing indicators post to the BlueBubbles chat typing endpoint and need a chat GUID target (chat_guid:iMessage;-;+15551234567); handles and chat ids are not resolved for typing.",
      "BlueBubbles authenticates with a ?password= URL query parameter, so use an https:// bridge URL or a loopback bridge (127.0.0.1, localhost, [::1]); a schemeless non-loopback bridge URL defaults to https.",
    ],
    requiredAnyOf: [
      ["bridgeUrl", "baseUrl", "serverUrl"],
      ["passwordEnv", "password", "apiPasswordEnv", "apiPassword"],
    ],
  },
  "nextcloud-talk": {
    platformUnsupportedActions: CHANNEL_PLATFORM_UNSUPPORTED_ACTIONS["nextcloud-talk"],
    supportedActions: ["channel.send", "channel.reply", "channel.react"],
    inboundModes: ["webhook"],
    threadCapabilities: {
      rooms: true,
      replies: true,
      direct: true,
      groups: true,
    },
    runtimePolicy: {
      allowlist: true,
    },
    chunkingMode: "fallback",
    supportsStreaming: false,
    runtimePosture: {
      outboundTransport: "api",
      inboundTransport: "webhook",
      lifecycle: "stateless",
      inboundReadiness: "ready",
      operatorSummary:
        "Nextcloud Talk is normalized as a stateless bot bridge with inbound webhooks. Outbound replies and reactions are available, and inbound events can be routed without a persistent gateway runtime.",
    },
    supportNotes: [
      "Nextcloud Talk bot connections support inbound webhooks, outbound replies, and bot reactions through the documented bot API.",
      "Attachments are unsupported in this adapter, and Nextcloud Talk bots cannot delete messages through the bot API.",
      "Nextcloud Talk bots cannot download shared media, so inbound voice messages are not transcribed: the agent receives a notice that a voice message arrived instead.",
    ],
    requiredAnyOf: [["baseUrl"], ["tokenEnv", "token", "botSecretEnv", "botSecret", "secretEnv", "secret"]],
  },
  line: {
    supportedActions: ["channel.send"],
    resolveInboundModes: (config) =>
      hasAnyConfigured(config, ["channelSecret", "channelSecretEnv", "secret", "secretEnv"]) ? ["webhook"] : ["none"],
    threadCapabilities: {
      rooms: true,
      direct: true,
      groups: true,
    },
    chunkingMode: "fallback",
    supportsStreaming: false,
    resolveRuntimePosture: (config) => {
      const hasWebhookIngress = hasAnyConfigured(config, ["channelSecret", "channelSecretEnv", "secret", "secretEnv"]);
      return {
        outboundTransport: "api",
        inboundTransport: hasWebhookIngress ? "webhook" : undefined,
        lifecycle: "stateless",
        inboundReadiness: hasWebhookIngress ? "ready" : "unsupported",
        operatorSummary: hasWebhookIngress
          ? "LINE is normalized as a stateless bridge with signed webhook ingress. It can send through the channel access token and route inbound message events without a persistent runtime."
          : "LINE is normalized as a stateless outbound bridge. It can send through the channel access token, but inbound routing is not available in the current runtime.",
      };
    },
    resolveSupportNotes: (config) => [
      hasAnyConfigured(config, ["channelSecret", "channelSecretEnv", "secret", "secretEnv"])
        ? "LINE inbound routing is enabled through the signed Messaging API webhook path when a channel secret is configured."
        : "LINE inbound routing remains disabled until a channel secret is configured.",
    ],
    requiredAnyOf: [["channelAccessTokenEnv", "channelAccessToken", "accessTokenEnv", "accessToken"]],
  },
  zalo: {
    supportedActions: ["channel.send"],
    inboundModes: ["none"],
    threadCapabilities: {
      direct: true,
      groups: true,
    },
    chunkingMode: "fallback",
    supportsStreaming: false,
    runtimePosture: {
      outboundTransport: "api",
      lifecycle: "stateless",
      inboundReadiness: "unsupported",
      operatorSummary:
        "Zalo is normalized as a stateless outbound bridge. It can send to configured recipients, but inbound routing is not available in the current runtime.",
    },
    requiredAnyOf: [["accessTokenEnv", "accessToken", "tokenEnv", "token"]],
  },
  zalouser: {
    supportedActions: ["channel.send"],
    supportedAttachmentSources: ["url"],
    inboundModes: ["none"],
    threadCapabilities: {
      direct: true,
      groups: true,
    },
    chunkingMode: "fallback",
    supportsStreaming: false,
    runtimePosture: {
      outboundTransport: "api",
      lifecycle: "stateless",
      inboundReadiness: "unsupported",
      operatorSummary:
        "Zalo user bridge delivery is normalized as a stateless outbound path and currently requires URL-backed rich attachments. Inbound routing is not available in the current runtime.",
    },
    supportNotes: ["Rich media sends currently require URL-backed attachments for the zca bridge."],
    requiredAnyOf: [
      ["baseUrl", "bridgeUrl", "serverUrl"],
      [
        "authToken",
        "authTokenEnv",
        "authorization",
        "authorizationEnv",
        "accessToken",
        "accessTokenEnv",
        "basicAuth",
        "basicAuthEnv",
      ],
    ],
  },
};

/** Channel keys that have an explicit capability rule (every other key gets the send-only fallback). */
export function listChannelRuleKeys(): string[] {
  return Object.keys(CHANNEL_RULES);
}

export function describeChannelCapabilities(channelKey: string, config: Record<string, unknown>): ChannelCapabilities {
  const rule = CHANNEL_RULES[channelKey] ?? {
    supportedActions: ["channel.send"],
    inboundModes: ["none"],
    chunkingMode: "fallback",
    supportsStreaming: false,
    runtimePosture: {
      outboundTransport: "api",
      lifecycle: "stateless",
      inboundReadiness: "unsupported",
      operatorSummary: "This channel is currently normalized as an outbound-only bridge.",
    },
    requiredAnyOf: [],
  };

  const supportedActions = uniqueActions([
    ...(rule.resolveSupportedActions
      ? rule.resolveSupportedActions(config)
      : (rule.supportedActions as ChannelActionName[])),
    "channel.activity",
  ]);
  const supportedAttachmentSources = uniqueAttachmentSources([
    ...(rule.resolveSupportedAttachmentSources?.(config) ?? rule.supportedAttachmentSources ?? []),
  ]);
  const inboundModes = uniqueInboundModes([...(rule.resolveInboundModes?.(config) ?? rule.inboundModes ?? ["none"])]);
  const threadCapabilities: ChannelThreadCapabilities = {
    ...DEFAULT_THREAD_CAPABILITIES,
    ...(rule.threadCapabilities ?? {}),
  };
  const runtimePolicy: ChannelRuntimePolicy = {
    ...DEFAULT_RUNTIME_POLICY,
    ...(rule.resolveRuntimePolicy?.(config) ?? rule.runtimePolicy ?? {}),
  };
  runtimePolicy.typing ||= supportedActions.includes("channel.typing");
  runtimePolicy.activity ||= supportedActions.includes("channel.activity");
  runtimePolicy.presence ||= supportedActions.includes("channel.presence");
  const activityCapabilities = buildActivityCapabilities(channelKey, supportedActions);
  const runtimePosture = rule.resolveRuntimePosture
    ? rule.resolveRuntimePosture(config)
    : (rule.runtimePosture as ChannelRuntimePosture);
  const setupDiagnostics = buildSetupDiagnostics(rule, config);

  return {
    channelKey,
    supportedActions,
    supportedDeliveryActions: [...supportedActions],
    platformUnsupportedActions: {
      ...(rule.resolvePlatformUnsupportedActions?.(config) ?? rule.platformUnsupportedActions ?? {}),
    },
    supportedAttachmentSources,
    inboundModes,
    threadCapabilities,
    runtimePolicy,
    activityCapabilities,
    runtimePosture,
    chunkingMode: rule.chunkingMode,
    supportsStreaming: rule.supportsStreaming,
    supportNotes: [...(rule.resolveSupportNotes?.(config) ?? rule.supportNotes ?? [])],
    setupDiagnostics,
    setupReady: setupDiagnostics.length === 0,
  };
}

export function planChannelTextDelivery(
  channelKey: string,
  text: string,
  options: { richFormat?: ChannelDeliveryRichFormat; maxChunkCodeUnits?: number } = {},
): ChannelTextDeliveryPlan {
  const capabilities = describeChannelCapabilities(channelKey, {});
  const maxChunkCodeUnits = Math.max(
    1,
    Math.floor(options.maxChunkCodeUnits ?? CHANNEL_TEXT_LIMITS[channelKey] ?? 4000),
  );
  const chunks = splitUtf16SafeChunks(text, maxChunkCodeUnits);
  const richFormat = options.richFormat ?? "plain_text";
  const richFormatPosture = richFormat === "plain_text" || chunks.length <= 1 ? "preserved" : "plain_text_fallback";
  const notes = [
    chunks.length > 1
      ? `Text exceeds ${maxChunkCodeUnits} UTF-16 code units and will be delivered in ${chunks.length} chunks.`
      : "Text fits within a single channel delivery chunk.",
    richFormatPosture === "plain_text_fallback"
      ? "Rich formatting must be flattened before chunking unless the channel adapter proves native rich chunk support."
      : "Formatting can be preserved for this planned delivery.",
  ];
  return {
    channelKey,
    chunkingMode: capabilities.chunkingMode,
    maxChunkCodeUnits,
    chunks,
    richFormatPosture,
    notes,
  };
}

export function planChannelRichMessageDelivery(
  channelKey: string,
  input: {
    text?: string;
    richFormat?: ChannelDeliveryRichFormat;
    attachments?: ChannelAttachmentInput[];
    attachmentIds?: string[];
  } = {},
): ChannelRichMessageDeliveryPlan | undefined {
  const normalizedChannelKey = channelKey.toLowerCase();
  const profile = CHANNEL_RICH_MESSAGE_PROFILES[normalizedChannelKey];
  if (!profile) {
    return undefined;
  }

  const text = input.text ?? "";
  const attachments = normalizeRichAttachments(input.attachments);
  const attachmentIds = normalizeAttachmentIds(input.attachmentIds);
  const plannedAttachments = attachments.map((attachment, index) =>
    planRichAttachment(normalizedChannelKey, attachment, index, profile.providerAttachmentLimit),
  );

  for (let index = 0; index < attachmentIds.length; index += 1) {
    plannedAttachments.push({
      index: plannedAttachments.length,
      source: "pending_attachment_id",
      mediaKind: "unknown",
      disposition: plannedAttachments.length < profile.providerAttachmentLimit ? "pending_hydration" : "blocked",
      reason:
        plannedAttachments.length < profile.providerAttachmentLimit
          ? "Attachment id will be hydrated before provider send."
          : `Provider rich delivery is capped at ${profile.providerAttachmentLimit} attachments per message.`,
    });
  }

  const nativeAttachmentCount = plannedAttachments.filter((item) => item.disposition === "native_media").length;
  const fallbackAttachmentCount = plannedAttachments.filter(
    (item) => item.disposition === "document_fallback" || item.disposition === "text_fallback",
  ).length;
  const blockedAttachmentCount = plannedAttachments.filter((item) => item.disposition === "blocked").length;
  const pendingAttachmentIdCount = plannedAttachments.filter((item) => item.source === "pending_attachment_id").length;
  const textPosture = resolveRichTextPosture(
    normalizedChannelKey,
    text,
    plannedAttachments,
    profile.captionMaxCodeUnits,
  );
  const status = blockedAttachmentCount > 0 ? "blocked" : resolveRichPlanStatus(textPosture, fallbackAttachmentCount);
  const notes = buildRichMessageNotes({
    channelKey: normalizedChannelKey,
    text,
    textPosture,
    richFormat: input.richFormat,
    attachmentCount: plannedAttachments.length,
    nativeAttachmentCount,
    fallbackAttachmentCount,
    blockedAttachmentCount,
    pendingAttachmentIdCount,
    providerAttachmentLimit: profile.providerAttachmentLimit,
    captionMaxCodeUnits: profile.captionMaxCodeUnits,
  });

  return {
    channelKey: normalizedChannelKey,
    provider: profile.provider,
    capabilityLabel: profile.capabilityLabel,
    status,
    textPosture,
    attachmentCount: plannedAttachments.length,
    nativeAttachmentCount,
    fallbackAttachmentCount,
    blockedAttachmentCount,
    pendingAttachmentIdCount,
    providerAttachmentLimit: profile.providerAttachmentLimit,
    captionMaxCodeUnits: profile.captionMaxCodeUnits,
    notes,
    evidence: {
      owner: "gateway",
      source: "channel_rich_message_plan",
      status,
      provider: profile.provider,
      evidenceId: buildRichMessageEvidenceId(normalizedChannelKey, status, textPosture, plannedAttachments),
    },
    attachments: plannedAttachments,
  };
}

function splitUtf16SafeChunks(text: string, maxChunkCodeUnits: number): string[] {
  if (!text) {
    return [""];
  }
  const chunks: string[] = [];
  let current = "";
  for (const char of text) {
    if (current.length > 0 && current.length + char.length > maxChunkCodeUnits) {
      chunks.push(current);
      current = "";
    }
    current += char;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

function normalizeRichAttachments(input: ChannelAttachmentInput[] | undefined): ChannelAttachmentInput[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      url: trimOptionalString(item.url),
      title: trimOptionalString(item.title),
      mimeType: trimOptionalString(item.mimeType),
      dataBase64: trimOptionalString(item.dataBase64),
      attachmentId: trimOptionalString(item.attachmentId),
    }))
    .filter((item) => item.url || item.title || item.mimeType || item.dataBase64 || item.attachmentId);
}

function normalizeAttachmentIds(input: string[] | undefined): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
}

function planRichAttachment(
  channelKey: string,
  attachment: ChannelAttachmentInput,
  index: number,
  providerAttachmentLimit: number,
): ChannelRichAttachmentPlan {
  const source = resolveRichAttachmentSource(attachment);
  const mediaKind = inferRichMediaKind(attachment);
  const common = {
    index,
    source,
    mediaKind,
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    ...(attachment.title ? { title: attachment.title } : {}),
  };

  if (index >= providerAttachmentLimit) {
    return {
      ...common,
      disposition: "blocked",
      reason: `Provider rich delivery is capped at ${providerAttachmentLimit} attachments per message.`,
    };
  }
  if (source === "pending_attachment_id") {
    return {
      ...common,
      disposition: "pending_hydration",
      reason: "Attachment id will be hydrated before provider send.",
    };
  }
  if (source === "metadata_only") {
    return channelKey === "whatsapp"
      ? {
          ...common,
          disposition: "text_fallback",
          reason: "Metadata-only attachment will be rendered into the text body.",
        }
      : {
          ...common,
          disposition: "blocked",
          reason: "Telegram rich attachments require a URL, inline data, or an attachmentId to hydrate.",
        };
  }
  if (channelKey === "telegram") {
    const isNativeMedia = mediaKind === "image" || mediaKind === "video" || mediaKind === "audio";
    const providerKind =
      mediaKind === "image" ? "photo" : mediaKind === "video" ? "video" : mediaKind === "audio" ? "audio" : "document";
    return {
      ...common,
      providerKind,
      disposition: isNativeMedia ? "native_media" : "document_fallback",
      ...(isNativeMedia ? {} : { reason: "Telegram non-media rich attachments use document delivery in this bridge." }),
    };
  }
  if (channelKey === "whatsapp") {
    const providerKind = mediaKind === "unknown" ? "document" : mediaKind;
    return {
      ...common,
      providerKind,
      disposition: mediaKind === "unknown" ? "document_fallback" : "native_media",
      ...(mediaKind === "unknown" ? { reason: "Unknown WhatsApp media type falls back to document delivery." } : {}),
    };
  }
  return {
    ...common,
    disposition: "blocked",
    reason: "No rich message planner is available for this channel.",
  };
}

function resolveRichAttachmentSource(attachment: ChannelAttachmentInput): ChannelRichAttachmentSource {
  if (attachment.dataBase64) {
    return "inline";
  }
  if (attachment.url) {
    return "url";
  }
  if (attachment.attachmentId) {
    return "pending_attachment_id";
  }
  return "metadata_only";
}

function inferRichMediaKind(attachment: ChannelAttachmentInput): ChannelRichMediaKind {
  const mimeType = attachment.mimeType?.toLowerCase();
  if (mimeType?.startsWith("image/")) {
    return "image";
  }
  if (mimeType?.startsWith("video/")) {
    return "video";
  }
  if (mimeType?.startsWith("audio/")) {
    return "audio";
  }
  if (mimeType) {
    return "document";
  }
  const path = `${attachment.title ?? ""} ${attachment.url ?? ""}`.toLowerCase();
  if (/\.(png|jpe?g|gif|webp)(\?|#|$)/u.test(path)) {
    return "image";
  }
  if (/\.(mp4|mov|webm|m4v)(\?|#|$)/u.test(path)) {
    return "video";
  }
  if (/\.(mp3|wav|m4a|ogg|aac)(\?|#|$)/u.test(path)) {
    return "audio";
  }
  if (path.trim()) {
    return "document";
  }
  return "unknown";
}

function resolveRichTextPosture(
  channelKey: string,
  text: string,
  attachments: ChannelRichAttachmentPlan[],
  captionMaxCodeUnits: number,
): ChannelRichMessageTextPosture {
  const hasText = text.trim().length > 0;
  const hasRichAttachment = attachments.some((item) => item.disposition !== "text_fallback");
  if (!hasRichAttachment) {
    return hasText ? "text_only" : "media_only";
  }
  if (!hasText) {
    return "media_only";
  }
  if (channelKey === "telegram" && text.length <= captionMaxCodeUnits) {
    return "caption";
  }
  return "separate_text_then_media";
}

function resolveRichPlanStatus(
  textPosture: ChannelRichMessageTextPosture,
  fallbackAttachmentCount: number,
): ChannelRichMessagePlanStatus {
  if (fallbackAttachmentCount > 0 || textPosture === "separate_text_then_media") {
    return "degraded";
  }
  return "preserved";
}

function buildRichMessageNotes(input: {
  channelKey: string;
  text: string;
  textPosture: ChannelRichMessageTextPosture;
  richFormat?: ChannelDeliveryRichFormat;
  attachmentCount: number;
  nativeAttachmentCount: number;
  fallbackAttachmentCount: number;
  blockedAttachmentCount: number;
  pendingAttachmentIdCount: number;
  providerAttachmentLimit: number;
  captionMaxCodeUnits: number;
}): string[] {
  const notes: string[] = [];
  if (input.attachmentCount === 0) {
    notes.push("No rich attachments are present; delivery stays text-only.");
  } else {
    notes.push(
      `${input.channelKey} rich delivery planned ${input.nativeAttachmentCount} native attachment${input.nativeAttachmentCount === 1 ? "" : "s"} and ${input.fallbackAttachmentCount} fallback attachment${input.fallbackAttachmentCount === 1 ? "" : "s"}.`,
    );
  }
  if (input.pendingAttachmentIdCount > 0) {
    notes.push(
      `${input.pendingAttachmentIdCount} attachment id${input.pendingAttachmentIdCount === 1 ? "" : "s"} will be hydrated before provider send.`,
    );
  }
  if (input.textPosture === "caption") {
    notes.push(`Message text fits the ${input.captionMaxCodeUnits} UTF-16 code unit caption limit.`);
  }
  if (input.textPosture === "separate_text_then_media") {
    notes.push(
      input.channelKey === "telegram"
        ? `Message text exceeds the ${input.captionMaxCodeUnits} UTF-16 code unit caption limit and will be sent before media.`
        : "WhatsApp Cloud API sends message text separately from media attachments in this bridge.",
    );
  }
  if (input.richFormat && input.richFormat !== "plain_text" && input.channelKey === "whatsapp") {
    notes.push("WhatsApp Cloud API delivery does not preserve arbitrary HTML/Markdown rich formatting in this bridge.");
  }
  if (input.blockedAttachmentCount > 0) {
    notes.push(
      `${input.blockedAttachmentCount} attachment${input.blockedAttachmentCount === 1 ? "" : "s"} blocked before provider send; fix the attachment payload or split the delivery.`,
    );
  }
  if (input.attachmentCount > input.providerAttachmentLimit) {
    notes.push(`Provider rich delivery limit is ${input.providerAttachmentLimit} attachments per message.`);
  }
  return notes;
}

function buildRichMessageEvidenceId(
  channelKey: string,
  status: ChannelRichMessagePlanStatus,
  textPosture: ChannelRichMessageTextPosture,
  attachments: ChannelRichAttachmentPlan[],
): string {
  const stable = `${channelKey}|${status}|${textPosture}|${attachments
    .map((item) => `${item.index}:${item.source}:${item.mediaKind}:${item.disposition}:${item.providerKind ?? ""}`)
    .join(";")}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < stable.length; index += 1) {
    hash ^= stable.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `richmsg-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function buildActivityCapabilities(
  channelKey: string,
  supportedActions: ChannelActionName[],
): ChannelActivityCapabilities {
  const nativeEffects: ChannelActivityCapabilities["nativeEffects"] = ["mission_control"];
  if (supportedActions.includes("channel.react")) {
    nativeEffects.push("reaction");
    if (["discord", "slack", "telegram", "whatsapp"].includes(channelKey)) {
      nativeEffects.push("reaction_clear");
    }
  }
  if (supportedActions.includes("channel.typing")) {
    nativeEffects.push("typing");
  }
  if (channelKey === "whatsapp") {
    nativeEffects.push("read_receipt");
  }
  return {
    supported: true,
    phases: [...CHANNEL_ACTIVITY_PHASES],
    nativeEffects: [...new Set(nativeEffects)],
    clearOnTerminal: true,
    activityEmoji: { ...CHANNEL_ACTIVITY_EMOJI },
  };
}

function buildSetupDiagnostics(rule: ChannelRule, config: Record<string, unknown>): string[] {
  const diagnostics: string[] = [];
  for (const group of rule.requiredAnyOf) {
    if (group.some((key) => readConfigString(config, key))) {
      continue;
    }
    diagnostics.push(`Missing one of: ${group.map((key) => `config.${key}`).join(", ")}.`);
  }
  diagnostics.push(...(rule.resolveSetupDiagnostics?.(config) ?? []));
  return diagnostics;
}

function uniqueActions(values: ChannelActionName[]): ChannelActionName[] {
  return [...new Set(values)];
}

function uniqueAttachmentSources(values: ChannelAttachmentSource[]): ChannelAttachmentSource[] {
  return [...new Set(values)];
}

function uniqueInboundModes(values: ChannelInboundMode[]): ChannelInboundMode[] {
  return [...new Set(values)];
}

function readConfigString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Telegram's explicit receive mode. Only "poll" and "off" change behavior here: "webhook", a missing
 * value, or anything unknown keeps the secret-based logic that predates the setting, so connections
 * saved before it existed behave exactly as before.
 */
function readTelegramReceiveMode(config: Record<string, unknown>): "poll" | "off" | undefined {
  const mode = readConfigString(config, "receiveMode");
  return mode === "poll" || mode === "off" ? mode : undefined;
}

function hasTelegramWebhookSecret(config: Record<string, unknown>): boolean {
  return hasAnyConfigured(config, ["webhookSecret", "webhookSecretEnv", "secretToken", "secretTokenEnv"]);
}

function resolveTelegramInboundNote(config: Record<string, unknown>): string {
  const receiveMode = readTelegramReceiveMode(config);
  if (receiveMode === "poll") {
    return "Telegram inbound routing works by asking Telegram for new messages; no public web address or webhook secret is needed.";
  }
  if (receiveMode === "off") {
    return "Telegram inbound routing is turned off for this connection.";
  }
  return hasTelegramWebhookSecret(config)
    ? "Telegram inbound webhook routing is enabled through the Bot API secret-token webhook path."
    : "Telegram inbound routing remains disabled until a webhook secret is configured.";
}

function isNtfyInboundRequested(config: Record<string, unknown>): boolean {
  const flag = config.inboundStreamEnabled;
  return flag === true || (typeof flag === "string" && flag.trim().toLowerCase() === "true");
}

function hasNtfyToken(config: Record<string, unknown>): boolean {
  return hasAnyConfigured(config, ["token", "tokenEnv"]);
}

/** Mirrors the ntfy stream adapter: opt-in, base URL, subscribe topic and a token. */
function isNtfyInboundEnabled(config: Record<string, unknown>): boolean {
  return (
    isNtfyInboundRequested(config) &&
    hasNtfyToken(config) &&
    hasAnyConfigured(config, ["baseUrl"]) &&
    hasAnyConfigured(config, ["subscribeTopic", "topic", "defaultTopic"])
  );
}

/** Mirrors the Signal stream adapter: receiveEvents opt-in and a bridge URL. */
function isSignalInboundEnabled(config: Record<string, unknown>): boolean {
  return isExplicitTrue(config.receiveEvents) && hasAnyConfigured(config, ["baseUrl", "bridgeUrl"]);
}

/** Mirrors the Mattermost stream adapter: opt-in, server URL and a bot token. */
function isMattermostInboundEnabled(config: Record<string, unknown>): boolean {
  return (
    isExplicitTrue(config.inboundStreamEnabled) &&
    hasAnyConfigured(config, ["serverUrl"]) &&
    hasAnyConfigured(config, ["botToken", "botTokenEnv", "token", "tokenEnv"])
  );
}

/** Mirrors the Matrix stream adapter: strict opt-in, homeserver URL and an access token. */
export function isMatrixInboundEnabled(config: Record<string, unknown>): boolean {
  return (
    config.inboundStreamEnabled === true &&
    hasAnyConfigured(config, ["homeserverUrl"]) &&
    hasAnyConfigured(config, ["accessToken", "accessTokenEnv"])
  );
}

/** QQBot signed webhook inbound: the app secret verifies the ed25519 request signature. */
export function isQqbotInboundEnabled(config: Record<string, unknown>): boolean {
  return hasAnyConfigured(config, ["appSecret", "appSecretEnv"]);
}

/** WeCom encrypted callback inbound: corp id, callback token and EncodingAESKey are all required. */
export function isWecomInboundEnabled(config: Record<string, unknown>): boolean {
  return (
    hasAnyConfigured(config, ["corpId"]) &&
    hasAnyConfigured(config, ["callbackToken", "callbackTokenEnv"]) &&
    hasAnyConfigured(config, ["encodingAesKey", "encodingAesKeyEnv"])
  );
}

/** Google Chat app mode: a service-account key (env name or JSON key string) is configured. */
function isGoogleChatServiceAccountMode(config: Record<string, unknown>): boolean {
  return hasAnyConfigured(config, ["serviceAccountKeyEnv", "serviceAccountKey"]);
}

/** Mirrors the Google Chat webhook route: app mode plus a verifiable audience. */
function isGoogleChatAppInboundEnabled(config: Record<string, unknown>): boolean {
  const audienceType = readConfigString(config, "audienceType");
  return (
    isGoogleChatServiceAccountMode(config) &&
    (audienceType === "project_number" || audienceType === "endpoint_url") &&
    hasAnyConfigured(config, ["audience"])
  );
}

function hasAnyConfigured(config: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => Boolean(readConfigString(config, key)));
}

export function isExplicitTrue(value: unknown): boolean {
  return value === true || (typeof value === "string" && value.trim().toLowerCase() === "true");
}

function trimOptionalString(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
