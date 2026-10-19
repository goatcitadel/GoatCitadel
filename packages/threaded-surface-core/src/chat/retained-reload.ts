import { useLayoutEffect, type MutableRefObject } from "react";

/**
 * The cockpit keeps a visited Chat mounted under `<Activity mode="hidden">`: state and refs survive,
 * but effects re-run when it is shown again. A load effect that re-runs for the same inputs within
 * this window keeps its data and skips the read; after it, it re-reads in the background.
 */
export const RETAINED_RELOAD_WINDOW_MS = 30_000;

export interface RetainedLoad {
  readonly key: readonly unknown[];
  readonly at: number;
}

export type RetainedReloadMode = "skip" | "background" | "fresh";

/** `fresh` for new inputs (today's behaviour), else `skip` or `background` by the age of the last load. */
export function retainedReloadMode(
  last: RetainedLoad | null,
  key: readonly unknown[],
  now: number = Date.now(),
): RetainedReloadMode {
  if (!last || last.key.length !== key.length || last.key.some((value, index) => !Object.is(value, key[index])))
    return "fresh";
  return now - last.at < RETAINED_RELOAD_WINDOW_MS ? "skip" : "background";
}

/**
 * Keeps `ref.current` equal to `value` as of the last commit. A retained (hidden) Chat can render
 * work React later discards, so writing `ref.current` during render could leak a value that never
 * showed; the layout effect runs at commit, before any passive effect that might read the ref.
 */
export function useCommitRefValue<T>(ref: MutableRefObject<T>, value: T): void {
  useLayoutEffect(() => {
    ref.current = value;
  }, [ref, value]);
}
