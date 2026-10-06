import { QueryClient } from "@tanstack/react-query";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";

export const COCKPIT_STALE_TIME_MS = 30_000;
/** The shared client already retries a failed GET once, so one retry here caps a failing query at four requests. */
const MAX_QUERY_RETRIES = 1;

export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (isApiRequestError(error) && error.kind === "http" && error.status !== undefined && error.status < 500) {
    return false;
  }
  return failureCount < MAX_QUERY_RETRIES;
}

export function createCockpitQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: COCKPIT_STALE_TIME_MS, retry: shouldRetryQuery, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}
