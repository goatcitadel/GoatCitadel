export const PREFLIGHT_CACHE_LIMIT = 32;

/** Remember one route check without letting the cache grow without bound. */
export function rememberPreflight<T>(
  cache: Map<string, { fetchedAt: number; result: T }>,
  key: string,
  entry: { fetchedAt: number; result: T },
  now: number,
  ttlMs: number,
): void {
  for (const [existingKey, existing] of cache) {
    if (now - existing.fetchedAt >= ttlMs) {
      cache.delete(existingKey);
    }
  }
  // Delete first so a re-set key moves to the end of the insertion order.
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > PREFLIGHT_CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) {
      break;
    }
    cache.delete(oldest.value);
  }
}
