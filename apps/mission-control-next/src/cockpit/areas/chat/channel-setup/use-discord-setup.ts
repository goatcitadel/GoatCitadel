import { useCallback, useEffect } from "react";
import type { ChannelSetupDraft, DiscordSetupCheckResult } from "@goatcitadel/contracts";
import {
  checkDiscordSetup,
  createChannelSetupDraft,
  discardChannelSetupDraft,
  fetchChannelSetupDrafts,
  submitChannelSetupDraftSecrets,
  updateChannelSetupDraft,
} from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { DISCORD_CATALOG_ID, DISCORD_TOKEN_FAILED } from "./discord-setup-model";
import { CHAT_SETUP_PAGE, chatSetupToResume, latestDraft } from "./setup-draft-session";
import { useSetupState } from "./use-setup-state";

// The page's words live with the rest of Discord's pure helpers; the hook's callers find them here too.
export {
  DISCORD_CATALOG_ID,
  DISCORD_DEVELOPER_PORTAL,
  DISCORD_TOKEN_FAILED,
  discordInviteHref,
} from "./discord-setup-model";

export interface DiscordSetupState {
  /** The setup in progress, or null before there is one. */
  draft: ChannelSetupDraft | null;
  /** What the last check that worked found: the bot, whether Message Content Intent is on, who made it. */
  check: DiscordSetupCheckResult | null;
  busy: boolean;
  error?: string;
  /** Stores the token on the draft, then asks Discord who the bot is. Starts the draft when there is none. */
  checkToken(token: string): Promise<void>;
  /** Checks again with the saved token, after a change in the Developer Portal. Nothing is sent but the question. */
  recheck(): Promise<void>;
  /** Discards the draft and its stored token. */
  startOver(): Promise<void>;
}

type Core = Omit<DiscordSetupState, "checkToken" | "recheck" | "startOver">;

const EMPTY: Core = { draft: null, check: null, busy: false, error: undefined };

/**
 * Discord's setup: the draft being built and the bot its token belongs to. Everything the draft holds is the
 * gateway's; this keeps the latest copy it returned, because every write to a draft must carry the version the last
 * one returned. The token itself is never kept: it goes to the draft's secure store and no further, and nothing the
 * page reads from here, or says, quotes it.
 *
 * A setup made on this page goes on where it was left (`chatSetupToResume`): a draft Settings made is Settings'. When
 * its token is stored, the page asks Discord about it again, so a bot changed in the Developer Portal in between is
 * seen as it is now.
 */
export function useDiscordSetup(workspaceId: string, resumeDraftId?: string): DiscordSetupState {
  const { view, current, begin, reset } = useSetupState<Core>(EMPTY);

  useEffect(() => {
    // Set when the page goes or the setup it was sent to changes, so nothing is asked for a setup nobody is looking at.
    let gone = false;
    const set = begin();
    void (async () => {
      set({ busy: true });
      let found: ChannelSetupDraft | null;
      try {
        const drafts = await fetchChannelSetupDrafts({ catalogId: DISCORD_CATALOG_ID });
        found = chatSetupToResume(drafts.items, DISCORD_CATALOG_ID, resumeDraftId);
      } catch {
        // Nothing to resume; the operator starts fresh. A draft left behind is found next time.
        set({ busy: false });
        return;
      }
      if (gone) return;
      if (!found) {
        set({ busy: false });
        return;
      }
      set({ draft: found });
      if (!found.secretState?.botToken?.configured) {
        set({ busy: false });
        return;
      }
      try {
        const check = await checkDiscordSetup({ draftId: found.draftId, expectedRevision: found.revision });
        set({ check, busy: false });
      } catch {
        set({ busy: false, error: DISCORD_TOKEN_FAILED });
      }
    })();
    return () => {
      gone = true;
      reset();
    };
  }, [workspaceId, resumeDraftId, begin, reset]);

  const checkToken = useCallback(
    async (token: string) => {
      const secret = token.trim();
      if (!secret || current().busy) return;
      const set = begin();
      set({ check: null, busy: true, error: undefined });
      let draft = current().draft;
      try {
        draft ??= await createChannelSetupDraft({ catalogId: DISCORD_CATALOG_ID, lifecycleMode: "create" });
        // Kept at once, so a try after a failure goes on with this draft instead of making another.
        set({ draft });
        const stored = await submitChannelSetupDraftSecrets(draft.draftId, {
          expectedRevision: draft.revision,
          values: { botToken: secret },
        });
        const check = await checkDiscordSetup({ draftId: draft.draftId, expectedRevision: stored.revision });
        const saved = await updateChannelSetupDraft(draft.draftId, {
          expectedRevision: stored.revision,
          draft: {
            ...stored.draft,
            setupPage: CHAT_SETUP_PAGE,
            runtimeMode: "gateway",
            applicationId: check.applicationId,
            inboundDmPolicy: "pairing",
          },
        });
        set({ draft: saved, check, busy: false });
      } catch {
        // The token may have been stored before the failure, which moved the draft's version on.
        const latest = draft ? await latestDraft(draft.draftId) : null;
        set({ ...(latest ? { draft: latest } : {}), check: null, busy: false, error: DISCORD_TOKEN_FAILED });
      }
    },
    [begin, current],
  );

  const recheck = useCallback(async () => {
    const { draft, busy } = current();
    if (!draft || busy) return;
    const set = begin();
    set({ busy: true, error: undefined });
    try {
      set({
        check: await checkDiscordSetup({ draftId: draft.draftId, expectedRevision: draft.revision }),
        busy: false,
      });
    } catch {
      // The last check that worked stays: the token is saved, and the bot is still the one it named.
      set({ busy: false, error: DISCORD_TOKEN_FAILED });
    }
  }, [begin, current]);

  const startOver = useCallback(async () => {
    const { draft, busy } = current();
    if (busy) return;
    if (!draft) {
      reset();
      return;
    }
    const set = begin();
    set({ busy: true, error: undefined });
    try {
      await discardChannelSetupDraft(draft.draftId, draft.revision);
      reset();
    } catch (error) {
      set({ busy: false, error: describeApiError(error).summary });
    }
  }, [begin, current, reset]);

  return { ...view, checkToken, recheck, startOver };
}
