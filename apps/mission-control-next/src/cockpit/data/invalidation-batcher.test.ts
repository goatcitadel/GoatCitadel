import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import { createInvalidationBatcher } from "./invalidation-batcher";

afterEach(() => vi.useRealTimers());

describe("invalidation batcher", () => {
  it("invalidates each key once for a replayed burst", async () => {
    vi.useFakeTimers();
    const invalidateQueries = vi.fn(async () => undefined);
    const batcher = createInvalidationBatcher({ invalidateQueries } as unknown as QueryClient, 100);
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
    const batcher = createInvalidationBatcher({ invalidateQueries } as unknown as QueryClient, 100);
    batcher.invalidate(["chat"]);
    batcher.dispose();
    await vi.advanceTimersByTimeAsync(200);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});
