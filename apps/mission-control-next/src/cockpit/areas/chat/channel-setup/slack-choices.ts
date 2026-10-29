import type { ChannelSetupDraft, SlackSetupCodeSender } from "@goatcitadel/contracts";
import { checkSlackSetup, updateChannelSetupDraft } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { latestDraft } from "./setup-draft-session";
import type { SlackChannel } from "./slack-setup-model";

/** How saving new values on the draft ended. */
export type SlackSaveOutcome =
  | { kind: "saved"; draft: ChannelSetupDraft }
  /** `latest` is the draft as the gateway has it now, when a save failed after the draft may have moved on. */
  | { kind: "failed"; error: string; latest: ChannelSetupDraft | null };

/**
 * Saves new values for the draft at the version it was read at. A write to a draft carries no token, so the reason a
 * save failed is the gateway's own plain sentence (a change made somewhere else, say).
 */
export async function saveSlackDraft(
  draft: ChannelSetupDraft,
  values: Record<string, unknown>,
): Promise<SlackSaveOutcome> {
  try {
    const saved = await updateChannelSetupDraft(draft.draftId, { expectedRevision: draft.revision, draft: values });
    return { kind: "saved", draft: saved };
  } catch (error) {
    return { kind: "failed", error: describeApiError(error).summary, latest: await latestDraft(draft.draftId) };
  }
}

/**
 * The channels the bot is in, by name, or null when Slack can't be asked or sends no list. One call reads them (it uses
 * conversations.list, which allows about 20 a minute), so a page asks for them when the step opens and when the
 * operator says so, never on a timer. The gateway's own message is never kept: it can quote the request the token
 * travelled in.
 */
export async function loadSlackChannels(draft: ChannelSetupDraft): Promise<SlackChannel[] | null> {
  try {
    const answer = await checkSlackSetup({
      draftId: draft.draftId,
      expectedRevision: draft.revision,
      listChannels: true,
    });
    return answer.channels ?? null;
  } catch {
    return null;
  }
}

/** What one look for the code found. */
export interface HiAnswer {
  /** Who sent the code, once someone has. */
  sender: SlackSetupCodeSender | null;
  /** The bot has more conversations than were looked through, so the hi may be hidden behind them. */
  many: boolean;
}

/** Asks Slack once whether the code has arrived in the bot's direct messages. A question that fails throws. */
export async function askForHi(draft: ChannelSetupDraft, code: string): Promise<HiAnswer> {
  const found = await checkSlackSetup({ draftId: draft.draftId, expectedRevision: draft.revision, setupCode: code });
  return { sender: found.codeSender ?? null, many: found.manyConversations === true };
}
