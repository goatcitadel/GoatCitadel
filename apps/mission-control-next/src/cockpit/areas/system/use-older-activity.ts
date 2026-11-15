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

/**
 * Older activity pages live in component state: the live query keeps the `{ items }` shape the realtime feed writes.
 * `firstCursor` is the live read's cursor; once a page has been read, that page's own cursor is the next one.
 */
export function useOlderActivity(firstCursor: string | undefined) {
  const [pages, setPages] = useState<readonly OlderPage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const alive = useRef(true);
  const pending = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const cursor = pages.length ? pages[pages.length - 1]?.nextCursor : firstCursor;
  const loadOlder = useCallback(async () => {
    if (!cursor || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const page = await fetchRealtimeEvents(PAGE_SIZE, cursor);
      if (alive.current) setPages((current) => [...current, page]);
    } catch (cause) {
      if (alive.current) setError(describeApiError(cause).summary);
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }, [cursor]);
  return { pages, hasMore: Boolean(cursor), busy, error, loadOlder };
}
