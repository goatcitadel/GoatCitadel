// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OPS_SAVED_BOARD_SCHEMA_VERSION, type OpsSavedBoardRecord } from "@goatcitadel/contracts";
import {
  createOpsSavedBoard,
  fetchOpsSavedBoard,
  fetchOpsSavedBoards,
  updateOpsSavedBoard,
} from "@goatcitadel/mission-control-shared/api/ops-saved-boards";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CockpitBoardEditor } from "./CockpitBoardEditor";
import { fetchHealthSummary } from "@goatcitadel/mission-control-shared/api/system";
import { __resetBoardMutationsForTests } from "../../../features/native-routes/ops/board-mutation-state";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";

vi.mock("@goatcitadel/mission-control-shared/api/ops-saved-boards", () => ({
  createOpsSavedBoard: vi.fn(),
  fetchOpsSavedBoard: vi.fn(),
  fetchOpsSavedBoards: vi.fn(),
  updateOpsSavedBoard: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/system", () => ({ fetchHealthSummary: vi.fn(), fetchCostSummary: vi.fn() }));

const board = (overrides: Partial<OpsSavedBoardRecord> = {}): OpsSavedBoardRecord => ({
  schemaVersion: OPS_SAVED_BOARD_SCHEMA_VERSION,
  boardId: "board-a",
  workspaceId: "workspace-a",
  name: "Operator board",
  status: "active",
  revision: 2,
  createdByActorId: "operator",
  updatedByActorId: "operator",
  createdAt: "2026-09-29T00:00:00.000Z",
  updatedAt: "2026-09-29T01:00:00.000Z",
  idempotencyKey: "create-a",
  requestSha256: "a".repeat(64),
  placements: [{ widgetId: "runtime-1", kind: "runtime_truth_summary", x: 0, y: 0, width: 6, height: 4 }],
  ...overrides,
});

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
const onSaved = vi.fn();
const onClose = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  __resetBoardMutationsForTests();
  __resetSessionDraftsForTests();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(fetchOpsSavedBoard).mockResolvedValue(board());
  vi.mocked(fetchOpsSavedBoards).mockResolvedValue({ workspaceId: "workspace-a", items: [] });
});

afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  vi.clearAllMocks();
});

async function render(edit = true, accessAvailable = true): Promise<void> {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CockpitBoardEditor
          workspaceId="workspace-a"
          accessAvailable={accessAvailable}
          board={edit ? board() : undefined}
          onClose={onClose}
          onSaved={onSaved}
        />
      </QueryClientProvider>,
    ),
  );
}

function button(label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label);
}
async function typeName(value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>("input");
  if (!input) throw new Error("Missing board name");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function rerender(current: OpsSavedBoardRecord): Promise<void> {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CockpitBoardEditor workspaceId="workspace-a" board={current} onClose={onClose} onSaved={onSaved} />
      </QueryClientProvider>,
    ),
  );
}
/** The create identity under review, as the editor exposes it on the open review. */
function lastReviewedKey(): string {
  const node = container.querySelector<HTMLElement>("[data-create-identity]");
  if (!node?.dataset.createIdentity) throw new Error("Missing reviewed create identity");
  return node.dataset.createIdentity;
}

