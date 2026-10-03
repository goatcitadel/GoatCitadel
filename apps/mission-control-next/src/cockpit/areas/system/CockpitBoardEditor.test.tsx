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
import { __resetBoardMutationsForTests } from "../../../features/native-routes/ops/board-mutation-state";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";

vi.mock("@goatcitadel/mission-control-shared/api/ops-saved-boards", () => ({
  createOpsSavedBoard: vi.fn(),
  fetchOpsSavedBoard: vi.fn(),
  fetchOpsSavedBoards: vi.fn(),
  updateOpsSavedBoard: vi.fn(),
}));

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

async function render(edit = true): Promise<void> {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CockpitBoardEditor
          workspaceId="workspace-a"
          board={edit ? board() : undefined}
          onClose={onClose}
          onSaved={onSaved}
        />
      </QueryClientProvider>,
    ),
  );
}

async function click(label: string): Promise<void> {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Missing ${label} button`);
  await act(async () => button.click());
}

describe("cockpit saved-board editor", () => {
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
    await vi.waitFor(() => expect(container.textContent).toContain("changed during review"));
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
