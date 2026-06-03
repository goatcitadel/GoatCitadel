import type {
  ChannelActionName,
  ChannelActivityCapabilities,
  ChannelActivityPhase,
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
        "iMessage via BlueBubbles is normalized as a stateless local bridge. Outbound sends, replies, reactions, and unsend depend on bridge capabilities, but inbound normalization is not active here.",
    },
    supportNotes: [
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
