/**
 * The cockpit keeps a visited Chat mounted under `<Activity mode="hidden">`: state and refs survive,
 * but effects re-run when it is shown again. A load effect that re-runs for the same inputs within
 * this window keeps its data and skips the read; after it, it re-reads in the background.
 */
export const RETAINED_RELOAD_WINDOW_MS = 30_000;
