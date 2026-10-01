import { afterEach, expect, it, vi } from "vitest";
import { fetchDurableRunHistory } from "./durable.js";
afterEach(() => vi.unstubAllGlobals());
it("keeps an owned current history read independent of an older coalesced workspace read", async () => {
  const resolve: Array<(value: Response) => void> = [];
  const fetchMock = vi.fn((_url: string, _init: RequestInit) => new Promise<Response>(done => resolve.push(done)));
  vi.stubGlobal("fetch", fetchMock);
  const query = { workspaceId: "history scope", limit: 100 };
  const older = fetchDurableRunHistory(query), joined = fetchDurableRunHistory(query);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const signal = new AbortController().signal;
  const fresh = fetchDurableRunHistory(query, { signal });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ signal, cache: "no-store" });
  expect(fetchMock.mock.calls[0]?.[1]?.cache).toBeUndefined();
  const url = new URL(fetchMock.mock.calls[1]![0]);
  expect(url.pathname).toBe("/api/v1/durable/runs");
  expect([...url.searchParams]).toEqual([["workspaceId", "history scope"], ["limit", "100"]]);
  resolve[1]!(Response.json({ items: [], nextCursor: "fresh-page" }));
  await expect(fresh).resolves.toEqual({ items: [], nextCursor: "fresh-page" });
  resolve[0]!(Response.json({ items: [], nextCursor: "older-page" }));
  expect(await Promise.all([older, joined])).toEqual([
    { items: [], nextCursor: "older-page" }, { items: [], nextCursor: "older-page" },
  ]);
});
