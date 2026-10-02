import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionState } from "../state/action-state";
import { IDLE_ACTION_STATE } from "../state/action-state";

export function useAction() {
  const [actionState, setActionState] = useState<ActionState>(IDLE_ACTION_STATE);
  // Guard against setState-after-unmount: actions are frequently button-triggered
  // and may resolve after the consuming component has unmounted.
  const mountedRef = useRef(true);
  const actionIdRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      actionIdRef.current += 1;
    };
  }, []);

  const run = useCallback(async <T>(operation: () => Promise<T>): Promise<T> => {
    const actionId = ++actionIdRef.current;
    const startedAt = new Date().toISOString();
    setActionState({
      state: "pending",
      startedAt,
    });

    try {
      const data = await operation();
      if (mountedRef.current && actionIdRef.current === actionId) {
        setActionState({
          state: "success",
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      }
      return data;
    } catch (error) {
      if (mountedRef.current && actionIdRef.current === actionId) {
        setActionState({
          state: "error",
          startedAt,
          finishedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }, []);

  const reset = useCallback(() => {
    actionIdRef.current += 1;
    setActionState(IDLE_ACTION_STATE);
  }, []);

  return {
    actionState,
    run,
    reset,
    pending: actionState.state === "pending",
  };
}
