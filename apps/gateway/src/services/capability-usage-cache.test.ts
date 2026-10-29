import { describe, expect, it, vi } from "vitest";
import { createUsageCache, USAGE_CACHE_MS } from "./capability-usage-cache.js";

const START = new Date("2026-10-28T12:00:00.000Z");

/** A cache over a clock the test moves by hand. */
function build<T>(read: () => Promise<T>) {
  let current = START;
  const reader = vi.fn(read);
  const cache = createUsageCache(reader, { cacheMs: USAGE_CACHE_MS, now: () => current });
  return {
    cache,
    reader,
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createUsageCache", () => {
  it("keeps the answer for 10 minutes", () => {
    expect(USAGE_CACHE_MS).toBe(600_000);
  });

  it("serves the cached answer for 10 minutes and reads again on refresh", async () => {
    let reads = 0;
    const { cache, reader, advance } = build(async () => ({ read: ++reads }));

    const first = await cache.read({ refresh: false });
    advance(USAGE_CACHE_MS - 1);
    const cached = await cache.read({ refresh: false });
    expect(reader).toHaveBeenCalledTimes(1);
    expect(cached).toBe(first);

    advance(1);
    const expired = await cache.read({ refresh: false });
    expect(reader).toHaveBeenCalledTimes(2);
    expect(expired).toEqual({ read: 2 });

    const refreshed = await cache.read({ refresh: true });
    expect(reader).toHaveBeenCalledTimes(3);
    expect(refreshed).toEqual({ read: 3 });
    // The refresh replaced the cache.
    expect(await cache.read({ refresh: false })).toBe(refreshed);
    expect(reader).toHaveBeenCalledTimes(3);
  });

  it("times the cache from when the read started, not when it finished", async () => {
    const gate = deferred<string>();
    const { cache, reader, advance } = build(() => gate.promise);

    const pending = cache.read({ refresh: false });
    advance(USAGE_CACHE_MS - 1);
    gate.resolve("slow");
    await pending;

    // Only one millisecond of the cache is left, so the next read is within it...
    expect(await cache.read({ refresh: false })).toBe("slow");
    expect(reader).toHaveBeenCalledTimes(1);
    // ...and the one after that is not.
    advance(1);
    await cache.read({ refresh: false });
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it("shares one read between concurrent requests", async () => {
    const gate = deferred<{ value: number }>();
    const { cache, reader } = build(() => gate.promise);

    const requests = [cache.read({ refresh: false }), cache.read({ refresh: false }), cache.read({ refresh: false })];
    gate.resolve({ value: 1 });
    const responses = await Promise.all(requests);

    expect(reader).toHaveBeenCalledTimes(1);
    expect(responses[1]).toBe(responses[0]);
    expect(responses[2]).toBe(responses[0]);
  });

  it("doesn't cache a failed read", async () => {
    const outcomes: Array<() => Promise<string>> = [
      async () => {
        throw new Error("database is locked");
      },
      async () => "recovered",
    ];
    const { cache, reader } = build(async () => (await outcomes.shift()!)());

    await expect(cache.read({ refresh: false })).rejects.toThrow("database is locked");
    const recovered = await cache.read({ refresh: false });

    expect(reader).toHaveBeenCalledTimes(2);
    expect(recovered).toBe("recovered");
  });

  it("fails every request that shared a failed read, with the real error", async () => {
    const gate = deferred<string>();
    const { cache, reader } = build(() => gate.promise);

    const requests = [cache.read({ refresh: false }), cache.read({ refresh: false })];
    gate.reject(new Error("corrupt row"));

    await expect(requests[0]).rejects.toThrow("corrupt row");
    await expect(requests[1]).rejects.toThrow("corrupt row");
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it("fails a read that throws before it returns a promise, and caches nothing", async () => {
    let attempts = 0;
    const { cache, reader } = build((): Promise<string> => {
      attempts += 1;
      if (attempts === 1) throw new Error("synchronous failure");
      return Promise.resolve("recovered");
    });

    await expect(cache.read({ refresh: false })).rejects.toThrow("synchronous failure");
    expect(await cache.read({ refresh: false })).toBe("recovered");
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it("lets a refresh start its own read, and an older read never replaces a newer cache", async () => {
    const older = deferred<string>();
    const newer = deferred<string>();
    const pending = [older, newer];
    const { cache, reader } = build(() => pending.shift()!.promise);

    const first = cache.read({ refresh: false });
    const refreshed = cache.read({ refresh: true });
    expect(reader).toHaveBeenCalledTimes(2);
    newer.resolve("newer");
    expect(await refreshed).toBe("newer");
    older.resolve("older");
    expect(await first).toBe("older");

    expect(await cache.read({ refresh: false })).toBe("newer");
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it("reads the real clock when none is given", async () => {
    const reader = vi.fn(async () => "now");
    const cache = createUsageCache(reader, { cacheMs: USAGE_CACHE_MS });

    await cache.read({ refresh: false });
    await cache.read({ refresh: false });

    expect(reader).toHaveBeenCalledTimes(1);
  });
});
