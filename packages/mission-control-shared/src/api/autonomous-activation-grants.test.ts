import { afterEach, expect, it, vi } from "vitest";
import { fetchAutonomousActivationGrants } from "./capabilities.js";

afterEach(() => vi.unstubAllGlobals());

it("keeps required fresh grant reads separate from an older coalesced list read", async () => {
  const resolvers: Array<(value: Response) => void> = [];
  const fetchMock = vi.fn(
    (_url: string, _init: RequestInit) => new Promise<Response>((resolve) => resolvers.push(resolve)),
  );
  vi.stubGlobal("fetch", fetchMock);
  const older = fetchAutonomousActivationGrants(true);
  const sharedOlder = fetchAutonomousActivationGrants(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);

  const freshSignal = new AbortController().signal;
  const fresh = fetchAutonomousActivationGrants(true, freshSignal);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ cache: "no-store", signal: freshSignal });
  expect(new URL(fetchMock.mock.calls[1]![0]).pathname).toBe("/api/v1/capabilities/autonomy-grants");
  resolvers[1]!(Response.json({ items: [{ grantId: "current-record" }] }));
  await expect(fresh).resolves.toEqual({ items: [{ grantId: "current-record" }] });

  // The earlier list remains in flight: a second required owner check must also start its own GET.
  const readback = fetchAutonomousActivationGrants(true, new AbortController().signal);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  resolvers[2]!(Response.json({ items: [{ grantId: "revoked-record" }] }));
  await expect(readback).resolves.toEqual({ items: [{ grantId: "revoked-record" }] });
  resolvers[0]!(Response.json({ items: [{ grantId: "old-record" }] }));
  expect(await Promise.all([older, sharedOlder])).toEqual([
    { items: [{ grantId: "old-record" }] },
    { items: [{ grantId: "old-record" }] },
  ]);
});
