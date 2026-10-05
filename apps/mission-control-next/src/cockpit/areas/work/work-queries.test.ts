import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORK_HISTORY_FALLBACK_MS,
  WORK_HISTORY_MAX_PAGES,
  workspaceDurableRunsOptions,
  workspaceTasksOptions,
} from "./work-queries";

const api = vi.hoisted(() => ({ fetchTasks: vi.fn(), fetchDurableRunHistory: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/tasks", () => ({ fetchTasks: api.fetchTasks }));
vi.mock("@goatcitadel/mission-control-shared/api/durable", () => ({
  fetchDurableRunHistory: api.fetchDurableRunHistory,
}));

beforeEach(() => {
  api.fetchTasks.mockReset().mockResolvedValue({ items: [] });
  api.fetchDurableRunHistory.mockReset().mockResolvedValue({ items: [] });
});

describe("Work history queries (WK-13)", () => {
  it("poll only as a fallback and refetch a bounded number of pages", () => {
    for (const options of [workspaceTasksOptions("w"), workspaceDurableRunsOptions("w")]) {
      expect(options.refetchInterval).toBe(WORK_HISTORY_FALLBACK_MS);
      expect(options.maxPages).toBe(WORK_HISTORY_MAX_PAGES);
    }
    expect(WORK_HISTORY_FALLBACK_MS).toBe(120_000);
    expect(WORK_HISTORY_MAX_PAGES).toBe(5);
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
