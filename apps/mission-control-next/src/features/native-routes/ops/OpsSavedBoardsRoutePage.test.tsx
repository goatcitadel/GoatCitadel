import { StrictMode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { OpsSavedBoardRecord, RealtimeEvent } from "@goatcitadel/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { publishOpsSavedBoardRealtimeEvent } from "@next/app/ops-saved-board-realtime";
import { NativeRoutePages } from "../NativeRoutePages";
import type { NativeRoutePagesProps } from "../types";

const apiMocks = vi.hoisted(() => ({
  archiveOpsSavedBoard: vi.fn(),
  createOpsSavedBoard: vi.fn(),
  fetchAgenticRuns: vi.fn(),
  fetchApprovals: vi.fn(),
  fetchCostSummary: vi.fn(),
  fetchHealthSummary: vi.fn(),
  fetchOpsSavedBoard: vi.fn(),
  fetchOpsSavedBoards: vi.fn(),
  fetchTasksByView: vi.fn(),
  restoreOpsSavedBoard: vi.fn(),
  updateOpsSavedBoard: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/ops-saved-boards", () => ({
  archiveOpsSavedBoard: apiMocks.archiveOpsSavedBoard,
  createOpsSavedBoard: apiMocks.createOpsSavedBoard,
  fetchOpsSavedBoard: apiMocks.fetchOpsSavedBoard,
  fetchOpsSavedBoards: apiMocks.fetchOpsSavedBoards,
  restoreOpsSavedBoard: apiMocks.restoreOpsSavedBoard,
  updateOpsSavedBoard: apiMocks.updateOpsSavedBoard,
}));

vi.mock("@goatcitadel/mission-control-shared/api/agentic", () => ({
  fetchAgenticRuns: apiMocks.fetchAgenticRuns,
}));

vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({
  fetchApprovals: apiMocks.fetchApprovals,
}));

vi.mock("@goatcitadel/mission-control-shared/api/system", () => ({
  fetchCostSummary: apiMocks.fetchCostSummary,
  fetchHealthSummary: apiMocks.fetchHealthSummary,
}));

vi.mock("@goatcitadel/mission-control-shared/api/tasks", () => ({
  fetchTasksByView: apiMocks.fetchTasksByView,
}));

const FIVE_PLACEMENTS: OpsSavedBoardRecord["placements"] = [
  { widgetId: "agentic", kind: "agentic_run_kanban", x: 0, y: 0, width: 6, height: 4 },
  { widgetId: "approvals", kind: "approval_queue_summary", x: 6, y: 0, width: 6, height: 4 },
  { widgetId: "runtime", kind: "runtime_truth_summary", x: 0, y: 4, width: 4, height: 4 },
  { widgetId: "tasks", kind: "task_status_summary", x: 4, y: 4, width: 4, height: 4 },
  { widgetId: "cost", kind: "usage_cost_summary", x: 8, y: 4, width: 4, height: 4 },
];

let canonicalBoards: OpsSavedBoardRecord[];

