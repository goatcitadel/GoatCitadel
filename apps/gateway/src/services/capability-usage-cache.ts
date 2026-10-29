/** How long a read of the use counts is served again. Each read scans a year of finished chat history. */
export const USAGE_CACHE_MS = 600_000;

export interface UsageCache<T> {
  /**
   * Concurrent reads share one query. `refresh` skips the cache and reads afresh; a failed read is never cached.
   * A read that fails rejects with the real error, and the caller decides what to show.
   */
  read(options: { refresh: boolean }): Promise<T>;
}

interface Read<T> {
  /** Set once the read starts; the read itself may finish before the caller stores it. */
  promise?: Promise<T>;
}

/**
 * Caches one expensive read for `cacheMs`, timed from when the read started. Only the newest read may fill the cache,
 * so a slow read that a refresh overtook can't put older counts back.
 */
export function createUsageCache<T>(
  read: () => Promise<T>,
  options: { cacheMs: number; now?: () => Date },
): UsageCache<T> {
  const now = options.now ?? (() => new Date());
  let cached: { value: T; readAtMs: number } | undefined;
  /** The newest read that has not settled. Only the newest read may fill the cache or clear this. */
  let latest: Read<T> | undefined;

  async function load(self: Read<T>): Promise<T> {
    const readAtMs = now().getTime();
    try {
      const value = await read();
      if (latest === self) {
        cached = { value, readAtMs };
      }
      return value;
    } finally {
      if (latest === self) {
        latest = undefined;
      }
    }
  }

  function startRead(): Promise<T> {
    const self: Read<T> = {};
    latest = self;
    self.promise = load(self);
    return self.promise;
  }

  return {
    async read({ refresh }) {
      if (!refresh) {
        if (cached && now().getTime() - cached.readAtMs < options.cacheMs) {
          return cached.value;
        }
        if (latest?.promise) {
          return latest.promise;
        }
      }
      return startRead();
    },
  };
}