async function click(label: string): Promise<void> {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Missing ${label} button`);
  await act(async () => button.click());
}

describe("cockpit saved-board editor", () => {
  it("previews current Gateway widgets without saving the retained layout", async () => {
    vi.mocked(fetchHealthSummary).mockResolvedValue({ daemonStatus: { running: true }, systemVitals: { hostname: "BLD", memoryUsedBytes: 50, memoryTotalBytes: 100 } } as never);
    await render(); await click("Preview live widgets");
    await vi.waitFor(() => expect(container.querySelector('[aria-label="Draft live widget preview"]')?.textContent).toContain("BLD"));
    expect(fetchHealthSummary).toHaveBeenCalledOnce();
    expect(updateOpsSavedBoard).not.toHaveBeenCalled(); expect(createOpsSavedBoard).not.toHaveBeenCalled();
    await click("Preview live widgets"); expect(container.querySelector('[aria-label="Draft live widget preview"]')).toBeNull();
    expect(container.querySelector("input")?.value).toBe("Operator board");
  });
  it("retains the editor and blocks saving when the current access read is unavailable", async () => {
    await render();
    await click("Review changes");
    await render(true, false);
    const confirm = [...container.querySelectorAll("button")].find(node => node.textContent === "Confirm save")!;
    expect(confirm.disabled).toBe(true);
    expect(container.querySelector("input")?.value).toBe("Operator board");
    expect(container.textContent).toContain("Your draft is retained");
    await click("Confirm save");
    expect(updateOpsSavedBoard).not.toHaveBeenCalled();
  });
  it("requires review and rechecks the exact owner revision before saving", async () => {
    vi.mocked(updateOpsSavedBoard).mockResolvedValue(board({ revision: 3 }));
    vi.mocked(fetchOpsSavedBoard)
      .mockResolvedValueOnce(board())
      .mockResolvedValue(board({ revision: 3 }));
    await render();
    expect(updateOpsSavedBoard).not.toHaveBeenCalled();
    await click("Review changes");
    expect(updateOpsSavedBoard).not.toHaveBeenCalled();
    await click("Confirm save");
    await vi.waitFor(() =>
      expect(updateOpsSavedBoard).toHaveBeenCalledWith("board-a", {
        workspaceId: "workspace-a",
        expectedRevision: 2,
        name: "Operator board",
        description: null,
        placements: board().placements,
      }),
    );
    expect(fetchOpsSavedBoard).toHaveBeenCalledWith("workspace-a", "board-a", expect.any(AbortSignal));
    expect(onSaved).toHaveBeenCalledWith(board({ revision: 3 }));
  });

  it("withholds an update when the reviewed board changes", async () => {
    vi.mocked(fetchOpsSavedBoard).mockResolvedValue(board({ revision: 3 }));
    await render();
    await click("Review changes");
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CockpitBoardEditor
            workspaceId="workspace-a"
            board={board({ revision: 3 })}
            onClose={onClose}
            onSaved={onSaved}
          />
        </QueryClientProvider>,
      ),
    );
    await click("Confirm save");
    // Port4 cycle 2: a newer revision now shows its recovery choices instead of a generic "changed" notice.
    await vi.waitFor(() => expect(container.textContent).toContain("Revision 3 is now current"));
    expect(updateOpsSavedBoard).not.toHaveBeenCalled();
  });

  it("locks a second request after an unconfirmed update outcome", async () => {
    vi.mocked(updateOpsSavedBoard).mockRejectedValue(new Error("Response lost"));
    await render();
    await click("Review changes");
    await click("Confirm save");
    await vi.waitFor(() => expect(container.textContent).toContain("save outcome is unconfirmed"));
    const review = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "Review changes",
    );
    expect(review?.disabled).toBe(true);
    expect(container.querySelector('a[href="/ops/boards?shell=classic&shellScope=visit"]')).not.toBeNull();
    expect(updateOpsSavedBoard).toHaveBeenCalledTimes(1);
  });

  it("creates a board through the owner after explicit review", async () => {
    vi.mocked(createOpsSavedBoard).mockImplementation(async (input) => {
      const saved = board({
        revision: 1,
        updatedAt: board().createdAt,
        name: input.name,
        idempotencyKey: input.idempotencyKey,
        placements: input.placements,
      });
      vi.mocked(fetchOpsSavedBoard).mockResolvedValue(saved);
      return saved;
    });
    await render(false);
    const input = container.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("Missing board name");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "New board");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Review new board");
    expect(createOpsSavedBoard).not.toHaveBeenCalled();
    await click("Confirm save");
    await vi.waitFor(() =>
      expect(createOpsSavedBoard).toHaveBeenCalledWith({
        workspaceId: "workspace-a",
        idempotencyKey: expect.any(String),
        name: "New board",
        placements: board().placements.map((item) => ({ ...item, widgetId: "runtime_truth_summary-1" })),
      }),
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it("keeps an edited draft on a newer revision only when asked, then saves it against that revision", async () => {
    await render();
    await typeName("My edited name");
    const newer = board({ revision: 3, name: "Renamed elsewhere", updatedAt: "2026-09-29T02:00:00.000Z" });
    await rerender(newer);
    expect(container.textContent).toContain("Revision 3 is now current");
    expect(container.textContent).toContain("Saving your draft replaces the changes in revision 3");
    expect(button("Review changes")?.disabled).toBe(true);
    await click("Keep my draft on revision 3");
    expect(container.querySelector("input")?.value).toBe("My edited name");
    vi.mocked(fetchOpsSavedBoard).mockResolvedValue(newer);
    vi.mocked(updateOpsSavedBoard).mockResolvedValue(board({ revision: 4, name: "My edited name" }));
    await click("Review changes");
    await click("Confirm save");
    await vi.waitFor(() => expect(updateOpsSavedBoard).toHaveBeenCalledWith("board-a", expect.objectContaining({ expectedRevision: 3, name: "My edited name" })));
  });

  it("discards the draft for the current revision without saving anything", async () => {
    await render();
    await typeName("My edited name");
    await rerender(board({ revision: 3, name: "Renamed elsewhere", updatedAt: "2026-09-29T02:00:00.000Z" }));
    await click("Discard my draft");
    expect(container.querySelector("input")?.value).toBe("Renamed elsewhere");
    expect(container.textContent).not.toContain("Revision 3 is now current");
    expect(updateOpsSavedBoard).not.toHaveBeenCalled();
  });

  it("offers the same recovery when the owner finds a newer revision at save time", async () => {
    await render();
    await typeName("My edited name");
    await click("Review changes");
    vi.mocked(fetchOpsSavedBoard).mockResolvedValue(board({ revision: 3, name: "Renamed elsewhere", updatedAt: "2026-09-29T02:00:00.000Z" }));
    await click("Confirm save");
    await vi.waitFor(() => expect(container.textContent).toContain("Revision 3 is now current"));
    expect(updateOpsSavedBoard).not.toHaveBeenCalled();
    expect(button("Keep my draft on revision 3")).toBeDefined();
  });

  it("loads a newer revision instead of re-targeting stale content when nothing was edited", async () => {
    await render();
    await rerender(board({ revision: 3, name: "Renamed elsewhere", updatedAt: "2026-09-29T02:00:00.000Z" }));
    expect(container.textContent).toContain("You have no unsaved edits");
    expect(button("Keep my draft on revision 3")).toBeUndefined();
    await click("Load revision 3");
    expect(container.querySelector("input")?.value).toBe("Renamed elsewhere");
    expect(container.textContent).not.toContain("Revision 3 is now current");
    expect(updateOpsSavedBoard).not.toHaveBeenCalled();
  });

  it("offers recovery when a retained draft is reopened behind a newer board", async () => {
    await render();
    await typeName("My edited name");
    await act(async () => root.render(<QueryClientProvider client={client}><div /></QueryClientProvider>));
    const newer = board({ revision: 3, name: "Renamed elsewhere", updatedAt: "2026-09-29T02:00:00.000Z" });
    await rerender(newer);
    expect(container.querySelector("input")?.value).toBe("My edited name");
    expect(container.textContent).toContain("Revision 3 is now current");
    await click("Keep my draft on revision 3");
    vi.mocked(fetchOpsSavedBoard).mockResolvedValue(newer);
    vi.mocked(updateOpsSavedBoard).mockResolvedValue(board({ revision: 4, name: "My edited name" }));
    await click("Review changes");
    await click("Confirm save");
    await vi.waitFor(() => expect(updateOpsSavedBoard).toHaveBeenCalledWith("board-a", expect.objectContaining({ expectedRevision: 3, name: "My edited name" })));
  });

  it("hides recovery choices while a previous save outcome is unconfirmed", async () => {
    vi.mocked(updateOpsSavedBoard).mockRejectedValue(new Error("Response lost"));
    await render();
    await typeName("My edited name");
    await click("Review changes");
    await click("Confirm save");
    await vi.waitFor(() => expect(container.textContent).toContain("save outcome is unconfirmed"));
    await rerender(board({ revision: 3, name: "Renamed elsewhere", updatedAt: "2026-09-29T02:00:00.000Z" }));
    expect(button("Keep my draft on revision 3")).toBeUndefined();
    expect(button("Discard my draft")).toBeUndefined();
  });

  it("starts a fresh create identity only after the reviewed one is found to exist", async () => {
    await render(false);
    await typeName("New board");
    await click("Review new board");
    const first = lastReviewedKey();
    vi.mocked(fetchOpsSavedBoards).mockResolvedValue({ workspaceId: "workspace-a",
      items: [board({ revision: 1, updatedAt: board().createdAt, idempotencyKey: first })] });
    await click("Confirm save");
    await vi.waitFor(() => expect(container.textContent).toContain("This create identity already exists"));
    expect(createOpsSavedBoard).not.toHaveBeenCalled();
    await click("Start a fresh create request");
    vi.mocked(fetchOpsSavedBoards).mockResolvedValue({ workspaceId: "workspace-a", items: [] });
    vi.mocked(createOpsSavedBoard).mockImplementation(async (input) => {
      const saved = board({ revision: 1, updatedAt: board().createdAt, name: input.name, idempotencyKey: input.idempotencyKey, placements: input.placements });
      vi.mocked(fetchOpsSavedBoard).mockResolvedValue(saved);
      return saved;
    });
    await click("Review new board");
    await click("Confirm save");
    await vi.waitFor(() => expect(createOpsSavedBoard).toHaveBeenCalledOnce());
    expect(vi.mocked(createOpsSavedBoard).mock.calls[0]![0].idempotencyKey).not.toBe(first);
  });

  it("keeps confirmed settlement when query refresh fails", async () => {
    vi.mocked(updateOpsSavedBoard).mockResolvedValue(board({ revision: 3 }));
    vi.mocked(fetchOpsSavedBoard)
      .mockResolvedValueOnce(board())
      .mockResolvedValue(board({ revision: 3 }));
    vi.spyOn(client, "invalidateQueries").mockRejectedValue(new Error("cache unavailable"));
    await render();
    await click("Review changes");
    await click("Confirm save");
    expect(container.textContent).toContain("Board saved and confirmed. The view could not refresh");
    expect(container.textContent).not.toContain("save outcome is unconfirmed");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("does not navigate from a completed refresh after the editor closes", async () => {
    let finishRefresh!: () => void;
    vi.mocked(updateOpsSavedBoard).mockResolvedValue(board({ revision: 3 }));
    vi.mocked(fetchOpsSavedBoard)
      .mockResolvedValueOnce(board())
      .mockResolvedValue(board({ revision: 3 }));
    vi.spyOn(client, "invalidateQueries").mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    await render();
    await click("Review changes");
    await click("Confirm save");
    await click("Close editor");
    await act(async () => finishRefresh());
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