beforeEach(() => {
  vi.resetAllMocks();
  canonicalBoards = [makeBoard()];
  apiMocks.fetchOpsSavedBoards.mockImplementation(async ({ workspaceId }: { workspaceId: string }) => ({
    workspaceId,
    items: canonicalBoards.filter((board) => board.workspaceId === workspaceId),
  }));
  apiMocks.fetchOpsSavedBoard.mockImplementation(async (workspaceId: string, boardId: string) => {
    const board = canonicalBoards.find(
      (candidate) => candidate.workspaceId === workspaceId && candidate.boardId === boardId,
    );
    if (!board) throw new Error("board not found");
    return board;
  });
  apiMocks.createOpsSavedBoard.mockImplementation(async (input: Record<string, unknown>) => {
    const created = makeBoard({
      boardId: "board-created",
      workspaceId: String(input.workspaceId),
      name: String(input.name),
      description: typeof input.description === "string" ? input.description : undefined,
      placements: input.placements as OpsSavedBoardRecord["placements"],
      idempotencyKey: String(input.idempotencyKey),
    });
    canonicalBoards = [...canonicalBoards, created];
    return created;
  });
  apiMocks.updateOpsSavedBoard.mockImplementation(async (boardId: string, input: Record<string, unknown>) => {
    const current = canonicalBoards.find((board) => board.boardId === boardId)!;
    const updated = makeBoard({
      ...current,
      name: typeof input.name === "string" ? input.name : current.name,
      description: Object.hasOwn(input, "description")
        ? input.description === null
          ? undefined
          : String(input.description)
        : current.description,
      placements: (input.placements as OpsSavedBoardRecord["placements"] | undefined) ?? current.placements,
      revision: Number(input.expectedRevision) + 1,
    });
    canonicalBoards = canonicalBoards.map((board) => (board.boardId === boardId ? updated : board));
    return updated;
  });
  apiMocks.archiveOpsSavedBoard.mockImplementation(async (boardId: string, input: { expectedRevision: number }) => {
    const current = canonicalBoards.find((board) => board.boardId === boardId)!;
    const archived = makeBoard({
      ...current,
      status: "archived",
      revision: input.expectedRevision + 1,
      archivedAt: "2026-07-14T20:05:00.000Z",
      archivedByActorId: "operator",
    });
    canonicalBoards = canonicalBoards.map((board) => (board.boardId === boardId ? archived : board));
    return archived;
  });
  apiMocks.restoreOpsSavedBoard.mockImplementation(async (boardId: string, input: { expectedRevision: number }) => {
    const current = canonicalBoards.find((board) => board.boardId === boardId)!;
    const restored = makeBoard({
      ...current,
      status: "active",
      revision: input.expectedRevision + 1,
      archivedAt: undefined,
      archivedByActorId: undefined,
    });
    canonicalBoards = canonicalBoards.map((board) => (board.boardId === boardId ? restored : board));
    return restored;
  });
  apiMocks.fetchAgenticRuns.mockResolvedValue({
    items: [
      {
        taskId: "task-agentic",
        runId: "run-1",
        title: "Release synthesis",
        taskStatus: "in_progress",
        status: "running",
        updatedAt: "2026-07-14T20:00:00.000Z",
      },
    ],
  });
  apiMocks.fetchApprovals.mockResolvedValue({
    items: [
      makeApproval("workspace-deploy", "ws-1"),
      makeApproval("foreign-deploy", "ws-foreign"),
      makeApproval("unscoped-deploy"),
    ],
  });
  apiMocks.fetchTasksByView.mockResolvedValue({
    view: "active",
    items: [
      {
        taskId: "task-1",
        revision: 1,
        workspaceId: "ws-1",
        title: "Run release proof",
        status: "testing",
        priority: "high",
        createdAt: "2026-07-14T19:00:00.000Z",
        updatedAt: "2026-07-14T20:00:00.000Z",
      },
    ],
  });
  apiMocks.fetchHealthSummary.mockResolvedValue(makeHealth("gateway-one"));
  apiMocks.fetchCostSummary.mockResolvedValue({
    scope: "day",
    from: "2026-07-14T00:00:00.000Z",
    to: "2026-07-15T00:00:00.000Z",
    items: [
      {
        key: "openai",
        tokenInput: 800,
        tokenOutput: 200,
        tokenCachedInput: 0,
        tokenTotal: 1000,
        costUsd: 0.25,
      },
    ],
  });
});

