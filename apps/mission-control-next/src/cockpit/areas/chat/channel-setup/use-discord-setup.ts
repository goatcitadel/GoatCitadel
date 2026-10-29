import { useCallback, useEffect, useRef } from "react";
import type { ChannelSetupDraft, ChannelSetupPerson, DiscordSetupCheckResult } from "@goatcitadel/contracts";
import {
  checkDiscordSetup,
  createChannelSetupDraft,
  discardChannelSetupDraft,
  fetchChannelSetupDrafts,
  submitChannelSetupDraftSecrets,
  updateChannelSetupDraft,
} from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { loadServerChannels, saveDiscordChoice } from "./discord-choices";
import {
  DISCORD_CATALOG_ID,
  DISCORD_TOKEN_FAILED,
  DISCORD_UNREACHABLE,
  discordValuesForBot,
  savedDiscordChoices,
  type DiscordPosting,
} from "./discord-setup-model";
import { listenForHi } from "./listen-for-hi";
import { CHAT_SETUP_PAGE, chatSetupToResume, latestDraft, markedChatSetupDraft } from "./setup-draft-session";
import { useSetupState } from "./use-setup-state";

// The page's words live with the rest of Discord's pure helpers; the hook's callers find them here too.
export {
  DISCORD_CATALOG_ID,
  DISCORD_DEVELOPER_PORTAL,
  DISCORD_TOKEN_FAILED,
  discordInviteHref,
  type DiscordPosting,
} from "./discord-setup-model";

export interface DiscordSetupState {
  /** The setup in progress, or null before there is one. */
  draft: ChannelSetupDraft | null;
  /** What the last check that worked found: the bot, whether Message Content Intent is on, who made it, its servers. */
  check: DiscordSetupCheckResult | null;
  busy: boolean;
  error?: string;
  /** GoatCitadel is asking Discord every few seconds whether the bot has joined a server. */
  waitingForServer: boolean;
  /** The wait ran out before the bot joined one. */
  serverWaitExpired: boolean;
  /** Who may message the bot: the person who made it. The only one is chosen for you; a team is asked. */
  makerId: string | null;
  /** The server whose text channels are offered. The only server is chosen for you; several are asked. */
  serverId: string | null;
  channels: ChannelSetupPerson[] | null;
  /** Where the bot posts, as saved on the draft. */
  posting: DiscordPosting | null;
  /** Stores the token on the draft, then asks Discord who the bot is. Starts the draft when there is none. */
  checkToken(token: string): Promise<void>;
  /** Checks again with the saved token, after a change in the Developer Portal. Nothing is sent but the question. */
  recheck(): Promise<void>;
  /** Discards the draft and its stored token. */
  startOver(): Promise<void>;
  /**
   * Asks Discord every few seconds until the bot is in a server, for ten minutes. A wait already going on is left
   * alone. Once the bot is in one, the person who made it and direct messages are chosen for you.
   */
  waitForServer(): void;
  chooseMaker(id: string): Promise<void>;
  chooseServer(guildId: string): Promise<void>;
  choosePosting(posting: DiscordPosting): Promise<void>;
}

type Actions =
  | "checkToken"
  | "recheck"
  | "startOver"
  | "waitForServer"
  | "chooseMaker"
  | "chooseServer"
  | "choosePosting";
type Core = Omit<DiscordSetupState, Actions>;
type Setter = (patch: Partial<Core>) => void;

/** Not waiting, and nothing chosen: what goes with a bot that has not been looked at yet. */
const NO_CHOICES = {
  waitingForServer: false,
  serverWaitExpired: false,
  makerId: null,
  serverId: null,
  channels: null,
  posting: null,
} as const;

const EMPTY: Core = { draft: null, check: null, busy: false, error: undefined, ...NO_CHOICES };

/**
 * Discord's setup: the draft being built, the bot its token belongs to, and what is chosen for it. Everything the draft
 * holds is the gateway's; this keeps the latest copy it returned, because every write to a draft must carry the
 * version the last one returned. The token itself is never kept: it goes to the draft's secure store and no further,
 * and nothing the page reads from here, or says, quotes it.
 *
 * A setup made on this page goes on where it was left (`chatSetupToResume`): a draft Settings made is Settings'. When
 * its token is stored, the page asks Discord about it again, so a bot changed in the Developer Portal in between is
 * seen as it is now.
 *
 * Once the bot is in a server, the draft is carried on from what it already holds, else chosen for the operator: the
 * person who made the bot is the only one let in (a team is asked which member), and the bot posts in direct messages
 * with them. Both are saved in one update, and the operator can change either.
 */
