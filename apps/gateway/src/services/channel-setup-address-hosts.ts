import {
  channelAddressHost,
  isChannelAddressHost,
  type ChannelSetupDefinition,
  type ChannelSetupDraft,
} from "@goatcitadel/contracts";
import type { ChannelSetupRuntimeDefinition } from "./channel-setup-definitions/common.js";

/**
 * The hosts of a channel's secret addresses (a Teams, Slack, Discord or Google Chat webhook URL). The secret is the
 * path and query; the host is not, and the Settings hosts check needs it to offer the host. So the host is read once,
 * in memory, when the pasted address arrives, and recorded beside the secret: in the draft's secret state, then, when
 * the draft is finalized, in the connection's config (`webhookUrl` → `webhookUrlHost`). An edit draft gets it back from
 * there. Nothing here reads a saved secret, and the address itself is never kept or logged.
 */

/** The config key a connection records the host of a secret address field under. */
function hostConfigKey(fieldKey: string): string {
  return `${fieldKey}Host`;
}

/** The channel's address fields that hold a secret. */
function secretAddressFields(definition: ChannelSetupDefinition): string[] {
  const secrets = new Set(definition.adapter.secretFieldKeys);
  return (definition.wizard.hostFields ?? []).filter((key) => secrets.has(key));
}

/** The hosts of the pasted secret addresses, by field key. An address that names no host has no entry. */
export function pastedAddressHosts(
  definition: ChannelSetupDefinition,
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    secretAddressFields(definition).flatMap((key) => {
      const host = channelAddressHost(values[key]);
      return host ? [[key, host]] : [];
    }),
  );
}

/**
 * The config a connection is finalized with: for each secret address the draft holds, the host recorded when it was
 * pasted, or none when it named no host. An address the draft did not replace keeps the host the connection recorded.
 */
export function recordAddressHosts(
  definition: ChannelSetupDefinition,
  secretState: ChannelSetupDraft["secretState"],
  config: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...config };
  for (const key of secretAddressFields(definition)) {
    const state = secretState[key];
    if (!state?.configured) continue;
    if (isChannelAddressHost(state.host)) next[hostConfigKey(key)] = state.host;
    else delete next[hostConfigKey(key)];
  }
  return next;
}

/** The hosts a saved connection recorded for the secret addresses it holds, by field key. */
function savedAddressHosts(
  definition: ChannelSetupDefinition,
  config: Record<string, unknown>,
): Record<string, string> | undefined {
  const entries = secretAddressFields(definition).flatMap((key) => {
    const host = config[hostConfigKey(key)];
    return config[key] && isChannelAddressHost(host) ? [[key, host] as const] : [];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** Returns a copy of the runtime whose drafts of a saved connection carry the hosts it recorded. */
export function withSavedAddressHosts(runtime: ChannelSetupRuntimeDefinition): ChannelSetupRuntimeDefinition {
  if (secretAddressFields(runtime.definition).length === 0) return runtime;
  return {
    ...runtime,
    hydrate(connection) {
      const hydrated = runtime.hydrate(connection);
      const addressHosts = savedAddressHosts(runtime.definition, connection.config);
      return addressHosts ? { ...hydrated, hydration: { ...hydrated.hydration, addressHosts } } : hydrated;
    },
  };
}
