import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgenticRunListItem } from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import { KanbanRoutePage } from "./KanbanRoutePage";

const fetchAgenticRuns = vi.fn();
const bulkTaskAction = vi.fn();

vi.mock("@goatcitadel/mission-control-shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/client")>()),
  fetchAgenticRuns: (...args: unknown[]) => fetchAgenticRuns(...args),
  bulkTaskAction: (...args: unknown[]) => bulkTaskAction(...args),
}));

const baseRuns: AgenticRunListItem[] = [
  {
    taskId: "t-1",
    taskRevision: 1,
    runId: "run-queued",
    title: "Queued run",
    taskStatus: "assigned",
    status: "queued",
    surface: "cowork",
    updatedAt: "2999-05-15T11:00:00.000Z",
  },
  {
    taskId: "t-2",
    taskRevision: 2,
    runId: "run-working",
    title: "Working",
    taskStatus: "in_progress",
    status: "running",
    surface: "cowork",
    contextMode: "fork",
    diagnostics: [
      {
        signalId: "diag-1",
        code: "repeated_tool_result",
        severity: "critical",
        title: "Loop",
        summary: "Repeated result.",
        createdAt: "2999-05-15T11:30:00.000Z",
      },
    ],
    updatedAt: "2999-05-15T11:30:00.000Z",
  },
  {
    taskId: "t-3",
    taskRevision: 3,
    runId: "run-failed",
    title: "Failed handoff",
    taskStatus: "blocked",
    status: "failed",
    surface: "cowork",
    updatedAt: "2999-05-15T11:40:00.000Z",
  },
  {
    taskId: "t-4",
    taskRevision: 4,
    runId: "run-complete",
    title: "Closed run",
    taskStatus: "done",
    status: "completed",
    surface: "code",
    updatedAt: "2999-05-15T11:45:00.000Z",
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
  fetchAgenticRuns.mockReset();
  bulkTaskAction.mockReset();
  fetchAgenticRuns.mockResolvedValue({ items: baseRuns });
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
  await act(async () => {
    await Promise.resolve();
  });
  return renderer;
}

function findRequiredByTestId(renderer: ReactTestRenderer, testId: string): ReactTestInstance {
  const node = renderer.root.findAll((candidate) => candidate.props?.["data-testid"] === testId)[0];
  if (!node) {
    throw new Error(`${testId} not found`);
  }
  return node;
}

function findRequiredButton(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const button = renderer.root.findAll(
    (node) => node.type === "button" && collectText(node).trim().toLowerCase() === label.toLowerCase(),
  )[0];
  if (!button) {
    throw new Error(`${label} button not found`);
  }
  return button;
}

describe("KanbanRoutePage", () => {
  it("offers a working retry when the canonical run list is unavailable", async () => {
    fetchAgenticRuns.mockRejectedValueOnce(new Error("run list offline")).mockResolvedValueOnce({ items: baseRuns });
    const renderer = await renderPage();
    expect(collectText(renderer.root)).toContain("run list offline");
    await act(async () => {
      findRequiredButton(renderer, "retry").props.onClick();
      await Promise.resolve();
    });
    expect(fetchAgenticRuns).toHaveBeenCalledTimes(2);
    expect(collectText(renderer.root)).toContain("Queued run");
    act(() => renderer.unmount());
  });

  it("renders run-state columns and groups agentic runs correctly", async () => {
    const renderer = await renderPage();
    const text = collectText(renderer.root);
    expect(text).toContain("Queued");
    expect(text).toContain("Running");
    expect(text).toContain("Needs Attention");
    expect(text).toContain("Closed");
    expect(text).toContain("Queued run");
    expect(text).toContain("Working");
    expect(text).toContain("Failed handoff");
    expect(text).toContain("Closed run");
    expect(renderer.root.findByProps({ "aria-label": "Agentic run bulk actions" }).props.role).toBe("toolbar");
    expect(findRequiredButton(renderer, "unblock").props["data-variant"]).toBe("default");
    expect(findRequiredButton(renderer, "retry").props["data-variant"]).toBe("outline");
    expect(findRequiredButton(renderer, "close").props["data-variant"]).toBe("outline");
    expect(findRequiredButton(renderer, "refresh").props["data-variant"]).toBe("secondary");
    act(() => renderer.unmount());
  });

  it("signposts the Run Board from the Kanban header (5.4)", async () => {
    const renderer = await renderPage();
    const signpost = findRequiredButton(renderer, "run board");
    await act(async () => {
      signpost.props.onClick();
    });
    expect(baseProps.navigate).toHaveBeenCalledWith({ area: "ops", section: "kanban", theme: "ops" });
    act(() => renderer.unmount());
  });

  it("shows a critical diagnostic chip on cards with unresolved critical diagnostics", async () => {
    const renderer = await renderPage();
    const chip = renderer.root.findAll((node) => node.props?.["data-testid"] === "diagnostic-chip-t-2")[0];
    expect(chip).toBeTruthy();
    expect(collectText(chip)).toMatch(/critical/i);
    act(() => renderer.unmount());
  });

  it("fires bulkTaskAction with workspace scope when the operator clicks Unblock with selections", async () => {
    const renderer = await renderPage();
    const checkbox = findRequiredByTestId(renderer, "kanban-select-t-3");
    await act(async () => {
      checkbox.props.onChange();
    });
    const unblockButton = findRequiredButton(renderer, "unblock");
    await act(async () => {
      await unblockButton.props.onClick();
    });
    expect(bulkTaskAction).toHaveBeenCalledWith({
      action: "unblock",
      taskIds: ["t-3"],
      expectedRevisionsByTaskId: { "t-3": 3 },
      workspaceId: "default",
    });
    const updatedCheckbox = findRequiredByTestId(renderer, "kanban-select-t-3");
    expect((updatedCheckbox.props as { checked: boolean }).checked).toBe(false);
    expect(collectText(renderer.root)).toContain("1 selected task updated.");
    act(() => renderer.unmount());
  });

  it("surfaces bulk action failures and keeps the selected run checked", async () => {
    bulkTaskAction.mockRejectedValueOnce(new Error("bulk route offline"));
    const renderer = await renderPage();
    const checkbox = findRequiredByTestId(renderer, "kanban-select-t-3");
    await act(async () => {
      checkbox.props.onChange();
    });
    const unblockButton = findRequiredButton(renderer, "unblock");

    await act(async () => {
      await unblockButton.props.onClick();
    });

    expect(collectText(renderer.root)).toContain("bulk route offline");
    const checkedAfterFailure = findRequiredByTestId(renderer, "kanban-select-t-3");
    expect((checkedAfterFailure.props as { checked: boolean }).checked).toBe(true);
    act(() => renderer.unmount());
  });

  it("refreshes canonical tasks on an actual 409 and requires an explicit retry with the new revision", async () => {
    const refreshedRuns = baseRuns.map((run) => (run.taskId === "t-3" ? { ...run, taskRevision: 9 } : run));
    fetchAgenticRuns.mockResolvedValueOnce({ items: baseRuns }).mockResolvedValueOnce({ items: refreshedRuns });
    bulkTaskAction
      .mockRejectedValueOnce(
        new ApiRequestError("stale task", {
          kind: "http",
          method: "POST",
          path: "/api/v1/tasks/bulk",
          status: 409,
        }),
      )
      .mockResolvedValueOnce({ tasks: [] });
    const renderer = await renderPage();
    await act(async () => {
      findRequiredByTestId(renderer, "kanban-select-t-3").props.onChange();
    });

    await act(async () => {
      await findRequiredButton(renderer, "unblock").props.onClick();
    });

    expect(fetchAgenticRuns).toHaveBeenCalledTimes(2);
    expect((findRequiredByTestId(renderer, "kanban-select-t-3").props as { checked: boolean }).checked).toBe(true);
    expect(collectText(renderer.root)).toContain("Canonical task data was refreshed");
    expect(findRequiredByTestId(renderer, "kanban-conflict-retry")).toBeTruthy();

    await act(async () => {
      await findRequiredByTestId(renderer, "kanban-conflict-retry").props.onClick();
    });

    expect(bulkTaskAction).toHaveBeenLastCalledWith({
      action: "unblock",
      taskIds: ["t-3"],
      expectedRevisionsByTaskId: { "t-3": 9 },
      workspaceId: "default",
    });
    expect((findRequiredByTestId(renderer, "kanban-select-t-3").props as { checked: boolean }).checked).toBe(false);
    act(() => renderer.unmount());
  });

  it("calls fetchAgenticRuns with the active workspace id", async () => {
    const renderer = await renderPage();
    expect(fetchAgenticRuns).toHaveBeenCalledWith({ workspaceId: "default", limit: 200 });
    act(() => renderer.unmount());
  });
});
