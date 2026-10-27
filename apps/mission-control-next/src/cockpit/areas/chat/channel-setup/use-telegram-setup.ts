import { useCallback, useEffect, useRef, useState } from "react";
import type { ChannelSetupCodeSender, ChannelSetupDraft } from "@goatcitadel/contracts";
import {
  createChannelSetupDraft,
  discardChannelSetupDraft,
  discoverTelegramSetupTargets,
  fetchChannelSetupDraft,
  fetchChannelSetupDrafts,
  updateChannelSetupDraft,
} from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { draftWithSender, savedSender } from "./code-sender";
import { listenForHi } from "./listen-for-hi";
import { createSetupCode } from "./setup-code";
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
  /** Who said hi with the code. Once they have, GoatCitadel has stopped listening. */
  sender: ChannelSetupCodeSender | null;
  /** The code the operator sends their bot, while GoatCitadel is listening for it or after it expired. */
  code: string | null;
  /** The code ran out before anyone sent it. */
  codeExpired: boolean;
  /** The bot has a full page of waiting messages, so the hi may be a while in showing up. */
  manyWaiting: boolean;
  busy: boolean;
  error?: string;
  checkKey(token: string): Promise<void>;
  /** Asks Telegram to stop sending the bot's messages to its web address. Only the operator's click does this. */
  stopWebAddress(): Promise<void>;
  /** Saves a fresh code on the draft and listens for it, in place of any code before it. */
  newCode(): Promise<void>;
  /** Discards the draft and its stored key. */
  startOver(): Promise<void>;
}

type Core = Omit<TelegramSetupState, "checkKey" | "stopWebAddress" | "newCode" | "startOver">;

/** Not saying hi: no code, nobody heard from, nothing waiting. */
const NOT_LISTENING = { sender: null, code: null, codeExpired: false, manyWaiting: false } as const;

const EMPTY: Core = {
  draft: null,
  bot: null,
  webhookActive: false,
  conflict: false,
  ...NOT_LISTENING,
  busy: false,
  error: undefined,
};

type Setter = (patch: Partial<Core>) => void;

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
export async function latestDraft(draftId: string): Promise<ChannelSetupDraft | null> {
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
 *
 * Saying hi: `newCode` saves a one-time code on the draft and then asks Telegram every few seconds whether anyone has
 * sent it. When they have, the draft is saved once with them as the only allowed sender and the owner, and the asking
 * stops. It also stops when the code expires, when the operator starts over or checks the key again, and when the
 * page goes.
 */
export function useTelegramSetup(workspaceId: string): TelegramSetupState {
  const [view, setView] = useState<Core>(EMPTY);
  // The latest state, readable between renders: a handler must see the draft a previous call just returned.
  const core = useRef<Core>(EMPTY);
  // Counts workspaces and unmounts, so a slow reply to a call made earlier is dropped.
  const epoch = useRef(0);
  // Changes whenever listening starts or stops, so a reply to a question asked before is dropped the same way.
  const listening = useRef(0);
  const stopAsking = useRef<(() => void) | null>(null);

  const begin = useCallback((): Setter => {
    const mine = epoch.current;
    return (patch) => {
      if (epoch.current !== mine) return;
      core.current = { ...core.current, ...patch };
      setView(core.current);
    };
  }, []);

  const stopListening = useCallback(() => {
    listening.current += 1;
    stopAsking.current?.();
    stopAsking.current = null;
  }, []);

  /** Asks about `code` until it is heard, runs out, or listening stops. */
  const listenFor = useCallback(
    (code: string, set: Setter) => {
      const mine = listening.current;
      const stillListening = () => listening.current === mine;

      const hear = async (sender: ChannelSetupCodeSender) => {
        const draft = core.current.draft;
        if (!draft) return;
        try {
          const saved = await updateChannelSetupDraft(draft.draftId, {
            expectedRevision: draft.revision,
            draft: draftWithSender(draft.draft, sender),
          });
          if (!stillListening()) return;
          stopListening();
          set({ draft: saved, sender, manyWaiting: false, error: undefined });
        } catch (error) {
          // The next question finds the same hi and tries again, from the draft as it is now.
          const latest = await latestDraft(draft.draftId);
          if (stillListening()) set({ ...(latest ? { draft: latest } : {}), error: describeApiError(error).summary });
        }
      };

      const ask = async () => {
        const draft = core.current.draft;
        if (!draft || !stillListening()) return;
        try {
          const found = await discoverTelegramSetupTargets({
            source: "draft",
            draftId: draft.draftId,
            expectedRevision: draft.revision,
            setupCode: code,
          });
          if (!stillListening()) return;
          if (found.codeSender) {
            await hear(found.codeSender);
            return;
          }
          const many = found.updatesTruncated === true;
          if (core.current.manyWaiting !== many) set({ manyWaiting: many });
        } catch {
          // Ignored: a question that fails is asked again with the next one.
        }
      };

      stopAsking.current = listenForHi(ask, () => {
        if (!stillListening()) return;
        stopListening();
        set({ codeExpired: true, manyWaiting: false });
      });
    },
    [stopListening],
  );

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
        const reading = await readTelegramBot({ draftId: found.draftId, expectedRevision: found.revision });
        // Someone may have said hi on an earlier visit. Then there is no code to save and nothing to listen for: the
        // draft already says who they are, and writing it again would only make an open change out of date.
        const clear = !reading.webhookActive && !reading.conflict;
        set({ ...reading, sender: clear ? savedSender(found.draft) : null, busy: false });
      } catch {
        set({ busy: false, error: TELEGRAM_KEY_FAILED });
      }
    })();
    return () => {
      epoch.current += 1;
      stopListening();
    };
  }, [workspaceId, begin, stopListening]);

  const checkKey = useCallback(
    async (token: string) => {
      const key = token.trim();
      if (!key || core.current.busy) return;
      const set = begin();
      stopListening();
      set({ ...NOT_LISTENING, busy: true, error: undefined });
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
    [begin, stopListening],
  );

  const stopWebAddress = useCallback(async () => {
    const { draft, busy } = core.current;
    if (!draft || busy) return;
    const set = begin();
    stopListening();
    set({ ...NOT_LISTENING, busy: true, error: undefined });
    try {
      set({
        ...(await readTelegramBot({ draftId: draft.draftId, expectedRevision: draft.revision, clearWebhook: true })),
        busy: false,
      });
    } catch {
      set({ busy: false, error: TELEGRAM_KEY_FAILED });
    }
  }, [begin, stopListening]);

  const newCode = useCallback(async () => {
    const { draft, bot, busy } = core.current;
    if (!draft || !bot || busy) return;
    const mine = epoch.current;
    const set = begin();
    stopListening();
    const code = createSetupCode();
    set({ ...NOT_LISTENING, busy: true, error: undefined });
    try {
      const saved = await updateChannelSetupDraft(draft.draftId, {
        expectedRevision: draft.revision,
        draft: { ...draft.draft, setupCode: code },
      });
      // The page may have gone while the code was being saved: then nothing may start listening for it.
      if (epoch.current !== mine) return;
      set({ draft: saved, code, busy: false });
      listenFor(code, set);
    } catch (error) {
      const latest = await latestDraft(draft.draftId);
      set({ ...(latest ? { draft: latest } : {}), busy: false, error: describeApiError(error).summary });
    }
  }, [begin, listenFor, stopListening]);

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
      stopListening();
      set(EMPTY);
    } catch (error) {
      set({ busy: false, error: describeApiError(error).summary });
    }
  }, [begin, stopListening]);

  return { ...view, checkKey, stopWebAddress, newCode, startOver };
}
