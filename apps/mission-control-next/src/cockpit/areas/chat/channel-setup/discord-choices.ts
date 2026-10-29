import type { ChannelSetupDraft, ChannelSetupPerson } from "@goatcitadel/contracts";
import { checkDiscordSetup, updateChannelSetupDraft } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { DISCORD_UNREACHABLE, discordChoiceValues, type DiscordPosting } from "./discord-setup-model";
import { latestDraft } from "./setup-draft-session";

/** How saving who may message the bot and where it posts ended. */
export type SaveOutcome =
  | { kind: "saved"; draft: ChannelSetupDraft }
  /** `latest` is the draft as the gateway has it now, when a save failed after the draft may have moved on. */
  | { kind: "failed"; error: string; latest: ChannelSetupDraft | null }
  /** The page moved on while it was being saved, so nothing was written. */
  | { kind: "stale" };

/**
 * One server's text channels, in the order Discord shows them, or null when Discord can't be asked. It only reads, so
 * it can be asked at the draft's current version beside anything else that reads.
 */
export async function loadServerChannels(
  draft: ChannelSetupDraft,
  guildId: string,
): Promise<ChannelSetupPerson[] | null> {
  try {
    const answer = await checkDiscordSetup({ draftId: draft.draftId, expectedRevision: draft.revision, guildId });
    return answer.channels ?? null;
  } catch {
    // The gateway's message may quote the request the token travelled in, so the page says its own words instead.
    return null;
  }
}

/**
 * Saves who may message the bot and where it posts in one update of the draft. Direct messages first ask Discord for
 * the channel it opens with that person, which sends nothing. `live` says whether the page is still on this setup;
 * once it is not, nothing more is asked or written.
 */
export async function saveDiscordChoice(
  draft: ChannelSetupDraft,
  makerId: string,
  posting: DiscordPosting,
  live: () => boolean,
): Promise<SaveOutcome> {
  let directChannelId: string | undefined;
  if (posting.kind === "direct") {
    try {
      const opened = await checkDiscordSetup({
        draftId: draft.draftId,
        expectedRevision: draft.revision,
        directMessageWith: makerId,
      });
      directChannelId = opened.directChannelId;
    } catch {
      return { kind: "failed", error: DISCORD_UNREACHABLE, latest: null };
    }
    if (!directChannelId) return { kind: "failed", error: DISCORD_UNREACHABLE, latest: null };
  }
  if (!live()) return { kind: "stale" };
  try {
    const saved = await updateChannelSetupDraft(draft.draftId, {
      expectedRevision: draft.revision,
      draft: discordChoiceValues(draft.draft, makerId, posting, directChannelId),
    });
    return { kind: "saved", draft: saved };
  } catch (error) {
    return { kind: "failed", error: describeApiError(error).summary, latest: await latestDraft(draft.draftId) };
  }
}
