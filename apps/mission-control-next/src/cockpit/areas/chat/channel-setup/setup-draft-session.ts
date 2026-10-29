import type { ChannelSetupDraft } from "@goatcitadel/contracts";
import { fetchChannelSetupDraft, updateChannelSetupDraft } from "@goatcitadel/mission-control-shared/api/client";

/** The mark a setup made on a page in Chat leaves on its draft (`setupPage`), so that page is where it goes on. */
export const CHAT_SETUP_PAGE = "messaging";

/** Whether the setup was made on a page in Chat. A draft made in Settings carries no mark and goes on in Settings. */
export function isChatSetupDraft(draft: Pick<ChannelSetupDraft, "draft">): boolean {
  const values: unknown = draft.draft;
  return (
    typeof values === "object" && values !== null && (values as Record<string, unknown>).setupPage === CHAT_SETUP_PAGE
  );
}

/**
 * The setup a Chat page goes on with: the unfinished one it was sent to, else the newest unfinished one. Unfinished
 * means this catalog's new setup, not tied to a saved connection, and made on the Chat page. When the named one is gone
 * or isn't one of those, nothing is: going on with another bot's setup, where Start over would discard it, is worse
 * than starting fresh.
 */
export function chatSetupToResume(
  drafts: readonly ChannelSetupDraft[],
  catalogId: string,
  draftId?: string,
): ChannelSetupDraft | null {
  const unfinished = drafts.filter(
    (draft) =>
      draft.catalogId === catalogId &&
      draft.lifecycleMode === "create" &&
      !draft.connectionId &&
      isChatSetupDraft(draft),
  );
  if (draftId) return unfinished.find((draft) => draft.draftId === draftId) ?? null;
  const updated = (draft: ChannelSetupDraft) => Date.parse(draft.updatedAt) || 0;
  return unfinished.reduce<ChannelSetupDraft | null>(
    (newest, draft) => (!newest || updated(draft) > updated(newest) ? draft : newest),
    null,
  );
}

/**
 * The draft marked as made on a Chat page, written before any secret is stored on it: a draft that holds a token is
 * then always one the page goes on with, even when the first check fails, and never one Settings lists as its own.
 * Returns the marked draft, whose version the next write carries. A draft already marked is returned as it is, and a
 * write that fails is left to fail.
 */
export async function markedChatSetupDraft(draft: ChannelSetupDraft): Promise<ChannelSetupDraft> {
  if (isChatSetupDraft(draft)) return draft;
  return await updateChannelSetupDraft(draft.draftId, {
    expectedRevision: draft.revision,
    draft: { ...draft.draft, setupPage: CHAT_SETUP_PAGE },
  });
}

/** The draft as the gateway has it now, or null when it cannot be read. */
export async function latestDraft(draftId: string): Promise<ChannelSetupDraft | null> {
  try {
    return await fetchChannelSetupDraft(draftId);
  } catch {
    return null;
  }
}
