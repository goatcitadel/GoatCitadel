import type { ChannelSetupFieldDefinition, ChannelSetupStepDefinition } from "@goatcitadel/contracts";
import { GUIDED_INBOUND_CHANNELS, hydrateGuidedChannelInboundAccess, normalizeGuidedChannelInboundAccess } from "../channel-setup-inbound-access.js";
import type { ChannelSetupRuntimeDefinition } from "./common.js";

const POSTURE: Record<string, { summary: string; prerequisites: string[]; firstMessage: string }> = {
  discord: { summary: "Connect an online Discord bot for paired direct messages or an allowlisted server channel.", prerequisites: ["A Discord application with a bot token and Message Content Intent enabled.", "For server messages, permission to install the bot and grant View Channel, Send Messages and Read Message History in the chosen channel."], firstMessage: "Wait for the saved Gateway connection to become ready. For server setup, mention the bot in the chosen channel. For direct messages, send a DM, approve the pending pairing, then send another message and confirm its reply." },
  slack: { summary: "Connect a Slack workspace bot, choose channels, and optionally enable verified inbound conversations.", prerequisites: ["Permission to install a Slack app in the intended workspace.", "Bot scopes for the actions you need and an invitation to the selected channels.", "A reachable HTTPS Gateway URL and Slack signing secret for Events API conversations."], firstMessage: "Register the connection webhook URL in Slack Events, enable message events, and allow your Slack user ID. Send a message from that user in a selected channel and confirm the reply. A webhook fallback remains a notification destination." },
  telegram: { summary: "Connect a BotFather bot, select Telegram destinations, and authorize users for webhook conversations.", prerequisites: ["A BotFather bot token and access to each intended chat.", "The bot added to each destination and permitted to post.", "A reachable HTTPS Gateway URL and webhook secret for inbound conversations."], firstMessage: "Register the saved connection webhook URL with the same secret token. Send the bot a message, approve its pairing request, then send another message and confirm its reply. Destination discovery does not authorize users." },
  ntfy: { summary: "Publish outbound notifications to an ntfy topic. This adapter does not receive conversations.", prerequisites: ["A reachable ntfy server and topic you control.", "Subscribe to that exact topic on a device before testing.", "For protected topics, an environment variable holding an authorized publish token."], firstMessage: "Run a publish test and confirm receipt on the subscribed device. Dry-run validates configuration without publishing; it cannot establish delivery proof." },
  "google-chat": { summary: "Send outbound cards and notifications into a Google Chat Space through its webhook.", prerequisites: ["Permission to create an incoming webhook in the intended Google Chat Space.", "The complete webhook URL, treated as a credential."], firstMessage: "Confirm the test card appears in the selected Space and thread. This webhook adapter cannot accept an inbound conversation." },
  teams: { summary: "Send outbound Adaptive Cards to a Microsoft Teams webhook destination.", prerequisites: ["A Teams Workflows webhook with Anyone trigger authentication; tenant-only Microsoft Entra triggers are unsupported.", "A workflow owner and co-owner who can maintain its Teams connection.", "Permission to post Adaptive Cards in the chosen channel and confirm a live sandbox card. Retired Office 365 connector URLs must be replaced."], firstMessage: "Confirm the sandbox card appears in the intended Teams channel. This adapter sends notifications; it does not install a conversational Teams bot." },
  whatsapp: { summary: "Connect WhatsApp Business Cloud API with a sender identity and optional signed inbound webhooks.", prerequisites: ["A Meta app and WhatsApp Business Cloud API sender with an access token and phone-number ID.", "A recipient permitted by the current Cloud API messaging rules.", "For inbound conversations, a public HTTPS endpoint, app secret and webhook verify token."], firstMessage: "Register the saved connection webhook URL in Meta, complete its verification challenge, and subscribe to messages. Allow trusted wa_id sender values (digits only), send an inbound message and confirm its reply. Personal WhatsApp QR linking is not supported by this adapter." },
  signal: { summary: "Use an outbound-only Signal adapter through a separately configured bridge.", prerequisites: ["A reachable Signal JSON-RPC bridge with an already linked sender account.", "The recipient or group identifier and permission to send to it."], firstMessage: "Confirm the sandbox message arrives in Signal. Inbound receive is deliberately unavailable until the bridge provides durable acknowledgement and replay; linking a device does not enable conversations in GoatCitadel." },
  mattermost: { summary: "Send outbound Mattermost posts, replies and files through a bot account.", prerequisites: ["A reachable Mattermost server and bot token.", "The bot joined to the intended team/channel, with posting permissions."], firstMessage: "Confirm the test post arrives in the chosen channel. This adapter has outbound actions but no inbound conversation transport." },
  imessage: { summary: "Use a reachable BlueBubbles Mac bridge for outbound iMessage delivery.", prerequisites: ["A Mac running a callable BlueBubbles bridge and its password.", "An existing chat or supported new-handle chat creation.", "Private API support when you need reactions or unsend."], firstMessage: "Confirm the message arrives in Messages. Reactions and unsend depend on Private API support. Photon/Spectrum remains diagnostics-only in this build; selecting it does not install a callable adapter." },
  "nextcloud-talk": { summary: "Connect a Nextcloud Talk bot with signed inbound events and outbound replies.", prerequisites: ["A reachable Nextcloud Talk instance with bot API support.", "A registered bot, shared signing token and room membership.", "A public HTTPS Gateway webhook endpoint for signed inbound messages."], firstMessage: "Register the saved connection webhook URL with the same shared token, allow your Nextcloud actor ID, and send a room message. Confirm its reply; attachments and unsend are not supported." },
  line: { summary: "Connect a LINE Messaging API bot with optional signed webhook conversations.", prerequisites: ["A LINE Messaging API channel and channel access token.", "The bot added to the intended user, room or group.", "For inbound messages, a channel secret and reachable HTTPS Gateway webhook endpoint."], firstMessage: "Enable webhooks in LINE and register the saved connection URL. Allow the sender actor ID separately from the destination user/group/room ID, send an inbound message, and confirm its reply." },
  zalo: { summary: "Send outbound messages from a Zalo Official Account to eligible recipients.", prerequisites: ["An authorized Zalo Official Account access token.", "The recipient OA user ID and eligibility to receive messages."], firstMessage: "Confirm the sandbox message arrives at the intended OA recipient. This narrow outbound adapter does not receive conversations." },
  zalouser: { summary: "Send outbound messages through an authenticated zca personal-session bridge.", prerequisites: ["A reachable authenticated zca bridge and its bearer credential.", "An already linked profile and intended personal-session recipient or group."], firstMessage: "Confirm the sandbox text arrives from the expected profile. Rich media uses URL-backed attachments; inbound conversations are unavailable. Authentication is required for the supported bridge posture." },
};
const DESTINATION_KEYS = new Set(["targets", "defaultChannel", "defaultChannelId", "defaultChatId", "defaultGuildId", "defaultTarget", "defaultRecipient", "defaultRecipientId", "defaultHandle", "defaultRoomId", "topic", "defaultTeam", "inboundDmPolicy", "guildPolicy"]);
const ADVANCED_KEYS = new Set(["defaultThreadTs", "defaultThreadKey", "parseMode", "voiceReplyMode", "cardTitle", "priority", "dryRun", "setupCode", "profile", "photonSidecarUrl", "photonAuthEnv"]);

