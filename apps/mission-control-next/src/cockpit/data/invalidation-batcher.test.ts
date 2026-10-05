import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createInvalidationBatcher, throttleIntervalFor } from "./invalidation-batcher";

afterEach(() => vi.useRealTimers());

describe("invalidation batcher", () => {
  it("invalidates each key once for a replayed burst", async () => {
    vi.useFakeTimers();
    const invalidateQueries = vi.fn(async () => undefined);
    const batcher = createInvalidationBatcher({ invalidateQueries } as unknown as QueryClient, { delayMs: 100 });
    for (let index = 0; index < 20; index += 1) {
      batcher.invalidate(["system"]);
      batcher.invalidate(["approvals", "operator-inbox"]);
    }
    expect(invalidateQueries).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(invalidateQueries).toHaveBeenCalledTimes(2);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["system"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["approvals", "operator-inbox"] });
  });

  it("drops pending work when disposed", async () => {
    vi.useFakeTimers();
    const invalidateQueries = vi.fn(async () => undefined);
    const batcher = createInvalidationBatcher({ invalidateQueries } as unknown as QueryClient, { delayMs: 100 });
    batcher.invalidate(["chat"]);
    batcher.dispose();
    await vi.advanceTimersByTimeAsync(200);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});

describe("per-key minimum interval", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("invalidates a health key at most once every 5 s, with one trailing refresh", async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
    const batcher = createInvalidationBatcher(client, { minIntervalMs: throttleIntervalFor });
    batcher.invalidate(["system", "health"]);
    await vi.advanceTimersByTimeAsync(120);
    expect(spy).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 10; i += 1) {
      batcher.invalidate(["system", "health"]);
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(spy).toHaveBeenCalledTimes(2);
    batcher.dispose();
  });

  it("does not throttle other keys", async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
    const batcher = createInvalidationBatcher(client, { minIntervalMs: throttleIntervalFor });
    batcher.invalidate(["chat"]);
    await vi.advanceTimersByTimeAsync(120);
    batcher.invalidate(["chat"]);
    await vi.advanceTimersByTimeAsync(120);
    expect(spy).toHaveBeenCalledTimes(2);
    batcher.dispose();
  });

  it("dispose cancels a pending trailing refresh", async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
    const batcher = createInvalidationBatcher(client, { minIntervalMs: throttleIntervalFor });
    batcher.invalidate(["system", "directory"]);
    await vi.advanceTimersByTimeAsync(120);
    batcher.invalidate(["system", "directory"]);
    batcher.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("throttles health and directory prefixes only", () => {
    expect(throttleIntervalFor(["system", "health", "ws-1"])).toBe(5_000);
    expect(throttleIntervalFor(["system", "directory", "citadels"])).toBe(5_000);
    expect(throttleIntervalFor(["system"])).toBe(0);
    expect(throttleIntervalFor(["system", "onboarding"])).toBe(0);
  });
});
