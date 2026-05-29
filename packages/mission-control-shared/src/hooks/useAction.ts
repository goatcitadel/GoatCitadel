import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionState } from "../state/action-state";
import { IDLE_ACTION_STATE } from "../state/action-state";

export function useAction() {
  const [actionState, setActionState] = useState<ActionState>(IDLE_ACTION_STATE);
  // Guard against setState-after-unmount: actions are frequently button-triggered
  // and may resolve after the consuming component has unmounted.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(async <T>(operation: () => Promise<T>): Promise<T> => {
    const startedAt = new Date().toISOString();
    setActionState({
      state: "pending",
      startedAt,
    });

    try {
      const data = await operation();
      if (mountedRef.current) {
        setActionState({
          state: "success",
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      }
      return data;
    } catch (error) {
      if (mountedRef.current) {
        setActionState({
          state: "error",
          startedAt,
          finishedAt: new Date().toISOString(),
          error: (error as Error).message,
        });
      }
      throw error;
    }
  }, []);

  const reset = useCallback(() => {
    setActionState(IDLE_ACTION_STATE);
  }, []);

  return {
    actionState,
    run,
    reset,
    pending: actionState.state === "pending",
  };
}
