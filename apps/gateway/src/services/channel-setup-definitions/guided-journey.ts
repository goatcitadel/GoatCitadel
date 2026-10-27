import type { ChannelSetupFieldDefinition, ChannelSetupStepDefinition } from "@goatcitadel/contracts";
import {
  GUIDED_INBOUND_CHANNELS,
  FORCED_ALLOWLIST_INBOUND_CHANNELS,
  hydrateGuidedChannelInboundAccess,
  normalizeGuidedChannelInboundAccess,
} from "../channel-setup-inbound-access.js";
import type { ChannelSetupRuntimeDefinition } from "./common.js";

const POSTURE: Record<string, { summary: string; prerequisites: string[]; firstMessage: string }> = {
  discord: {
    summary: "Connect an online Discord bot for paired direct messages or an allowlisted server channel.",
    prerequisites: [
      "A Discord application with a bot token and Message Content Intent enabled.",
      "For server messages, permission to install the bot and grant View Channel, Send Messages and Read Message History in the chosen channel.",
    ],
    firstMessage:
      "Wait for the saved Gateway connection to become ready. For server setup, mention the bot in the chosen channel. For direct messages, send a DM, approve the pending pairing, then send another message and confirm its reply.",
  },
  slack: {
    summary: "Connect a Slack workspace bot, choose channels, and optionally enable verified inbound conversations.",
    prerequisites: [
      "Permission to install a Slack app in the intended workspace.",
      "Bot scopes for the actions you need and an invitation to the selected channels.",
      "A reachable HTTPS Gateway URL and Slack signing secret for Events API conversations.",
    ],
    firstMessage:
      "Register the connection webhook URL in Slack Events, enable message events, and allow your Slack user ID. Send a message from that user in a selected channel and confirm the reply. A webhook fallback remains a notification destination.",
  },
  telegram: {
    summary: "Connect a Telegram bot, choose who can message it, and how it gets messages.",
    prerequisites: [
      "A BotFather bot token and access to each intended chat.",
      "The bot added to each destination and permitted to post.",
      "A public HTTPS address only if you choose web-address delivery.",
    ],
    firstMessage:
      "Send the bot a message and approve its pairing request in GoatCitadel. With web-address delivery, first register the connection's webhook URL with the same secret token. Then send another message and confirm its reply. Destination discovery does not authorize users.",
  },
  ntfy: {
    summary:
      "Publish notifications to an ntfy topic and, optionally, subscribe to a topic's JSON stream for inbound conversations. Anyone able to publish to the subscribed topic can start turns, so limit its write access to trusted publishers; messages published while the gateway is down are skipped.",
    prerequisites: [
      "A reachable ntfy server and topic you control.",
      "Subscribe to that exact topic on a device before testing.",
      "For protected topics and for inbound, an environment variable holding an authorized token that can read and publish the topic.",
    ],
    firstMessage:
      "Run a publish test and confirm receipt on the subscribed device. Dry-run validates configuration without publishing; it cannot establish delivery proof. For inbound, publish a message to the topic from another client and allow the sender ntfy-topic:<topic>.",
  },
  "google-chat": {
    summary:
      "Send cards and notifications into a Google Chat Space through its webhook, or run a Chat app (service account) that also receives messages, replies, and deletes its own messages.",
    prerequisites: [
      "Webhook mode: permission to create an incoming webhook in the intended Google Chat Space, and the complete webhook URL treated as a credential.",
      "Chat app mode: a Chat app whose HTTP endpoint is this connection's Google Chat webhook URL, its authentication audience (project number or endpoint URL), and the service-account JSON key in a gateway environment variable.",
      "For inbound, the Google Chat user resource names (users/...) allowed to start conversations; a dropped message's sender_not_allowlisted diagnostic shows the id.",
    ],
    firstMessage:
      "Webhook mode: confirm the test card appears in the selected Space and thread; webhook mode cannot receive messages. Chat app mode: allow your users/... id, message the app (or @mention it in a space), and confirm its threaded reply.",
  },
  teams: {
    summary: "Send outbound Adaptive Cards to a Microsoft Teams webhook destination.",
    prerequisites: [
      "A Teams Workflows webhook with Anyone trigger authentication; tenant-only Microsoft Entra triggers are unsupported.",
      "A workflow owner and co-owner who can maintain its Teams connection.",
      "Permission to post Adaptive Cards in the chosen channel and confirm a live sandbox card. Retired Office 365 connector URLs must be replaced.",
    ],
    firstMessage:
      "Confirm the sandbox card appears in the intended Teams channel. This adapter sends notifications; it does not install a conversational Teams bot.",
  },
  whatsapp: {
    summary: "Connect WhatsApp Business Cloud API with a sender identity and optional signed inbound webhooks.",
    prerequisites: [
      "A Meta app and WhatsApp Business Cloud API sender with an access token and phone-number ID.",
      "A recipient permitted by the current Cloud API messaging rules.",
      "For inbound conversations, a public HTTPS endpoint, app secret and webhook verify token.",
    ],
    firstMessage:
      "Register the saved connection webhook URL in Meta, complete its verification challenge, and subscribe to messages. Allow trusted wa_id sender values (digits only), send an inbound message and confirm its reply. Personal WhatsApp QR linking is not supported by this adapter.",
  },
  signal: {
    summary:
      "Send Signal messages through a separately configured bridge and, optionally, receive messages from the signal-cli HTTP daemon event stream.",
    prerequisites: [
      "A reachable Signal JSON-RPC bridge with an already linked sender account.",
      "The recipient or group identifier and permission to send to it.",
      "For inbound, a signal-cli daemon --http bridge and the sender UUIDs allowed to start conversations (a dropped message's sender_not_allowlisted diagnostic shows the id; senders without a UUID use their number).",
    ],
    firstMessage:
      "Confirm the sandbox message arrives in Signal. For inbound, enable receiveEvents, allow your sender id, send a message and confirm its reply; messages from senders who are not allowed are dropped, and messages sent while the event stream is disconnected are not replayed.",
  },
  mattermost: {
    summary:
      "Send Mattermost posts, replies and files through a bot account and, optionally, receive posts over the bot WebSocket.",
    prerequisites: [
      "A reachable Mattermost server and bot token.",
      "The bot joined to the intended team/channel, with posting permissions.",
      "For inbound, the bot must be a member of each channel you want it to hear, and you need the Mattermost user ids allowed to start conversations (in Mattermost, open a person's profile and choose Copy user ID; a dropped post's sender_not_allowlisted diagnostic also shows the id).",
    ],
    firstMessage:
      "Confirm the test post arrives in the chosen channel. For inbound, allow your Mattermost user id, post in a channel the bot has joined, and confirm its reply; inbound posts from users who are not allowed are dropped.",
  },
  matrix: {
    summary:
      "Send Matrix room messages, replies, reactions and redactions through a bot account and, optionally, receive messages over the /sync long-poll.",
    prerequisites: [
      "A Matrix bot account on a reachable homeserver and its access token in a gateway environment variable (for example MATRIX_ACCESS_TOKEN).",
      "The bot invited to and joined in the intended room, with permission to post.",
      "The homeserver host added to the network allowlist.",
      "End-to-end encrypted rooms are not supported: inbound ignores encrypted events and outbound sends unencrypted messages; use an unencrypted room.",
      "For inbound, the Matrix user ids (such as @alice:example.com) allowed to start conversations; a dropped message's sender_not_allowlisted diagnostic shows the id.",
    ],
    firstMessage:
      "Confirm the sandbox notice arrives in the chosen room. For inbound, allow your Matrix user id, post in a room the bot has joined, and confirm its reply; messages from users who are not allowed are dropped. Outbound is text-only.",
  },
  qqbot: {
    summary:
      "Send QQ group, C2C, channel and direct-message text through a QQ Bot Open Platform app and receive messages on a signed webhook.",
    prerequisites: [
      "A QQ Bot Open Platform app with its AppID and its AppSecret in a gateway environment variable (for example QQBOT_APP_SECRET).",
      "The QQ hosts (bots.qq.com and api.bot.qq.com, or sandbox.api.sgroup.qq.com for the sandbox) added to the network allowlist.",
      "A public HTTPS Gateway URL registered as the callback URL in the QQ console.",
      "For inbound, the QQ openids allowed to start conversations; a dropped message's sender_not_allowlisted diagnostic shows the id.",
    ],
    firstMessage:
      "Register the connection webhook URL in the QQ console and pass its validation. Allow your QQ openid, message the bot, and confirm its reply; messages from openids that are not allowed are dropped. Outbound is text-only, and QQ limits active (unprompted) messages to platform quotas.",
  },
  wecom: {
    summary:
      "Send WeCom application text to users, departments and tags and receive messages on an encrypted callback.",
    prerequisites: [
      "A WeCom self-built application with its CorpID, AgentId and Secret (the Secret in a gateway environment variable such as WECOM_SECRET).",
      "qyapi.weixin.qq.com in the network allowlist and the gateway host's public IP on the application's trusted IP list.",
      "For inbound, the callback Token and EncodingAESKey in gateway environment variables and a public HTTPS Gateway URL for the callback.",
      "For inbound, the WeCom userids allowed to start conversations; a dropped message's sender_not_allowlisted diagnostic shows the id.",
    ],
    firstMessage:
      "Confirm the sandbox message arrives in WeCom. For inbound, save the connection webhook URL, Token and EncodingAESKey in the application's message-receiving settings, allow your WeCom userid, message the application, and confirm its reply; messages from users who are not allowed are dropped. Outbound is text-only.",
  },
  imessage: {
    summary: "Use a reachable BlueBubbles Mac bridge for outbound iMessage delivery.",
    prerequisites: [
      "A Mac running a callable BlueBubbles bridge and its password.",
      "An existing chat or supported new-handle chat creation.",
      "Private API support when you need reactions or unsend.",
    ],
    firstMessage:
      "Confirm the message arrives in Messages. Reactions and unsend depend on Private API support. Photon/Spectrum remains diagnostics-only in this build; selecting it does not install a callable adapter.",
  },
  "nextcloud-talk": {
    summary: "Connect a Nextcloud Talk bot with signed inbound events and outbound replies.",
    prerequisites: [
      "A reachable Nextcloud Talk instance with bot API support.",
      "A registered bot, shared signing token and room membership.",
      "A public HTTPS Gateway webhook endpoint for signed inbound messages.",
    ],
    firstMessage:
      "Register the saved connection webhook URL with the same shared token, allow your Nextcloud actor ID, and send a room message. Confirm its reply; attachments and unsend are not supported.",
  },
  line: {
    summary: "Connect a LINE Messaging API bot with optional signed webhook conversations.",
    prerequisites: [
      "A LINE Messaging API channel and channel access token.",
      "The bot added to the intended user, room or group.",
      "For inbound messages, a channel secret and reachable HTTPS Gateway webhook endpoint.",
    ],
    firstMessage:
      "Enable webhooks in LINE and register the saved connection URL. Allow the sender actor ID separately from the destination user/group/room ID, send an inbound message, and confirm its reply.",
  },
  zalo: {
    summary: "Send outbound messages from a Zalo Official Account to eligible recipients.",
    prerequisites: [
      "An authorized Zalo Official Account access token.",
      "The recipient OA user ID and eligibility to receive messages.",
    ],
    firstMessage:
      "Confirm the sandbox message arrives at the intended OA recipient. This narrow outbound adapter does not receive conversations.",
  },
  zalouser: {
    summary: "Send outbound messages through an authenticated zca personal-session bridge.",
    prerequisites: [
      "A reachable authenticated zca bridge and its bearer credential.",
      "An already linked profile and intended personal-session recipient or group.",
    ],
    firstMessage:
      "Confirm the sandbox text arrives from the expected profile. Rich media uses URL-backed attachments; inbound conversations are unavailable. Authentication is required for the supported bridge posture.",
  },
};
const DESTINATION_KEYS = new Set([
  "targets",
  "defaultSpace",
  "defaultChannel",
  "defaultChannelId",
  "defaultChatId",
  "defaultGuildId",
  "defaultTarget",
  "defaultRecipient",
  "defaultRecipientId",
  "defaultHandle",
  "defaultRoomId",
  "topic",
  "subscribeTopic",
  "defaultTeam",
  "inboundDmPolicy",
  "guildPolicy",
]);
const ADVANCED_KEYS = new Set([
  "defaultThreadTs",
  "defaultThreadKey",
  "parseMode",
  "voiceReplyMode",
  "cardTitle",
  "priority",
  "dryRun",
  "setupCode",
  "profile",
  "photonSidecarUrl",
  "photonAuthEnv",
  "sandbox",
]);
/** Webhook inbound that is always default-deny: the runtime ignores a stored open_legacy mode for these. */
const FORCED_WEBHOOK_INBOUND_KEYS = new Set(["qqbot", "wecom"]);

