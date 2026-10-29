import { useCallback, useEffect } from "react";
import type { ChannelSetupDraft, SlackSetupCheckResult } from "@goatcitadel/contracts";
import {
  checkSlackSetup,
  createChannelSetupDraft,
  discardChannelSetupDraft,
  fetchChannelSetupDrafts,
  submitChannelSetupDraftSecrets,
  updateChannelSetupDraft,
} from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { CHAT_SETUP_PAGE, chatSetupToResume, latestDraft } from "./setup-draft-session";
import { SLACK_APP_TOKEN_FAILED, SLACK_BOT_TOKEN_FAILED, SLACK_CATALOG_ID } from "./slack-setup-model";
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
  /**
   * Stores both tokens on the draft in one write, then asks Slack whether each is accepted. Starts the draft when there
   * is none. Once both are, the draft is marked as made on this page and keeps the workspace and the bot.
   */
  checkTokens(botToken: string, appToken: string): Promise<void>;
  /** Discards the draft and its stored tokens. */
  startOver(): Promise<void>;
}

type Core = Omit<SlackSetupState, "checkTokens" | "startOver">;

const EMPTY: Core = { draft: null, workspace: null, bot: null, busy: false, error: undefined };

/** What the draft keeps of a check that worked: socket mode, and the workspace and bot by id and name. */
function draftWithWorkspace(values: Record<string, unknown>, check: SlackSetupCheckResult): Record<string, unknown> {
  return {
    ...values,
    setupPage: CHAT_SETUP_PAGE,
    receiveMode: "socket",
    slackTeamId: check.workspace.id,
    slackTeamName: check.workspace.name,
    slackBotUserId: check.bot.userId,
  };
}

/**
 * Slack's setup: the draft being built and the workspace and bot its two tokens belong to. Everything the draft holds is
 * the gateway's; this keeps the latest copy it returned, because every write to a draft must carry the version the last
 * one returned. The tokens themselves are never kept: they go to the draft's secure store and no further, and nothing
 * the page reads from here, or says, quotes either.
 *
 * A setup made on this page goes on where it was left (`chatSetupToResume`): a draft Settings made is Settings'. When
 * both its tokens are stored, the page asks Slack about them again, so an app changed in Slack in between is seen as it
 * is now.
 *
 * A token that is not accepted ends the check there. A bot token Slack refuses, or cannot be asked about, gives one
 * sentence; an app-level token it refuses gives another, and nothing more is written to the draft. Both tokens are
 * stored by then, so the next try sends both again on the same draft.
 */
export function useSlackSetup(workspaceId: string, resumeDraftId?: string): SlackSetupState {
  const { view, current, begin, reset } = useSetupState<Core>(EMPTY);

  useEffect(() => {
    let gone = false;
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
      if (gone) return;
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
      if (gone) return;
      if (check.appToken !== "ok") {
        set({ busy: false, error: SLACK_APP_TOKEN_FAILED });
        return;
      }
      set({ workspace: check.workspace, bot: check.bot, busy: false });
    })();
    return () => {
      gone = true;
      reset();
    };
  }, [workspaceId, resumeDraftId, begin, reset]);

  const checkTokens = useCallback(
    async (botToken: string, appToken: string) => {
      const bot = botToken.trim();
      const app = appToken.trim();
      if (!bot || !app || current().busy) return;
      const set = begin();
      set({ workspace: null, bot: null, busy: true, error: undefined });
      let draft = current().draft;
      try {
        draft ??= await createChannelSetupDraft({ catalogId: SLACK_CATALOG_ID, lifecycleMode: "create" });
        // Kept at once, so a try after a failure goes on with this draft instead of making another.
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
          draft: draftWithWorkspace(stored.draft, check),
        });
        set({ draft: saved, workspace: check.workspace, bot: check.bot, busy: false });
      } catch {
        // The tokens may have been stored before the failure, which moved the draft's version on.
        const latest = draft ? await latestDraft(draft.draftId) : null;
        set({ ...(latest ? { draft: latest } : {}), busy: false, error: SLACK_BOT_TOKEN_FAILED });
      }
    },
    [begin, current],
  );

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

  return { ...view, checkTokens, startOver };
}
