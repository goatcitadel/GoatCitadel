// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchDurableRunHistory } from "@goatcitadel/mission-control-shared/api/durable";
import { fetchTasks } from "@goatcitadel/mission-control-shared/api/tasks";
import { WorkArea } from "./WorkArea";

vi.mock("./WorkWaitingDecisions", () => ({ WorkWaitingDecisions: () => null }));
vi.mock("@goatcitadel/mission-control-shared/api/durable", () => ({ fetchDurableRunHistory: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/tasks", () => ({ fetchTasks: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "workspace-a" }),
}));
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ rest: [], navigate: vi.fn() }) }));

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(fetchDurableRunHistory).mockResolvedValue({ items: [] } as never);
});

afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  vi.clearAllMocks();
});

describe("Work task board", () => {
  it.each(["tasks", "runs"] as const)("does not report zero for unavailable %s while the other source succeeds", async source => {
    vi.mocked(fetchTasks).mockResolvedValue({ items: [] });
    if (source === "tasks") vi.mocked(fetchTasks).mockRejectedValue(new Error("Unavailable tasks"));
    else vi.mocked(fetchDurableRunHistory).mockRejectedValue(new Error("Unavailable runs"));
    await act(async () => root.render(<QueryClientProvider client={client}><WorkArea /></QueryClientProvider>));
    await vi.waitFor(() => expect(container.textContent).toContain(`${source === "tasks" ? "Tasks" : "Runs"} unavailable`));
    const lane = container.querySelector('[aria-label="Active"]')!;
    expect(lane.textContent).not.toContain(`0 ${source}`);
  });
  it.each(["tasks", "runs"] as const)("names pending %s independently of the successful empty source", async source => {
    vi.mocked(fetchTasks).mockResolvedValue({ items: [] });
    if (source === "tasks") vi.mocked(fetchTasks).mockReturnValue(new Promise(() => {}));
    else vi.mocked(fetchDurableRunHistory).mockReturnValue(new Promise(() => {}));
    await act(async () => root.render(<QueryClientProvider client={client}><WorkArea /></QueryClientProvider>));
    await vi.waitFor(() => expect(container.querySelector('[aria-label="Active"]')).not.toBeNull());
    const lane = container.querySelector('[aria-label="Active"]')!;
    expect(lane.textContent).toContain(`${source === "tasks" ? "Tasks" : "Runs"} loading`);
    expect(lane.textContent).not.toContain(`0 ${source}`);
  });
  it.each(["tasks", "runs"] as const)("marks previously loaded %s counts stale after a failed refresh", async source => {
    vi.mocked(fetchTasks).mockResolvedValue({ items: [] });
    await act(async () => root.render(<QueryClientProvider client={client}><WorkArea /></QueryClientProvider>));
    await vi.waitFor(() => expect(container.querySelector('[aria-label="Active"]')).not.toBeNull());
    if (source === "tasks") vi.mocked(fetchTasks).mockRejectedValue(new Error("Unavailable tasks"));
    else vi.mocked(fetchDurableRunHistory).mockRejectedValue(new Error("Unavailable runs"));
    const refresh = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Refresh")!;
    await act(async () => refresh.click());
    await vi.waitFor(() => expect(container.querySelector('[aria-label="Active"]')?.textContent).toContain(`0 ${source} (stale)`));
    expect([...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "New task")?.disabled).toBe(source === "tasks");
  });
  it("keeps operator tasks and runtime runs distinct and filters loaded canonical fixtures", async () => {
    vi.mocked(fetchTasks).mockResolvedValue({ items: [{ taskId: "planning", revision: 1, workspaceId: "workspace-a", title: "Outline release", status: "planning", priority: "normal", createdAt: "2026-10-06", updatedAt: "2026-10-06" }] } as never);
    vi.mocked(fetchDurableRunHistory).mockResolvedValue({ items: [{ runId: "failed", workflowKey: "chat.turn.execute", status: "failed", attemptCount: 1, maxAttempts: 3, version: 1, payload: { workspaceId: "workspace-a" }, metadata: { objective: "Runtime review" }, lastError: "Provider unavailable", createdAt: "2026-10-06", updatedAt: "2026-10-06" }] } as never);
    await act(async () => root.render(<QueryClientProvider client={client}><WorkArea /></QueryClientProvider>));
    await vi.waitFor(() => expect(container.textContent).toContain("Outline release"));
    expect(container.textContent).toContain("Operator task · Planning"); expect(container.textContent).toContain("Runtime run"); expect(container.textContent).toContain("Provider unavailable");
    const select = container.querySelector<HTMLSelectElement>("select")!;
    await act(async () => { select.value = "task"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container.querySelector('a[href="/work/runs/failed"]')).toBeNull(); expect(container.querySelector('a[href="/work/tasks/planning"]')).not.toBeNull();
    const search = container.querySelector<HTMLInputElement>("input")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, "No match"); search.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(container.querySelector('a[href="/work/tasks/planning"]')).toBeNull();
  });
  it("selects operator tasks for reviewed task actions while runtime runs stay links", async () => {
    vi.mocked(fetchTasks).mockResolvedValue({ items: [{ taskId: "blocked-1", revision: 2, workspaceId: "workspace-a", title: "Stuck import", status: "blocked", priority: "normal", createdAt: "2026-10-06", updatedAt: "2026-10-06" }] } as never);
    vi.mocked(fetchDurableRunHistory).mockResolvedValue({ items: [{ runId: "failed", workflowKey: "chat.turn.execute", status: "failed", attemptCount: 1, maxAttempts: 3, version: 1, payload: { workspaceId: "workspace-a" }, metadata: { objective: "Runtime review" }, createdAt: "2026-10-06", updatedAt: "2026-10-06" }] } as never);
    await act(async () => root.render(<QueryClientProvider client={client}><WorkArea /></QueryClientProvider>));
    await vi.waitFor(() => expect(container.textContent).toContain("Stuck import"));
    const selectTasks = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Select tasks");
    await vi.waitFor(() => expect(selectTasks()?.disabled).toBe(false));
    await act(async () => selectTasks()!.click());
    const checkbox = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(input => input.closest("label")?.textContent?.includes("Stuck import"));
    expect(checkbox).toBeDefined();
    expect(container.querySelector('a[href="/work/tasks/blocked-1"]')).toBeNull();
    expect(container.querySelector('a[href="/work/runs/failed"]')).not.toBeNull();
    expect([...container.querySelectorAll('input[type="checkbox"]')].some(input => input.closest("label")?.textContent?.includes("Runtime review"))).toBe(false);
    await act(async () => checkbox!.click());
    expect(container.querySelector('[aria-label="Task actions"]')?.textContent).toContain("1 task selected");
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Done selecting")!.click());
    expect(container.querySelector('[aria-label="Task actions"]')).toBeNull();
    expect(container.querySelector('a[href="/work/tasks/blocked-1"]')).not.toBeNull();
  });

  it("lets Select tasks work during a background task refetch", async () => {
    vi.mocked(fetchTasks).mockResolvedValue({ items: [{ taskId: "blocked-1", revision: 2, workspaceId: "workspace-a", title: "Stuck import", status: "blocked", priority: "normal", createdAt: "2026-10-06", updatedAt: "2026-10-06" }] } as never);
    await act(async () => root.render(<QueryClientProvider client={client}><WorkArea /></QueryClientProvider>));
    await vi.waitFor(() => expect(container.textContent).toContain("Stuck import"));
    vi.mocked(fetchTasks).mockImplementation(() => new Promise(() => {}));
    // A background refetch through the board's own Refresh (the query stays fetching).
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Refresh")!.click());
    // React Query batches observer notifications on a timer; let the fetching state reach the board.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector('[aria-label="Needs attention"]')?.textContent).toContain("tasks (checking)");
    const selectTasks = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Select tasks")!;
    expect(selectTasks.disabled).toBe(false);
    await act(async () => selectTasks.click());
    expect(container.querySelector('[aria-label="Task actions"]')).not.toBeNull();
  });

  it("loads the next owner cursor and omits a foreign task", async () => {
    vi.mocked(fetchTasks).mockImplementation(async (_status, _workspaceId, options) =>
      options?.cursor
        ? {
            items: [
              {
                taskId: "second",
                revision: 1,
                workspaceId: "workspace-a",
                title: "Second task",
                status: "review",
                priority: "normal",
                createdAt: "2026-09-29T00:00:00Z",
                updatedAt: "2026-09-29T01:00:00Z",
              },
            ],
          }
        : {
            items: [
              {
                taskId: "first",
                revision: 1,
                workspaceId: "workspace-a",
                title: "First task",
                status: "inbox",
                priority: "normal",
                createdAt: "2026-09-29T00:00:00Z",
                updatedAt: "2026-09-29T01:00:00Z",
              },
              {
                taskId: "foreign",
                revision: 1,
                workspaceId: "workspace-b",
                title: "Private foreign task",
                status: "inbox",
                priority: "normal",
                createdAt: "2026-09-29T00:00:00Z",
                updatedAt: "2026-09-29T01:00:00Z",
              },
            ],
            nextCursor: "cursor-2",
          },
    );
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <WorkArea />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(container.textContent).toContain("First task"));
    expect(container.textContent).not.toContain("Private foreign task");
    const more = [...container.querySelectorAll("button")].find((button) => button.textContent === "Load more tasks");
    if (!more) throw new Error("Missing pagination control");
    await act(async () => more.click());
    await vi.waitFor(() => expect(container.textContent).toContain("Second task"));
    expect(fetchTasks).toHaveBeenCalledWith(undefined, "workspace-a", {
      limit: 200,
      cursor: "cursor-2",
      signal: expect.any(AbortSignal),
    });
  });
});
