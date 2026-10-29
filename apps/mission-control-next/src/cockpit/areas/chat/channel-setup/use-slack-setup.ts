import { useCallback, useEffect, useRef } from "react";
import type { ChannelSetupDraft, SlackSetupCheckResult, SlackSetupCodeSender } from "@goatcitadel/contracts";
import {
  checkSlackSetup,
  createChannelSetupDraft,
  discardChannelSetupDraft,
  fetchChannelSetupDrafts,
  submitChannelSetupDraftSecrets,
  updateChannelSetupDraft,
} from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { askForHi, loadSlackChannels, saveSlackDraft } from "./slack-choices";
import {
  SLACK_APP_TOKEN_FAILED,
  SLACK_BOT_TOKEN_FAILED,
  SLACK_CATALOG_ID,
  SLACK_SAY_HI_POLL_MS,
  SLACK_UNREACHABLE,
  savedSlackPosting,
  savedSlackSender,
  slackDraftWithPosting,
  slackDraftWithSender,
  type SlackChannel,
  type SlackPosting,
} from "./slack-setup-model";
import { listenForHi } from "./listen-for-hi";
import { createSetupCode } from "./setup-code";
import { CHAT_SETUP_PAGE, chatSetupToResume, latestDraft, markedChatSetupDraft } from "./setup-draft-session";
import { useSetupState } from "./use-setup-state";

export { SLACK_CATALOG_ID } from "./slack-setup-model";

export interface SlackSetupState {
  /** The setup in progress, or null before there is one. */
  draft: ChannelSetupDraft | null;
  /** The Slack workspace the app was made in, once both tokens have checked out. */
  workspace: { id: string; name: string } | null;
  /** The bot the tokens belong to, once both have checked out. */
  bot: { userId: string; name: string } | null;
  busy: boolean;
  error?: string;
  /** Who said hi with the code. Once they have, GoatCitadel has stopped listening. */
  sender: SlackSetupCodeSender | null;
  /** The code the operator sends their bot, while GoatCitadel is listening for it or after it expired. */
  code: string | null;
  /** The code ran out before anyone sent it. */
  codeExpired: boolean;
  /** The bot has more conversations than GoatCitadel looked through, so the hi may be hidden behind them. */
  manyConversations: boolean;
  /** The channels the bot is in, once asked for. Null before then, and when Slack couldn't be asked. */
  channels: SlackChannel[] | null;
  /** Where the bot posts, as saved on the draft. */
  posting: SlackPosting | null;
  /**
   * Stores both tokens on the draft in one write, then asks Slack whether each is accepted. Starts the draft when there
   * is none, marked as made on this page before any token is stored. Once both are accepted, the draft receives over a
   * socket. The workspace and the bot come from the check's answer and are held here, never written to the draft.
   */
  checkTokens(botToken: string, appToken: string): Promise<void>;
  /** Discards the draft and its stored tokens. */
  startOver(): Promise<void>;
  /** Saves a fresh code on the draft and listens for it, in place of any code before it. */
  newCode(): Promise<void>;
  /** Asks Slack which channels the bot is in. Only once someone has said hi. */
  refreshChannels(): Promise<void>;
  /** Saves where the bot posts. A channel is chosen from the list read last. */
  choosePosting(posting: SlackPosting): Promise<void>;
}

type Actions = "checkTokens" | "startOver" | "newCode" | "refreshChannels" | "choosePosting";
type Core = Omit<SlackSetupState, Actions>;
type Setter = (patch: Partial<Core>) => void;

/** Nobody said hi, no code, nothing chosen: what goes with tokens that have just been checked. */
const NO_CHOICES = {
  sender: null,
  code: null,
  codeExpired: false,
  manyConversations: false,
  channels: null,
  posting: null,
} as const;

const EMPTY: Core = { draft: null, workspace: null, bot: null, busy: false, error: undefined, ...NO_CHOICES };

/**
 * What the draft keeps of a check that worked: that it was made on this page, and that it receives over a socket. The
 * workspace and the bot are not written. The gateway refuses every installation identity key (`slackTeamId`,
 * `slackTeamName`, `slackBotUserId` and the rest) on any Slack draft update, because only a bound OAuth adoption
 * authors them; the page holds them in its own state from the check's answer instead.
 */
function draftAsMadeHere(values: Record<string, unknown>): Record<string, unknown> {
  return { ...values, setupPage: CHAT_SETUP_PAGE, receiveMode: "socket" };
}

/** Who said hi on an earlier visit, and where the draft says it posts, so the page goes on from there. */
function savedChoices(values: Record<string, unknown>): Pick<Core, "sender" | "posting"> {
  const sender = savedSlackSender(values);
  return { sender, posting: savedSlackPosting(values, sender) };
}

