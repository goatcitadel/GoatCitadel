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

it("ignores a superseded in-flight read on return and reuses the cached summary on remount", async () => {
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
    // Every mount shares the one cached read; a fresh summary is not read again.
    expect(read).toHaveBeenCalledTimes(3);
    expect(state()).toBe("none");
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    client.clear();
  }
});
it("reads whenever it is rendered, at any width, and shows the running count on the phone Work tab", async () => {
  width = 390;
  read.mockResolvedValue({ items: [run()] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await mount(<WorkRunningIndicator workspaceId="a" showCount />, client);
  try {
    await vi.waitFor(() =>
      expect(view.container.querySelector("[data-work-running]")?.getAttribute("data-work-running")).toBe("running"),
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('[data-work-running] [aria-hidden="true"]')?.textContent).toBe("1");
    expect(view.container.textContent).toContain("1 queued or running interactive Chat/plan record");
  } finally {
    await view.unmount();
  }
});

async function mount(children: React.ReactNode, client: QueryClient) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
  });
  return {
    container,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
      client.clear();
    },
  };
}

it("shares one read between the rail and the collapsed rail", async () => {
  read.mockResolvedValue({ items: [run()] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await mount(
    <>
      <WorkRunningIndicator workspaceId="a" />
      <WorkRunningIndicator workspaceId="a" overlay />
    </>,
    client,
  );
  try {
    await vi.waitFor(() => expect(view.container.querySelectorAll('[data-work-running="running"]')).toHaveLength(2));
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    await view.unmount();
  }
});

it("keeps the last summary while it is read again and dates it after a failed read (NV-19)", async () => {
  read.mockResolvedValueOnce({ items: [run()] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await mount(<WorkRunningIndicator workspaceId="a" />, client);
  const node = () => view.container.querySelector<HTMLElement>("[data-work-running]")!;
  try {
    await vi.waitFor(() => expect(node().dataset.workRunning).toBe("running"));
    let release!: () => void;
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ items: [run()] });
        }),
    );
    await act(async () => {
      void client.invalidateQueries({ queryKey: ["tasks"] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(node().dataset.workRunning).toBe("running");
    expect(node().title).toMatch(/· as of /);
    await act(async () => release());
    await vi.waitFor(() => expect(node().title).not.toMatch(/· as of /));
    read.mockRejectedValueOnce(new Error("Gateway offline"));
    await act(async () => {
      void client.invalidateQueries({ queryKey: ["tasks"] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(node().dataset.workRunning).toBe("running");
    expect(node().title).toMatch(/1 queued or running .* · as of /);
  } finally {
    await view.unmount();
  }
});

it("polls only while work is running and draws each state distinctly", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  read.mockResolvedValueOnce({ items: [run()] });
  const view = await mount(<WorkRunningIndicator workspaceId="a" />, client);
  const node = () => view.container.querySelector<HTMLElement>("[data-work-running]")!;
  const interval = () => {
    const query = client.getQueryCache().findAll({ queryKey: ["tasks", "sidebar-recent-work"] })[0]!;
    // refetchInterval is an observer option, so the cached query's options type omits it.
    const option = (query.options as { refetchInterval?: number | false | ((q: typeof query) => number | false) })
      .refetchInterval;
    return typeof option === "function" ? option(query) : option;
  };
  try {
    await vi.waitFor(() => expect(node().dataset.workRunning).toBe("running"));
    expect(interval()).toBe(30_000);
    expect(node().querySelector('[aria-hidden="true"]')?.className).toContain("animate-pulse-live");
    read.mockResolvedValueOnce({ items: [] });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["tasks"] });
    });
    await vi.waitFor(() => expect(node().dataset.workRunning).toBe("none"));
    expect(interval()).toBe(false);
    expect(node().querySelector('[aria-hidden="true"]')).toBeNull();
    read.mockResolvedValueOnce({ items: [], nextCursor: "more" });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["tasks"] });
    });
    await vi.waitFor(() => expect(node().dataset.workRunning).toBe("unknown"));
    expect(interval()).toBe(false);
    expect(node().querySelector('[aria-hidden="true"]')?.className).toContain("bg-transparent");
  } finally {
    await view.unmount();
  }
});
