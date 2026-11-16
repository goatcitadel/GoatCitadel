import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORK_HISTORY_FALLBACK_MS,
  workHistoryFallbackInterval,
  workspaceDurableRunsOptions,
  workspaceTasksOptions,
} from "./work-queries";

const api = vi.hoisted(() => ({ fetchTasks: vi.fn(), fetchDurableRunHistory: vi.fn() }));
const stream = vi.hoisted(() => ({ state: "closed" as string }));
vi.mock("@goatcitadel/mission-control-shared/state/event-stream-status-store", () => ({
  getEventStreamStatus: () => ({ state: stream.state, reconnectAttempts: 0 }),
}));
vi.mock("@goatcitadel/mission-control-shared/api/tasks", () => ({ fetchTasks: api.fetchTasks }));
vi.mock("@goatcitadel/mission-control-shared/api/durable", () => ({
  fetchDurableRunHistory: api.fetchDurableRunHistory,
}));

beforeEach(() => {
  stream.state = "closed";
  api.fetchTasks.mockReset().mockResolvedValue({ items: [] });
  api.fetchDurableRunHistory.mockReset().mockResolvedValue({ items: [] });
});

describe("Work history queries (WK-13)", () => {
  it("poll only as a fallback and keep every loaded page", () => {
    for (const options of [workspaceTasksOptions("w"), workspaceDurableRunsOptions("w")]) {
      expect(options.refetchInterval).toBe(workHistoryFallbackInterval);
      // No backward cursor exists, so a page cap would drop the newest page (the first one loaded).
      expect(options.maxPages).toBeUndefined();
    }
    expect(WORK_HISTORY_FALLBACK_MS).toBe(120_000);
  });

  it("hands a multi-page list to the head poll whatever the connection state, and keeps the timer for one page (U-WK-008)", () => {
    const twoPages = { state: { data: { pages: [{}, {}] } } };
    for (const state of ["open", "retrying", "closed"]) {
      stream.state = state;
      expect(workHistoryFallbackInterval(twoPages)).toBe(false);
      expect(workHistoryFallbackInterval({ state: { data: { pages: [{}] } } })).toBe(WORK_HISTORY_FALLBACK_MS);
      expect(workHistoryFallbackInterval({ state: {} })).toBe(WORK_HISTORY_FALLBACK_MS);
    }
  });

  it("forwards the query's abort signal to the task read", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await client.fetchInfiniteQuery(workspaceTasksOptions("w"));
    expect(api.fetchTasks).toHaveBeenCalledWith(undefined, "w", {
      limit: 200,
      cursor: undefined,
      signal: expect.any(AbortSignal),
    });
    await client.fetchInfiniteQuery(workspaceDurableRunsOptions("w"));
    expect(api.fetchDurableRunHistory).toHaveBeenCalledWith(
      { workspaceId: "w", limit: 100, cursor: undefined },
      { signal: expect.any(AbortSignal) },
    );
    client.clear();
  });
});