describe("OpsSavedBoardsRoutePage", () => {
  it("remains live after the Strict Mode effect lifecycle probe", async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <StrictMode>
          <NativeRoutePages {...makeProps()} />
        </StrictMode>,
      );
      await flushPromises();
    });

    expect(collectText(renderer!.root)).toContain("Release watch");
    expect(apiMocks.fetchOpsSavedBoards).toHaveBeenCalled();
    expect(apiMocks.fetchOpsSavedBoard).toHaveBeenCalledWith("ws-1", "board-1");
    await act(async () => {
      renderer!.unmount();
    });
  });

  it("coalesces retained changes, rejects stale/foreign signals, and preserves the operator draft", async () => {
    const renderer = await renderBoards();
    await click(renderer, "Edit layout");
    await change(findTextInput(renderer), "Preserved operator draft");

    canonicalBoards = [makeBoard({ name: "Canonical revision three", revision: 3 })];
    await act(async () => {
      publishOpsSavedBoardRealtimeEvent(boardChangeEvent({ workspaceId: "ws-foreign", revision: 2 }));
      publishOpsSavedBoardRealtimeEvent(boardChangeEvent({ revision: 1 }));
      publishOpsSavedBoardRealtimeEvent(boardChangeEvent({ revision: 2 }));
      publishOpsSavedBoardRealtimeEvent(boardChangeEvent({ revision: 2 }));
      publishOpsSavedBoardRealtimeEvent(boardChangeEvent({ revision: 3 }));
      await flushRealtimeReload();
    });

    expect(apiMocks.fetchOpsSavedBoards).toHaveBeenCalledTimes(2);
    expect(apiMocks.fetchOpsSavedBoard).toHaveBeenCalledTimes(2);
    expect(findTextInput(renderer).props.value).toBe("Preserved operator draft");
    expect(apiMocks.updateOpsSavedBoard).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it("invalidates an in-flight read on a revision gap and keeps the newer canonical reload", async () => {
    const renderer = await renderBoards();
    const staleList = deferred<{ workspaceId: string; items: OpsSavedBoardRecord[] }>();
    let subsequentListCall = 0;
    apiMocks.fetchOpsSavedBoards.mockImplementation(({ workspaceId }: { workspaceId: string }) => {
      subsequentListCall += 1;
      if (subsequentListCall === 1) return staleList.promise;
      return Promise.resolve({
        workspaceId,
        items: [makeBoard({ name: "Canonical revision five", revision: 5 })],
      });
    });
    apiMocks.fetchOpsSavedBoard.mockResolvedValue(makeBoard({ name: "Canonical revision five", revision: 5 }));

    await act(async () => {
      buttonContaining(renderer, "Refresh").props.onClick();
      await Promise.resolve();
      publishOpsSavedBoardRealtimeEvent(boardChangeEvent({ revision: 5 }));
      await flushRealtimeReload();
    });
    expect(collectText(renderer.root)).toContain("Canonical revision five");

    await act(async () => {
      staleList.resolve({ workspaceId: "ws-1", items: [makeBoard({ name: "Stale revision one" })] });
      await flushPromises();
    });
    expect(collectText(renderer.root)).not.toContain("Stale revision one");
    expect(collectText(renderer.root)).toContain("Canonical revision five");
    expect(apiMocks.fetchOpsSavedBoards).toHaveBeenCalledTimes(3);
    renderer.unmount();
  });

  it("wires /ops/boards to exactly five compiled, independently sourced widgets", async () => {
    const navigate = vi.fn();
    const renderer = await renderBoards(makeProps({ navigate }));

    const widgetLabels = renderer.root
      .findAll((node) => node.type === "article" && typeof node.props["aria-label"] === "string")
      .map((node) => node.props["aria-label"]);
    expect(widgetLabels).toEqual([
      "Agentic run Kanban",
      "Approval queue",
      "Runtime truth",
      "Task status",
      "Usage and cost",
    ]);
    expect(collectText(renderer.root)).toContain("workspace-deploy · caution");
    expect(collectText(renderer.root)).not.toContain("foreign-deploy");
    expect(collectText(renderer.root)).not.toContain("unscoped-deploy");
    expect(apiMocks.fetchOpsSavedBoards).toHaveBeenCalledWith({ workspaceId: "ws-1", includeArchived: false });
    expect(apiMocks.fetchOpsSavedBoard).toHaveBeenCalledWith("ws-1", "board-1");
    expect(apiMocks.fetchAgenticRuns).toHaveBeenCalledWith({ workspaceId: "ws-1", limit: 200 });
    expect(apiMocks.fetchApprovals).toHaveBeenCalledWith({ status: "pending", limit: 200 });
    expect(apiMocks.fetchTasksByView).toHaveBeenCalledWith("active", undefined, "ws-1", { limit: 200 });
    expect(apiMocks.fetchHealthSummary).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchCostSummary).toHaveBeenCalledWith("day");

    await act(async () => {
      buttonsContaining(renderer, "Open source")[4]!.props.onClick();
    });
    expect(navigate).toHaveBeenCalledWith({ area: "ops", section: "costs", theme: "ops" });
  });

  it("keeps one widget failure local and retries only that source", async () => {
    apiMocks.fetchHealthSummary.mockRejectedValueOnce(new Error("runtime probe unavailable"));
    const renderer = await renderBoards();

    expect(collectText(renderer.root)).toContain("runtime probe unavailable");
    expect(collectText(renderer.root)).toContain("Release synthesis · running");
    expect(collectText(renderer.root)).toContain("Run release proof · testing");
    expect(collectText(renderer.root)).toContain("1K");

    apiMocks.fetchHealthSummary.mockResolvedValueOnce(makeHealth("gateway-recovered"));
    await click(renderer, "Retry source");
    expect(apiMocks.fetchHealthSummary).toHaveBeenCalledTimes(2);
    expect(collectText(renderer.root)).toContain("gateway-recovered");
  });

  it("selects, creates, archives, and restores through canonical reloads", async () => {
    canonicalBoards = [makeBoard(), makeBoard({ boardId: "board-2", name: "Second board" })];
    const renderer = await renderBoards();

    const selector = renderer.root.findByProps({ "aria-label": "Saved board" });
    await act(async () => {
      selector.props.onChange({ currentTarget: { value: "board-2" } });
      await flushPromises();
    });
    expect(apiMocks.fetchOpsSavedBoard).toHaveBeenLastCalledWith("ws-1", "board-2");
    expect(collectText(renderer.root)).toContain("Second board");

    await click(renderer, "New board");
    await change(findTextInput(renderer), "Incident watch");
    await change(renderer.root.findByType("textarea"), "A bounded response layout");
    await click(renderer, "Create board");

    expect(apiMocks.createOpsSavedBoard).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        name: "Incident watch",
        description: "A bounded response layout",
        idempotencyKey: expect.stringMatching(/^ops-board-/),
      }),
    );
    expect(apiMocks.fetchOpsSavedBoards).toHaveBeenCalledTimes(2);
    expect(apiMocks.fetchOpsSavedBoard).toHaveBeenLastCalledWith("ws-1", "board-created");
    expect(collectText(renderer.root)).toContain("Incident watch");

    await click(renderer, "Archive");
    await click(renderer, "Archive board");
    expect(apiMocks.archiveOpsSavedBoard).toHaveBeenCalledWith("board-created", {
      workspaceId: "ws-1",
      expectedRevision: 1,
    });
    expect(collectText(renderer.root)).toContain("archived");
    expect(collectText(renderer.root)).toContain("revision 2");

    await click(renderer, "Restore");
    await click(renderer, "Restore board");
    expect(apiMocks.restoreOpsSavedBoard).toHaveBeenCalledWith("board-created", {
      workspaceId: "ws-1",
      expectedRevision: 2,
    });
    expect(collectText(renderer.root)).toContain("revision 3");
  });

  it("preserves an edit draft on CAS conflict and never replays it automatically", async () => {
    const canonicalRevisionTwo = makeBoard({ revision: 2, name: "Canonical revision two" });
    apiMocks.updateOpsSavedBoard.mockRejectedValueOnce(Object.assign(new Error("conflict"), { status: 409 }));
    apiMocks.fetchOpsSavedBoard
      .mockResolvedValueOnce(makeBoard())
      .mockResolvedValueOnce(canonicalRevisionTwo)
      .mockImplementation(async () => canonicalBoards[0]);
    const renderer = await renderBoards();

    await click(renderer, "Edit layout");
    const nameInput = findTextInput(renderer);
    await change(nameInput, "Preserved operator draft");
    await click(renderer, "Save changes");

    expect(apiMocks.updateOpsSavedBoard).toHaveBeenCalledTimes(1);
    expect(apiMocks.updateOpsSavedBoard).toHaveBeenCalledWith(
      "board-1",
      expect.objectContaining({ expectedRevision: 1, name: "Preserved operator draft" }),
    );
    expect(findTextInput(renderer).props.value).toBe("Preserved operator draft");
    expect(collectText(renderer.root)).toContain("Canonical revision 2 is now current");
    expect(collectText(renderer.root)).toContain("your draft was preserved");

    await click(renderer, "Use revision 2");
    expect(apiMocks.updateOpsSavedBoard).toHaveBeenCalledTimes(1);

    canonicalBoards = [canonicalRevisionTwo];
    await click(renderer, "Save changes");
    expect(apiMocks.updateOpsSavedBoard).toHaveBeenCalledTimes(2);
    expect(apiMocks.updateOpsSavedBoard).toHaveBeenLastCalledWith(
      "board-1",
      expect.objectContaining({ expectedRevision: 2, name: "Preserved operator draft" }),
    );
  });

  it("sends an explicit null when an edit clears the canonical description", async () => {
    const renderer = await renderBoards();

    await click(renderer, "Edit layout");
    await change(renderer.root.findByType("textarea"), "");
    await click(renderer, "Save changes");

    expect(apiMocks.updateOpsSavedBoard).toHaveBeenCalledWith(
      "board-1",
      expect.objectContaining({
        workspaceId: "ws-1",
        description: null,
        expectedRevision: 1,
      }),
    );
    expect(collectText(renderer.root)).not.toContain("Canonical operational summaries");
  });

  it("synchronizes the archived filter when a create identity conflicts", async () => {
    apiMocks.createOpsSavedBoard.mockRejectedValueOnce(Object.assign(new Error("conflict"), { status: 409 }));
    const renderer = await renderBoards();
    canonicalBoards = [
      makeBoard({
        status: "archived",
        revision: 2,
        archivedAt: "2026-07-14T20:05:00.000Z",
        archivedByActorId: "operator",
      }),
    ];

    await click(renderer, "New board");
    await change(findTextInput(renderer), "Conflicting create");
    await click(renderer, "Create board");

    const archiveToggle = renderer.root.findAllByType("input").find((node) => node.props.type === "checkbox");
    expect(archiveToggle?.props.checked).toBe(true);
    expect(apiMocks.fetchOpsSavedBoards).toHaveBeenLastCalledWith({ workspaceId: "ws-1", includeArchived: true });
    expect(collectText(renderer.root)).toContain("This create identity already committed different content");
  });

  it("cannot strand a new workspace behind a late editor mutation", async () => {
    const lateUpdate = deferred<OpsSavedBoardRecord>();
    apiMocks.updateOpsSavedBoard.mockReturnValueOnce(lateUpdate.promise);
    bindBoardsToRequestedWorkspace();
    const renderer = await renderBoards();

    await click(renderer, "Edit layout");
    await click(renderer, "Save changes");
    expect(collectText(renderer.root)).toContain("Saving");

    await act(async () => {
      renderer.update(<NativeRoutePages {...makeProps({ activeWorkspaceId: "ws-2", activeWorkspaceName: "Two" })} />);
      await flushPromises();
    });
    expect(collectText(renderer.root)).toContain("Board ws-2");
    expect(buttonContaining(renderer, "New board").props.disabled).toBe(false);

    await act(async () => {
      lateUpdate.resolve(makeBoard({ name: "Stale saved board" }));
      await flushPromises();
    });
    expect(buttonContaining(renderer, "New board").props.disabled).toBe(false);
    expect(collectText(renderer.root)).not.toContain("Stale saved board");
  });

  it("drops a stale transition conflict failure after resetting transition state for a new workspace", async () => {
    const staleConflictRefresh = deferred<OpsSavedBoardRecord>();
    let workspaceOneDetailCalls = 0;
    apiMocks.fetchOpsSavedBoards.mockImplementation(async ({ workspaceId }: { workspaceId: string }) => ({
      workspaceId,
      items: [makeBoard({ workspaceId, boardId: `board-${workspaceId}`, name: `Board ${workspaceId}` })],
    }));
    apiMocks.fetchOpsSavedBoard.mockImplementation((workspaceId: string) => {
      if (workspaceId === "ws-2") {
        return Promise.resolve(makeBoard({ workspaceId, boardId: "board-ws-2", name: "Board ws-2" }));
      }
      workspaceOneDetailCalls += 1;
      return workspaceOneDetailCalls === 1
        ? Promise.resolve(makeBoard({ boardId: "board-ws-1", name: "Board ws-1" }))
        : staleConflictRefresh.promise;
    });
    apiMocks.archiveOpsSavedBoard.mockRejectedValueOnce(Object.assign(new Error("conflict"), { status: 409 }));
    const renderer = await renderBoards();

    await click(renderer, "Archive");
    await click(renderer, "Archive board");

    await act(async () => {
      renderer.update(<NativeRoutePages {...makeProps({ activeWorkspaceId: "ws-2", activeWorkspaceName: "Two" })} />);
      await flushPromises();
    });
    expect(collectText(renderer.root)).toContain("Board ws-2");
    expect(buttonContaining(renderer, "New board").props.disabled).toBe(false);

    await act(async () => {
      staleConflictRefresh.reject(new Error("stale transition refresh failure"));
      await flushPromises();
    });
    expect(collectText(renderer.root)).not.toContain("stale transition refresh failure");
    expect(buttonContaining(renderer, "New board").props.disabled).toBe(false);
  });

  it("rejects a late workspace list after the workspace generation changes", async () => {
    const staleList = deferred<{ workspaceId: string; items: OpsSavedBoardRecord[] }>();
    apiMocks.fetchOpsSavedBoards.mockImplementation(({ workspaceId }: { workspaceId: string }) =>
      workspaceId === "ws-1"
        ? staleList.promise
        : Promise.resolve({ workspaceId, items: [makeBoard({ workspaceId, boardId: "board-2", name: "WS two" })] }),
    );
    apiMocks.fetchOpsSavedBoard.mockImplementation(async (workspaceId: string) =>
      makeBoard({ workspaceId, boardId: "board-2", name: "WS two" }),
    );
    apiMocks.fetchHealthSummary.mockResolvedValue(makeHealth("gateway-two"));

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<NativeRoutePages {...makeProps()} />);
    });
    await act(async () => {
      renderer.update(<NativeRoutePages {...makeProps({ activeWorkspaceId: "ws-2", activeWorkspaceName: "Two" })} />);
      await flushPromises();
    });
    expect(collectText(renderer!.root)).toContain("WS two");
    expect(collectText(renderer!.root)).toContain("gateway-two");

    await act(async () => {
      staleList.resolve({ workspaceId: "ws-1", items: [makeBoard({ name: "Stale WS one" })] });
      await flushPromises();
    });
    expect(collectText(renderer!.root)).not.toContain("Stale WS one");
    expect(collectText(renderer!.root)).toContain("WS two");
  });

  it("rejects a late selected-board detail result", async () => {
    const staleBoard = deferred<OpsSavedBoardRecord>();
    canonicalBoards = [makeBoard(), makeBoard({ boardId: "board-2", name: "Current board two" })];
    apiMocks.fetchOpsSavedBoard.mockImplementation((_workspaceId: string, boardId: string) =>
      boardId === "board-1" ? staleBoard.promise : Promise.resolve(canonicalBoards[1]!),
    );
    const renderer = await renderBoards();

    await act(async () => {
      renderer.root
        .findByProps({ "aria-label": "Saved board" })
        .props.onChange({ currentTarget: { value: "board-2" } });
      await flushPromises();
    });
    expect(collectText(renderer.root)).toContain("Current board two");

    await act(async () => {
      staleBoard.resolve(makeBoard({ name: "Stale board one" }));
      await flushPromises();
    });
    expect(collectText(renderer.root)).not.toContain("Stale board one");
    expect(collectText(renderer.root)).toContain("Current board two");
  });

  it("rejects a late widget result after the workspace binding changes", async () => {
    const staleHealth = deferred<ReturnType<typeof makeHealth>>();
    apiMocks.fetchOpsSavedBoards.mockImplementation(async ({ workspaceId }: { workspaceId: string }) => ({
      workspaceId,
      items: [makeBoard({ workspaceId, boardId: `board-${workspaceId}`, name: `Board ${workspaceId}` })],
    }));
    apiMocks.fetchOpsSavedBoard.mockImplementation(async (workspaceId: string) =>
      makeBoard({ workspaceId, boardId: `board-${workspaceId}`, name: `Board ${workspaceId}` }),
    );
    apiMocks.fetchHealthSummary
      .mockReturnValueOnce(staleHealth.promise)
      .mockResolvedValueOnce(makeHealth("gateway-two"));
    const renderer = await renderBoards();
    expect(collectText(renderer.root)).toContain("Loading this source");

    await act(async () => {
      renderer.update(<NativeRoutePages {...makeProps({ activeWorkspaceId: "ws-2", activeWorkspaceName: "Two" })} />);
      await flushPromises();
    });
    expect(collectText(renderer.root)).toContain("gateway-two");

    await act(async () => {
      staleHealth.resolve(makeHealth("stale-gateway-one"));
      await flushPromises();
    });
    expect(collectText(renderer.root)).not.toContain("stale-gateway-one");
    expect(collectText(renderer.root)).toContain("gateway-two");
  });
});

