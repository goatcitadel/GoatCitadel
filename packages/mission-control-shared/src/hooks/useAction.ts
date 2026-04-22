import { useCallback, useState } from "react";
import type { ActionState } from "../state/action-state";
import { IDLE_ACTION_STATE } from "../state/action-state";

export function useAction() {
  const [actionState, setActionState] = useState<ActionState>(IDLE_ACTION_STATE);

  const run = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
    const startedAt = new Date().toISOString();
    setActionState({
      state: "pending",
      startedAt,
    });

    try {
      const data = await operation();
      setActionState({
        state: "success",
        startedAt,
        finishedAt: new Date().toISOString(),
      });
      return data;
    } catch (error) {
      setActionState({
        state: "error",
        startedAt,
        finishedAt: new Date().toISOString(),
        error: (error as Error).message,
      });
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
