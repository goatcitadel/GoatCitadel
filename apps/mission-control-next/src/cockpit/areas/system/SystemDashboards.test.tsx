// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OPS_SAVED_BOARD_SCHEMA_VERSION, type OpsSavedBoardRecord } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SystemDashboards } from "./SystemDashboards";

const api = vi.hoisted(() => ({
  fetchOpsSavedBoard: vi.fn(), fetchOpsSavedBoards: vi.fn(), fetchHealthSummary: vi.fn(),
  fetchCostSummary: vi.fn(), fetchApprovals: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/ops-saved-boards", () => ({
  fetchOpsSavedBoard: api.fetchOpsSavedBoard, fetchOpsSavedBoards: api.fetchOpsSavedBoards,
}));
vi.mock("@goatcitadel/mission-control-shared/api/system", () => ({
  fetchHealthSummary: api.fetchHealthSummary, fetchCostSummary: api.fetchCostSummary,
}));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({ fetchApprovals: api.fetchApprovals }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => ({ activeWorkspaceId: "default" }) }));
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ rest: ["dashboards", "board-1"], navigate: vi.fn() }) }));

const board: OpsSavedBoardRecord = {
  schemaVersion: OPS_SAVED_BOARD_SCHEMA_VERSION, boardId: "board-1", workspaceId: "default", name: "Operator board",
  status: "active", revision: 2, createdByActorId: "operator", updatedByActorId: "operator",
  createdAt: "2026-09-28T00:00:00.000Z", updatedAt: "2026-09-28T01:00:00.000Z",
  idempotencyKey: "board-key", requestSha256: "test-hash",
  placements: [{ widgetId: "usage", kind: "usage_cost_summary", x: 0, y: 0, width: 6, height: 2 },
    { widgetId: "runtime", kind: "runtime_truth_summary", x: 6, y: 0, width: 6, height: 2 }],
};

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.fetchOpsSavedBoard.mockResolvedValue(board);
  api.fetchHealthSummary.mockResolvedValue({ daemonStatus: { running: true },
    systemVitals: { hostname: "local-host", memoryUsedBytes: 50, memoryTotalBytes: 100 } });
  api.fetchCostSummary.mockResolvedValue({ scope: "day", from: "2026-09-28T00:00:00.000Z", to: "2026-09-29T00:00:00.000Z", items: [] });
});
afterEach(() => { act(() => root.unmount()); container.remove(); client.clear(); });

describe("cockpit saved board detail", () => {
  it("renders current owner widgets and keeps missing cost coverage unknown", async () => {
    await act(async () => root.render(<QueryClientProvider client={client}><SystemDashboards /></QueryClientProvider>));
    await vi.waitFor(() => expect(container.textContent).toContain("Cost coverage was not reported"));
    expect(api.fetchOpsSavedBoard).toHaveBeenCalledWith("default", "board-1");
    expect(api.fetchCostSummary).toHaveBeenCalledWith("day");
    expect(container.textContent).toContain("Operator board");
    expect(container.textContent).toContain("local-host");
    expect(container.textContent).toContain("50% used");
    expect(container.textContent).toContain("Known costUnknown");
    expect(container.textContent).toContain("Host-wide status applies beyond the selected workspace");
    const placements = [...container.querySelectorAll<HTMLElement>(".cockpit-saved-board-placement")];
    expect(placements).toHaveLength(2);
    expect(placements.map((node) => [
      node.style.getPropertyValue("--board-column-start"),
      node.style.getPropertyValue("--board-column-span"),
      node.style.getPropertyValue("--board-row-start"),
      node.style.getPropertyValue("--board-row-span"),
    ])).toEqual([["1", "6", "1", "2"], ["7", "6", "1", "2"]]);
  });

  it("counts only approvals linked to the selected workspace", async () => {
    api.fetchOpsSavedBoard.mockResolvedValue({ ...board, placements: [{ ...board.placements[0]!, kind: "approval_queue_summary" }] });
    api.fetchApprovals.mockResolvedValue({ items: [
      { approvalId: "a", riskLevel: "danger", linkage: { workspaceId: "default" } },
      { approvalId: "b", riskLevel: "caution", linkage: { workspaceId: "other" } },
    ] });
    await act(async () => root.render(<QueryClientProvider client={client}><SystemDashboards /></QueryClientProvider>));
    await vi.waitFor(() => expect(container.textContent).toContain("Known pending1"));
    expect(container.textContent).toContain("High risk1");
    expect(container.textContent).toContain("Caution0");
    expect(api.fetchApprovals).toHaveBeenCalledWith({ status: "pending", workspaceId: "default", limit: 200 });
  });
});
