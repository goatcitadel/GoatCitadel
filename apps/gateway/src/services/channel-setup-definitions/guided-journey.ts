import type {
  ChannelSetupFieldDefinition,
  ChannelSetupStage,
  ChannelSetupStepDefinition,
} from "@goatcitadel/contracts";
import {
  GUIDED_INBOUND_CHANNELS,
  FORCED_ALLOWLIST_INBOUND_CHANNELS,
  hydrateGuidedChannelInboundAccess,
  normalizeGuidedChannelInboundAccess,
} from "../channel-setup-inbound-access.js";
import {
  PASTED_SECRET_EXPLANATION,
  plainSecretLabel,
  secretEnvFieldCopy,
  type ChannelSetupRuntimeDefinition,
} from "./common.js";

const POSTURE: Record<string, { summary: string; prerequisites: string[]; firstMessage: string }> = {
  discord: {
    summary:
      "Chat with your Discord bot in direct messages, or let it answer in one server channel when mentioned. No public web address is needed.",
    prerequisites: [
      "A Discord application with a bot. Turn on Message Content Intent on its Bot page.",
      "To use it in a server: permission to add the bot, and View Channel, Send Messages and Read Message History in that channel.",
    ],
    firstMessage:
      "Wait until the connection shows ready. In a server, mention the bot in the chosen channel. For a direct message, send one, approve the pairing request in Settings › Channels › this connection › Connection operations, then send another and check the reply.",
  },
  slack: {
    summary:
      "Send messages from your own Slack app into the channels you choose. Receiving messages needs an app installed with OAuth and a public HTTPS address.",
    prerequisites: [
      "Your own Slack app with the chat:write scope, installed to your workspace.",
      "The bot invited to each private channel (/invite @your-app).",
      "To receive messages: an OAuth install from here with message history scopes, and a public HTTPS address for this Gateway.",
    ],
    firstMessage:
      "With a bot token, check that the test passed. With only an incoming webhook, check that the test post arrived in the channel. To receive messages (OAuth installs only): in your Slack app open Event Subscriptions, paste this connection's webhook address, subscribe to message events, and allow your Slack member ID under Who may message this bot.",
  },
  telegram: {
    summary:
      "Change a Telegram channel that's already on: use its bot in groups or channels, choose who can message it, and how its messages arrive. A new bot is set up in Chat › Messaging.",
    prerequisites: [
      "A Telegram channel that's already on. To add a new bot, go to Chat › Messaging and choose Add.",
      "For a group or channel: permission to add the bot there.",
      "A public HTTPS address only if you choose web-address delivery.",
    ],
    firstMessage:
      "Send the bot a message from an allowed account and check that it answers. Someone not yet allowed gets a pairing request to approve in GoatCitadel. With web-address delivery, first register the connection's webhook URL with the same secret token. Finding a chat doesn't let anyone in it message the bot.",
  },
  ntfy: {
    summary:
      "Send notifications to an ntfy topic. Optionally, messages posted to a topic can start conversations; only do that on a topic nobody else can post to. No public web address is needed.",
    prerequisites: [
      "An ntfy server (ntfy.sh or your own) and a topic name.",
      "The ntfy app subscribed to that topic, to see the test.",
      "To receive: an access token that can read the topic.",
    ],
    firstMessage:
      "If dry run is off, check the test notification arrived. If dry run is on, nothing was sent: turn it off in Edit setup and test again. To receive: post to the subscribe topic from another device and check the reply.",
  },
  "google-chat": {
    summary:
      "Incoming webhook: send messages into one Google Chat space (sends only). Chat app: send and receive, with a Google Cloud project and a public HTTPS address.",
    prerequisites: [
      "Incoming webhook: a Google Workspace Business or Enterprise account and permission to add webhooks to the space.",
      "Chat app: a Google Cloud project with the Chat API on, a service account key, and a public HTTPS address for this Gateway.",
      "Chat app: the Google user ids (users/…) allowed to message it.",
    ],
    firstMessage:
      "Incoming webhook: check the test message appeared in the space. Chat app: paste this connection's webhook address into the Chat app's HTTP endpoint URL, allow your users/… id, then message the app and check the reply.",
  },
  teams: {
    summary:
      "Post cards to a Microsoft Teams channel through a Workflows webhook. Sends only: Teams can't message GoatCitadel. No public web address is needed.",
    prerequisites: [
      "A Teams Workflows webhook whose trigger allows Anyone. Tenant-only triggers don't work.",
      "A co-owner on the workflow is recommended.",
      "Old Office 365 connector URLs stopped working in May 2026; make a new Workflows webhook.",
    ],
    firstMessage:
      "Check the test card appeared in the channel. If it didn't, open the workflow's run history in Teams.",
  },
  whatsapp: {
    summary:
      "Send WhatsApp messages from a WhatsApp Business number through Meta's Cloud API. Receiving messages needs a public HTTPS address. Personal WhatsApp (QR code linking) isn't supported.",
    prerequisites: [
      "A Meta app with WhatsApp set up, its phone number ID, and a permanent System User access token.",
      "The recipient messages your business number first; WhatsApp delivers the plain-text test only in the 24 hours after that.",
      "To receive messages: a public HTTPS address with a trusted certificate, the app secret, and a verify token you choose.",
    ],
    firstMessage:
      "Check the test message arrived. To receive: in Meta's App Dashboard open WhatsApp › Configuration, paste this connection's webhook address and your verify token, verify, and subscribe to messages. Allow your number (digits only, no plus) under Who may message this bot, then send a message and check the reply.",
  },
  mattermost: {
    summary:
      "Send and receive Mattermost posts through a bot account. No public web address is needed: GoatCitadel connects out, and only hears posts while it's running.",
    prerequisites: [
      "A bot account and its token. Only a Mattermost system admin can create bots.",
      "The bot added to the team and to each channel it should use.",
      "Your Mattermost server in the hosts GoatCitadel may reach.",
    ],
    firstMessage:
      "Check the test passed. To receive: turn on Receive posts, allow your user ID, post in a channel the bot is in, and check the reply.",
  },
  matrix: {
    summary:
      "Send and receive Matrix messages through a bot account on your homeserver. No public web address is needed: GoatCitadel connects out, and only hears messages while it's running.",
    prerequisites: [
      "A Matrix account for the bot and its access token.",
      "To receive messages or get a test notice: the bot invited to and joined in a room with encryption off. GoatCitadel can't read encrypted rooms and doesn't accept invites.",
      "Your homeserver in the hosts GoatCitadel may reach.",
    ],
    firstMessage:
      "If you set a Default room ID, check the test notice arrived in that room. To receive: turn on Receive messages, allow your Matrix ID (for example @alice:example.com), post in the room, and check the reply.",
  },
  qqbot: {
    summary:
      "Send and receive QQ messages through a QQ Bot Open Platform app. Receiving needs a public HTTPS address on port 443, 8443, 80 or 8080.",
    prerequisites: [
      "The QQ Bot app's AppID and AppSecret.",
      "A public HTTPS address for this Gateway (a reverse proxy or tunnel); GoatCitadel doesn't provide one.",
    ],
    // QQ's approval for group and direct-message events (audit line) is on no QQ page, so it is not claimed here.
    firstMessage:
      "In the QQ Bot console set the callback URL to this connection's webhook address and subscribe to GROUP_AT_MESSAGE_CREATE, C2C_MESSAGE_CREATE, AT_MESSAGE_CREATE and DIRECT_MESSAGE_CREATE. Message the bot once; it won't answer yet. Add your openid (see Who may message this bot) with Edit setup, then message again. GoatCitadel can't show your openid yet, so you need to know it already.",
  },
  wecom: {
    // WeCom's callback page allows http or https and recommends https (developer.work.weixin.qq.com/document/path/90238),
    // so "a public HTTPS address" from the audit is "a public web address (WeCom recommends HTTPS)" here.
    summary:
      "Send and receive WeCom messages through a self-built application. Sending needs this computer's public IP on the app's trusted IP list. Receiving needs a public web address (WeCom recommends HTTPS).",
    prerequisites: [
      "A WeCom self-built application: its CorpID, AgentId and Secret.",
      "This computer's public IP on the app's trusted IP list.",
      "To receive: a public web address (WeCom recommends HTTPS), and the Token and EncodingAESKey from the app's receive messages settings.",
    ],
    // The test sends a message only when a default target is set, so the first check is conditional.
    firstMessage:
      "If you set a default target, check the test message arrived. To receive: in the app's receive messages settings enter this connection's webhook address with the same Token and EncodingAESKey, and save. Allow your WeCom userid, message the app, and check the reply.",
  },
  "nextcloud-talk": {
    summary:
      "Send Nextcloud Talk messages through a Talk bot. Receiving needs an HTTPS address your Nextcloud server can reach.",
    prerequisites: [
      "Shell access to your Nextcloud server, to add a bot with occ.",
      "A bot secret of 40 to 128 characters.",
      "The room token of the conversation the bot should use.",
    ],
    firstMessage:
      "Check the test message arrived. To receive: reinstall the bot with this connection's webhook address and the same secret, turn it on for the room again, allow users/<your user name>, and send a message. Talk sends every message posted in the room to that address, so use only an address you control.",
  },
  line: {
    summary:
      "Send LINE messages from your LINE Official Account. Receiving needs a public HTTPS address. Every message is a push message, which counts toward your plan's monthly limit.",
    prerequisites: [
      "A LINE Official Account with the Messaging API on, and its long-lived channel access token.",
      "Your LINE user ID (Developers Console › your channel › Basic settings).",
      "To receive: a public HTTPS address and the channel secret.",
    ],
    firstMessage:
      "Check the test message arrived. To receive: in LINE Developers Console › Messaging API set Webhook URL to this connection's webhook address, click Verify, turn on Use webhook, and turn off auto-reply and greeting messages in Official Account Manager. Allow your LINE user ID under Who may message this bot.",
  },
  zalo: {
    summary: "Send messages from a Zalo Official Account. Sends only: Zalo can't message GoatCitadel.",
    // The audit says "follows your Official Account and has messaged it recently". Zalo's messages overview states the
    // rule as an interaction in the last 7 days (a message to the Official Account is one) and does not say "follows".
    prerequisites: [
      "A Zalo Official Account access token.",
      "The Zalo user_id of someone who has messaged your Official Account in the last 7 days.",
    ],
    firstMessage: "Check the test message arrived in the recipient's Zalo.",
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
]);
/** A draft value `hydrate` sets when the saved connection was open access. It is never part of the saved config. */
const OPEN_ACCESS_MARKER = "inboundAccessWasOpen";
/** Webhook inbound that is always default-deny: the runtime ignores a stored open_legacy mode for these. */
const FORCED_WEBHOOK_INBOUND_KEYS = new Set(["qqbot", "wecom"]);

