import { useCallback, useEffect } from "react";
import { type ChatErrorSource } from "../chat-error-copy";
import { useChatErrorState } from "./useChatErrorState";
import { useChatSessionSelection } from "./useChatSessionSelection";

type Input = {
  selection: Pick<ReturnType<typeof useChatSessionSelection>, "selectedSessionId" | "selectedSessionIdRef">;
  errorState: Pick<
    ReturnType<typeof useChatErrorState>,
    "setError" | "setErrorSource" | "setFailedAutoImageRecovery" | "failedAutoImageRecovery"
  >;
  draft: string;
};

/** Keeps late errors bound to their originating session and clears stale image recovery. */
export function useChatScopedErrors({ selection, errorState, draft }: Input) {
  const { setError } = errorState;
  const { setErrorSource } = errorState;
  const { setFailedAutoImageRecovery } = errorState;

  const setUiError = useCallback(
    (value: string | null, source: ChatErrorSource = "other") => {
      // The callback can be invoked by a promise that began in an older chat.
      // Its closure retains that chat's selectedSessionId, so ignore both a
      // stale error and stale clear rather than leaking them into the current
      // chat's composer/recovery state.
      if (selection.selectedSessionId !== selection.selectedSessionIdRef.current) {
        return;
      }
      setError(value);
      setErrorSource(value ? source : null);
      if (!value || source !== "image_generate") {
        setFailedAutoImageRecovery(null);
      }
    },
    [selection.selectedSessionId, selection.selectedSessionIdRef, setError, setErrorSource, setFailedAutoImageRecovery],
  );
  useEffect(() => {
    if (
      errorState.failedAutoImageRecovery &&
      (errorState.failedAutoImageRecovery.sessionId !== selection.selectedSessionId ||
        errorState.failedAutoImageRecovery.prompt !== draft)
    ) {
      setFailedAutoImageRecovery(null);
    }
  }, [draft, errorState.failedAutoImageRecovery, selection.selectedSessionId, setFailedAutoImageRecovery]);

  return { setUiError };
}
