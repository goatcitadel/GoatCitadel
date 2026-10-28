import type { ChannelSetupHostRule, ChannelSetupInboundWebhook, ChannelSetupPickerHint } from "@goatcitadel/contracts";
import type { ChannelSetupRuntimeDefinition } from "./common.js";

type ChannelPickerHintEntry = Omit<ChannelSetupPickerHint, "order">;
type FrozenHostRule = Readonly<Omit<ChannelSetupHostRule, "whenAnyFieldSet">> & {
  readonly whenAnyFieldSet: readonly string[];
};
type FrozenInboundWebhook = Readonly<Omit<ChannelSetupInboundWebhook, "whenAnyFieldSet">> & {
  readonly whenAnyFieldSet?: readonly string[];
};

/**
 * How each channel appears in the channel picker, keyed by catalog key.
 *
 * Property order is the agreed picker order: groups run quickest, team chat, then phone apps, and
 * each group lists its channels in order. `withPickerHints` turns a channel's position within its
 * group into the hint's `order`, so the order is written once, here. It is not the order of the
 * setup-definitions list, which keeps its own ranking. Only Telegram sets `minutes`; the rest show
 * their wizard's `estimatedMinutes`.
 *
 * Each note must stay within what the channel's `prerequisites` say (see `guided-journey.ts`).
 */
export const CHANNEL_PICKER_HINTS: Readonly<Record<string, ChannelPickerHintEntry>> = Object.freeze({
  telegram: { group: "quickest", minutes: 3 },
  discord: { group: "quickest" },
  ntfy: { group: "quickest", note: "Needs an ntfy topic you control" },
  slack: { group: "quickest", note: "Receiving needs a public web address" },

  mattermost: { group: "team_chat", note: "Needs a Mattermost server" },
  matrix: { group: "team_chat", note: "Needs a Matrix bot account" },
  teams: { group: "team_chat", note: "Sends only" },
  "google-chat": { group: "team_chat", note: "Receiving needs a public web address" },

  whatsapp: { group: "phone_apps", note: "Business account + public web address" },
  line: { group: "phone_apps", note: "Receiving needs a public web address" },
  wecom: { group: "phone_apps", note: "Receiving needs a public web address" },
  qqbot: { group: "phone_apps", note: "Needs a public web address" },
  zalo: { group: "phone_apps", note: "Sends only, from a Zalo Official Account" },
  "nextcloud-talk": { group: "phone_apps", note: "Receiving needs a public web address" },
});

/**
 * Provider hosts a channel must be allowed to reach, keyed by catalog key.
 *
 * Each list comes from the code the channel sends through: `comms-executor.ts`, `qqbot-client.ts`,
 * `wecom-client.ts`, `google-chat-service-account.ts` and the live probes. A channel whose host the
 * operator chooses has no fixed host here; its URL field is in `CHANNEL_HOST_FIELDS` instead.
 */
export const CHANNEL_REQUIRED_HOSTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  telegram: Object.freeze(["api.telegram.org"]),
  discord: Object.freeze(["discord.com"]),
  slack: Object.freeze(["slack.com"]),
  whatsapp: Object.freeze(["graph.facebook.com"]),
  line: Object.freeze(["api.line.me"]),
  zalo: Object.freeze(["openapi.zalo.me"]),
  qqbot: Object.freeze(["bots.qq.com", "api.bot.qq.com"]),
  wecom: Object.freeze(["qyapi.weixin.qq.com"]),
  "google-chat": Object.freeze(["chat.googleapis.com"]),
});

/** Fields holding a URL whose host the channel must be allowed to reach, keyed by catalog key. */
export const CHANNEL_HOST_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  discord: Object.freeze(["webhookUrl"]),
  slack: Object.freeze(["webhookUrl"]),
  "google-chat": Object.freeze(["webhookUrl"]),
  teams: Object.freeze(["webhookUrl"]),
  ntfy: Object.freeze(["baseUrl"]),
  matrix: Object.freeze(["homeserverUrl"]),
  mattermost: Object.freeze(["serverUrl"]),
  "nextcloud-talk": Object.freeze(["baseUrl"]),
});

/**
 * Google Chat runs as a Chat app when a service-account key is given, named by an environment variable the guide asks
 * for or stored as a saved key (which a connection's public config shows as redacted); the channel reads either.
 */
const GOOGLE_CHAT_APP_KEY_FIELDS: readonly string[] = Object.freeze(["serviceAccountKeyEnv", "serviceAccountKey"]);