export function withGuidedJourney(runtime: ChannelSetupRuntimeDefinition): ChannelSetupRuntimeDefinition {
  const key = runtime.definition.catalog.key;
  const profile = POSTURE[key];
  if (!profile) return runtime;
  const steps: ChannelSetupStepDefinition[] = [];
  for (const step of runtime.definition.wizard.steps) {
    if (step.fields?.length) {
      const fields = step.fields.map((field): ChannelSetupFieldDefinition => {
        if (key === "imessage" && ["bridgeUrl", "password", "passwordEnv", "defaultHandle"].includes(field.key))
          return {
            ...field,
            required: false,
            visibleWhenFieldEquals: { fieldKey: "bridgeProvider", value: "bluebubbles" },
          };
        if (key === "whatsapp" && field.key === "phoneNumberId") return { ...field, inputMode: "numeric" };
        if (field.key === "targets")
          return { ...field, type: "target-list", targetAddressKey: key === "telegram" ? "chatId" : "channel" };
        if (key === "discord" && ["defaultChannelId", "defaultGuildId"].includes(field.key))
          return {
            ...field,
            required: false,
            inputMode: "numeric",
            visibleWhenFieldEquals: { fieldKey: "guildPolicy", value: "allowlist" },
          };
        return {
          ...field,
          ...(ADVANCED_KEYS.has(field.key) || field.label.startsWith("Legacy") ? { advanced: true } : {}),
          ...(runtime.definition.adapter.secretFieldKeys.includes(field.key) ? { required: false } : {}),
        };
      });
      const identity = fields.filter((field) => !DESTINATION_KEYS.has(field.key));
      const destinations = fields.filter((field) => DESTINATION_KEYS.has(field.key));
      const alternatives = runtime.definition.adapter.secretFieldKeys
        .filter((fieldKey) => identity.some((field) => field.key === fieldKey))
        .map((fieldKey) => [fieldKey, fieldKey + "Env"])
        .filter((group) => group.some((fieldKey) => identity.some((field) => field.key === fieldKey)));
      if (identity.length)
        steps.push({
          ...step,
          id: step.id + "-identity",
          stage: "identity",
          title: "Connect the account",
          fields: identity,
          requiredAnyOf: credentialAlternatives(key, alternatives),
        });
      if (destinations.length)
        steps.push({
          ...step,
          id: step.id + "-destinations",
          stage: "destinations_access",
          title: "Choose destinations and access",
          fields: destinations,
        });
      continue;
    }
    steps.push({
      ...step,
      stage: step.kind === "test" ? "checks" : step.kind === "confirm" ? "activation" : "prerequisites",
    });
  }
  if (GUIDED_INBOUND_CHANNELS.has(key)) {
    const insertAt = Math.max(
      0,
      steps.findIndex((step) => step.stage === "checks"),
    );
    steps.splice(insertAt, 0, {
      id: "sender-access",
      kind: "field-collection",
      stage: "destinations_access",
      title: "Who may message this bot?",
      body: [
        {
          kind: "paragraph",
          text: "Sender identities control who can start a conversation. Destination selection only chooses where messages are delivered. An empty sender list blocks all inbound conversations.",
        },
      ],
      fields: [
        {
          key: "inboundAccessMode",
          label: "Inbound access",
          type: "select",
          required: true,
          defaultValue: "allowlist",
          explanation:
            "Keep allowlist for controlled access. Existing open legacy connections keep their posture until you deliberately change it.",
          options: FORCED_ALLOWLIST_INBOUND_CHANNELS.has(key)
            ? [{ value: "allowlist", label: "Only allowed senders" }]
            : [
                { value: "allowlist", label: "Only allowed senders" },
                { value: "open_legacy", label: "Open legacy access (advanced)" },
              ],
        },
        {
          key: "allowedSenders",
          label: "Allowed sender identities",
          type: "sender-list",
          required: false,
          explanation:
            key === "telegram"
              ? "Telegram pairing approval adds the approved user here. A destination chat ID is not permission to message the bot."
              : key === "google-chat"
                ? "Chat app mode only: add Google Chat user resource names such as users/123456789. Webhook mode never receives messages. Empty means every inbound sender is denied."
                : key === "qqbot"
                  ? "Add the QQ openids (the ids QQ assigns to senders, not QQ numbers) that may start conversations. Inbound is default-deny; empty means every inbound sender is denied."
                  : key === "wecom"
                    ? "Add the WeCom userids that may start conversations. Inbound is default-deny; empty means every inbound sender is denied."
                    : "Add trusted platform actor IDs. Empty means every inbound sender is denied.",
          visibleWhenFieldEquals: { fieldKey: "inboundAccessMode", value: "allowlist" },
        },
      ],
    });
  }
  steps.push({
    id: "first-message",
    kind: "instruction",
    stage: "first_message",
    title: GUIDED_INBOUND_CHANNELS.has(key) || key === "discord" ? "Verify the first conversation" : "Confirm delivery",
    body: [{ kind: "paragraph", text: profile.firstMessage }],
  });
  return {
    ...runtime,
    definition: {
      ...runtime.definition,
      wizard: {
        ...runtime.definition.wizard,
        contentVersion: runtime.definition.wizard.contentVersion + ".guided-2026-10",
        introSummary: profile.summary,
        prerequisites: profile.prerequisites,
        steps,
      },
    },
    hydrate(connection) {
      const hydrated = runtime.hydrate(connection);
      return {
        ...hydrated,
        draft: { ...hydrated.draft, ...hydrateGuidedChannelInboundAccess(key, connection.config) },
      };
    },
    normalize(draft) {
      const normalized = {
        ...runtime.normalize(draft),
        ...normalizeGuidedChannelInboundAccess(key, draft, draft.hydration?.rawLegacyConfig ?? {}),
      };
      // Stream and Google Chat app inbound are new for a connection, so a hydrated open_legacy mode must not carry over.
      return normalized.inboundStreamEnabled === true ||
        normalized.receiveEvents === true ||
        FORCED_WEBHOOK_INBOUND_KEYS.has(key) ||
        (key === "google-chat" && Boolean(normalized.serviceAccountKeyEnv ?? normalized.serviceAccountKey))
        ? { ...normalized, inboundAccessMode: "allowlist" }
        : normalized;
    },
    validate(draft) {
      const issues = runtime.validate(draft);
      try {
        normalizeGuidedChannelInboundAccess(key, draft, draft.hydration?.rawLegacyConfig ?? {});
      } catch {
        issues.push({
          key: "sender_policy_invalid",
          fieldKey: "allowedSenders",
          level: "error",
          message: "Choose a valid inbound access mode and sender list.",
          failureCategory: "malformed_value",
        });
      }
      return issues;
    },
  };
}

function credentialAlternatives(key: string, alternatives: string[][]): string[][] | undefined {
  if (key === "slack") return [["slackInstallId", "botToken", "botTokenEnv", "webhookUrl", "webhookUrlEnv"]];
  if (key === "discord") return [["botToken", "botTokenEnv", "webhookUrl", "webhookUrlEnv"]];
  if (key === "google-chat") return [["webhookUrl", "webhookUrlEnv", "serviceAccountKeyEnv"]];
  // Photon is inspectable metadata; its unavailable callable adapter must not
  // prompt for an unrelated BlueBubbles password. Backend validation owns it.
  if (key === "imessage") return undefined;
  return alternatives.length ? [alternatives[0]!] : undefined;
}
