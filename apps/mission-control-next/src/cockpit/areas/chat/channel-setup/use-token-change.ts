import { useCallback, useEffect } from "react";
import type { ChannelSetupDraft, IntegrationConnection } from "@goatcitadel/contracts";
import {
  submitChannelSetupDraftSecrets,
  updateChannelSetupDraft,
} from "@goatcitadel/mission-control-shared/api/client";
import { draftForKeyChange } from "./key-change-draft";
import { latestDraft } from "./setup-draft-session";
import type { TokenChangeChannel } from "./token-change-channels";
import type { CheckedTokens, TokenInputs } from "./token-change-model";
import { useSetupState } from "./use-setup-state";

export interface TokenChangeState {
  /** The draft the new tokens are stored on, once the first check has made or found it. */
  draft: ChannelSetupDraft | null;
  /** What the last check that worked found, once there is one. */
  checked: CheckedTokens | null;
  busy: boolean;
  error?: string;
  /** Stores the new tokens on the draft, then asks the channel's own service about them. Starts the draft when needed. */
  checkTokens(tokens: TokenInputs): Promise<void>;
  /** Asks again about the tokens already stored, after a change in the channel's own app. Sends nothing new. */
  recheck(): Promise<void>;
}

type Core = Omit<TokenChangeState, "checkTokens" | "recheck">;
type Setter = (patch: Partial<Core>) => void;

const EMPTY: Core = { draft: null, checked: null, busy: false, error: undefined };

/**
 * Writes what the channel follows from a check to the draft, unless the draft holds it already. Nothing is written
 * when there is nothing to write.
 */
async function keepDraftValues(
  draft: ChannelSetupDraft,
  values: Readonly<Record<string, unknown>>,
): Promise<ChannelSetupDraft> {
  const changed = Object.entries(values).some(([key, value]) => draft.draft[key] !== value);
  if (!changed) return draft;
  return updateChannelSetupDraft(draft.draftId, {
    expectedRevision: draft.revision,
    draft: { ...draft.draft, ...values },
  });
}

/**
 * Changing a Discord, Slack or WhatsApp channel's tokens. The draft is made, or found, on the first check, never by visiting the
 * page. A check stores the new tokens on the draft's secure store (both of Slack's in one write), asks the channel's
 * own service what they belong to, and keeps on the draft what the saved channel follows from that, leaving every
 * other setting as it was. The tokens themselves are never kept here, and neither is any message that mentions them:
 * every failure is the channel's one sentence.
 */
export function useTokenChange(
  connection: Pick<IntegrationConnection, "connectionId" | "revision">,
  channel: TokenChangeChannel,
): TokenChangeState {
  const { connectionId, revision } = connection;
  const { view, current, begin, reset } = useSetupState<Core>(EMPTY);

  // Another channel, or the page going, drops what a slow reply to a check made before would have written.
  useEffect(() => {
    reset();
    return reset;
  }, [connectionId, reset]);

  /** A failed check says one sentence. Storing the tokens may have moved the draft's version on, so it is read again. */
  const failed = useCallback(
    async (draft: ChannelSetupDraft | null, set: Setter) => {
      const latest = draft ? ((await latestDraft(draft.draftId)) ?? draft) : null;
      // A draft that no longer matches the channel can never be checked: the next try starts another.
      const usable = latest?.connectionRevision === revision ? latest : null;
      set({ draft: usable, checked: null, busy: false, error: channel.failed });
    },
    [channel, revision],
  );

  /** Asks the channel about the tokens stored on `stored`, and keeps what the channel follows on the draft. */
  const verify = useCallback(
    async (stored: ChannelSetupDraft, set: Setter) => {
      const outcome = await channel.check({ draftId: stored.draftId, expectedRevision: stored.revision });
      if (outcome.kind === "rejected") {
        // The tokens are stored, which moved the draft's version on. Nothing else is written.
        set({ draft: stored, checked: null, busy: false, error: outcome.error });
        return;
      }
      const saved = await keepDraftValues(stored, outcome.draftValues);
      set({ draft: saved, checked: outcome.checked, busy: false });
    },
    [channel],
  );

  const checkTokens = useCallback(
    async (tokens: TokenInputs) => {
      const values = channel.secretValues(tokens);
      if (!values || current().busy) return;
      const set = begin();
      set({ busy: true, error: undefined, checked: null });
      let draft = current().draft;
      try {
        draft ??= await draftForKeyChange({ connectionId, revision }, channel.catalogId);
        // Kept at once, so a try after a failure goes on with this draft instead of making another.
        set({ draft });
        draft = await submitChannelSetupDraftSecrets(draft.draftId, {
          expectedRevision: draft.revision,
          values,
        });
        set({ draft });
        await verify(draft, set);
      } catch {
        await failed(draft, set);
      }
    },
    [begin, channel, connectionId, current, failed, revision, verify],
  );

  const recheck = useCallback(async () => {
    const { draft, busy } = current();
    if (!draft || busy) return;
    const set = begin();
    // What was found stays on show while the question is asked, so the page does not flicker between its two views.
    set({ busy: true, error: undefined });
    try {
      await verify(draft, set);
    } catch {
      await failed(draft, set);
    }
  }, [begin, current, failed, verify]);

  return { ...view, checkTokens, recheck };
}
