// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SystemWorkers } from "./SystemWorkers";
import { assignment, workerItem } from "./workers.test-data";

const route = vi.hoisted(() => ({ search: "", hash: "", navigate: vi.fn() }));
const registry = vi.hoisted(() => ({ value: null as unknown }));
const preferences = vi.hoisted(() => ({ activeWorkspaceId: "ws", activeCitadelId: "c", showTechnicalDetails: false }));
const api = vi.hoisted(() => ({
  fetchRemoteWorkerDetail: vi.fn(),
  fetchRemoteWorkerAssignments: vi.fn(),
  fetchRemoteWorkerReconciliation: vi.fn(),
  fetchRemoteWorkerAssignmentEvents: vi.fn(),
}));
vi.mock("../../../app/use-cockpit-route", () => ({ useCockpitRoute: () => route }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => preferences }));
vi.mock("@goatcitadel/mission-control-shared/hooks/use-current-access", () => ({
  useProjectAccess: () => ({ identity: "owner-a", current: () => true }),
}));
vi.mock("../../../data/use-workspace-name", () => ({ useWorkspaceName: () => "Aurora" }));
vi.mock("@goatcitadel/mission-control-shared/hooks/useRemoteWorkerRegistry", () => ({
  useRemoteWorkerRegistry: () => registry.value,
}));
vi.mock("@goatcitadel/mission-control-shared/api/remote-workers", () => api);
vi.mock("../../../../app/remote-worker-realtime", () => ({
  REMOTE_WORKER_REALTIME_COALESCE_MS: 25,
  RemoteWorkerRealtimeCursor: class {
    decide() {
      return { reload: false };
    }
    reset() {}
  },
  subscribeRemoteWorkerRealtime: () => () => undefined,
}));
vi.mock("./WorkerBudgets", () => ({ WorkerBudgets: () => <p>Budgets section</p> }));
vi.mock("./AssignmentInspector", () => ({
  AssignmentInspector: ({ assignmentId }: { assignmentId: string }) => <p>Inspector for {assignmentId}</p>,
}));

const ready = (items = [workerItem("worker-0001-long-identifier")]) => {
  registry.value = {
    page: { items, observedAt: "now" },
    loading: false,
    error: null,
    loadingMore: false,
    moreError: null,
    reload: vi.fn(),
    loadMore: vi.fn(),
  };
};
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  route.search = "?workspaceId=ws&keep=yes";
  route.hash = "#x";
  ready();
  api.fetchRemoteWorkerDetail.mockImplementation(async (_ws: string, id: string) => ({ item: workerItem(id) }));
  api.fetchRemoteWorkerAssignments.mockResolvedValue({ items: [assignment("assignment-1")], observedAt: "now" });
  api.fetchRemoteWorkerReconciliation.mockResolvedValue(null);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const render = async () => {
  await act(async () => root.render(<SystemWorkers />));
};
const text = () => host.textContent ?? "";

it("lists workers by name and status without raw IDs or Classic words", async () => {
  await render();
  expect(host.querySelector("h1")?.textContent).toBe("Workers");
  expect(text()).toContain("Build box");
  expect(text()).toContain("Active");
  expect(text()).toContain("4 capabilities");
  expect(text()).not.toContain("worker-0001");
  expect(text()).not.toMatch(/Canonical|admitted|evidence/i);
  expect(host.querySelector(".cockpit-embedded-classic")).toBeNull();
});

it("selects a worker by writing it to the URL, keeping other parameters and the hash", async () => {
  await render();
  const row = [...host.querySelectorAll("button")].find((node) => node.textContent?.startsWith("Build box"))!;
  await act(async () => row.click());
  const target = new URL(route.navigate.mock.calls[0]![0], "http://cockpit.invalid");
  expect(target.pathname).toBe("/system/runtime/workers");
  expect(target.searchParams.get("workerId")).toBe("worker-0001-long-identifier");
  expect(target.searchParams.get("keep")).toBe("yes");
  expect(target.hash).toBe("#x");
});

it("shows Detail unavailable for an unknown bookmarked worker and never falls back to the first row", async () => {
  route.search = "?workerId=missing";
  api.fetchRemoteWorkerDetail.mockRejectedValue(new Error("404"));
  await render();
  await vi.waitFor(() => expect(text()).toContain("Detail unavailable"));
  expect(api.fetchRemoteWorkerDetail).toHaveBeenCalledWith("ws", "missing");
  expect(text()).not.toContain("Build box");
});

it("says worker records are unavailable when the registry fails", async () => {
  registry.value = { ...(registry.value as object), page: null, error: "offline" };
  await render();
  expect(text()).toContain("Worker records are unavailable");
});

it("opens the worker's assignments and names each details button after its visible text", async () => {
  route.search = "?workerId=w1";
  await render();
  await vi.waitFor(() => expect(text()).toContain("Assignments"));
  const details = [...host.querySelectorAll("button")].find((node) => node.textContent === "Assignment details")!;
  expect(details.getAttribute("aria-label") ?? details.textContent).toMatch(/^Assignment details/);
  expect(text()).toContain("Done");
  expect(text()).toContain("Budgets section");
  expect(text()).not.toContain("assignment-1");
});

it("keeps the alert for an ambiguous worker link", async () => {
  route.search = "?workerId=a&workerId=b";
  await render();
  expect(host.textContent).toContain("does not identify one worker");
  expect(api.fetchRemoteWorkerDetail).not.toHaveBeenCalled();
});