export function withGuidedJourney(runtime: ChannelSetupRuntimeDefinition): ChannelSetupRuntimeDefinition {
  const key = runtime.definition.catalog.key;
  const profile = POSTURE[key];
  if (!profile) return runtime;
  const steps: ChannelSetupStepDefinition[] = [];
  const authoredFields = runtime.definition.wizard.steps.flatMap((step) => step.fields ?? []);
  let firstFieldStepSplit = false;
  for (const step of runtime.definition.wizard.steps) {
    if (step.fields?.length) {
      const fields = secretsBeforeTheirVariables(
        step.fields.map((field) => guidedField(runtime, authoredFields, field)),
        runtime.definition.adapter.secretFieldKeys,
      );
      // Only the first field step is the account/destination pair; a later one keeps the id, title and stage it was written with.
      if (firstFieldStepSplit) {
        steps.push({ ...step, fields, stage: step.stage ?? fieldStepStage(fields) });
      } else {
        firstFieldStepSplit = true;
        steps.push(...splitFieldStep(runtime, step, fields));
      }
      continue;
    }
    steps.push({ ...step, stage: step.stage ?? stageForKind(step) });
  }
  if (GUIDED_INBOUND_CHANNELS.has(key)) {
    const insertAt = Math.max(
      0,
      steps.findIndex((step) => step.stage === "checks"),
    );
    steps.splice(insertAt, 0, senderAccessStep(key));
  }
  steps.push({
    id: "first-message",
    kind: "instruction",
    stage: "first_message",
    title: takesConversations(key) ? "Verify the first conversation" : "Confirm delivery",
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
      const access = hydrateGuidedChannelInboundAccess(key, connection.config);
      return {
        ...hydrated,
        draft: {
          ...hydrated.draft,
          ...access,
          // Remembers that the saved connection was open, so the choice to change that stays on screen while it is edited.
          ...(access.inboundAccessMode === "open_legacy" ? { [OPEN_ACCESS_MARKER]: true } : {}),
        },
      };
    },
    normalize(draft) {
      // The marker belongs to the draft only; whatever a guide's own normalizer copies, it never reaches the saved config.
      const { [OPEN_ACCESS_MARKER]: _openAccessMarker, ...normalized } = {
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

/** The wizard's field after the shared rules: expert options, optional secrets, and the secret/variable wording. */
function guidedField(
  runtime: ChannelSetupRuntimeDefinition,
  siblings: readonly ChannelSetupFieldDefinition[],
  field: ChannelSetupFieldDefinition,
): ChannelSetupFieldDefinition {
  const key = runtime.definition.catalog.key;
  const secretKeys = runtime.definition.adapter.secretFieldKeys;
  if (key === "whatsapp" && field.key === "phoneNumberId") return { ...field, inputMode: "numeric" };
  if (field.key === "targets")
    return { ...field, type: "target-list", targetAddressKey: key === "telegram" ? "chatId" : "channel" };
  // Both ids are required while the bot listens in a server channel; a direct-message setup hides them and is not asked.
  if (key === "discord" && ["defaultChannelId", "defaultGuildId"].includes(field.key))
    return {
      ...field,
      inputMode: "numeric",
      visibleWhenFieldEquals: { fieldKey: "guildPolicy", value: "allowlist" },
    };
  const shared: ChannelSetupFieldDefinition = {
    ...field,
    ...(ADVANCED_KEYS.has(field.key) || field.label.startsWith("Legacy") ? { advanced: true } : {}),
    ...(secretKeys.includes(field.key) ? { required: false } : {}),
  };
  const secretOfVariable = field.key.endsWith("Env") ? field.key.slice(0, -"Env".length) : undefined;
  if (secretOfVariable && secretKeys.includes(secretOfVariable)) {
    // A variable name is the expert way to give a secret; the pasted field beside it is the main one.
    return {
      ...shared,
      ...secretEnvFieldCopy(
        key,
        field,
        siblings.find((item) => item.key === secretOfVariable),
      ),
    };
  }
  if (secretKeys.includes(field.key) && siblings.some((item) => item.key === `${field.key}Env`)) {
    const { placeholder: _placeholder, ...pasted } = shared;
    return { ...pasted, label: plainSecretLabel(field.label), explanation: PASTED_SECRET_EXPLANATION };
  }
  return shared;
}

/** Puts each pasted secret ahead of the field that names its environment variable, leaving other fields where they were. */
function secretsBeforeTheirVariables(
  fields: ChannelSetupFieldDefinition[],
  secretKeys: readonly string[],
): ChannelSetupFieldDefinition[] {
  const indexOf = new Map(fields.map((field, index) => [field.key, index]));
  const lateSecrets = new Map<ChannelSetupFieldDefinition, ChannelSetupFieldDefinition>();
  fields.forEach((field, index) => {
    if (!field.key.endsWith("Env")) return;
    const secretKey = field.key.slice(0, -"Env".length);
    const secretIndex = indexOf.get(secretKey);
    if (secretIndex === undefined || secretIndex < index || !secretKeys.includes(secretKey)) return;
    const secret = fields[secretIndex];
    if (secret) lateSecrets.set(field, secret);
  });
  const moved = new Set(lateSecrets.values());
  return fields.flatMap((field) => {
    if (moved.has(field)) return [];
    const secret = lateSecrets.get(field);
    return secret ? [secret, field] : [field];
  });
}

/** The account half and the destinations half of a guide's first field step, each keeping the step's other settings. */
function splitFieldStep(
  runtime: ChannelSetupRuntimeDefinition,
  step: ChannelSetupStepDefinition,
  fields: ChannelSetupFieldDefinition[],
): ChannelSetupStepDefinition[] {
  const key = runtime.definition.catalog.key;
  const identity = fields.filter((field) => !DESTINATION_KEYS.has(field.key));
  const destinations = fields.filter((field) => DESTINATION_KEYS.has(field.key));
  const alternatives = runtime.definition.adapter.secretFieldKeys
    .filter((fieldKey) => identity.some((field) => field.key === fieldKey))
    .map((fieldKey) => [fieldKey, fieldKey + "Env"])
    .filter((group) => group.some((fieldKey) => identity.some((field) => field.key === fieldKey)));
  const halves: ChannelSetupStepDefinition[] = [];
  if (identity.length)
    halves.push({
      ...step,
      id: step.id + "-identity",
      stage: "identity",
      title: "Connect the account",
      fields: identity,
      requiredAnyOf: credentialAlternatives(key, alternatives),
    });
  if (destinations.length) {
    const shownWhen = sharedVisibility(destinations);
    halves.push({
      ...step,
      id: step.id + "-destinations",
      stage: "destinations_access",
      // A channel people can message has access to choose here; the others only choose where messages go.
      title: takesConversations(key) ? "Choose destinations and access" : "Where should messages go?",
      fields: destinations,
      // A step whose every field is hidden together is hidden too, so nobody clicks through an empty one.
      ...(shownWhen ? { visibleWhenFieldEquals: shownWhen } : {}),
    });
  }
  return halves;
}

/** The one condition every field in the list is shown under, if they all share it. */
function sharedVisibility(
  fields: readonly ChannelSetupFieldDefinition[],
): NonNullable<ChannelSetupFieldDefinition["visibleWhenFieldEquals"]> | undefined {
  const condition = fields[0]?.visibleWhenFieldEquals;
  if (!condition) return undefined;
  const sharesIt = fields.every(
    (field) =>
      field.visibleWhenFieldEquals?.fieldKey === condition.fieldKey &&
      field.visibleWhenFieldEquals.value === condition.value,
  );
  return sharesIt ? { ...condition } : undefined;
}

/**
 * Channels people can message: the ones with a "Who may message this bot?" step, and Discord, which sets that with the
 * direct-message and server policies on its destinations step. Zalo and Teams only send.
 */
function takesConversations(key: string): boolean {
  return GUIDED_INBOUND_CHANNELS.has(key) || key === "discord";
}

/** The stage a step gets when its guide did not set one. */
function stageForKind(step: ChannelSetupStepDefinition): ChannelSetupStage {
  return step.kind === "test" ? "checks" : step.kind === "confirm" ? "activation" : "prerequisites";
}

function fieldStepStage(fields: readonly ChannelSetupFieldDefinition[]): ChannelSetupStage {
  return fields.some((field) => DESTINATION_KEYS.has(field.key)) ? "destinations_access" : "identity";
}

/** Sender identities differ by platform, and matching is exact, so each channel says what its own look like. */
const SENDER_EXPLANATIONS: Readonly<Record<string, string>> = {
  slack: "Your Slack member ID (starts with U).",
  telegram:
    "Telegram pairing approval adds the approved user here. A destination chat ID is not permission to message the bot.",
  whatsapp: "Your WhatsApp number with country code, digits only, no plus (for example 15551234567).",
  line: "Your LINE user ID (starts with U). For a one-to-one chat it is the same ID as Default target.",
  "nextcloud-talk": "users/ followed by your Nextcloud user name, for example users/alice.",
  ntfy: "Added for you as ntfy-topic:<subscribe topic>. If you change the topic later, change this too.",
  mattermost:
    "Mattermost user IDs (26 letters and digits), not usernames. An admin sees them in System Console › User Management › Users.",
  matrix: "Your Matrix ID with the @ and the server, for example @alice:example.com.",
  "google-chat":
    "Chat app mode only: add Google Chat user resource names such as users/123456789. Webhook mode never receives messages. Empty means every inbound sender is denied.",
  qqbot:
    "Add the QQ openids (the ids QQ assigns to senders, not QQ numbers) that may start conversations. Inbound is default-deny; empty means every inbound sender is denied.",
  wecom:
    "Add the WeCom userids that may start conversations. Inbound is default-deny; empty means every inbound sender is denied.",
};
const GENERIC_SENDER_EXPLANATION = "Add trusted platform actor IDs. Empty means every inbound sender is denied.";

/** Receiving here is a switch the operator turns on, so the sender step has nothing to say while it is off. */
const SENDER_STEP_SHOWN_WHEN: Readonly<Record<string, { fieldKey: string; value: string | boolean }>> = {
  ntfy: { fieldKey: "inboundStreamEnabled", value: true },
  matrix: { fieldKey: "inboundStreamEnabled", value: true },
  mattermost: { fieldKey: "inboundStreamEnabled", value: true },
  // An incoming webhook only sends; the Chat app is the half that receives.
  "google-chat": { fieldKey: "mode", value: "app" },
};

function senderAccessStep(key: string): ChannelSetupStepDefinition {
  const forcedAllowlist = FORCED_ALLOWLIST_INBOUND_CHANNELS.has(key);
  const shownWhen = SENDER_STEP_SHOWN_WHEN[key];
  const allowedSenders: ChannelSetupFieldDefinition = {
    key: "allowedSenders",
    label: "Allowed sender identities",
    type: "sender-list",
    required: false,
    explanation: SENDER_EXPLANATIONS[key] ?? GENERIC_SENDER_EXPLANATION,
    // A forced-allowlist channel has no mode to compare against, so its sender list is always shown.
    ...(forcedAllowlist ? {} : { visibleWhenFieldEquals: { fieldKey: "inboundAccessMode", value: "allowlist" } }),
  };
  // The choice only matters to a connection that was saved with open access. Definitions are shared by every draft, so
  // `hydrate` marks such a draft and the choice follows the marker, not the mode being edited: it stays on screen
  // after "Only allowed senders" is picked, and a new draft never sees it.
  const accessMode: ChannelSetupFieldDefinition = {
    key: "inboundAccessMode",
    label: "Inbound access",
    type: "select",
    required: true,
    defaultValue: "allowlist",
    explanation:
      "This connection lets any sender start a conversation. Choose Only allowed senders to limit it to the people you list.",
    options: [
      { value: "allowlist", label: "Only allowed senders" },
      { value: "open_legacy", label: "Open legacy access (advanced)" },
    ],
    visibleWhenFieldEquals: { fieldKey: OPEN_ACCESS_MARKER, value: true },
  };
  return {
    id: "sender-access",
    kind: "field-collection",
    stage: "destinations_access",
    title: "Who may message this bot?",
    ...(shownWhen ? { visibleWhenFieldEquals: { ...shownWhen } } : {}),
    body: [
      {
        kind: "paragraph",
        text: "Sender identities control who can start a conversation. Destination selection only chooses where messages are delivered. An empty sender list blocks all inbound conversations.",
      },
    ],
    fields: forcedAllowlist ? [allowedSenders] : [accessMode, allowedSenders],
  };
}

function credentialAlternatives(key: string, alternatives: string[][]): string[][] | undefined {
  // An ntfy topic can be public, so sending needs no token. Receiving asks for one itself (see ntfy.ts).
  if (key === "ntfy") return undefined;
  // The pasted bot token is the main way in, so a missing-value message names it first.
  if (key === "slack") return [["botToken", "botTokenEnv", "webhookUrl", "webhookUrlEnv", "slackInstallId"]];
  if (key === "discord") return [["botToken", "botTokenEnv", "webhookUrl", "webhookUrlEnv"]];
  if (key === "google-chat") return [["webhookUrl", "webhookUrlEnv", "serviceAccountKey", "serviceAccountKeyEnv"]];
  return alternatives.length ? [alternatives[0]!] : undefined;
}
