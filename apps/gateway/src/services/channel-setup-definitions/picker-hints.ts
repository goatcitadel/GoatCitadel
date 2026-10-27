import type { ChannelSetupPickerHint } from "@goatcitadel/contracts";
import type { ChannelSetupRuntimeDefinition } from "./common.js";

type ChannelPickerHintEntry = Omit<ChannelSetupPickerHint, "order">;

/**
 * How each channel appears in the channel picker, keyed by catalog key.
 *
 * Property order is the agreed picker order: groups run quickest, team chat, then phone apps, and
 * each group lists its channels in order. `withPickerHints` turns a channel's position within its
 * group into the hint's `order`, so the order is written once, here. It is not the order of the
 * setup-definitions list, which keeps its own ranking. `zalouser` is left out on purpose. It is an
 * unofficial personal-session bridge, so the picker never offers it. Only Telegram sets `minutes`;
 * the rest show their wizard's `estimatedMinutes`.
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

  signal: { group: "phone_apps", note: "Needs signal-cli" },
  whatsapp: { group: "phone_apps", note: "Business account + public web address" },
  line: { group: "phone_apps", note: "Receiving needs a public web address" },
  imessage: { group: "phone_apps", note: "Sends only, through BlueBubbles on a Mac" },
  wecom: { group: "phone_apps", note: "Receiving needs a public web address" },
  qqbot: { group: "phone_apps", note: "Needs a public web address" },
  zalo: { group: "phone_apps", note: "Sends only, from a Zalo Official Account" },
  "nextcloud-talk": { group: "phone_apps", note: "Receiving needs a public web address" },
});

/** Provider hosts a channel must be allowed to reach, keyed by catalog key. */
export const CHANNEL_REQUIRED_HOSTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  telegram: Object.freeze(["api.telegram.org"]),
});

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

/** Returns a copy of the runtime whose definition carries the channel's picker hint and required hosts. */
export function withPickerHints(runtime: ChannelSetupRuntimeDefinition): ChannelSetupRuntimeDefinition {
  const key = runtime.definition.catalog.key;
  const picker = pickerHintFor(key);
  const requiredHosts = Object.hasOwn(CHANNEL_REQUIRED_HOSTS, key) ? CHANNEL_REQUIRED_HOSTS[key] : undefined;
  if (!picker && !requiredHosts) {
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
      },
    },
  };
}
