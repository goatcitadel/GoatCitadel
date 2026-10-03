// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DurableRunRecord } from "@goatcitadel/contracts";
import { fetchDurableRunHistory } from "@goatcitadel/mission-control-shared/api/durable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../../data/query-keys";
import { WorkRunHistory } from "./WorkRunHistory";

vi.mock("@goatcitadel/mission-control-shared/api/durable", () => ({ fetchDurableRunHistory: vi.fn() }));

function run(runId: string, workspaceId = "workspace-a", overrides: Partial<DurableRunRecord> = {}): DurableRunRecord {
  return { runId, workflowKey: "chat.turn.execute", status: "completed", version: 1,
    attemptCount: 1, maxAttempts: 3, payload: { workspaceId }, metadata: { objective: runId },
    createdAt: "2026-09-28T10:00:00.000Z", updatedAt: "2026-09-28T11:00:00.000Z", ...overrides };
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(fetchDurableRunHistory).mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
});

async function render(workspaceId = "workspace-a") {
  await act(async () => root.render(<QueryClientProvider client={client}><WorkRunHistory workspaceId={workspaceId} /></QueryClientProvider>));
}

async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
  if (!button) throw new Error(`Missing ${label}`);
  await act(async () => button.click());
}

describe("durable Work history", () => {
  it("loads the exact next cursor and links saved runs after activity has expired", async () => {
    vi.mocked(fetchDurableRunHistory).mockImplementation(async ({ cursor }) => cursor
      ? { items: [run("older/run") ] }
      : { items: [run("latest")], nextCursor: "older-page" });
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("latest"));
    await click("Load older runs");
    await vi.waitFor(() => expect(container.textContent).toContain("older/run"));
    expect(fetchDurableRunHistory).toHaveBeenLastCalledWith({ workspaceId: "workspace-a", limit: 100, cursor: "older-page" }, { signal: expect.any(AbortSignal) });
    expect(container.querySelector('a[href="/work/runs/older%2Frun?shell=cockpit"]')).not.toBeNull();
    expect(container.textContent).toContain("End of saved run history.");
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  it("withholds foreign, conflicting, and unbound run records defensively", async () => {
    vi.mocked(fetchDurableRunHistory).mockResolvedValue({ items: [run("allowed"), run("foreign-secret", "workspace-b"),
      run("unbound-secret", "workspace-a", { payload: {} }),
      run("conflict-secret", "workspace-a", { metadata: { workspaceId: "workspace-b", objective: "conflict-secret" } })] });
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("allowed"));
    expect(container.textContent).not.toContain("secret");
    expect(container.querySelectorAll("li")).toHaveLength(1);
  });

  it("never carries a prior workspace's rows or cursor into another workspace", async () => {
    vi.mocked(fetchDurableRunHistory).mockImplementation(async ({ workspaceId }) => workspaceId === "workspace-a"
      ? { items: [run("private-a")], nextCursor: "cursor-a" }
      : { items: [run("private-b", "workspace-b")] });
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("private-a"));
    await render("workspace-b");
    expect(container.textContent).not.toContain("private-a");
    await vi.waitFor(() => expect(container.textContent).toContain("private-b"));
    expect(fetchDurableRunHistory).toHaveBeenLastCalledWith({ workspaceId: "workspace-b", limit: 100, cursor: undefined }, { signal: expect.any(AbortSignal) });
  });

  it("keeps loaded records with a stale notice after a page failure and retries that page", async () => {
    vi.mocked(fetchDurableRunHistory).mockResolvedValueOnce({ items: [run("saved")], nextCursor: "retry-page" })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ items: [run("recovered")] });
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("saved"));
    await click("Load older runs");
    await vi.waitFor(() => expect(container.textContent).toContain("Older runs could not be loaded."));
    expect(container.textContent).toContain("Previously loaded records remain visible");
    expect(container.textContent).toContain("saved");
    await click("Try runs again");
    await vi.waitFor(() => expect(container.textContent).toContain("recovered"));
    expect(fetchDurableRunHistory).toHaveBeenLastCalledWith({ workspaceId: "workspace-a", limit: 100, cursor: "retry-page" }, { signal: expect.any(AbortSignal) });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("refreshes status when existing run controls invalidate the durable owner", async () => {
    vi.mocked(fetchDurableRunHistory).mockResolvedValueOnce({ items: [run("changing", "workspace-a", { status: "running" })] })
      .mockResolvedValueOnce({ items: [run("changing")] });
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Running"));
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.durableRuns() }); });
    await vi.waitFor(() => expect(container.textContent).toContain("Done"));
    expect(fetchDurableRunHistory).toHaveBeenCalledTimes(2);
  });
});
