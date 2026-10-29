import type {
  ChannelSetupHostRule,
  ChannelSetupInboundWebhook,
  ChannelSetupPickerHint,
  IntegrationConnection,
} from "@goatcitadel/contracts";
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
 * setup-definitions list, which keeps its own ranking. A tile sets `minutes` when its Chat page takes a
 * different time than the wizard's `estimatedMinutes`; the rest show their wizard's `estimatedMinutes`.
 *
 * Each note must stay within what the channel's `prerequisites` say (see `guided-journey.ts`).
 */
export const CHANNEL_PICKER_HINTS: Readonly<Record<string, ChannelPickerHintEntry>> = Object.freeze({
  telegram: { group: "quickest", minutes: 3 },
  discord: { group: "quickest", minutes: 5 },
  ntfy: { group: "quickest", note: "Needs an ntfy topic you control" },
  slack: { group: "quickest", minutes: 5 },

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
 * operator chooses has no fixed host here; its URL field is in `CHANNEL_HOST_FIELDS` instead. Slack has
 * none either: its API host only matters with a bot token or an app-level token, so it is in
 * `CHANNEL_CONDITIONAL_HOSTS`.
 */
export const CHANNEL_REQUIRED_HOSTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  telegram: Object.freeze(["api.telegram.org"]),
  discord: Object.freeze(["discord.com"]),
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
 * A saved Google Chat connection is a Chat app when it holds a service-account key, named by an environment variable
 * or stored as a saved key (which a connection's public config shows as redacted); the channel reads either. The
 * connection keeps no mode of its own, so a saved connection's webhook address follows these keys. The audience is
 * listed too: a Chat app always has one, and unlike a pasted key it is also in the setup wizard's own values.
 */
const GOOGLE_CHAT_APP_FIELDS: readonly string[] = Object.freeze([
  "serviceAccountKeyEnv",
  "serviceAccountKey",
  "audience",
]);

/**
 * Hosts a channel needs only while certain fields are set, keyed by catalog key. Google's token host follows the
 * guide's "Connect with" choice, which the setup wizard always holds (an edit draft derives it from the saved keys), so
 * a key left behind after switching back to an incoming webhook does not ask for it. Slack's API host follows its bot
 * token (pasted, or from an OAuth install) or its app-level token (Socket Mode asks Slack for its connection address
 * with it): an incoming webhook posts to its own address and never contacts it.
 */
export const CHANNEL_CONDITIONAL_HOSTS: Readonly<Record<string, readonly FrozenHostRule[]>> = Object.freeze({
  slack: Object.freeze([
    Object.freeze({
      host: "slack.com",
      whenAnyFieldSet: Object.freeze(["botToken", "slackInstallId", "appToken", "appTokenEnv"]),
    }),
  ]),
  qqbot: Object.freeze([
    Object.freeze({ host: "sandbox.api.sgroup.qq.com", whenAnyFieldSet: Object.freeze(["sandbox"]), equals: true }),
  ]),
  "google-chat": Object.freeze([
    Object.freeze({ host: "oauth2.googleapis.com", whenAnyFieldSet: Object.freeze(["mode"]), equals: "app" }),
  ]),
});

function inboundWebhookRoute(key: string): string {
  return `/api/v1/integrations/connections/{connectionId}/${key}/webhook`;
}

/**
 * Channels that receive on a Gateway webhook route (`routes/integration-webhooks-<key>-routes.ts`),
 * keyed by catalog key. Telegram and Slack receive on a webhook only when their receive mode is `webhook`
 * (Slack's other mode keeps a connection open to Slack and needs no address).
 * Google Chat receives only in Chat app mode, which is when a service-account key is given; its
 * webhook mode only sends. A saved connection has no mode, only its keys, so this rule reads the keys.
 */
export const CHANNEL_INBOUND_WEBHOOKS: Readonly<Record<string, FrozenInboundWebhook>> = Object.freeze({
  telegram: Object.freeze({
    pathTemplate: inboundWebhookRoute("telegram"),
    whenFieldEquals: Object.freeze({ fieldKey: "receiveMode", value: "webhook" }),
  }),
  slack: Object.freeze({
    pathTemplate: inboundWebhookRoute("slack"),
    whenFieldEquals: Object.freeze({ fieldKey: "receiveMode", value: "webhook" }),
  }),
  whatsapp: Object.freeze({ pathTemplate: inboundWebhookRoute("whatsapp") }),
  line: Object.freeze({ pathTemplate: inboundWebhookRoute("line") }),
  qqbot: Object.freeze({ pathTemplate: inboundWebhookRoute("qqbot") }),
  wecom: Object.freeze({ pathTemplate: inboundWebhookRoute("wecom") }),
  "google-chat": Object.freeze({
    pathTemplate: inboundWebhookRoute("google-chat"),
    whenAnyFieldSet: GOOGLE_CHAT_APP_FIELDS,
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

/** Whether the guide counts a field as filled in (`hasFieldValue` in Mission Control's `channel-wizard-model.ts`). */
function isFieldFilled(value: unknown, savedState: string | undefined): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value);
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return savedState === "configured";
}

/**
 * The fixed provider hosts a saved connection needs: the guide's `requiredHosts`, then the `conditionalHosts` whose
 * condition holds. It is what Mission Control's `channelHosts` offers on the "Allow these hosts" button for the draft
 * the Gateway makes of this connection, minus the hosts of address fields, which the connection's URL check reports.
 * The conditions read the draft the guide's own `hydrate` makes (that is where Google Chat's mode and QQ's Test mode
 * come from), with the same defaults and the same idea of a filled field as the guide.
 */
export function connectionFixedHosts(
  runtime: ChannelSetupRuntimeDefinition,
  connection: IntegrationConnection,
): string[] {
  const { requiredHosts = [], conditionalHosts = [], steps } = runtime.definition.wizard;
  if (requiredHosts.length === 0 && conditionalHosts.length === 0) return [];
  const { draft, hydration } = runtime.hydrate(connection);
  const defaults = steps.flatMap((step) => step.fields ?? []).filter((field) => field.defaultValue !== undefined);
  // A value the guide leaves undefined is absent in the draft Mission Control receives, so it can't hide a default.
  const values: Record<string, unknown> = {
    ...Object.fromEntries(defaults.map((field) => [field.key, field.defaultValue])),
    ...Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== undefined)),
  };
  const holds = (rule: ChannelSetupHostRule) =>
    rule.whenAnyFieldSet.some(
      (key) =>
        isFieldFilled(values[key], hydration.fieldState[key]) &&
        (rule.equals === undefined || values[key] === rule.equals),
    );
  return [...new Set([...requiredHosts, ...conditionalHosts.filter(holds).map((rule) => rule.host)])];
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
