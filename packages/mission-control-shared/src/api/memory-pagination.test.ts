import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchMemoryItems } from "./memory";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./client-core.js", () => ({ request: mocks.request }));
beforeEach(() => { mocks.request.mockReset(); });

describe("memory enumeration client", () => {
  it("preserves scope, filters and opaque continuation and returns the full page envelope", async () => {
    const page = { items: [], total: 1_211, snapshotAt: "2026-09-13T00:00:00.000Z", nextCursor: "next.signature" };
    mocks.request.mockResolvedValue(page);
    expect(await fetchMemoryItems({
      workspaceId: "workspace a", namespace: "research & notes", status: "all", query: "needle + more",
      limit: 500, cursor: "opaque.signature",
    })).toBe(page);
    const url = new URL(mocks.request.mock.calls[0]![0], "http://local.test");
    expect(url.pathname).toBe("/api/v1/memory/items");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      workspaceId: "workspace a", namespace: "research & notes", status: "all", query: "needle + more",
      limit: "500", cursor: "opaque.signature",
    });
  });

  it("preserves a stale-page conflict so the caller can reload instead of appending partial results", async () => {
    const conflict = Object.assign(new Error("Memory changed"), { status: 409 });
    mocks.request.mockRejectedValue(conflict);
    await expect(fetchMemoryItems({ cursor: "stale.signature" })).rejects.toBe(conflict);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
});
