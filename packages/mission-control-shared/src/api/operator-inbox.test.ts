// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOperatorInbox, markOperatorInboxUpdatesRead } from "./operator-inbox";

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Inbox owner transport freshness", () => {
  it("preserves ordinary in-flight GET coalescing for existing callers", async () => {
    let finish!: (value: Response) => void;
    const fetchMock = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const first = fetchOperatorInbox("ordinary");
    const second = fetchOperatorInbox("ordinary");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish(json({ workspaceId: "ordinary", items: [] }));
    expect(await first).toEqual(await second);
  });

  it("does not let a notification reuse the pre-event empty HTTP read", async () => {
    let finishEarlier!: (value: Response) => void;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishEarlier = resolve;
          }),
      )
      .mockResolvedValueOnce(json({ workspaceId: "w & x", items: [{ id: "approval:current" }] }));
    vi.stubGlobal("fetch", fetchMock);
    // Keep the real client-core transport: a mock of request() would miss this race.
    const earlier = fetchOperatorInbox("w & x");
    const controller = new AbortController();
    const live = fetchOperatorInbox("w & x", { signal: controller.signal });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/api/v1/inbox?workspaceId=w+%26+x");
    expect(fetchMock.mock.calls[1]?.[1]?.signal).toBe(controller.signal);
    await expect(live).resolves.toMatchObject({ items: [{ id: "approval:current" }] });
    finishEarlier(json({ workspaceId: "w & x", items: [] }));
    await expect(earlier).resolves.toMatchObject({ items: [] });
  });
});

it("sends bounded reference-only acknowledgement through the shared idempotent transport", async () => {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      json({
        readStatus: { scope: "operator" },
        acknowledged: [{ id: "update", version: "a".repeat(64) }],
        skipped: [],
      }),
    );
  vi.stubGlobal("fetch", fetchMock);
  const updates = [{ id: "update", version: "a".repeat(64) }];
  await markOperatorInboxUpdatesRead("workspace-a", updates);
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(String(url)).toContain("/api/v1/inbox/updates/read");
  expect(init?.method).toBe("POST");
  expect(JSON.parse(init?.body as string)).toEqual({ workspaceId: "workspace-a", updates });
  expect(new Headers(init?.headers).get("Idempotency-Key")).toBeTruthy();
});
