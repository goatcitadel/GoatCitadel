import { QueryClient } from "@tanstack/react-query";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";

export const COCKPIT_STALE_TIME_MS = 30_000;
const MAX_QUERY_RETRIES = 2;

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