function makeProps(overrides: Partial<NativeRoutePagesProps> = {}): NativeRoutePagesProps {
  return {
    route: { area: "ops", section: "boards", theme: "ops" },
    activeWorkspaceId: "ws-1",
    activeWorkspaceName: "Workspace one",
    pendingApprovals: 0,
    navigate: vi.fn(),
    setActiveWorkspaceId: vi.fn(),
    ...overrides,
  };
}

function makeBoard(overrides: Partial<OpsSavedBoardRecord> = {}): OpsSavedBoardRecord {
  return {
    schemaVersion: "goatcitadel.ops-board.v1",
    boardId: "board-1",
    workspaceId: "ws-1",
    name: "Release watch",
    description: "Canonical operational summaries",
    status: "active",
    placements: FIVE_PLACEMENTS.map((placement) => ({ ...placement })),
    revision: 1,
    createdByActorId: "operator",
    createdAt: "2026-07-14T20:00:00.000Z",
    updatedByActorId: "operator",
    updatedAt: "2026-07-14T20:00:00.000Z",
    idempotencyKey: "create-board-1",
    requestSha256: "a".repeat(64),
    ...overrides,
  };
}

function boardChangeEvent({
  workspaceId = "ws-1",
  revision,
  epoch = "epoch-1",
}: {
  workspaceId?: string;
  revision: number;
  epoch?: string;
}): RealtimeEvent {
  return {
    eventId: `board-${workspaceId}-${revision}`,
    sequence: revision,
    eventType: "ops_saved_board_changed",
    source: "ops_saved_boards",
    timestamp: "2026-07-14T20:00:00.000Z",
    eventClass: "operational_signal",
    eventAuthority: "retained_stream",
    links: { workspaceId },
    payload: {
      workspaceId,
      boardId: "board-1",
      revision,
      epoch,
      operation: "update",
    },
  };
}

