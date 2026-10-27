import { useCallback, useEffect, useRef, useState } from "react";
import type { ChannelSetupDraft, IntegrationConnection } from "@goatcitadel/contracts";
import {
  createChannelRotateSecretDraft,
  fetchChannelSetupDrafts,
  updateChannelSetupDraft,
} from "@goatcitadel/mission-control-shared/api/client";
import { checkTelegramKey } from "./telegram-key-check";
import { latestDraft, TELEGRAM_CATALOG_ID, TELEGRAM_KEY_FAILED } from "./use-telegram-setup";

export interface TelegramKeyChangeState {
  /** The draft the new key is stored on, once the first check has made or found it. */
  draft: ChannelSetupDraft | null;
  /** The bot the new key belongs to, once it has been checked. */
  bot: { username: string; label?: string } | null;
  /** The new bot sends its messages to a web address. */
  webhookActive: boolean;
  /** Telegram answered a request for the bot's messages with a conflict. */
  conflict: boolean;
  busy: boolean;
  error?: string;
  checkKey(token: string): Promise<void>;
}

type Core = Omit<TelegramKeyChangeState, "checkKey">;

const EMPTY: Core = { draft: null, bot: null, webhookActive: false, conflict: false, busy: false, error: undefined };

/**
 * The newest draft for changing this channel's key that still matches the channel, or a new one. A draft made
 * against an older version of the channel is no use: the gateway refuses to check it. A draft for editing or
 * repairing the channel is not this change and could carry other unsaved edits, so it is never taken.
 */
async function draftForKeyChange(connection: Pick<IntegrationConnection, "connectionId" | "revision">) {
  const { items } = await fetchChannelSetupDrafts({ connectionId: connection.connectionId });
  const updated = (draft: ChannelSetupDraft) => Date.parse(draft.updatedAt) || 0;
  const newest = items
    .filter(
      (draft) =>
        draft.catalogId === TELEGRAM_CATALOG_ID &&
        draft.connectionId === connection.connectionId &&
        draft.lifecycleMode === "rotate_secret" &&
        draft.connectionRevision === connection.revision,
    )
    .reduce<ChannelSetupDraft | null>((best, draft) => (!best || updated(draft) > updated(best) ? draft : best), null);
  return newest ?? createChannelRotateSecretDraft(connection.connectionId);
}

/**
 * Changing a Telegram channel's key. The draft is made, or found, on the first check, never by visiting the page. A
 * check stores the key on the draft's secure store, asks Telegram which bot it belongs to, and saves that bot on the
 * draft, leaving every other setting, including how the channel receives messages, as it was. It never asks Telegram
 * to stop sending a bot's messages to a web address. The key itself is never kept here, and neither is any message
 * that mentions it: every failure is the one sentence.
 */
export function useTelegramKeyChange(
  connection: Pick<IntegrationConnection, "connectionId" | "revision">,
): TelegramKeyChangeState {
  const { connectionId, revision } = connection;
  const [view, setView] = useState<Core>(EMPTY);
  // The latest state, readable between renders: a check must see the draft the one before it returned.
  const core = useRef<Core>(EMPTY);
  // Counts channels and unmounts, so a slow reply to a check made earlier is dropped.
  const epoch = useRef(0);

  useEffect(() => {
    epoch.current += 1;
    core.current = EMPTY;
    setView(EMPTY);
    return () => {
      epoch.current += 1;
    };
  }, [connectionId]);

  const checkKey = useCallback(
    async (token: string) => {
      const key = token.trim();
      if (!key || core.current.busy) return;
      const mine = epoch.current;
      const set = (patch: Partial<Core>) => {
        if (epoch.current !== mine) return;
        core.current = { ...core.current, ...patch };
        setView(core.current);
      };
      set({ busy: true, error: undefined });
      let draft = core.current.draft;
      try {
        draft ??= await draftForKeyChange({ connectionId, revision });
        // Kept at once, so a try after a failure goes on with this draft instead of making another.
        set({ draft });
        const check = await checkTelegramKey({ draftId: draft.draftId, expectedRevision: draft.revision, token: key });
        const saved = await updateChannelSetupDraft(draft.draftId, {
          expectedRevision: check.revision,
          draft: { ...draft.draft, botUsername: check.bot.username },
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
        const latest = draft ? ((await latestDraft(draft.draftId)) ?? draft) : null;
        // A draft that no longer matches the channel can never be checked: the next try starts another.
        const usable = latest?.connectionRevision === revision ? latest : null;
        set({
          draft: usable,
          bot: null,
          webhookActive: false,
          conflict: false,
          busy: false,
          error: TELEGRAM_KEY_FAILED,
        });
      }
    },
    [connectionId, revision],
  );

  return { ...view, checkKey };
}
