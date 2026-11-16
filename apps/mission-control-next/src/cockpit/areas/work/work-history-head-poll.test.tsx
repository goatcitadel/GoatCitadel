// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InfiniteQueryObserver, focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkHistoryHeadPoll } from "./work-history-head-poll";
import { WORK_HISTORY_FALLBACK_MS, workspaceDurableRunsOptions, workspaceTasksOptions } from "./work-queries";

const api = vi.hoisted(() => ({ fetchTasks: vi.fn(), fetchDurableRunHistory: vi.fn() }));
const stream = vi.hoisted(() => ({ state: "open" as string }));
vi.mock("@goatcitadel/mission-control-shared/api/tasks", () => ({ fetchTasks: api.fetchTasks }));
vi.mock("@goatcitadel/mission-control-shared/api/durable", () => ({
  fetchDurableRunHistory: api.fetchDurableRunHistory,
}));
vi.mock("@goatcitadel/mission-control-shared/state/event-stream-status-store", () => ({
  getEventStreamStatus: () => ({ state: stream.state, reconnectAttempts: 0 }),
}));

type Page<T> = { items: T[]; nextCursor?: string };
const task = (taskId: string, updatedAt = "2026-11-01T00:00:00.000Z") => ({ taskId, updatedAt });
const run = (runId: string, status: string, updatedAt = "2026-11-01T00:00:00.000Z") => ({ runId, status, updatedAt });
const taskPages = (): Page<ReturnType<typeof task>>[] => [
  { items: [task("t1"), task("t2")], nextCursor: "c1" },
  { items: [task("t3")], nextCursor: "c2" },
  { items: [task("t4")] },
];

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let unsubscribe: Array<() => void>;

function Probe() {
  useWorkHistoryHeadPoll("w");
  return null;
}

/** Seeds a loaded infinite query and keeps one observer on it that never fetches by itself. */
function seed(options: { queryKey: readonly unknown[] }, pages: unknown[]) {
  client.setQueryData(options.queryKey, { pages, pageParams: pages.map((_, i) => (i === 0 ? "" : `c${i}`)) });
  const observer = new InfiniteQueryObserver(client, {
    ...options,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchInterval: false,
  } as never);
  unsubscribe.push(observer.subscribe(() => undefined));
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  stream.state = "open";
  unsubscribe = [];
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.fetchTasks.mockReset().mockImplementation(async (_s: unknown, _w: unknown, o: { cursor?: string }) => {
    const pages = taskPages();
    return pages[o.cursor === "c2" ? 2 : o.cursor === "c1" ? 1 : 0];
  });
  api.fetchDurableRunHistory.mockReset().mockResolvedValue({ items: [] });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  seed(workspaceTasksOptions("w"), taskPages());
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  unsubscribe.forEach((stop) => stop());
  client.clear();
  container.remove();
  vi.useRealTimers();
});

describe("Work history head poll (U-WK-008)", () => {
  it("reads only the first page when nothing changed", async () => {
    await advance(WORK_HISTORY_FALLBACK_MS);
    expect(api.fetchTasks).toHaveBeenCalledTimes(1);
    expect(api.fetchTasks).toHaveBeenLastCalledWith(
      undefined,
      "w",
      expect.objectContaining({ cursor: undefined, limit: 200 }),
    );
  });

  it("refetches every loaded page when the first page changed", async () => {
    const changed = [task("t1", "2026-11-02T00:00:00.000Z"), task("t2")];
    api.fetchTasks.mockResolvedValueOnce({ items: changed, nextCursor: "c1" });
    await advance(WORK_HISTORY_FALLBACK_MS);
    expect(api.fetchTasks).toHaveBeenCalledTimes(1 + 3);
  });

  it("refetches every run page while a loaded older run has not finished", async () => {
    const first = { items: [run("r1", "completed")], nextCursor: "c1" };
    api.fetchDurableRunHistory.mockImplementation(async (query: { cursor?: string }) =>
      query.cursor ? { items: [run("r2", "running")] } : first,
    );
    seed(workspaceDurableRunsOptions("w"), [first, { items: [run("r2", "running")] }]);
    await advance(WORK_HISTORY_FALLBACK_MS);
    expect(api.fetchDurableRunHistory).toHaveBeenCalledTimes(1 + 2);
  });

  it("leaves every run page alone when all loaded older runs finished and the first page is the same", async () => {
    const first = { items: [run("r1", "running")], nextCursor: "c1" };
    api.fetchDurableRunHistory.mockResolvedValue(first);
    seed(workspaceDurableRunsOptions("w"), [first, { items: [run("r2", "failed")] }]);
    await advance(WORK_HISTORY_FALLBACK_MS);
    expect(api.fetchDurableRunHistory).toHaveBeenCalledTimes(1);
  });

  it("refetches every loaded page when the connection drops after the interval was chosen", async () => {
    stream.state = "closed";
    await advance(WORK_HISTORY_FALLBACK_MS);
    expect(api.fetchTasks).toHaveBeenCalledTimes(3);
  });

  it("moves a changed later-page task to the first page, so the head differs and every page refetches", async () => {
    const moved = [task("t3", "2026-11-03T00:00:00.000Z"), task("t1"), task("t2")];
    api.fetchTasks.mockResolvedValueOnce({ items: moved, nextCursor: "c1" });
    await advance(WORK_HISTORY_FALLBACK_MS);
    expect(api.fetchTasks).toHaveBeenCalledTimes(1 + 3);
  });

  it("polls a one-page list exactly once per tick through the query's own timer", async () => {
    const only = { items: [run("r1", "running")] };
    api.fetchDurableRunHistory.mockResolvedValue(only);
    client.setQueryData(workspaceDurableRunsOptions("w").queryKey, { pages: [only], pageParams: [""] } as never);
    const observer = new InfiniteQueryObserver(client, {
      ...workspaceDurableRunsOptions("w"),
      refetchOnMount: false,
      staleTime: Infinity,
    } as never);
    unsubscribe.push(observer.subscribe(() => undefined));
    await advance(WORK_HISTORY_FALLBACK_MS);
    expect(api.fetchDurableRunHistory).toHaveBeenCalledTimes(1);
  });

  it("does not start a tick while the previous one is still reading", async () => {
    let release: (page: Page<ReturnType<typeof task>>) => void = () => undefined;
    api.fetchTasks.mockReset().mockImplementation(() => new Promise((resolve) => (release = resolve)));
    await advance(WORK_HISTORY_FALLBACK_MS * 3);
    expect(api.fetchTasks).toHaveBeenCalledTimes(1);
    release(taskPages()[0]!);
  });

  it("skips the tick while the window is hidden", async () => {
    focusManager.setFocused(false);
    await advance(WORK_HISTORY_FALLBACK_MS);
    focusManager.setFocused(undefined);
    expect(api.fetchTasks).not.toHaveBeenCalled();
  });

  it("does nothing for a list with one page loaded", async () => {
    client.setQueryData(workspaceTasksOptions("w").queryKey, { pages: [taskPages()[0]], pageParams: [""] } as never);
    await advance(WORK_HISTORY_FALLBACK_MS);
    expect(api.fetchTasks).not.toHaveBeenCalled();
  });
});
