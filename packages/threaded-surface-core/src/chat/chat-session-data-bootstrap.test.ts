import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "production");
});
afterEach(() => {
  vi.unstubAllEnvs();
});
describe("production bootstrap read coalescing", () => {
  it("shares only an equal pending owner key and rereads after successful settlement", async () => {
    const { getDevBootstrapPromise } = await import("./chat-session-data-bootstrap");
    const cache = new Map();
    const deferred = held<string>();
    const read = vi.fn(() => deferred.promise);
    const first = getDevBootstrapPromise(cache, "gateway/caller-revision/workspace/session", read),
      second = getDevBootstrapPromise(cache, "gateway/caller-revision/workspace/session", read);
    expect(first).toBe(second);
    expect(read).toHaveBeenCalledTimes(1);
    deferred.resolve("current");
    await expect(first).resolves.toBe("current");
    const fresh = vi.fn(async () => "fresh");
    await expect(getDevBootstrapPromise(cache, "gateway/caller-revision/workspace/session", fresh)).resolves.toBe(
      "fresh",
    );
    expect(fresh).toHaveBeenCalledTimes(1);
  });
  it("does not coalesce another caller, workspace or session key", async () => {
    const { getDevBootstrapPromise } = await import("./chat-session-data-bootstrap");
    const cache = new Map();
    const deferred = held<string>();
    const read = vi.fn(() => deferred.promise);
    const keys = [
      "gw/caller-a/ws/session",
      "gw/caller-b/ws/session",
      "gw/caller-a/other/session",
      "gw/caller-a/ws/other",
    ];
    const reads = keys.map((key) => getDevBootstrapPromise(cache, key, read));
    expect(read).toHaveBeenCalledTimes(4);
    deferred.resolve("current");
    await Promise.all(reads);
  });
  it("evicts rejected reads and does not replay the failure", async () => {
    const { getDevBootstrapPromise } = await import("./chat-session-data-bootstrap");
    const cache = new Map();
    const error = new Error("Unavailable");
    await expect(
      getDevBootstrapPromise(cache, "scope", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    const next = vi.fn(async () => "recovered");
    await expect(getDevBootstrapPromise(cache, "scope", next)).resolves.toBe("recovered");
    expect(next).toHaveBeenCalledTimes(1);
  });
  it("bypass preserves the explicit fresh-read contract", async () => {
    const { getDevBootstrapPromise } = await import("./chat-session-data-bootstrap");
    const cache = new Map();
    const deferred = held<string>();
    const pending = getDevBootstrapPromise(cache, "scope", () => deferred.promise);
    const fresh = vi.fn(async () => "reviewed");
    await expect(getDevBootstrapPromise(cache, "scope", fresh, { bypassCache: true })).resolves.toBe("reviewed");
    expect(fresh).toHaveBeenCalledTimes(1);
    deferred.resolve("old");
    await pending;
    expect(cache.has("scope")).toBe(false);
  });
});