export function withGuidedJourney(runtime: ChannelSetupRuntimeDefinition): ChannelSetupRuntimeDefinition {
  const key = runtime.definition.catalog.key;
  const profile = POSTURE[key];
  if (!profile) return runtime;
  const steps: ChannelSetupStepDefinition[] = [];
  for (const step of runtime.definition.wizard.steps) {
    if (step.fields?.length) {
      const fields = step.fields.map((field): ChannelSetupFieldDefinition => {
        if (key === "imessage" && ["bridgeUrl", "password", "passwordEnv", "defaultHandle"].includes(field.key)) return { ...field, required: false, visibleWhenFieldEquals: { fieldKey: "bridgeProvider", value: "bluebubbles" } };
        if (key === "whatsapp" && field.key === "phoneNumberId") return { ...field, inputMode: "numeric" };
        if (field.key === "targets") return { ...field, type: "target-list", targetAddressKey: key === "telegram" ? "chatId" : "channel" };
        if (key === "discord" && ["defaultChannelId", "defaultGuildId"].includes(field.key)) return { ...field, required: false, inputMode: "numeric", visibleWhenFieldEquals: { fieldKey: "guildPolicy", value: "allowlist" } };
        return { ...field, ...(ADVANCED_KEYS.has(field.key) || field.label.startsWith("Legacy") ? { advanced: true } : {}), ...(runtime.definition.adapter.secretFieldKeys.includes(field.key) ? { required: false } : {}) };
      });
      const identity = fields.filter((field) => !DESTINATION_KEYS.has(field.key));
      const destinations = fields.filter((field) => DESTINATION_KEYS.has(field.key));
      const alternatives = runtime.definition.adapter.secretFieldKeys.filter((fieldKey) => identity.some((field) => field.key === fieldKey)).map((fieldKey) => [fieldKey, fieldKey + "Env"]).filter((group) => group.some((fieldKey) => identity.some((field) => field.key === fieldKey)));
      if (identity.length) steps.push({ ...step, id: step.id + "-identity", stage: "identity", title: "Connect the account", fields: identity, requiredAnyOf: credentialAlternatives(key, alternatives) });
      if (destinations.length) steps.push({ ...step, id: step.id + "-destinations", stage: "destinations_access", title: "Choose destinations and access", fields: destinations });
      continue;
    }
    steps.push({ ...step, stage: step.kind === "test" ? "checks" : step.kind === "confirm" ? "activation" : "prerequisites" });
  }
  if (GUIDED_INBOUND_CHANNELS.has(key)) {
    const insertAt = Math.max(0, steps.findIndex((step) => step.stage === "checks"));
    steps.splice(insertAt, 0, {
      id: "sender-access", kind: "field-collection", stage: "destinations_access", title: "Who may message this bot?",
      body: [{ kind: "paragraph", text: "Sender identities control who can start a conversation. Destination selection only chooses where messages are delivered. An empty sender list blocks all inbound conversations." }],
      fields: [{ key: "inboundAccessMode", label: "Inbound access", type: "select", required: true, defaultValue: "allowlist", explanation: "Keep allowlist for controlled access. Existing open legacy connections keep their posture until you deliberately change it.", options: [{ value: "allowlist", label: "Only allowed senders" }, { value: "open_legacy", label: "Open legacy access (advanced)" }] }, { key: "allowedSenders", label: "Allowed sender identities", type: "sender-list", required: false, explanation: key === "telegram" ? "Telegram pairing approval adds the approved user here. A destination chat ID is not permission to message the bot." : "Add trusted platform actor IDs. Empty means every inbound sender is denied.", visibleWhenFieldEquals: { fieldKey: "inboundAccessMode", value: "allowlist" } }],
    });
  }
  steps.push({ id: "first-message", kind: "instruction", stage: "first_message", title: GUIDED_INBOUND_CHANNELS.has(key) || key === "discord" ? "Verify the first conversation" : "Confirm delivery", body: [{ kind: "paragraph", text: profile.firstMessage }] });
  return {
    ...runtime,
    definition: { ...runtime.definition, wizard: { ...runtime.definition.wizard, contentVersion: runtime.definition.wizard.contentVersion + ".guided-2026-10", introSummary: profile.summary, prerequisites: profile.prerequisites, steps } },
    hydrate(connection) { const hydrated = runtime.hydrate(connection); return { ...hydrated, draft: { ...hydrated.draft, ...hydrateGuidedChannelInboundAccess(key, connection.config) } }; },
    normalize(draft) { return { ...runtime.normalize(draft), ...normalizeGuidedChannelInboundAccess(key, draft, draft.hydration?.rawLegacyConfig ?? {}) }; },
    validate(draft) { const issues = runtime.validate(draft); try { normalizeGuidedChannelInboundAccess(key, draft, draft.hydration?.rawLegacyConfig ?? {}); } catch { issues.push({ key: "sender_policy_invalid", fieldKey: "allowedSenders", level: "error", message: "Choose a valid inbound access mode and sender list.", failureCategory: "malformed_value" }); } return issues; },
  };
}

function credentialAlternatives(key: string, alternatives: string[][]): string[][] | undefined {
  if (key === "slack") return [["slackInstallId", "botToken", "botTokenEnv", "webhookUrl", "webhookUrlEnv"]];
  if (key === "discord") return [["botToken", "botTokenEnv", "webhookUrl", "webhookUrlEnv"]];
  // Photon is inspectable metadata; its unavailable callable adapter must not
  // prompt for an unrelated BlueBubbles password. Backend validation owns it.
  if (key === "imessage") return undefined;
  return alternatives.length ? [alternatives[0]!] : undefined;
}
