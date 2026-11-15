import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeEvent } from "@goatcitadel/contracts";
import { fetchRealtimeEvents } from "@goatcitadel/mission-control-shared/api/system";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";

const PAGE_SIZE = 100;

type OlderPage = { items: RealtimeEvent[]; nextCursor?: string };

/** The live feed followed by the older pages read so far, without a signal listed twice. */
export function mergeActivity(live: readonly RealtimeEvent[], older: readonly OlderPage[]): RealtimeEvent[] {
  const seen = new Set<string>();
  const merged: RealtimeEvent[] = [];
  for (const event of [...live, ...older.flatMap((page) => page.items)]) {
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    merged.push(event);
  }
  return merged;
}

type OlderState = { key: string; pages: readonly OlderPage[]; busy: boolean; error?: string };

/**
 * Older activity pages live in component state: the live query keeps the `{ items }` shape the realtime feed writes.
 * `firstCursor` is the live read's cursor; once a page has been read, that page's own cursor is the next one.
 * Pages belong to one `scope` (workspace and access) and one refresh: another scope, or `reset()`, shows none of
 * them, and an answer that arrives for an earlier key is dropped.
 */
export function useOlderActivity(firstCursor: string | undefined, scope: string) {
  const [epoch, setEpoch] = useState(0);
  const key = `${scope}#${epoch}`;
  const [state, setState] = useState<OlderState>({ key, pages: [], busy: false });
  const alive = useRef(true);
  const currentKey = useRef(key);
  currentKey.current = key;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const view: OlderState = state.key === key ? state : { key, pages: [], busy: false };
  const cursor = view.pages.length ? view.pages[view.pages.length - 1]?.nextCursor : firstCursor;
  const loadOlder = useCallback(async () => {
    if (!cursor || view.busy) return;
    const started = key;
    const pages = view.pages;
    setState({ key: started, pages, busy: true });
    const stillCurrent = () => alive.current && currentKey.current === started;
    try {
      const page = await fetchRealtimeEvents(PAGE_SIZE, cursor);
      if (stillCurrent()) setState({ key: started, pages: [...pages, page], busy: false });
    } catch (cause) {
      if (stillCurrent()) setState({ key: started, pages, busy: false, error: describeApiError(cause).summary });
    }
  }, [cursor, key, view.busy, view.pages]);
  const reset = useCallback(() => setEpoch((value) => value + 1), []);
  return { pages: view.pages, hasMore: Boolean(cursor), busy: view.busy, error: view.error, loadOlder, reset };
}
