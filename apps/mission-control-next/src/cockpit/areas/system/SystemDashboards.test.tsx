// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OPS_SAVED_BOARD_SCHEMA_VERSION, type OpsSavedBoardRecord } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { createCockpitQueryClient } from "../../data/query-client";
import { SystemDashboards } from "./SystemDashboards";
import { __resetBoardMutationsForTests } from "../../../features/native-routes/ops/board-mutation-state";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";

const api = vi.hoisted(() => ({
  fetchOpsSavedBoard: vi.fn(), fetchOpsSavedBoards: vi.fn(), fetchHealthSummary: vi.fn(),
  fetchCostSummary: vi.fn(), fetchApprovals: vi.fn(), rest: ["dashboards", "board-1"] as string[],
  updateOpsSavedBoard: vi.fn(), createOpsSavedBoard: vi.fn(), archiveOpsSavedBoard: vi.fn(), restoreOpsSavedBoard: vi.fn(),
  search: "", navigate: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/ops-saved-boards", () => ({
  fetchOpsSavedBoard: api.fetchOpsSavedBoard, fetchOpsSavedBoards: api.fetchOpsSavedBoards,
  updateOpsSavedBoard: api.updateOpsSavedBoard, createOpsSavedBoard: api.createOpsSavedBoard,
  archiveOpsSavedBoard: api.archiveOpsSavedBoard, restoreOpsSavedBoard: api.restoreOpsSavedBoard,
}));
vi.mock("@goatcitadel/mission-control-shared/api/system", () => ({
  fetchHealthSummary: api.fetchHealthSummary, fetchCostSummary: api.fetchCostSummary,
}));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({ fetchApprovals: api.fetchApprovals }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => ({ activeWorkspaceId: "default" }) }));
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ rest: api.rest, search: api.search, navigate: api.navigate }) }));

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
  __resetBoardMutationsForTests(); __resetSessionDraftsForTests();
  api.rest = ["dashboards", "board-1"];
  api.search = "";
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.fetchOpsSavedBoard.mockResolvedValue(board);
  api.fetchHealthSummary.mockResolvedValue({ daemonStatus: { running: true },
    systemVitals: { hostname: "local-host", memoryUsedBytes: 50, memoryTotalBytes: 100 } });
  api.fetchCostSummary.mockResolvedValue({ scope: "day", from: "2026-09-28T00:00:00.000Z", to: "2026-09-29T00:00:00.000Z", items: [] });
});
afterEach(() => { act(() => root.unmount()); container.remove(); client.clear(); vi.useRealTimers(); });