/**
 * Slack's setup: the draft being built, the workspace and bot its two tokens belong to, and who said hi and where the
 * bot posts. Everything the draft holds is the gateway's; this keeps the latest copy it returned, because every write to
 * a draft must carry the version the last one returned. The tokens themselves are never kept: they go to the draft's
 * secure store and no further, and nothing the page reads from here, or says, quotes either.
 *
 * A setup made on this page goes on where it was left (`chatSetupToResume`): a draft Settings made is Settings'. When
 * both its tokens are stored, the page asks Slack about them again, so an app changed in Slack in between is seen as it
 * is now. Who said hi and where it posts come back from the draft, so no new code is asked for.
 *
 * A token that is not accepted ends the check there. A bot token Slack refuses, or cannot be asked about, gives one
 * sentence; an app-level token it refuses gives another, and nothing more is written to the draft. Both tokens are
 * stored by then, so the next try sends both again on the same draft.
 *
 * Saying hi: `newCode` saves a one-time code on the draft and then asks Slack every few seconds whether anyone has
 * sent it to the bot. When they have, the draft is saved once with them as the only allowed sender and an owner, with
 * their direct messages as where it posts, and the asking stops. It also stops when the code expires, when the operator
 * starts over or checks the tokens again, and when the page goes. Each question reads the bot's conversations, which
 * Slack allows about 20 times a minute, so it asks for the code alone: the channel list is read once, when the
 * operator has a hi to go on from (`refreshChannels`), and again only when the operator asks. A question that fails is
 * asked again with the next, and says nothing.
 */
