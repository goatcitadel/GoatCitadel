import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRecord } from "@goatcitadel/contracts";
import { KanbanRoutePage } from "./KanbanRoutePage";

const fetchTasksByView = vi.fn();
const bulkTaskAction = vi.fn();

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchTasksByView: (...args: unknown[]) => fetchTasksByView(...args),
  bulkTaskAction: (...args: unknown[]) => bulkTaskAction(...args),
}));

const baseTasks: TaskRecord[] = [
  {
    taskId: "t-1",
    workspaceId: "default",
    title: "Backlog item",
    status: "inbox",
    priority: "normal",
    createdAt: "2026-05-15T11:00:00.000Z",
    updatedAt: "2026-05-15T11:00:00.000Z",
  },
  {
    taskId: "t-2",
    workspaceId: "default",
    title: "Working",
    status: "in_progress",
    priority: "high",
    assignedAgentId: "agent-7",
    distressSignals: [
      {
        signalId: "ds-1",
        code: "tool_error",
        severity: "critical",
        title: "boom",
        summary: "x",
        createdAt: "2026-05-15T11:30:00.000Z",
      },
    ],
    createdAt: "2026-05-15T11:00:00.000Z",
    updatedAt: "2026-05-15T11:30:00.000Z",
  },
];

const baseProps = {
  route: { area: "ops", section: "kanban", theme: "ops" } as any,
  activeWorkspaceId: "default",
  activeWorkspaceName: "Default",
  pendingApprovals: 0,
  navigate: vi.fn(),
  setActiveWorkspaceId: vi.fn(),
};

beforeEach(() => {
  fetchTasksByView.mockReset();
  bulkTaskAction.mockReset();
  fetchTasksByView.mockResolvedValue({ items: baseTasks, view: "active" });
  bulkTaskAction.mockResolvedValue({ tasks: [] });
});

function collectText(node: ReactTestInstance | unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object" || !("children" in node)) return "";
  return (node as ReactTestInstance).children.map(collectText).join(" ");
}

async function renderPage(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<KanbanRoutePage {...baseProps} />);
  });
  // flush the load effect's promise
  await act(async () => {
    await Promise.resolve();
  });
  return renderer;
}

describe("KanbanRoutePage", () => {
  it("renders four columns and groups tasks correctly", async () => {
    const renderer = await renderPage();
    const text = collectText(renderer.root);
    expect(text).toContain("Backlog");
    expect(text).toContain("In Progress");
    expect(text).toContain("Blocked");
    expect(text).toContain("Done");
    expect(text).toContain("Backlog item");
    expect(text).toContain("Working");
    act(() => renderer.unmount());
  });

  it("shows a critical distress chip on cards with unresolved critical signals", async () => {
    const renderer = await renderPage();
    const chip = renderer.root.findAll((node) => node.props?.["data-testid"] === "distress-chip-t-2")[0];
    expect(chip).toBeTruthy();
    expect(collectText(chip)).toMatch(/critical/i);
    act(() => renderer.unmount());
  });

  it("fires bulkTaskAction with unblock when the operator clicks Unblock with selections", async () => {
    const renderer = await renderPage();
    const checkbox = renderer.root.findAll((node) => node.props?.["data-testid"] === "kanban-select-t-2")[0];
    if (!checkbox) {
      throw new Error("kanban-select-t-2 checkbox not found");
    }
    await act(async () => {
      checkbox.props.onChange();
    });
    const unblockButton = renderer.root.findAll(
      (node) => node.type === "button" && collectText(node).trim().toLowerCase() === "unblock",
    )[0];
    if (!unblockButton) {
      throw new Error("unblock button not found");
    }
    await act(async () => {
      await unblockButton.props.onClick();
    });
    expect(bulkTaskAction).toHaveBeenCalledWith({ action: "unblock", taskIds: ["t-2"] });
    act(() => renderer.unmount());
  });

  it("calls fetchTasksByView with the active workspace id", async () => {
    const renderer = await renderPage();
    expect(fetchTasksByView).toHaveBeenCalledWith("active", undefined, "default");
    act(() => renderer.unmount());
  });
});
