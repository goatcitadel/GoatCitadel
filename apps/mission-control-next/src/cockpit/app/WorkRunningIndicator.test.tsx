// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DurableRunHistoryPage, DurableRunRecord } from "@goatcitadel/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkRunningIndicator, summarizeRecentRunningWork } from "./WorkRunningIndicator";
const read = vi.hoisted(() =>
  vi.fn<typeof import("@goatcitadel/mission-control-shared/api/durable").fetchDurableRunHistory>(),
);
vi.mock("@goatcitadel/mission-control-shared/api/durable", () => ({ fetchDurableRunHistory: read }));
function run(workspaceId = "a", status: DurableRunRecord["status"] = "running"): DurableRunRecord {
  return {
    runId: `run-${workspaceId}-${status}`,
    workflowKey: "chat.turn.execute",
    payload: { workspaceId },
    status,
    version: 1,
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  };
}
let width = 1280;
let media: EventTarget;
beforeEach(() => {
  width = 1280;
  media = new EventTarget();
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    get matches() {
      return width >= 640;
    },
    addEventListener: media.addEventListener.bind(media),
    removeEventListener: media.removeEventListener.bind(media),
  }));
});
afterEach(() => {
  read.mockReset();
  vi.unstubAllGlobals();
});
it("distinguishes known running work, partial unknown, complete empty and foreign/malformed owner records", () => {
  expect(summarizeRecentRunningWork({ items: [run()] }, "a")).toMatchObject({ state: "running", count: 1 });
  expect(summarizeRecentRunningWork({ items: [run()], nextCursor: "more" }, "a").label).toContain("At least 1");
  expect(summarizeRecentRunningWork({ items: [], nextCursor: "more" }, "a").state).toBe("unknown");
  expect(summarizeRecentRunningWork({ items: [] }, "a")).toMatchObject({ state: "none", count: 0 });
  expect(summarizeRecentRunningWork({ items: [run("foreign")] }, "a").state).toBe("unknown");
  expect(summarizeRecentRunningWork({ items: [run(), run()] }, "a").state).toBe("unknown");
  expect(summarizeRecentRunningWork({ items: [{ ...run(), payload: null }] }, "a").state).toBe("unknown");
  expect(summarizeRecentRunningWork({ items: [{ ...run(), status: "invented" }] }, "a").state).toBe("unknown");
  expect(summarizeRecentRunningWork({ items: [{ ...run(), workflowKey: "memory.maintenance" }] }, "a")).toMatchObject({
    state: "none",
    label: "No queued or running interactive Chat/plan work recorded",
  });
});
it("never publishes a prior workspace response into the new scope, and shares no mutation owner", async () => {
  let finish!: (value: DurableRunHistoryPage) => void;
  read
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValue({ items: [], nextCursor: "more" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (id: string) => (
    <QueryClientProvider client={client}>
      <WorkRunningIndicator workspaceId={id} />
    </QueryClientProvider>
  );
  try {
    await act(async () => {
      root.render(render("a"));
    });
    expect(container.textContent).toContain("unavailable");
    await act(async () => {
      root.render(render("b"));
    });
    await vi.waitFor(() => expect(container.textContent).toContain("outside the recent history window"));
    await act(async () => {
      finish({ items: [run("a")] });
    });
    expect(container.querySelector("[data-work-running]")?.getAttribute("data-work-running")).toBe("unknown");
    expect(read.mock.calls.map((call) => call[0])).toEqual([
      { workspaceId: "a", limit: 100 },
      { workspaceId: "b", limit: 100 },
    ]);
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    client.clear();
  }
});

it("keeps a returning workspace unavailable until its new signalled read settles, including cache and in-flight ABA", async () => {
  const resolve: Array<(page: DurableRunHistoryPage) => void> = [];
  read.mockImplementation(() => new Promise((done) => resolve.push(done)));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (id: string) => (
    <QueryClientProvider client={client}>
      <WorkRunningIndicator workspaceId={id} />
    </QueryClientProvider>
  );
  const state = () => container.querySelector("[data-work-running]")?.getAttribute("data-work-running");
  try {
    await act(async () => {
      root.render(render("a"));
    });
    const oldSignal = read.mock.calls[0]?.[1]?.signal;
    expect(oldSignal).toBeInstanceOf(AbortSignal);
    await act(async () => {
      root.render(render("b"));
    });
    await act(async () => {
      resolve[1]!({ items: [] });
    });
    await vi.waitFor(() => expect(state()).toBe("none"));
    await act(async () => {
      root.render(render("a"));
    });
    expect(read).toHaveBeenCalledTimes(3);
    expect(oldSignal?.aborted).toBe(true);
    expect(read.mock.calls[2]?.[1]?.signal).not.toBe(oldSignal);
    expect(state()).toBe("unknown");
    await act(async () => {
      resolve[0]!({ items: [run("a")] });
    });
    expect(state()).toBe("unknown");
    await act(async () => {
      resolve[2]!({ items: [] });
    });
    await vi.waitFor(() => expect(state()).toBe("none"));
    await act(async () => {
      root.render(null);
    });
    await act(async () => {
      root.render(render("a"));
    });
    expect(read).toHaveBeenCalledTimes(4);
    expect(state()).toBe("unknown");
    await act(async () => {
      resolve[3]!({ items: [run("foreign")] });
    });
    expect(state()).toBe("unknown");
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    client.clear();
  }
});
it("does not read or revalidate the CSS-hidden phone rail", async () => {
  width = 390;
  read.mockResolvedValue({ items: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <WorkRunningIndicator workspaceId="a" />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["tasks"] });
    });
    expect(read).not.toHaveBeenCalled();
    await act(async () => {
      width = 800;
      media.dispatchEvent(new Event("change"));
    });
    expect(read).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(container.textContent).toContain("No queued or running interactive Chat/plan work recorded"),
    );
    await act(async () => {
      width = 390;
      media.dispatchEvent(new Event("change"));
    });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["tasks"] });
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-work-running]")?.getAttribute("data-work-running")).toBe("unknown");
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    client.clear();
  }
});
