import { useCallback, useRef } from "react";
import { getErrorMessage } from "../SettingsShared";
import type { ProviderNoticeSetter } from "./provider-section-types";
import {
  beginProviderMutation,
  dispatchProviderMutation,
  finishProviderMutation,
  retainProviderMutationUncertainty,
  useProviderEditorEpoch,
  useProviderMutationState,
} from "./provider-mutation-state";

export interface OAuthOperation {
  isCurrent: () => boolean;
  write: <T>(dispatch: () => Promise<T>, validate: (value: T) => void) => Promise<T>;
}

/** Shared admission survives component remounts; the store never retains credential values. */
export function useProviderOAuthOperation(workspaceId: string, setNotice: ProviderNoticeSetter) {
  const mutation = useProviderMutationState();
  const capture = useProviderEditorEpoch(workspaceId);
  const latest = useRef({ capture, setNotice });
  latest.current = { capture, setNotice };
  const run = useCallback(async <T>(task: (operation: OAuthOperation) => Promise<T>): Promise<T | undefined> => {
    if (!beginProviderMutation()) return undefined;
    const owner = latest.current;
    const isCurrent = owner.capture();
    let attempted = false,
      acknowledged = false;
    try {
      return await task({
        isCurrent,
        write: async (dispatch, validate) => {
          if (!isCurrent()) throw new Error("The provider view changed before dispatch.");
          attempted = true;
          acknowledged = false;
          const value = await dispatchProviderMutation(dispatch);
          validate(value);
          acknowledged = true;
          return value;
        },
      });
    } catch (error) {
      if (attempted && !acknowledged) retainProviderMutationUncertainty();
      if (isCurrent()) owner.setNotice({ tone: "error", message: getErrorMessage(error) });
      return undefined;
    } finally {
      finishProviderMutation();
    }
  }, []);
  return { run, mutation };
}
