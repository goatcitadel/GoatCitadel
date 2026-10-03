// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCockpitQueryClient } from "../data/query-client";
import { workspaceDurableRunsOptions, workspaceTasksOptions } from "../areas/work/work-queries";
import { preloadCockpitDestination } from "./use-cockpit-preload";

const mocks = vi.hoisted(() => ({
  installation: "http://gateway-a.invalid",
  runs: vi.fn(), tasks: vi.fn(), code: vi.fn(),
}));
vi.mock("./area-loaders", () => ({ preloadCockpitArea: mocks.code }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => mocks.installation }));
vi.mock("@goatcitadel/mission-control-shared/api/durable", () => ({ fetchDurableRunHistory: mocks.runs }));
vi.mock("@goatcitadel/mission-control-shared/api/tasks", () => ({ fetchTasks: mocks.tasks }));

let client = createCockpitQueryClient();
beforeEach(() => {
  vi.clearAllMocks();
  mocks.installation = "http://gateway-a.invalid";
  mocks.runs.mockResolvedValue({ items: [], nextCursor: "more-runs" });
  mocks.tasks.mockResolvedValue({ items: [], nextCursor: "more-tasks" });
  client = createCockpitQueryClient();
});
afterEach(() => { client.clear(); vi.unstubAllGlobals(); });

async function warmed() {
  await vi.waitFor(() => {
    expect(client.getQueryData(workspaceDurableRunsOptions("a").queryKey)).toBeDefined();
    expect(client.getQueryData(workspaceTasksOptions("a").queryKey)).toBeDefined();
  });
}

it("warms only the first bounded pages and shares them with the board", async () => {
  preloadCockpitDestination(client, "work", "a");
  preloadCockpitDestination(client, "work", "a");
  await warmed();
  await client.fetchInfiniteQuery(workspaceDurableRunsOptions("a"));
  await client.fetchInfiniteQuery(workspaceTasksOptions("a"));
  expect(mocks.runs).toHaveBeenCalledOnce();
  expect(mocks.runs.mock.calls[0]?.[0]).toEqual({ workspaceId: "a", limit: 100, cursor: undefined });
  expect(mocks.tasks).toHaveBeenCalledOnce();
  expect(mocks.tasks).toHaveBeenCalledWith(undefined, "a", { limit: 200, cursor: undefined });
});

it("keeps cached pagination intact and still obeys owner invalidation", async () => {
  const options = workspaceTasksOptions("a");
  const paginated = { pages: [{ items: [], nextCursor: "second" }, { items: [] }], pageParams: ["", "second"] };
  client.setQueryData(options.queryKey, paginated, { updatedAt: Date.now() - 60_000 });
  preloadCockpitDestination(client, "work", "a");
  expect(client.getQueryData(options.queryKey)).toBe(paginated);
  expect(mocks.tasks).not.toHaveBeenCalled();
  await client.invalidateQueries({ queryKey: ["tasks"] });
  await client.fetchInfiniteQuery(options);
  expect(mocks.tasks).toHaveBeenCalledTimes(2);
});

it("partitions preloaded pages by workspace and Gateway", async () => {
  preloadCockpitDestination(client, "work", "a");
  await warmed();
  expect(client.getQueryData(workspaceTasksOptions("b").queryKey)).toBeUndefined();
  mocks.installation = "http://gateway-b.invalid";
  expect(client.getQueryData(workspaceTasksOptions("a").queryKey)).toBeUndefined();
  expect(client.getQueryData(workspaceDurableRunsOptions("a").queryKey)).toBeUndefined();
});

it("rejects a late read begun under the previous Gateway", async () => {
  let resolve!: (page: { items: [] }) => void;
  mocks.tasks.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const oldOptions = workspaceTasksOptions("a");
  const pending = client.fetchInfiniteQuery({ ...oldOptions, retry: false });
  const rejected = expect(pending).rejects.toThrow("no longer current");
  mocks.installation = "http://gateway-b.invalid";
  resolve({ items: [] });
  await rejected;
  expect(client.getQueryData(oldOptions.queryKey)).toBeUndefined();
  expect(client.getQueryData(workspaceTasksOptions("a").queryKey)).toBeUndefined();
});

it("does not hammer failed speculative reads with repeated pointer events", async () => {
  mocks.tasks.mockRejectedValue(new Error("Unavailable"));
  preloadCockpitDestination(client, "work", "a");
  await vi.waitFor(() => expect(client.getQueryState(workspaceTasksOptions("a").queryKey)?.status).toBe("error"));
  preloadCockpitDestination(client, "work", "a");
  preloadCockpitDestination(client, "work", "a");
  expect(mocks.tasks).toHaveBeenCalledOnce();
  // An explicit destination read may retry immediately.
  mocks.tasks.mockResolvedValue({ items: [] });
  await client.fetchInfiniteQuery(workspaceTasksOptions("a"));
  expect(mocks.tasks).toHaveBeenCalledTimes(2);
});

it("avoids speculative reads when offline or using data saver", () => {
  vi.stubGlobal("navigator", { onLine: false });
  preloadCockpitDestination(client, "work", "a");
  vi.stubGlobal("navigator", { onLine: true, connection: { saveData: true } });
  preloadCockpitDestination(client, "work", "a");
  expect(mocks.code).not.toHaveBeenCalled();
  expect(mocks.tasks).not.toHaveBeenCalled();
  expect(mocks.runs).not.toHaveBeenCalled();
});
