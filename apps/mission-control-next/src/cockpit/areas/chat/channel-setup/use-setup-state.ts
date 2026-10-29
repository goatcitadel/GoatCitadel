import { useCallback, useRef, useState } from "react";

/**
 * A setup page's state, in the shape the Telegram page keeps its own (`useTelegramSetup`): the state to draw, the
 * latest state readable between renders, and setters that stop writing once the page has started over.
 *
 * A handler that has just awaited must see the draft a previous call returned, and React has not rendered it yet, so
 * `current()` reads a copy kept apart from the rendered one. Every write goes through a setter from `begin()`. A slow
 * reply to a call made before `reset()` (a new workspace, another draft, starting over) finds its setter dropped and
 * changes nothing.
 */
export function useSetupState<T extends object>(empty: T) {
  const [view, setView] = useState<T>(empty);
  const latest = useRef<T>(empty);
  // The state `reset` returns to, kept from the first render so a caller's literal does not have to be stable.
  const initial = useRef<T>(empty);
  // Counts resets, so a setter made earlier can tell that it is stale.
  const epoch = useRef(0);

  const current = useCallback(() => latest.current, []);

  const begin = useCallback((): ((patch: Partial<T>) => void) => {
    const mine = epoch.current;
    return (patch) => {
      if (epoch.current !== mine) return;
      latest.current = { ...latest.current, ...patch };
      setView(latest.current);
    };
  }, []);

  const reset = useCallback(() => {
    epoch.current += 1;
    latest.current = initial.current;
    setView(initial.current);
  }, []);

  return { view, current, begin, reset };
}