/** Hosts a channel needs only while certain fields are set, keyed by catalog key. */
export const CHANNEL_CONDITIONAL_HOSTS: Readonly<Record<string, readonly FrozenHostRule[]>> = Object.freeze({
  qqbot: Object.freeze([
    Object.freeze({ host: "sandbox.api.sgroup.qq.com", whenAnyFieldSet: Object.freeze(["sandbox"]), equals: true }),
  ]),
  "google-chat": Object.freeze([
    Object.freeze({ host: "oauth2.googleapis.com", whenAnyFieldSet: GOOGLE_CHAT_APP_KEY_FIELDS }),
  ]),
});

function inboundWebhookRoute(key: string): string {
  return `/api/v1/integrations/connections/{connectionId}/${key}/webhook`;
}

/**
 * Channels that receive on a Gateway webhook route (`routes/integration-webhooks-<key>-routes.ts`),
 * keyed by catalog key. Telegram receives on a webhook only when its receive mode is `webhook`.
 * Google Chat receives only in Chat app mode, which is when a service-account key is given; its
 * webhook mode only sends.
 */
export const CHANNEL_INBOUND_WEBHOOKS: Readonly<Record<string, FrozenInboundWebhook>> = Object.freeze({
  telegram: Object.freeze({
    pathTemplate: inboundWebhookRoute("telegram"),
    whenFieldEquals: Object.freeze({ fieldKey: "receiveMode", value: "webhook" }),
  }),
  slack: Object.freeze({ pathTemplate: inboundWebhookRoute("slack") }),
  whatsapp: Object.freeze({ pathTemplate: inboundWebhookRoute("whatsapp") }),
  line: Object.freeze({ pathTemplate: inboundWebhookRoute("line") }),
  qqbot: Object.freeze({ pathTemplate: inboundWebhookRoute("qqbot") }),
  wecom: Object.freeze({ pathTemplate: inboundWebhookRoute("wecom") }),
  "google-chat": Object.freeze({
    pathTemplate: inboundWebhookRoute("google-chat"),
    whenAnyFieldSet: GOOGLE_CHAT_APP_KEY_FIELDS,
  }),
  "nextcloud-talk": Object.freeze({ pathTemplate: inboundWebhookRoute("nextcloud-talk") }),
});

function ownEntry<Value>(table: Readonly<Record<string, Value>>, key: string): Value | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** The channel's picker hint, with `order` set to its position among the earlier channels of the same group. */
function pickerHintFor(key: string): ChannelSetupPickerHint | undefined {
  const hint = Object.hasOwn(CHANNEL_PICKER_HINTS, key) ? CHANNEL_PICKER_HINTS[key] : undefined;
  if (!hint) {
    return undefined;
  }
  const keys = Object.keys(CHANNEL_PICKER_HINTS);
  const order = keys
    .slice(0, keys.indexOf(key))
    .filter((earlierKey) => CHANNEL_PICKER_HINTS[earlierKey]?.group === hint.group).length;
  return { ...hint, order };
}

function copyHostRule(rule: FrozenHostRule): ChannelSetupHostRule {
  return { ...rule, whenAnyFieldSet: [...rule.whenAnyFieldSet] };
}

function copyInboundWebhook(webhook: FrozenInboundWebhook): ChannelSetupInboundWebhook {
  const { whenAnyFieldSet, ...rest } = webhook;
  return {
    ...rest,
    ...(webhook.whenFieldEquals ? { whenFieldEquals: { ...webhook.whenFieldEquals } } : {}),
    ...(whenAnyFieldSet ? { whenAnyFieldSet: [...whenAnyFieldSet] } : {}),
  };
}

/**
 * Returns a copy of the runtime whose definition carries the channel's picker hint, the hosts it
 * reaches and, when it receives on a Gateway route, its inbound webhook path.
 */
export function withPickerHints(runtime: ChannelSetupRuntimeDefinition): ChannelSetupRuntimeDefinition {
  const key = runtime.definition.catalog.key;
  const picker = pickerHintFor(key);
  const requiredHosts = ownEntry(CHANNEL_REQUIRED_HOSTS, key);
  const hostFields = ownEntry(CHANNEL_HOST_FIELDS, key);
  const conditionalHosts = ownEntry(CHANNEL_CONDITIONAL_HOSTS, key);
  const inboundWebhook = ownEntry(CHANNEL_INBOUND_WEBHOOKS, key);
  if (!picker && !requiredHosts && !hostFields && !conditionalHosts && !inboundWebhook) {
    return runtime;
  }
  return {
    ...runtime,
    definition: {
      ...runtime.definition,
      wizard: {
        ...runtime.definition.wizard,
        ...(picker ? { picker } : {}),
        ...(requiredHosts ? { requiredHosts: [...requiredHosts] } : {}),
        ...(hostFields ? { hostFields: [...hostFields] } : {}),
        ...(conditionalHosts ? { conditionalHosts: conditionalHosts.map(copyHostRule) } : {}),
        ...(inboundWebhook ? { inboundWebhook: copyInboundWebhook(inboundWebhook) } : {}),
      },
    },
  };
}
