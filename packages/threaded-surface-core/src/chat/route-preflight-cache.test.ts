import { describe, expect, it } from "vitest";
import { PREFLIGHT_CACHE_LIMIT, rememberPreflight } from "./route-preflight-cache";

type Entry = { fetchedAt: number; result: string };

describe("rememberPreflight", () => {
  it("keeps at most the limit and drops the oldest first", () => {
    const cache = new Map<string, Entry>();
    for (let index = 0; index < 40; index += 1) {
      rememberPreflight(cache, `key-${index}`, { fetchedAt: 1000, result: `r${index}` }, 1000, 30_000);
    }
    expect(PREFLIGHT_CACHE_LIMIT).toBe(32);
    expect(cache.size).toBe(32);
    expect(cache.has("key-7")).toBe(false);
    expect(cache.has("key-8")).toBe(true);
    expect(cache.has("key-39")).toBe(true);
  });

  it("drops expired entries before any live one", () => {
    const cache = new Map<string, Entry>();
    rememberPreflight(cache, "old", { fetchedAt: 0, result: "old" }, 0, 30_000);
    rememberPreflight(cache, "live", { fetchedAt: 29_000, result: "live" }, 29_000, 30_000);
    rememberPreflight(cache, "new", { fetchedAt: 40_000, result: "new" }, 40_000, 30_000);
    expect([...cache.keys()]).toEqual(["live", "new"]);
  });

  it("moves a re-set key to the end so it is dropped last", () => {
    const cache = new Map<string, Entry>();
    for (let index = 0; index < PREFLIGHT_CACHE_LIMIT; index += 1) {
      rememberPreflight(cache, `key-${index}`, { fetchedAt: 1, result: "x" }, 1, 30_000);
    }
    rememberPreflight(cache, "key-0", { fetchedAt: 2, result: "again" }, 2, 30_000);
    rememberPreflight(cache, "extra", { fetchedAt: 2, result: "x" }, 2, 30_000);
    expect(cache.has("key-0")).toBe(true);
    expect(cache.has("key-1")).toBe(false);
  });
});