export function useSlackSetup(workspaceId: string, resumeDraftId?: string): SlackSetupState {
  const { view, current, begin, reset } = useSetupState<Core>(EMPTY);
  // Counts the times what was going on was dropped (the page went, the workspace changed, the operator started over or
  // checked the tokens anew, someone said hi), so a reply to something asked before changes nothing and nothing more
  // is asked or written for it.
  const generation = useRef(0);
  const stopAsking = useRef<(() => void) | null>(null);

  const invalidate = useCallback(() => {
    generation.current += 1;
    stopAsking.current?.();
    stopAsking.current = null;
  }, []);
  /** Starts following what is going on now: the returned function says whether it still is. */
  const follow = useCallback(() => {
    const mine = generation.current;
    return () => generation.current === mine;
  }, []);

  /** Asks about `code` until it is heard, runs out, or listening stops. */
  const listenFor = useCallback(
    (code: string, set: Setter, live: () => boolean) => {
      // A question and the next can find the same hi at once. It is saved once.
      let hearing = false;
      const hear = async (sender: SlackSetupCodeSender) => {
        const draft = current().draft;
        if (!draft || hearing) return;
        hearing = true;
        try {
          const outcome = await saveSlackDraft(draft, slackDraftWithSender(draft.draft, sender));
          if (!live()) return;
          if (outcome.kind === "failed") {
            // The next question finds the same hi and tries again, from the draft as it is now.
            set({ ...(outcome.latest ? { draft: outcome.latest } : {}), error: outcome.error });
            return;
          }
          invalidate();
          set({
            draft: outcome.draft,
            sender,
            posting: { kind: "direct" },
            manyConversations: false,
            error: undefined,
          });
        } finally {
          hearing = false;
        }
      };

      const ask = async () => {
        const draft = current().draft;
        // Never under a write that is going on: the draft's version would move on under the question.
        if (!draft || current().busy || !live()) return;
        const heard = await askForHi(draft, code);
        if (!live()) return;
        if (heard.sender) {
          await hear(heard.sender);
          return;
        }
        if (current().manyConversations !== heard.many) set({ manyConversations: heard.many });
      };

      // A question that fails is ignored: it is asked again with the next one.
      stopAsking.current = listenForHi(
        () => ask().catch(() => undefined),
        () => {
          if (!live()) return;
          invalidate();
          set({ codeExpired: true, manyConversations: false });
        },
        SLACK_SAY_HI_POLL_MS,
      );
    },
    [current, invalidate],
  );

  /** Saves where the bot posts, and says why when it can't. */
  const apply = useCallback(
    async (posting: SlackPosting, channels: readonly SlackChannel[], set: Setter, live: () => boolean) => {
      const draft = current().draft;
      if (!draft) return;
      const outcome = await saveSlackDraft(draft, slackDraftWithPosting(draft.draft, posting, channels));
      if (!live()) return;
      if (outcome.kind === "failed") {
        set({ ...(outcome.latest ? { draft: outcome.latest } : {}), error: outcome.error });
        return;
      }
      set({ draft: outcome.draft, posting, error: undefined });
    },
    [current],
  );

  useEffect(() => {
    const live = follow();
    const set = begin();
    void (async () => {
      set({ busy: true });
      let found: ChannelSetupDraft | null;
      try {
        const drafts = await fetchChannelSetupDrafts({ catalogId: SLACK_CATALOG_ID });
        found = chatSetupToResume(drafts.items, SLACK_CATALOG_ID, resumeDraftId);
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
      if (!found.secretState?.botToken?.configured || !found.secretState?.appToken?.configured) {
        set({ busy: false });
        return;
      }
      let check: SlackSetupCheckResult;
      try {
        check = await checkSlackSetup({
          draftId: found.draftId,
          expectedRevision: found.revision,
          checkAppToken: true,
        });
      } catch {
        set({ busy: false, error: SLACK_BOT_TOKEN_FAILED });
        return;
      }
      if (!live()) return;
      if (check.appToken !== "ok") {
        set({ busy: false, error: SLACK_APP_TOKEN_FAILED });
        return;
      }
      // The tokens were stored but the page went, or its last write failed, before the draft was set to receive over a
      // socket. That is saved before the later steps open, so Turn on never finishes a connection that cannot receive.
      let resumed = found;
      if (found.draft.receiveMode !== "socket") {
        const outcome = await saveSlackDraft(found, draftAsMadeHere(found.draft));
        if (!live()) return;
        if (outcome.kind === "failed") {
          set({ ...(outcome.latest ? { draft: outcome.latest } : {}), busy: false, error: outcome.error });
          return;
        }
        resumed = outcome.draft;
      }
      set({ draft: resumed, workspace: check.workspace, bot: check.bot, ...savedChoices(resumed.draft), busy: false });
    })();
    return () => {
      invalidate();
      reset();
    };
  }, [workspaceId, resumeDraftId, begin, reset, follow, invalidate]);

  const checkTokens = useCallback(
    async (botToken: string, appToken: string) => {
      const bot = botToken.trim();
      const app = appToken.trim();
      if (!bot || !app || current().busy) return;
      invalidate();
      const set = begin();
      set({ workspace: null, bot: null, ...NO_CHOICES, busy: true, error: undefined });
      let draft = current().draft;
      try {
        draft ??= await createChannelSetupDraft({ catalogId: SLACK_CATALOG_ID, lifecycleMode: "create" });
        // Kept at once, so a try after a failure goes on with this draft instead of making another.
        set({ draft });
        // Marked as made here before the tokens are stored, so a draft holding a token is always this page's.
        draft = await markedChatSetupDraft(draft);
        set({ draft });
        const stored = await submitChannelSetupDraftSecrets(draft.draftId, {
          expectedRevision: draft.revision,
          values: { botToken: bot, appToken: app },
        });
        const check = await checkSlackSetup({
          draftId: draft.draftId,
          expectedRevision: stored.revision,
          checkAppToken: true,
        });
        if (check.appToken !== "ok") {
          // Both tokens are stored, which moved the draft's version on. Nothing else is saved.
          set({ draft: stored, busy: false, error: SLACK_APP_TOKEN_FAILED });
          return;
        }
        const saved = await updateChannelSetupDraft(draft.draftId, {
          expectedRevision: stored.revision,
          draft: draftAsMadeHere(stored.draft),
        });
        set({ draft: saved, workspace: check.workspace, bot: check.bot, busy: false });
      } catch {
        // The tokens may have been stored before the failure, which moved the draft's version on.
        const latest = draft ? await latestDraft(draft.draftId) : null;
        set({ ...(latest ? { draft: latest } : {}), busy: false, error: SLACK_BOT_TOKEN_FAILED });
      }
    },
    [begin, current, invalidate],
  );

  const newCode = useCallback(async () => {
    const { draft, workspace, busy } = current();
    if (!draft || !workspace || busy) return;
    invalidate();
    const live = follow();
    const set = begin();
    const code = createSetupCode();
    set({ ...NO_CHOICES, busy: true, error: undefined });
    const outcome = await saveSlackDraft(draft, { ...draft.draft, setupCode: code });
    // The page may have gone while the code was being saved: then nothing may start listening for it.
    if (!live()) return;
    if (outcome.kind === "failed") {
      set({ ...(outcome.latest ? { draft: outcome.latest } : {}), busy: false, error: outcome.error });
      return;
    }
    set({ draft: outcome.draft, code, busy: false });
    listenFor(code, set, live);
  }, [begin, current, follow, invalidate, listenFor]);

  const refreshChannels = useCallback(async () => {
    const { draft, sender, busy } = current();
    if (!draft || !sender || busy) return;
    const live = follow();
    const set = begin();
    set({ busy: true, error: undefined });
    const channels = await loadSlackChannels(draft);
    if (!live()) return;
    if (!channels) {
      set({ busy: false, error: SLACK_UNREACHABLE });
      return;
    }
    set({ channels });
    // A saved channel the bot is no longer in is no choice: the draft goes back to direct messages.
    const { posting } = current();
    if (posting?.kind === "channel" && !channels.some((channel) => channel.id === posting.channelId)) {
      await apply({ kind: "direct" }, channels, set, live);
    }
    set({ busy: false });
  }, [apply, begin, current, follow]);

  const choosePosting = useCallback(
    async (posting: SlackPosting) => {
      const { sender, channels, busy } = current();
      if (!sender || busy) return;
      // A channel is chosen from the list read last.
      if (posting.kind === "channel" && !channels?.some((channel) => channel.id === posting.channelId)) return;
      const live = follow();
      const set = begin();
      set({ busy: true, error: undefined });
      await apply(posting, channels ?? [], set, live);
      set({ busy: false });
    },
    [apply, begin, current, follow],
  );

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

  return { ...view, checkTokens, startOver, newCode, refreshChannels, choosePosting };
}
