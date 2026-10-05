// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchDurableRunHistory } from "@goatcitadel/mission-control-shared/api/durable";
import { fetchTasks } from "@goatcitadel/mission-control-shared/api/tasks";
import { WorkArea } from "./WorkArea";

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
