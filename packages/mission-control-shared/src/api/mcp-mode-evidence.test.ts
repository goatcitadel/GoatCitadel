import { afterEach, expect, it, vi } from "vitest";
import { fetchMcpRemotePreview, fetchMcpServerModeManifest } from "./mcp.js";
afterEach(() => vi.unstubAllGlobals());
it.each([
  { read: fetchMcpRemotePreview, path: "/api/v1/mcp/remote-preview" },
  { read: fetchMcpServerModeManifest, path: "/api/v1/mcp/server-mode/manifest" },
])("keeps fresh $path inspections separate from pending cached reads", async ({ read, path }) => {
  const resolvers: Array<(value: Response) => void> = [];
  const fetchMock = vi.fn(
    (_url: string, _init: RequestInit) => new Promise<Response>((resolve) => resolvers.push(resolve)),
  );
  vi.stubGlobal("fetch", fetchMock);
  const old = read();
  const sharedOld = read();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const signal = new AbortController().signal;
  const current = read(signal);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ cache: "no-store", signal });
  expect(fetchMock.mock.calls[1]?.[1].method ?? "GET").toBe("GET");
  expect(new URL(fetchMock.mock.calls[1]![0]).pathname).toBe(path);
  resolvers[1]!(Response.json({ generatedAt: "current" }));
  await expect(current).resolves.toEqual({ generatedAt: "current" });
  resolvers[0]!(Response.json({ generatedAt: "old" }));
  expect(await Promise.all([old, sharedOld])).toEqual([{ generatedAt: "old" }, { generatedAt: "old" }]);
});