export function useDiscordSetup(workspaceId: string, resumeDraftId?: string): DiscordSetupState {
  const { view, current, begin, reset } = useSetupState<Core>(EMPTY);
  // Counts the times what was going on was dropped (the page went, the workspace changed, the operator started over or
  // checked the token anew), so a reply to something asked before changes nothing and nothing more is asked for it.
  const generation = useRef(0);
  const stopAsking = useRef<(() => void) | null>(null);

  const stopWaiting = useCallback(() => {
    stopAsking.current?.();
    stopAsking.current = null;
  }, []);
  const invalidate = useCallback(() => {
    generation.current += 1;
    stopWaiting();
  }, [stopWaiting]);
  /** Starts following what is going on now: the returned function says whether it still is. */
  const follow = useCallback(() => {
    const mine = generation.current;
    return () => generation.current === mine;
  }, []);

  /** Saves who may message the bot and where it posts, and says why when it can't. */
  const apply = useCallback(
    async (makerId: string, posting: DiscordPosting, set: Setter, live: () => boolean) => {
      const draft = current().draft;
      if (!draft) return;
      const outcome = await saveDiscordChoice(draft, makerId, posting, live);
      if (outcome.kind === "stale" || !live()) return;
      if (outcome.kind === "failed") {
        set({ ...(outcome.latest ? { draft: outcome.latest } : {}), error: outcome.error });
        return;
      }
      set({
        draft: outcome.draft,
        makerId,
        posting,
        error: undefined,
        ...(posting.kind === "channel" ? { serverId: posting.guildId } : {}),
      });
    },
    [current],
  );

  /**
   * The bot is in a server: go on with what the draft holds, else choose. The channels are listed for the only server,
   * or for the one a saved channel is in. A saved channel missing from a list that was read is gone and is no choice;
   * a list that could not be read says nothing about it, so the choice stays, the page says so, and the operator can
   * load the list again (`chooseServer`). A team is asked, never guessed.
   */
  const settleChoices = useCallback(
    async (check: DiscordSetupCheckResult, set: Setter, live: () => boolean) => {
      const draft = current().draft;
      if (!draft || !check.messageContentIntent || check.servers.length === 0) return;
      const saved = savedDiscordChoices(draft.draft, check);
      const makerId = saved.makerId ?? (check.makers.length === 1 ? (check.makers[0]?.id ?? null) : null);
      const savedChannel = saved.posting?.kind === "channel" ? saved.posting : null;
      const serverId = savedChannel?.guildId ?? (check.servers.length === 1 ? (check.servers[0]?.id ?? null) : null);
      const channels = serverId ? await loadServerChannels(draft, serverId) : null;
      if (!live()) return;
      const gone = savedChannel !== null && channels !== null && !channels.some((c) => c.id === savedChannel.channelId);
      const posting = gone ? null : saved.posting;
      set({ makerId, serverId, channels, posting });
      if (makerId && !posting) await apply(makerId, { kind: "direct" }, set, live);
      // Said last, so saving the default does not clear it. A failed save has already said why.
      if (serverId && !channels && live() && !current().error) set({ error: DISCORD_UNREACHABLE });
    },
    [apply, current],
  );

  useEffect(() => {
    const live = follow();
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
      if (!live()) return;
      if (!found) {
        set({ busy: false });
        return;
      }
      set({ draft: found });
      if (!found.secretState?.botToken?.configured) {
        set({ busy: false });
        return;
      }
      let check: DiscordSetupCheckResult;
      try {
        check = await checkDiscordSetup({ draftId: found.draftId, expectedRevision: found.revision });
      } catch {
        set({ busy: false, error: DISCORD_TOKEN_FAILED });
        return;
      }
      if (!live()) return;
      set({ check });
      await settleChoices(check, set, live);
      set({ busy: false });
    })();
    return () => {
      invalidate();
      reset();
    };
  }, [workspaceId, resumeDraftId, begin, reset, follow, invalidate, settleChoices]);

  const checkToken = useCallback(
    async (token: string) => {
      const secret = token.trim();
      if (!secret || current().busy) return;
      invalidate();
      const live = follow();
      const set = begin();
      set({ ...NO_CHOICES, check: null, busy: true, error: undefined });
      let draft = current().draft;
      let check: DiscordSetupCheckResult;
      try {
        draft ??= await createChannelSetupDraft({ catalogId: DISCORD_CATALOG_ID, lifecycleMode: "create" });
        // Kept at once, so a try after a failure goes on with this draft instead of making another.
        set({ draft });
        // Marked as made here before the token is stored, so a draft holding a token is always this page's.
        draft = await markedChatSetupDraft(draft);
        set({ draft });
        const stored = await submitChannelSetupDraftSecrets(draft.draftId, {
          expectedRevision: draft.revision,
          values: { botToken: secret },
        });
        check = await checkDiscordSetup({ draftId: draft.draftId, expectedRevision: stored.revision });
        const saved = await updateChannelSetupDraft(draft.draftId, {
          expectedRevision: stored.revision,
          draft: {
            // A token for another bot drops the old bot's choices, so the defaults are chosen again for this one.
            ...discordValuesForBot(stored.draft, check.applicationId),
            setupPage: CHAT_SETUP_PAGE,
            runtimeMode: "gateway",
            applicationId: check.applicationId,
            inboundDmPolicy: "pairing",
          },
        });
        set({ draft: saved, check });
      } catch {
        // The token may have been stored before the failure, which moved the draft's version on.
        const latest = draft ? await latestDraft(draft.draftId) : null;
        set({ ...(latest ? { draft: latest } : {}), check: null, busy: false, error: DISCORD_TOKEN_FAILED });
        return;
      }
      await settleChoices(check, set, live);
      set({ busy: false });
    },
    [begin, current, follow, invalidate, settleChoices],
  );

  const recheck = useCallback(async () => {
    const { draft, busy } = current();
    if (!draft || busy) return;
    invalidate();
    const live = follow();
    const set = begin();
    set({ ...NO_CHOICES, busy: true, error: undefined });
    let check: DiscordSetupCheckResult;
    try {
      check = await checkDiscordSetup({ draftId: draft.draftId, expectedRevision: draft.revision });
    } catch {
      // The token is stored, but Discord no longer takes it or can't be reached. The bot is not known any more, which
      // puts the token field back: a new token is pasted without starting over.
      set({ check: null, busy: false, error: DISCORD_TOKEN_FAILED });
      return;
    }
    set({ check });
    await settleChoices(check, set, live);
    set({ busy: false });
  }, [begin, current, follow, invalidate, settleChoices]);

  const startOver = useCallback(async () => {
    const { draft, busy } = current();
    if (busy) return;
    if (!draft) {
      invalidate();
      reset();
      return;
    }
    const set = begin();
    set({ busy: true, error: undefined });
    try {
      await discardChannelSetupDraft(draft.draftId, draft.revision);
      invalidate();
      reset();
    } catch (error) {
      set({ busy: false, error: describeApiError(error).summary });
    }
  }, [begin, current, invalidate, reset]);

  const waitForServer = useCallback(() => {
    const { draft, check } = current();
    if (!draft || !check?.messageContentIntent || check.servers.length > 0 || stopAsking.current) return;
    const live = follow();
    const set = begin();
    set({ waitingForServer: true, serverWaitExpired: false });
    const ask = async () => {
      const latest = current().draft;
      if (!latest || current().busy || !live()) return;
      let found: DiscordSetupCheckResult;
      try {
        found = await checkDiscordSetup({ draftId: latest.draftId, expectedRevision: latest.revision });
      } catch {
        // Asked again with the next question.
        return;
      }
      if (!live() || found.servers.length === 0) return;
      stopWaiting();
      set({ waitingForServer: false, serverWaitExpired: false, check: found, busy: true, error: undefined });
      await settleChoices(found, set, live);
      set({ busy: false });
    };
    stopAsking.current = listenForHi(
      () => ask().catch(() => undefined),
      () => {
        stopWaiting();
        set({ waitingForServer: false, serverWaitExpired: true });
      },
    );
  }, [begin, current, follow, settleChoices, stopWaiting]);

  /** Runs one choice the operator made, alone, and not on after the page has moved on. */
  const choose = useCallback(
    async (work: (set: Setter, live: () => boolean) => Promise<void>) => {
      const { check, draft, busy } = current();
      if (!check || !draft || busy) return;
      const live = follow();
      const set = begin();
      set({ busy: true, error: undefined });
      await work(set, live);
      set({ busy: false });
    },
    [begin, current, follow],
  );

  const chooseMaker = useCallback(
    async (id: string) => {
      if (!current().check?.makers.some((maker) => maker.id === id)) return;
      // A channel already chosen stays: it answers whoever is chosen. Direct messages are with them, so they follow.
      await choose((set, live) => apply(id, current().posting ?? { kind: "direct" }, set, live));
    },
    [apply, choose, current],
  );

  const chooseServer = useCallback(
    async (guildId: string) => {
      if (!current().check?.servers.some((server) => server.id === guildId)) return;
      await choose(async (set, live) => {
        const draft = current().draft;
        const channels = draft ? await loadServerChannels(draft, guildId) : null;
        if (!live()) return;
        if (!channels) {
          set({ error: DISCORD_UNREACHABLE });
          return;
        }
        set({ serverId: guildId, channels });
        // A channel that is not among the choices shown (another server's, or one the list read now lacks) is no
        // longer a choice, so the draft goes back to the default.
        const { makerId, posting } = current();
        if (makerId && posting?.kind === "channel") {
          const stays = posting.guildId === guildId && channels.some((channel) => channel.id === posting.channelId);
          if (!stays) await apply(makerId, { kind: "direct" }, set, live);
        }
      });
    },
    [apply, choose, current],
  );

  const choosePosting = useCallback(
    async (posting: DiscordPosting) => {
      const { makerId, serverId, channels } = current();
      if (!makerId) return;
      // A channel is chosen from the list of the server shown.
      if (posting.kind === "channel") {
        const known = posting.guildId === serverId && channels?.some((channel) => channel.id === posting.channelId);
        if (!known) return;
      }
      await choose((set, live) => apply(makerId, posting, set, live));
    },
    [apply, choose, current],
  );

  return { ...view, checkToken, recheck, startOver, waitForServer, chooseMaker, chooseServer, choosePosting };
}
