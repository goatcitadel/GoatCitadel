import { isDeepStrictEqual } from "node:util";
import {
  ValidationError,
  type ChannelSetupDraft,
  type ChannelSetupDraftUpdateInput,
} from "@goatcitadel/contracts";

/** Installation identity is authored exclusively by bound OAuth adoption. */
export const CHANNEL_SLACK_OAUTH_METADATA_KEYS = [
  "authMode", "slackInstallId", "slackTeamId", "slackTeamName", "slackAppId",
  "slackBotUserId", "slackScopes", "slackInstallerUserId", "oauthConnectedAt",
] as const;

/** Public edits may retain a receipt, but cannot fabricate, replace, or clear it. */
export function protectChannelOAuthDraftMetadata(
  current: ChannelSetupDraft,
  input: ChannelSetupDraftUpdateInput,
): ChannelSetupDraftUpdateInput {
  if (current.catalogId !== "channel.slack" || !input.draft) return input;
  const nextDraft = { ...input.draft };
  for (const key of CHANNEL_SLACK_OAUTH_METADATA_KEYS) {
    const owner = Object.hasOwn(current.draft, key)
      ? current.draft
      : current.hydration?.rawLegacyConfig;
    const hasCurrent = Boolean(owner && Object.hasOwn(owner, key));
    const expected = hasCurrent ? owner![key] : undefined;
    if (Object.hasOwn(input.draft, key) && !isDeepStrictEqual(input.draft[key], expected)) {
      throw new ValidationError({
        field: key,
        message: "Slack installation metadata belongs to its authorization receipt. Use Connect Slack and explicitly adopt the bound installation before reviewing the Change Plan.",
      });
    }
    if (hasCurrent) nextDraft[key] = expected;
    else delete nextDraft[key];
  }
  return { ...input, draft: nextDraft };
}
