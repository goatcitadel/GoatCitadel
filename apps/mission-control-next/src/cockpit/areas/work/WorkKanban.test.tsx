// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkKanban } from "./WorkKanban";
const fixture = vi.hoisted(() => ({ search: "", hash: "", navigate: vi.fn(), task: vi.fn(), run: vi.fn() }));
vi.mock("../../app/use-cockpit-route", () => ({
  useCockpitRoute: () => ({ search: fixture.search, hash: fixture.hash, navigate: fixture.navigate }),
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "workspace-a", setActiveWorkspaceId: vi.fn() }),
}));
vi.mock("../../../features/native-routes/ops/KanbanRoutePage", () => ({
  KanbanRoutePage: (props: unknown) => {
    fixture.task(props);
    return <p>Existing revision-aware task owner</p>;
  },
}));
vi.mock("../../../features/native-routes/ops/RunDetailRoutePage", () => ({
  RunDetailRoutePage: (props: unknown) => {
    fixture.run(props);
    return <p>Existing run evidence owner</p>;
  },
}));
vi.mock("../../data/use-operator-inbox", () => ({
  useOperatorInbox: () => ({
    isError: false,
    data: { workspaceId: "workspace-a", items: [], counts: { needs_decision: { known: 2, complete: true } } },
  }),
}));
vi.mock("../../data/use-workspace-name", () => ({ useActiveWorkspaceLabel: () => "Workspace A" }));
vi.mock("../../ui/NativeOwnerLink", () => ({
  NativeOwnerLink: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  fixture.search = "?taskId=t%2F1&workspaceId=workspace-a&extra=keep";
  fixture.hash = "#details";
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
it("keeps task operations with the existing owner and its active workspace", () => {
  act(() => root.render(<WorkKanban />));
  expect(host.textContent).toContain("Existing revision-aware task owner");
  expect(fixture.task).toHaveBeenCalledWith(
    expect.objectContaining({
      activeWorkspaceId: "workspace-a",
      activeWorkspaceName: "Workspace A",
      pendingApprovals: 2,
      route: expect.objectContaining({ area: "ops", section: "kanban" }),
    }),
  );
  expect(fixture.run).not.toHaveBeenCalled();
  expect(host.querySelector("h1")?.textContent).toBe("Older Kanban view");
});
it.each(["?runId=r%2F1&taskId=t&workspaceId=workspace-a", "?view=run-detail&workspaceId=workspace-a"])(
  "keeps the original Ops run selection and experimental label: %s",
  (search) => {
    fixture.search = search;
    act(() => root.render(<WorkKanban />));
    expect(host.textContent).toContain("Existing run evidence owner");
    expect(host.textContent).toContain("Experimental");
    expect(fixture.task).not.toHaveBeenCalled();
    expect(fixture.run).toHaveBeenCalledWith(
      expect.objectContaining({
        route: expect.objectContaining({ area: "ops", section: "kanban" }),
        activeWorkspaceId: "workspace-a",
      }),
    );
  },
);
