// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCronJob, fetchCronJobs } from "./cron";

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
afterEach(() => {
  vi.unstubAllGlobals();
});
describe("fresh cron owner reads", () => {
  it.each(["job", "directory"])("keeps ordinary %s coalescing but isolates a guarded preflight", async (kind) => {
    let finish!: (response: Response) => void;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(
        json(kind === "job" ? { jobId: "fresh-job", revision: 2 } : { items: [{ jobId: "fresh-job" }] }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const read = (signal?: AbortSignal) =>
      kind === "job" ? fetchCronJob("fresh-job", { signal }) : fetchCronJobs({ signal });
    const earlier = read();
    const joined = read();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    const fresh = read(controller.signal);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The fresh read sends the caller's signal (combined with the client's read timeout).
    const sent = fetchMock.mock.calls[1]?.[1]?.signal as AbortSignal;
    expect(sent.aborted).toBe(false);
    await expect(fresh).resolves.toEqual(
      kind === "job" ? { jobId: "fresh-job", revision: 2 } : { items: [{ jobId: "fresh-job" }] },
    );
    controller.abort();
    expect(sent.aborted).toBe(true);
    finish(json(kind === "job" ? { jobId: "fresh-job", revision: 1 } : { items: [] }));
    expect(await earlier).toEqual(await joined);
  });
});