function makeApproval(kind: string, workspaceId?: string) {
  return {
    approvalId: `approval-${kind}`,
    kind,
    riskLevel: "caution",
    status: "pending",
    payload: {},
    preview: {},
    ...(workspaceId ? { linkage: { workspaceId } } : {}),
    createdAt: "2026-07-14T20:00:00.000Z",
    explanationStatus: "not_requested",
  };
}

function makeHealth(hostname: string) {
  return {
    generatedAt: "2026-07-14T20:00:00.000Z",
    systemVitals: {
      hostname,
      platform: "win32",
      release: "11",
      uptimeSeconds: 100,
      loadAverage: [0, 0, 0],
      cpuCount: 12,
      memoryTotalBytes: 100,
      memoryFreeBytes: 40,
      memoryUsedBytes: 60,
      processRssBytes: 10,
      processHeapUsedBytes: 5,
    },
    daemonStatus: {
      running: true,
      pid: 42,
      uptimeSeconds: 90,
      host: hostname,
      state: "running",
      supported: true,
      controllable: true,
      controlMessage: "ready",
    },
    daemonLogs: { items: [] },
    costs: {
      summary: { scope: "day", from: "", to: "", items: [] },
      qmd: { totalRuns: 0, compressionPercent: 0, expansionPercent: 0, efficiencyLabel: "neutral" },
    },
    backups: { items: [], latest: null },
  };
}

