import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { RealtimeEvent } from "@goatcitadel/mission-control-shared/api/shell-client";
import { queryKeys } from "./query-keys";

const RETAINED_LIMIT = 100;
interface ActivityPage {
  items: RealtimeEvent[];
  nextCursor?: string;
}

/**
 * Live events extend the last read of the retained window instead of re-reading it on a timer.
 * Every cached read under `queryKey` (a prefix) gains the event once, newest first, capped at 100.
 * Nothing is written before the first read, so an empty cache never looks like a complete window.
 */
export function appendRetainedActivity(
  queryClient: QueryClient,
  event: RealtimeEvent,
  queryKey: QueryKey = queryKeys.systemActivity(),
): void {
  queryClient.setQueriesData<ActivityPage>({ queryKey }, (current) => {
    if (!current) return current;
    if (current.items.some((item) => item.eventId === event.eventId)) return current;
    return { ...current, items: [event, ...current.items].slice(0, RETAINED_LIMIT) };
  });
}
