import { describe, expect, it, vi } from "vitest";
import type { OperatorSummary } from "@goatcitadel/contracts";
import { OperatorSummaryCache } from "./operator-summary-cache.js";

describe("OperatorSummaryCache", () => {
  const summaries: OperatorSummary[] = [
    {
      operatorId: "operator-a",
      sessionCount: 2,
      activeSessions: 1,
      lastActivityAt: "2026-03-05T10:05:00.000Z",
    },
    {
      operatorId: "operator-b",
      sessionCount: 1,
      activeSessions: 1,
      lastActivityAt: "2026-03-05T10:02:00.000Z",
    },
  ];

  it("reuses cached summaries within the TTL", () => {
    const cache = new OperatorSummaryCache(10_000);
    const loader = vi.fn(() => summaries);
    const first = cache.get(loader, Date.parse("2026-03-05T10:10:00.000Z"));
    const second = cache.get(() => [], Date.parse("2026-03-05T10:10:05.000Z"));

    expect(loader).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(second).toHaveLength(2);
    expect(second[0]).toMatchObject({
      operatorId: "operator-a",
      sessionCount: 2,
    });
  });

  it("invalidates cached summaries on demand", () => {
    const cache = new OperatorSummaryCache(10_000);
    const first = cache.get(() => summaries, Date.parse("2026-03-05T10:10:00.000Z"));
    cache.invalidate();
    const second = cache.get(() => [summaries[1]!], Date.parse("2026-03-05T10:10:01.000Z"));

    expect(second).not.toBe(first);
    expect(second).toEqual([
      expect.objectContaining({
        operatorId: "operator-b",
        sessionCount: 1,
      }),
    ]);
  });

  it("does not cache a load that was invalidated while in flight", async () => {
    const cache = new OperatorSummaryCache();
    let resolve!: (value: OperatorSummary[]) => void;
    const pending = cache.getAsync(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    cache.invalidate();
    resolve(summaries);
    await pending;
    const freshLoader = vi.fn(async () => [summaries[1]!]);
    expect(await cache.getAsync(freshLoader)).toEqual([summaries[1]!]);
    expect(freshLoader).toHaveBeenCalledOnce();
  });

  it("keeps the replacement load coalesced when an invalidated load completes", async () => {
    const cache = new OperatorSummaryCache();
    let resolveOld!: (value: OperatorSummary[]) => void;
    let resolveNew!: (value: OperatorSummary[]) => void;
    const oldLoad = cache.getAsync(
      () =>
        new Promise((done) => {
          resolveOld = done;
        }),
    );
    cache.invalidate();
    const newLoad = cache.getAsync(
      () =>
        new Promise((done) => {
          resolveNew = done;
        }),
    );
    resolveOld(summaries);
    await oldLoad;
    const duplicateLoader = vi.fn(async () => summaries);
    const duplicate = cache.getAsync(duplicateLoader);
    expect(duplicateLoader).not.toHaveBeenCalled();
    resolveNew([summaries[1]!]);
    expect(await newLoad).toEqual([summaries[1]!]);
    expect(await duplicate).toEqual([summaries[1]!]);
  });
});
