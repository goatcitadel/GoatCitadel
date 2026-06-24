import { type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgenticRunListItem } from "@goatcitadel/contracts";
import { KanbanCard, KanbanRoutePage } from "./KanbanRoutePage";
import { toKanbanCard, type KanbanCardModel } from "./kanban-card-model";

const fetchAgenticRuns = vi.fn();
const bulkTaskAction = vi.fn();

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchAgenticRuns: (...args: unknown[]) => fetchAgenticRuns(...args),
  bulkTaskAction: (...args: unknown[]) => bulkTaskAction(...args),
}));

// Mirror the proven ChatThreadView mock: react-test-renderer has no layout, so
// real Virtuoso would window down to zero rows. Render every row through the
// supplied `List` component + itemContent so the windowed branch is assertable.
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data = [],
    computeItemKey,
    itemContent,
    components,
    className,
  }: {
    data?: unknown[];
    computeItemKey?: (index: number, item: unknown) => string;
    itemContent: (index: number, item: unknown) => ReactNode;
    components?: { List?: (props: { children?: ReactNode }) => ReactNode };
    className?: string;
  }) => {
    const List = components?.List;
    const children = data.map((item, index) => (
      <div key={computeItemKey?.(index, item) ?? index} data-virtuoso-item="true">
        {itemContent(index, item)}
      </div>
    ));
    return (
      <div className={className} data-virtuoso="true">
        {List ? <List>{children}</List> : children}
      </div>
    );
  },
}));

const baseProps = {
  route: { area: "ops", section: "kanban", theme: "ops" } as never,
  activeWorkspaceId: "default",
  activeWorkspaceName: "Default",
  pendingApprovals: 0,
  navigate: vi.fn(),
  setActiveWorkspaceId: vi.fn(),
};

// 30 queued runs — comfortably above KANBAN_VIRTUALIZE_THRESHOLD (24) so the
// Queued column renders through the virtualized branch.
function buildQueuedRuns(count: number): AgenticRunListItem[] {
  return Array.from({ length: count }, (_unused, index) => ({
    taskId: `t-${index}`,
    runId: `run-${index}`,
    title: `Queued run ${index}`,
    taskStatus: "assigned",
    status: "queued",
    surface: "cowork",
    updatedAt: "2999-05-15T11:00:00.000Z",
  })) as AgenticRunListItem[];
}

beforeEach(() => {
  fetchAgenticRuns.mockReset();
  bulkTaskAction.mockReset();
  fetchAgenticRuns.mockResolvedValue({ items: buildQueuedRuns(30) });
  bulkTaskAction.mockResolvedValue({ tasks: [] });
});

function findByTestId(renderer: ReactTestRenderer, testId: string): ReactTestInstance {
  const node = renderer.root.findAll((candidate) => candidate.props?.["data-testid"] === testId)[0];
  if (!node) {
    throw new Error(`${testId} not found`);
  }
  return node;
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

describe("KanbanRoutePage virtualization", () => {
  it("renders a long column through the virtualized list branch", async () => {
    const renderer = await renderPage();
    // The virtualized scroller is mounted for the over-threshold Queued column.
    const scrollers = renderer.root.findAll((node) => node.props?.["data-virtuoso"] === "true");
    expect(scrollers.length).toBeGreaterThan(0);
    // Every queued card is still reachable through the mocked window.
    expect(findByTestId(renderer, "kanban-select-t-0")).toBeTruthy();
    expect(findByTestId(renderer, "kanban-select-t-29")).toBeTruthy();
    act(() => renderer.unmount());
  });

  it("toggles a single card's selection without touching its siblings", async () => {
    const renderer = await renderPage();
    const target = findByTestId(renderer, "kanban-select-t-5");
    await act(async () => {
      target.props.onChange();
    });
    expect((findByTestId(renderer, "kanban-select-t-5").props as { checked: boolean }).checked).toBe(true);
    expect((findByTestId(renderer, "kanban-select-t-6").props as { checked: boolean }).checked).toBe(false);
    expect((findByTestId(renderer, "kanban-select-t-0").props as { checked: boolean }).checked).toBe(false);

    const unblock = renderer.root.findAll(
      (node) =>
        node.type === "button" &&
        node.children.map((child) => (typeof child === "string" ? child : "")).join("").trim().toLowerCase() ===
          "unblock",
    )[0];
    if (!unblock) {
      throw new Error("Unblock button not found");
    }
    await act(async () => {
      await unblock.props.onClick();
    });
    expect(bulkTaskAction).toHaveBeenCalledWith({ action: "unblock", taskIds: ["t-5"], workspaceId: "default" });
    act(() => renderer.unmount());
  });

  it("bails out of re-rendering when its props are referentially stable (React.memo)", () => {
    // Instrument the card model so each render of the card body (which reads
    // `surfaceLabel` exactly once) bumps a counter we can assert on.
    let renderReads = 0;
    const base = toKanbanCard({
      taskId: "t-stable",
      runId: "run-stable",
      title: "Stable card",
      taskStatus: "assigned",
      status: "queued",
      surface: "cowork",
      updatedAt: "2999-05-15T11:00:00.000Z",
    } as AgenticRunListItem);
    const card: KanbanCardModel = {
      ...base,
      get surfaceLabel() {
        renderReads += 1;
        return "Cowork";
      },
    };
    const onToggleSelect = vi.fn();

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<KanbanCard card={card} checked={false} onToggleSelect={onToggleSelect} />);
    });
    expect(renderReads).toBe(1);

    // Same prop references ⇒ memo bails out, card body does not run again.
    act(() => {
      renderer.update(<KanbanCard card={card} checked={false} onToggleSelect={onToggleSelect} />);
    });
    expect(renderReads).toBe(1);

    // Flipping its own `checked` ⇒ the card re-renders exactly once.
    act(() => {
      renderer.update(<KanbanCard card={card} checked={true} onToggleSelect={onToggleSelect} />);
    });
    expect(renderReads).toBe(2);
    act(() => renderer.unmount());
  });
});
