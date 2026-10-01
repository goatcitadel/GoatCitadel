import { useCallback, type Dispatch, type SetStateAction, type RefObject } from "react";
import type { ChatSessionRecord, ChatSessionPrefsRecord, ChatSessionPrefsPatch } from "@goatcitadel/contracts";
import {
  ApiRequestError,
  fetchChatSessionPrefs,
  updateChatSessionPrefs,
} from "@goatcitadel/mission-control-shared/api/client";
import { resolveOptimisticChatPrefs } from "./chat-page-pure-helpers";

type PreferenceConflictDraft = { sessionId: string; patch: ChatSessionPrefsPatch } | null;
type Input = {
  lastLocalPrefMutationAtRef: RefObject<number>;
  prefMutationSequenceRef: RefObject<number>;
  prefsRef: RefObject<ChatSessionPrefsRecord | null>;
  selectedSession: ChatSessionRecord | null;
  setPrefs: Dispatch<SetStateAction<ChatSessionPrefsRecord | null>>;
  preferenceConflictDraft: PreferenceConflictDraft;
  setPreferenceConflictDraft: Dispatch<SetStateAction<PreferenceConflictDraft>>;
  refreshChatSessionAggregate: (sessionId: string) => Promise<void>;
  setUiError: (value: string | null) => void;
};

export function useChatPreferenceMutations({
  lastLocalPrefMutationAtRef,
  prefMutationSequenceRef,
  prefsRef,
  selectedSession,
  setPrefs,
  preferenceConflictDraft,
  setPreferenceConflictDraft,
  refreshChatSessionAggregate,
  setUiError,
}: Input) {
  const applyPrefPatchToSession = useCallback(
    async (
      sessionId: string,
      patch: ChatSessionPrefsPatch,
      options?: {
        syncLocalState?: boolean;
      },
    ) => {
      lastLocalPrefMutationAtRef.current = Date.now();
      const previousPrefs = prefsRef.current;
      const shouldSyncLocalState =
        options?.syncLocalState ?? (!selectedSession || selectedSession.sessionId === sessionId);
      const optimisticPrefs =
        shouldSyncLocalState && previousPrefs ? resolveOptimisticChatPrefs(previousPrefs, patch) : null;
      const mutationId = prefMutationSequenceRef.current + 1;
      prefMutationSequenceRef.current = mutationId;
      if (optimisticPrefs) {
        prefsRef.current = optimisticPrefs;
        setPrefs(optimisticPrefs);
      }
      try {
        const baselinePrefs =
          previousPrefs?.sessionId === sessionId ? previousPrefs : await fetchChatSessionPrefs(sessionId);
        const updated = await updateChatSessionPrefs(sessionId, {
          ...patch,
          expectedRevision: baselinePrefs.revision,
        });
        if (prefMutationSequenceRef.current !== mutationId) {
          return updated;
        }
        if (shouldSyncLocalState) {
          prefsRef.current = updated;
          setPrefs(updated);
        }
        setPreferenceConflictDraft((current) => (current?.sessionId === sessionId ? null : current));
        return updated;
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 409) {
          const latestPrefs = await fetchChatSessionPrefs(sessionId);
          await refreshChatSessionAggregate(sessionId);
          if (shouldSyncLocalState) {
            prefsRef.current = latestPrefs;
            setPrefs(latestPrefs);
          }
          setPreferenceConflictDraft({ sessionId, patch });
          setUiError(
            "This chat changed elsewhere. Canonical preferences were refreshed; your unsaved preference draft is preserved for review and retry.",
          );
          throw err;
        }
        if (prefMutationSequenceRef.current === mutationId && previousPrefs) {
          prefsRef.current = previousPrefs;
          setPrefs(previousPrefs);
        }
        setUiError((err as Error).message);
        throw err;
      }
    },
    [
      lastLocalPrefMutationAtRef,
      prefMutationSequenceRef,
      prefsRef,
      refreshChatSessionAggregate,
      selectedSession,
      setPreferenceConflictDraft,
      setPrefs,
      setUiError,
    ],
  );
  const handlePrefPatch = useCallback(
    async (patch: ChatSessionPrefsPatch) => {
      if (!selectedSession) return;
      try {
        await applyPrefPatchToSession(selectedSession.sessionId, patch);
      } catch {
        // Errors are already surfaced in local state for dock/composer callers.
      }
    },
    [applyPrefPatchToSession, selectedSession],
  );
  const handleRetryPreferenceDraft = useCallback(async () => {
    if (!preferenceConflictDraft) return;
    try {
      await applyPrefPatchToSession(preferenceConflictDraft.sessionId, preferenceConflictDraft.patch);
    } catch (_error) {
      // The mutation helper preserves the draft and surfaces the current error.
      void _error;
    }
  }, [applyPrefPatchToSession, preferenceConflictDraft]);
  const handleDiscardPreferenceDraft = useCallback(() => {
    setPreferenceConflictDraft(null);
    setUiError(null);
  }, [setPreferenceConflictDraft, setUiError]);
  return { applyPrefPatchToSession, handlePrefPatch, handleRetryPreferenceDraft, handleDiscardPreferenceDraft };
}
