import { afterEach, expect, it, vi } from "vitest";
import { getCitadelStructureSnapshot, listCitadels } from "./citadels.js";
afterEach(() => vi.unstubAllGlobals());
it("keeps a required scope membership read independent of an older Citadel directory GET", async () => {
  const resolvers: Array<(value: Response) => void> = [];
  const fetchMock = vi.fn((_url: string, _init: RequestInit) => new Promise<Response>((resolve) => resolvers.push(resolve)));
  vi.stubGlobal("fetch", fetchMock);
  const older = listCitadels("active", 500), coalesced = listCitadels("active", 500);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const signal = new AbortController().signal;
  const fresh = listCitadels("active", 500, { signal });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ cache: "no-store", signal });
  expect(fetchMock.mock.calls[1]?.[1]?.method ?? "GET").toBe("GET");
  const url = new URL(fetchMock.mock.calls[1]![0]);
  expect(url.pathname).toBe("/api/v1/citadels");
  expect([...url.searchParams]).toEqual([["view", "active"], ["limit", "500"]]);
  resolvers[1]!(Response.json({ items: [], view: "active" }));
  await expect(fresh).resolves.toEqual({ items: [], view: "active" });
  resolvers[0]!(Response.json({ items: [{ citadelId: "old" }], view: "active" }));
  expect(await Promise.all([older, coalesced])).toEqual([
    { items: [{ citadelId: "old" }], view: "active" }, { items: [{ citadelId: "old" }], view: "active" },
  ]);
});
it("reads the current Citadel structure independently while preserving its original single-argument API", async () => {
  const resolvers: Array<(value: Response) => void> = [];
  const fetchMock = vi.fn((_url: string, _init: RequestInit) => new Promise<Response>((resolve) => resolvers.push(resolve)));
  vi.stubGlobal("fetch", fetchMock);
  const older = getCitadelStructureSnapshot("scope/a"), coalesced = getCitadelStructureSnapshot("scope/a");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const signal = new AbortController().signal;
  const fresh = getCitadelStructureSnapshot("scope/a", { signal });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ signal, cache: "no-store" });
  expect(new URL(fetchMock.mock.calls[1]![0]).pathname).toBe("/api/v1/citadels/scope%2Fa/structure");
  const snapshot = { citadelId: "scope/a", revision: "a".repeat(64), charter: null, chambers: [] };
  resolvers[1]!(Response.json(snapshot));
  await expect(fresh).resolves.toEqual(snapshot);
  resolvers[0]!(Response.json(snapshot));
  expect(await Promise.all([older, coalesced])).toEqual([snapshot, snapshot]);
});
