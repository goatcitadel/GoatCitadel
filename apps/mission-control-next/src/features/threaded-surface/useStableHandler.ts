import { useCallback, useLayoutEffect, useRef } from "react";

/*
 * Referentially stable wrappers around always-fresh callbacks.
 *
 * MissionThreadedControllerHost rebuilds its surface-props object — including
 * every per-turn handler — on each render, and it renders at animation-frame
 * cadence while a response streams. ChatThreadTurnCard is memo()ized, so the
 * only thing standing between "one card re-renders per token flush" and "all
 * sixty visible cards re-render per token flush" is the identity of these
 * handlers. Wrapping them here keeps the memo effective without refactoring
 * the host.
 */

/** Stable identity wrapper that always invokes the latest `handler`. */
export function useStableHandler<Args extends unknown[], Result>(
  handler: (...args: Args) => Result,
): (...args: Args) => Result {
  const handlerRef = useRef(handler);
  useLayoutEffect(() => {
    handlerRef.current = handler;
  });
  return useCallback((...args: Args) => handlerRef.current(...args), []);
}

/**
 * Optional-preserving variant: `undefined` stays `undefined` so presence
 * checks downstream ("render this affordance only when a handler exists")
 * keep working, while a defined handler gets a stable identity that only
 * changes when the handler's presence flips.
 */
export function useOptionalStableHandler<Args extends unknown[], Result>(
  handler: ((...args: Args) => Result) | undefined,
): ((...args: Args) => Result) | undefined {
  const handlerRef = useRef(handler);
  useLayoutEffect(() => {
    handlerRef.current = handler;
  });
  const stable = useCallback((...args: Args) => handlerRef.current?.(...args) as Result, []);
  return handler ? stable : undefined;
}
