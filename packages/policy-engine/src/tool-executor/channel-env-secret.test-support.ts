import type { ChannelEnvSecretRequest, ChannelEnvSecretResolution } from "./comms-executor.js";

/**
 * Stand-in for the Gateway's `resolveChannelEnvSecret` hook in executor tests. The real name rule lives in the Gateway
 * (`resolveChannelSendEnvSecret`) and is tested there against this same executor. This keeps its main property, so a
 * test fixture cannot name a variable outside its channel by accident: a name must start with the channel's key.
 */
export function channelEnvSecretStandIn(input: ChannelEnvSecretRequest): ChannelEnvSecretResolution {
  const prefix = `${input.channelKey.toUpperCase().replaceAll("-", "_")}_`;
  if (!input.envName.startsWith(prefix)) {
    return { refusal: `The variable name must start with ${prefix}. Rename it and restart GoatCitadel.` };
  }
  return { value: process.env[input.envName] };
}
