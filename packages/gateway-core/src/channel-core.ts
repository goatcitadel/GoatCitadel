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
    resolveSupportedActions: (config) => {
      const runtimeMode = readConfigString(config, "runtimeMode") === "gateway" ? "gateway" : "bridge";
      if (hasAnyConfigured(config, ["botTokenEnv", "botToken", "tokenEnv", "token"])) {
        return runtimeMode === "gateway"
          ? ["channel.send", "channel.reply", "channel.react", "channel.unsend", "channel.typing"]
          : ["channel.send", "channel.reply", "channel.react", "channel.unsend"];
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
            "Outbound replies still use the shared Discord send bridge, so reactions and unsend follow the same REST constraints as bridge mode.",
            "Guided setup can run token, channel, sandbox send/delete, and runtime-readiness probes before finalize.",
          ]
        : hasAnyConfigured(config, ["botTokenEnv", "botToken", "tokenEnv", "token"])
          ? [
              "Bridge-mode Discord connections are outbound REST bridges. They support reactions and deleting messages in channels the bot can manage, but they do not create a persistent online presence.",
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
    resolveInboundModes: (config) =>
      hasAnyConfigured(config, ["webhookSecret", "webhookSecretEnv", "secretToken", "secretTokenEnv"])
        ? ["webhook"]
        : ["none"],
    threadCapabilities: {
      replies: true,
      direct: true,
      groups: true,
    },
    chunkingMode: "fallback",
    supportsStreaming: false,
    resolveRuntimePosture: (config) => {
      const hasWebhookIngress = hasAnyConfigured(config, [
        "webhookSecret",
        "webhookSecretEnv",
        "secretToken",
        "secretTokenEnv",
      ]);
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
      hasAnyConfigured(config, ["webhookSecret", "webhookSecretEnv", "secretToken", "secretTokenEnv"])
        ? "Telegram inbound webhook routing is enabled through the Bot API secret-token webhook path."
        : "Telegram inbound routing remains disabled until a webhook secret is configured.",
      "Guided setup can run a sandbox send/delete probe before finalize.",
    ],
    requiredAnyOf: [["botTokenEnv", "botToken", "tokenEnv", "token"]],
  },
  ntfy: {
    supportedActions: ["channel.send"],
    supportedAttachmentSources: ["url"],
    inboundModes: ["none"],
    threadCapabilities: {
      rooms: true,
    },
    chunkingMode: "fallback",
    supportsStreaming: false,
    runtimePosture: {
      outboundTransport: "api",
      lifecycle: "stateless",
      inboundReadiness: "unsupported",
      operatorSummary:
        "ntfy is normalized as a stateless outbound-only notification path. It can publish to a configured topic, but it does not accept inbound webhooks, subscriptions, or remote commands in this runtime.",
    },
    supportNotes: [
      "ntfy v1 supports outbound text notifications only; inbound webhook and topic subscription handling are intentionally not wired.",
      "Token-backed topics should use tokenEnv so secrets are resolved at the tool host boundary.",
      "Dry-run mode validates routing without publishing to the ntfy server.",
    ],
    requiredAnyOf: [["baseUrl"], ["topic", "defaultTopic"]],
  },
  "google-chat": {
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
        "Google Chat is normalized as a stateless outbound webhook destination. Rich card sends work, but inbound routing is not available in the current runtime.",
    },
    supportNotes: [
      "Google Chat webhook sends support URL-backed rich cards for image and link attachments.",
      "Google Chat webhook mode is outbound only and does not provide inbound routing.",
      "Guided setup can run a sandbox webhook probe before finalize, but destination confirmation is still manual.",
    ],
    requiredAnyOf: [["webhookUrl", "url"]],
  },
  teams: {
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
    supportedActions: ["channel.send", "channel.reply", "channel.react"],
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
          ? "WhatsApp Cloud API is normalized as a stateless bridge with signed webhook ingress. Rich outbound media, reactions, and inbound message routing are available, but delete parity is still incomplete."
          : "WhatsApp Cloud API is normalized as a stateless outbound bridge. Rich outbound media and reactions are supported, but inbound routing and delete parity are still incomplete.",
      };
    },
    resolveSupportNotes: (config) => [
      "WhatsApp Cloud API rich sends support public URL media and uploaded inline files for supported image, video, audio, and document types.",
      "WhatsApp rich-message preflight labels native media, text fallbacks, pending attachment hydration, and Cloud API provider evidence before send.",
      "WhatsApp reactions are sent through the Cloud API, but unsend/delete is still not wired in this bridge.",
      hasAnyConfigured(config, ["appSecret", "appSecretEnv"]) &&
      hasAnyConfigured(config, ["webhookVerifyToken", "webhookVerifyTokenEnv", "verifyToken", "verifyTokenEnv"])
        ? "WhatsApp inbound routing is enabled through the signed Cloud API webhook path when both the app secret and webhook verify token are configured."
        : "WhatsApp inbound routing remains disabled until both the app secret and webhook verify token are configured.",
    ],
    requiredAnyOf: [["phoneNumberId"], ["accessTokenEnv", "accessToken", "tokenEnv", "token"]],
  },
  signal: {
    supportedActions: ["channel.send"],
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
        "Signal is normalized as a stateless outbound bridge. It can send to configured recipients, but inbound routing is not available in the current runtime.",
    },
    requiredAnyOf: [["baseUrl", "bridgeUrl"]],
  },
  mattermost: {
    supportedActions: ["channel.send", "channel.reply", "channel.react", "channel.unsend"],
    supportedAttachmentSources: ["url", "inline"],
    threadCapabilities: {
      rooms: true,
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
        "Mattermost is normalized as a stateless outbound bot bridge. Rich outbound post actions are supported, but inbound routing is not yet wired.",
    },
    supportNotes: [
      "Mattermost unsend deletes the original post and typically applies only to posts the bot can remove.",
      "Mattermost rich sends upload files to the resolved channel before creating the post.",
    ],
    requiredAnyOf: [["serverUrl"], ["botTokenEnv", "botToken"]],
  },
  imessage: {
    supportedActions: ["channel.send", "channel.reply", "channel.react", "channel.unsend"],
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
      "Reactions and unsend require BlueBubbles Private API support.",
    ],
    requiredAnyOf: [
      ["bridgeUrl", "baseUrl", "serverUrl"],
      ["passwordEnv", "password", "apiPasswordEnv", "apiPassword"],
    ],
  },
  "nextcloud-talk": {
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
      "Attachments and unsend remain unsupported in this adapter.",
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
      ["authToken", "authTokenEnv", "authorization", "authorizationEnv"],
    ],
  },
};

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

function hasAnyConfigured(config: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => Boolean(readConfigString(config, key)));
}

function trimOptionalString(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
