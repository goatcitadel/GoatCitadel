/** Largest wait honored before a same-provider retry; a longer Retry-After skips the retry instead. */
export const MAX_PROVIDER_RETRY_DELAY_MS = 30_000;

type ErrorWithRetryAfter = Error & { retryAfterMs?: number };

/** Parses a Retry-After header: delta-seconds or an HTTP-date. Returns undefined for absent/invalid values. */
export function parseRetryAfterMs(value: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined;
  }
  const dateMs = /[a-z]/i.test(trimmed) ? Date.parse(trimmed) : Number.NaN;
  if (Number.isNaN(dateMs)) {
    return undefined;
  }
  return Math.max(0, dateMs - nowMs);
}

/** Records the response's Retry-After on the error so retry scheduling can honor it. */
export function attachRetryAfter<T extends Error>(error: T, response: Response): T {
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  if (retryAfterMs !== undefined) {
    (error as ErrorWithRetryAfter).retryAfterMs = retryAfterMs;
  }
  return error;
}

export function readRetryAfterMs(error: unknown): number | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const value = (error as ErrorWithRetryAfter).retryAfterMs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
