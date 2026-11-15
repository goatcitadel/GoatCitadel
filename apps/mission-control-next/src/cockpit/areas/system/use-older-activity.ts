import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeEvent } from "@goatcitadel/contracts";
import { fetchRealtimeEvents } from "@goatcitadel/mission-control-shared/api/system";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";

const PAGE_SIZE = 100;
/** The most older signals this page keeps listed: signals the live list displaced plus the older pages read. */
export const MAX_OLDER_SIGNALS = 500;

type OlderPage = { items: RealtimeEvent[]; nextCursor?: string };

/** Keeps the first of each event id, in order. */
function dedupe(events: readonly RealtimeEvent[]): RealtimeEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => !seen.has(event.eventId) && seen.add(event.eventId));
}

type OlderState = {
  key: string;
  pages: readonly OlderPage[];
  /** Signals the live list pushed off its end while this page was open, newest first. */
  displaced: readonly RealtimeEvent[];
  busy: boolean;
  error?: string;
};

const fresh = (key: string): OlderState => ({ key, pages: [], displaced: [], busy: false });

/**
 * Older activity lives in component state: the live query keeps the `{ items }` shape the realtime feed writes, and
 * that feed drops its oldest item for each live one without moving its cursor. So the hook keeps what the live list
 * displaces, then the older pages, and the list stays continuous from the newest signal down to the oldest loaded.
 * Everything belongs to one `scope` (workspace and access) and one refresh: another scope, or `reset()`, shows none of
 * it, and an answer that arrives for an earlier key is dropped. Older signals are bounded by MAX_OLDER_SIGNALS,
 * dropped from the old end; `capped` says the bound applies, so nothing disappears silently.
 */
export function useOlderActivity(live: readonly RealtimeEvent[], firstCursor: string | undefined, scope: string) {
  const [epoch, setEpoch] = useState(0);
  const key = `${scope}#${epoch}`;
  const [state, setState] = useState<OlderState>(() => fresh(key));
  const alive = useRef(true);
  const currentKey = useRef(key);
  currentKey.current = key;
  const previousLive = useRef<{ key: string; items: readonly RealtimeEvent[] } | undefined>(undefined);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const previous = previousLive.current;
    previousLive.current = { key, items: live };
    if (!previous || previous.key !== key) return;
    const ids = new Set(live.map((event) => event.eventId));
    const gone = previous.items.filter((event) => !ids.has(event.eventId));
    if (!gone.length) return;
    setState((current) => {
      const base = current.key === key ? current : fresh(key);
      return { ...base, displaced: dedupe([...gone, ...base.displaced]) };
    });
  }, [live, key]);

  const view = state.key === key ? state : fresh(key);
  const liveIds = new Set(live.map((event) => event.eventId));
  const olderAll = dedupe([...view.displaced, ...view.pages.flatMap((page) => page.items)]).filter(
    (event) => !liveIds.has(event.eventId),
  );
  const older = olderAll.slice(0, MAX_OLDER_SIGNALS);
  const cursor = view.pages.length ? view.pages[view.pages.length - 1]?.nextCursor : firstCursor;
  const atBound = older.length >= MAX_OLDER_SIGNALS;
  const capped = olderAll.length > older.length || (atBound && Boolean(cursor));
  const loadOlder = useCallback(async () => {
    if (!cursor || view.busy || atBound) return;
    const started = key;
    const stillCurrent = () => alive.current && currentKey.current === started;
    setState((current) => ({ ...(current.key === started ? current : fresh(started)), busy: true, error: undefined }));
    try {
      const page = await fetchRealtimeEvents(PAGE_SIZE, cursor);
      if (stillCurrent())
        setState((current) =>
          current.key === started ? { ...current, pages: [...current.pages, page], busy: false } : current,
        );
    } catch (cause) {
      if (stillCurrent())
        setState((current) =>
          current.key === started ? { ...current, busy: false, error: describeApiError(cause).summary } : current,
        );
    }
  }, [atBound, cursor, key, view.busy]);
  const reset = useCallback(() => setEpoch((value) => value + 1), []);
  return {
    items: [...live, ...older],
    hasMore: Boolean(cursor) && !capped,
    capped,
    busy: view.busy,
    error: view.error,
    loadOlder,
    reset,
  };
}