async function renderBoards(props = makeProps()): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(<NativeRoutePages {...props} />);
    await flushPromises();
  });
  return renderer!;
}

function bindBoardsToRequestedWorkspace(): void {
  apiMocks.fetchOpsSavedBoards.mockImplementation(async ({ workspaceId }: { workspaceId: string }) => ({
    workspaceId,
    items: [makeBoard({ workspaceId, boardId: `board-${workspaceId}`, name: `Board ${workspaceId}` })],
  }));
  apiMocks.fetchOpsSavedBoard.mockImplementation(async (workspaceId: string) =>
    makeBoard({ workspaceId, boardId: `board-${workspaceId}`, name: `Board ${workspaceId}` }),
  );
}

async function click(renderer: ReactTestRenderer, label: string): Promise<void> {
  await act(async () => {
    buttonContaining(renderer, label).props.onClick();
    await flushPromises();
  });
}

async function change(node: ReactTestInstance, value: string): Promise<void> {
  await act(async () => {
    node.props.onChange({ currentTarget: { value } });
  });
}

function buttonContaining(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const button = buttonsContaining(renderer, label)[0];
  if (!button) throw new Error(`Expected a '${label}' button.`);
  return button;
}

function buttonsContaining(renderer: ReactTestRenderer, label: string): ReactTestInstance[] {
  return renderer.root.findAllByType("button").filter((node) => collectText(node).includes(label));
}

function findTextInput(renderer: ReactTestRenderer): ReactTestInstance {
  const input = renderer.root.findAllByType("input").find((node) => node.props.type !== "checkbox");
  if (!input) throw new Error("Expected a text input.");
  return input;
}

function collectText(node: ReactTestInstance | string | number | null | undefined): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node) return "";
  return node.children.map((child) => collectText(child as ReactTestInstance | string)).join("");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function flushRealtimeReload(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 35));
  await flushPromises();
}