describe("cockpit saved board detail", () => {
  it("retains a visible canonical save receipt after the editor closes and owner query refreshes", async () => {
    const original = { ...board, requestSha256: "a".repeat(64) };
    const saved = { ...original, revision: original.revision + 1 };
    api.fetchOpsSavedBoard.mockResolvedValue(original);
    api.updateOpsSavedBoard.mockImplementation(async () => { api.fetchOpsSavedBoard.mockResolvedValue(saved); return saved; });
    await act(async () => root.render(<QueryClientProvider client={client}><SystemDashboards /></QueryClientProvider>));
    const button = (label: string) => [...container.querySelectorAll("button")].find(node => node.textContent === label)!;
    await vi.waitFor(() => expect(button("Edit layout")?.disabled).toBe(false));
    await act(async () => button("Edit layout").click());
    await act(async () => button("Review changes").click());
    await act(async () => button("Confirm save").click());
    await vi.waitFor(() => expect(container.textContent).toContain("Board saved and confirmed at revision 3."));
    expect(api.updateOpsSavedBoard).toHaveBeenCalledOnce();
    expect(container.querySelector('[aria-label="Edit board"]')).toBeNull();
    await act(async () => client.invalidateQueries({ queryKey: ["surface", "saved-board", "default", "board-1"] }));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Board saved and confirmed at revision 3.");
  });
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

describe("saved board access", () => {
  const render = () => act(async () => root.render(<QueryClientProvider client={client}><SystemDashboards /></QueryClientProvider>));
  const newBoard = () => [...container.querySelectorAll("button")].find(node => node.textContent === "New board")!;
  it("requires a successful current read before enabling create", async () => {
    api.rest = ["dashboards"];
    let finish!: (value: { items: OpsSavedBoardRecord[] }) => void;
    api.fetchOpsSavedBoards.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    client.setQueryData(["surface", "saved-boards", "default"], { items: [] });
    await render();
    expect(newBoard().disabled).toBe(true);
    await act(async () => finish({ items: [] }));
    await vi.waitFor(() => expect(newBoard().disabled).toBe(false));
    api.fetchOpsSavedBoards.mockRejectedValue(new ApiRequestError("Denied", { kind: "http", method: "GET", path: "/api/v1/ops/boards", status: 403 }));
    await act(async () => { await client.invalidateQueries(); });
    await vi.waitFor(() => expect(newBoard().disabled).toBe(true));
    expect(container.textContent).toContain("auth-none");
    expect(container.querySelector('a[href="/settings/access#device-access"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Try again");
  });
  it("does not enable create for a skipped read", async () => {
    api.rest = ["dashboards"];
    client.setDefaultOptions({ queries: { enabled: false } });
    client.setQueryData(["surface", "saved-boards", "default"], { items: [] });
    await render();
    expect(newBoard().disabled).toBe(true);
    expect(api.fetchOpsSavedBoards).not.toHaveBeenCalled();
  });
  it("does not automatically retry or poll a permission denial", async () => {
    vi.useFakeTimers();
    api.rest = ["dashboards"];
    client = createCockpitQueryClient();
    api.fetchOpsSavedBoards.mockRejectedValue(new ApiRequestError("Denied", { kind: "http", method: "GET", path: "/api/v1/ops/boards", status: 403 }));
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Dashboards unavailable"));
    await act(async () => { await vi.advanceTimersByTimeAsync(125_000); });
    expect(api.fetchOpsSavedBoards).toHaveBeenCalledTimes(1);
    expect(newBoard().disabled).toBe(true);
  });
});

describe("saved board details", () => {
  const render = () => act(async () => root.render(<QueryClientProvider client={client}><SystemDashboards /></QueryClientProvider>));
  it("shows identity, revision history and archive metadata in plain language", async () => {
    api.fetchOpsSavedBoard.mockResolvedValue({ ...board, status: "archived", revision: 3, updatedByActorId: "operator-2",
      updatedAt: "2026-09-28T02:00:00.000Z", archivedByActorId: "operator-2", archivedAt: "2026-09-28T02:00:00.000Z" });
    await render();
    const details = await vi.waitFor(() => {
      const node = [...container.querySelectorAll("details")].find((item) => item.querySelector("summary")?.textContent === "Board details");
      expect(node).toBeDefined();
      return node!;
    });
    for (const text of ["Board ID", "board-1", "Revision", "3", "Status", "Archived", "Created by", "operator", "Last updated by", "operator-2", "Archived by"])
      expect(details.textContent).toContain(text);
    expect(details.textContent).toContain("A saved board is a layout only");
    expect(details.textContent).not.toContain("test-hash");
  });
});

describe("background refetch", () => {
  it("keeps Edit layout usable during a background refetch, while saving waits for the fresh read", async () => {
    api.fetchOpsSavedBoard.mockResolvedValue({ ...board, requestSha256: "a".repeat(64) });
    await act(async () => root.render(<QueryClientProvider client={client}><SystemDashboards /></QueryClientProvider>));
    const edit = () => [...container.querySelectorAll("button")].find((node) => node.textContent === "Edit layout");
    await vi.waitFor(() => expect(edit()?.disabled).toBe(false));
    api.fetchOpsSavedBoard.mockImplementation(() => new Promise(() => {}));
    await act(async () => { void client.refetchQueries({ queryKey: ["surface", "saved-board"] }); });
    expect(container.textContent).toContain("Saved layout revision");
    expect(client.isFetching({ queryKey: ["surface", "saved-board"] })).toBeGreaterThan(0);
    // React Query batches observer notifications on a timer; let the fetching state reach the component.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(edit()?.disabled).toBe(false);
    await act(async () => edit()!.click());
    expect(container.querySelector('[aria-label="Edit board"]')).not.toBeNull();
    expect(container.textContent).toContain("Current board access has not been verified");
  });
});

describe("saved board lifecycle", () => {
  const render = () => act(async () => root.render(<QueryClientProvider client={client}><SystemDashboards /></QueryClientProvider>));
  const button = (label: string) => [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  // The governed owner asserts a real 64-hex request hash, as the existing save test does.
  const valid = { ...board, requestSha256: "a".repeat(64) };
  const archived = { ...valid, status: "archived" as const, revision: 3, updatedAt: "2026-09-28T02:00:00.000Z",
    archivedByActorId: valid.updatedByActorId, archivedAt: "2026-09-28T02:00:00.000Z" };
  beforeEach(() => { api.fetchOpsSavedBoard.mockResolvedValue(valid); });

  it("reviews an archive, sends nothing on Cancel and exactly one CAS request on Confirm", async () => {
    api.archiveOpsSavedBoard.mockImplementation(async () => { api.fetchOpsSavedBoard.mockResolvedValue(archived); return archived; });
    await render();
    await vi.waitFor(() => expect(button("Archive board…")?.disabled).toBe(false));
    await act(async () => button("Archive board…")!.click());
    expect(dialog()?.textContent).toContain("revision 2");
    expect(dialog()?.textContent).toContain("Widgets and the data they read are untouched");
    await act(async () => button("Cancel")!.click());
    expect(dialog()).toBeNull();
    expect(api.archiveOpsSavedBoard).not.toHaveBeenCalled();
    await act(async () => button("Archive board…")!.click());
    await act(async () => button("Archive board")!.click());
    await vi.waitFor(() => expect(container.textContent).toContain("Board archived and confirmed at revision 3."));
    expect(api.archiveOpsSavedBoard).toHaveBeenCalledExactlyOnceWith("board-1", { workspaceId: "default", expectedRevision: 2 });
    expect(button("Restore board…")).toBeDefined();
    expect(button("Edit layout")).toBeUndefined();
  });

  it("restores an archived board through the same reviewed owner", async () => {
    const { archivedByActorId: _by, archivedAt: _at, ...unarchived } = archived;
    const restored = { ...unarchived, status: "active" as const, revision: 4, updatedAt: "2026-09-28T03:00:00.000Z" };
    api.fetchOpsSavedBoard.mockResolvedValue(archived);
    api.restoreOpsSavedBoard.mockImplementation(async () => { api.fetchOpsSavedBoard.mockResolvedValue(restored); return restored; });
    await render();
    await vi.waitFor(() => expect(button("Restore board…")?.disabled).toBe(false));
    await act(async () => button("Restore board…")!.click());
    expect(dialog()?.textContent).toContain("returns this saved layout to the active list");
    await act(async () => button("Restore board")!.click());
    await vi.waitFor(() => expect(container.textContent).toContain("Board restored and confirmed at revision 4."));
    expect(api.restoreOpsSavedBoard).toHaveBeenCalledExactlyOnceWith("board-1", { workspaceId: "default", expectedRevision: 3 });
  });

  it("refuses to send when the board changed during review and shows the current record", async () => {
    await render();
    await vi.waitFor(() => expect(button("Archive board…")?.disabled).toBe(false));
    await act(async () => button("Archive board…")!.click());
    api.fetchOpsSavedBoard.mockResolvedValue({ ...valid, revision: 3, name: "Renamed elsewhere" });
    await act(async () => button("Archive board")!.click());
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("This board changed during review"));
    expect(api.archiveOpsSavedBoard).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(container.textContent).toContain("Renamed elsewhere"));
  });

  it("locks lifecycle and layout writes when the outcome is unconfirmed", async () => {
    api.archiveOpsSavedBoard.mockRejectedValue(new Error("socket hang up"));
    await render();
    await vi.waitFor(() => expect(button("Archive board…")?.disabled).toBe(false));
    await act(async () => button("Archive board…")!.click());
    await act(async () => button("Archive board")!.click());
    await vi.waitFor(() => expect(document.body.textContent).toContain("The save outcome is unconfirmed"));
    await act(async () => button("Close")?.click());
    expect(button("Archive board…")?.disabled).toBe(true);
    expect(button("Edit layout")?.disabled).toBe(true);
    expect(api.archiveOpsSavedBoard).toHaveBeenCalledOnce();
  });

  it("confirms under StrictMode, where effects mount, unmount and mount again", async () => {
    api.archiveOpsSavedBoard.mockImplementation(async () => { api.fetchOpsSavedBoard.mockResolvedValue(archived); return archived; });
    await act(async () => root.render(<StrictMode><QueryClientProvider client={client}><SystemDashboards /></QueryClientProvider></StrictMode>));
    await vi.waitFor(() => expect(button("Archive board…")?.disabled).toBe(false));
    await act(async () => button("Archive board…")!.click());
    await act(async () => button("Archive board")!.click());
    await vi.waitFor(() => expect(container.textContent).toContain("Board archived and confirmed at revision 3."));
    expect(api.archiveOpsSavedBoard).toHaveBeenCalledOnce();
  });

  it("reports a Gateway revision conflict truthfully and reloads the board without locking it", async () => {
    // The board changes on the Gateway after the owner's pre-send read, so the request itself meets the CAS refusal.
    api.archiveOpsSavedBoard.mockImplementation(async () => {
      api.fetchOpsSavedBoard.mockResolvedValue({ ...valid, revision: 3, name: "Changed on the Gateway" });
      throw new ApiRequestError("Conflict", { kind: "http", method: "POST", path: "/api/v1/ops/boards/board-1/archive", status: 409,
        body: { code: "WRITE_CONFLICT", details: { resourceKind: "ops_saved_board", resourceId: "board-1", expectedRevision: 2, currentRevision: 3 } } });
    });
    await render();
    await vi.waitFor(() => expect(button("Archive board…")?.disabled).toBe(false));
    await act(async () => button("Archive board…")!.click());
    const reads = api.fetchOpsSavedBoard.mock.calls.length;
    await act(async () => button("Archive board")!.click());
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("no longer at revision 2"));
    expect(dialog()?.textContent).not.toContain("The save outcome is unconfirmed");
    await vi.waitFor(() => expect(api.fetchOpsSavedBoard.mock.calls.length).toBeGreaterThan(reads + 1));
    await act(async () => button("Close")!.click());
    await vi.waitFor(() => expect(container.textContent).toContain("Changed on the Gateway"));
    expect(button("Archive board…")?.disabled).toBe(false);
  });

  it("lists archived boards only when asked, from the URL, and labels them", async () => {
    api.rest = ["dashboards"];
    api.fetchOpsSavedBoards.mockResolvedValue({ workspaceId: "default", items: [valid] });
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Operator board"));
    expect(api.fetchOpsSavedBoards).toHaveBeenLastCalledWith({ workspaceId: "default" });
    const toggle = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) => input.closest("label")?.textContent?.includes("Show archived boards"))!;
    await act(async () => toggle.click());
    expect(api.navigate).toHaveBeenCalledWith("/system/dashboards?archived=1", { replace: true });
    act(() => root.unmount()); root = createRoot(container);
    api.search = "?archived=1";
    api.fetchOpsSavedBoards.mockResolvedValue({ workspaceId: "default", items: [valid, { ...archived, boardId: "board-2", name: "Old board" }] });
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Old board"));
    expect(api.fetchOpsSavedBoards).toHaveBeenLastCalledWith({ workspaceId: "default", includeArchived: true });
    const oldCard = [...container.querySelectorAll("li")].find((item) => item.textContent?.includes("Old board"))!;
    expect(oldCard.textContent).toContain("Archived");
  });
});
