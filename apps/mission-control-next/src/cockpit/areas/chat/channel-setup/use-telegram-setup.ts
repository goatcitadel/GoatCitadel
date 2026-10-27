import { useCallback, useEffect, useRef, useState } from "react";
import type { ChannelSetupDraft } from "@goatcitadel/contracts";
import {
  createChannelSetupDraft,
  discardChannelSetupDraft,
  fetchChannelSetupDraft,
  fetchChannelSetupDrafts,
  updateChannelSetupDraft,
} from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { checkTelegramKey, readTelegramBot } from "./telegram-key-check";

export const TELEGRAM_CATALOG_ID = "channel.telegram";

/** The one sentence a failed key check, or a failed look at the bot, comes to. The gateway's own message is never shown. */
export const TELEGRAM_KEY_FAILED =
  "Telegram didn't accept that key, or GoatCitadel couldn't reach Telegram. Check the key and try again.";

export interface TelegramSetupState {
  /** The setup in progress, or null before there is one. */
  draft: ChannelSetupDraft | null;
  /** The bot the key belongs to, once the key has been checked. */
  bot: { username: string; label?: string } | null;
  /** The bot sends its messages to a web address, so GoatCitadel cannot read them. */
  webhookActive: boolean;
  /** Another app is reading the bot's messages. */
  conflict: boolean;
  busy: boolean;
  error?: string;
  checkKey(token: string): Promise<void>;
  /** Asks Telegram to stop sending the bot's messages to its web address. Only the operator's click does this. */
  stopWebAddress(): Promise<void>;
  /** Discards the draft and its stored key. */
  startOver(): Promise<void>;
}

type Core = Omit<TelegramSetupState, "checkKey" | "stopWebAddress" | "startOver">;

const EMPTY: Core = { draft: null, bot: null, webhookActive: false, conflict: false, busy: false, error: undefined };

/** The newest setup that is still unfinished: a Telegram draft that is not changing an existing connection. */
function newestUnfinished(drafts: readonly ChannelSetupDraft[]): ChannelSetupDraft | null {
  const updated = (draft: ChannelSetupDraft) => Date.parse(draft.updatedAt) || 0;
  const unfinished = drafts.filter((draft) => draft.catalogId === TELEGRAM_CATALOG_ID && !draft.connectionId);
  return unfinished.reduce<ChannelSetupDraft | null>(
    (newest, draft) => (!newest || updated(draft) > updated(newest) ? draft : newest),
    null,
  );
}

/** The draft as the gateway has it now, or null when it cannot be read. */
async function latestDraft(draftId: string): Promise<ChannelSetupDraft | null> {
  try {
    return await fetchChannelSetupDraft(draftId);
  } catch {
    return null;
  }
}

/**
 * Telegram's setup: the draft being built, the bot its key belongs to, and what stands in the way of reading the
 * bot's messages. Everything the draft holds is the gateway's; this keeps the latest copy it returned, because every
 * write to a draft must carry the version the last one returned. The key itself is never kept: it goes to the draft's
 * secure store and no further.
 */
export function useTelegramSetup(workspaceId: string): TelegramSetupState {
  const [view, setView] = useState<Core>(EMPTY);
  // The latest state, readable between renders: a handler must see the draft a previous call just returned.
  const core = useRef<Core>(EMPTY);
  // Counts workspaces and unmounts, so a slow reply to a call made earlier is dropped.
  const epoch = useRef(0);

  const begin = useCallback(() => {
    const mine = epoch.current;
    return (patch: Partial<Core>) => {
      if (epoch.current !== mine) return;
      core.current = { ...core.current, ...patch };
      setView(core.current);
    };
  }, []);

  useEffect(() => {
    epoch.current += 1;
    core.current = EMPTY;
    setView(EMPTY);
    const set = begin();
    void (async () => {
      set({ busy: true });
      let found: ChannelSetupDraft | null;
      try {
        found = newestUnfinished((await fetchChannelSetupDrafts({ catalogId: TELEGRAM_CATALOG_ID })).items);
      } catch {
        // Nothing to resume; the operator starts fresh. A draft left behind is found next time.
        set({ busy: false });
        return;
      }
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
        set({ ...(await readTelegramBot({ draftId: found.draftId, expectedRevision: found.revision })), busy: false });
      } catch {
        set({ busy: false, error: TELEGRAM_KEY_FAILED });
      }
    })();
    return () => {
      epoch.current += 1;
    };
  }, [workspaceId, begin]);

  const checkKey = useCallback(
    async (token: string) => {
      const key = token.trim();
      if (!key || core.current.busy) return;
      const set = begin();
      set({ busy: true, error: undefined });
      let draft = core.current.draft;
      try {
        draft ??= await createChannelSetupDraft({ catalogId: TELEGRAM_CATALOG_ID, lifecycleMode: "create" });
        // Kept at once, so a try after a failure goes on with this draft instead of making another.
        set({ draft });
        const check = await checkTelegramKey({ draftId: draft.draftId, expectedRevision: draft.revision, token: key });
        const saved = await updateChannelSetupDraft(draft.draftId, {
          expectedRevision: check.revision,
          draft: { ...draft.draft, botUsername: check.bot.username, receiveMode: "poll" },
        });
        set({
          draft: saved,
          bot: check.bot,
          webhookActive: check.webhookActive,
          conflict: check.conflict,
          busy: false,
        });
      } catch {
        // The key may have been stored before the failure, which moved the draft's version on.
        const latest = draft ? await latestDraft(draft.draftId) : null;
        set({
          ...(latest ? { draft: latest } : {}),
          bot: null,
          webhookActive: false,
          conflict: false,
          busy: false,
          error: TELEGRAM_KEY_FAILED,
        });
      }
    },
    [begin],
  );

  const stopWebAddress = useCallback(async () => {
    const { draft, busy } = core.current;
    if (!draft || busy) return;
    const set = begin();
    set({ busy: true, error: undefined });
    try {
      set({
        ...(await readTelegramBot({ draftId: draft.draftId, expectedRevision: draft.revision, clearWebhook: true })),
        busy: false,
      });
    } catch {
      set({ busy: false, error: TELEGRAM_KEY_FAILED });
    }
  }, [begin]);

  const startOver = useCallback(async () => {
    const { draft, busy } = core.current;
    if (busy) return;
    const set = begin();
    if (!draft) {
      set(EMPTY);
      return;
    }
    set({ busy: true, error: undefined });
    try {
      await discardChannelSetupDraft(draft.draftId, draft.revision);
      set(EMPTY);
    } catch (error) {
      set({ busy: false, error: describeApiError(error).summary });
    }
  }, [begin]);

  return { ...view, checkKey, stopWebAddress, startOver };
}
