import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ACTIVE_BOARD = {
  schemaVersion: "goatcitadel.ops-board.v1",
  boardId: "board-1",
  workspaceId: "workspace/one",
  name: "Operations",
  status: "active",
  placements: [{ widgetId: "runtime", kind: "runtime_truth_summary", x: 0, y: 0, width: 6, height: 4 }],
  revision: 1,
  createdByActorId: "operator-1",
  createdAt: "2026-07-14T00:00:00.000Z",
  updatedByActorId: "operator-1",
  updatedAt: "2026-07-14T00:00:00.000Z",
  idempotencyKey: "board-request-1",
  requestSha256: "a".repeat(64),
} as const;

describe("ops saved boards API", { timeout: 15_000 }, () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { protocol: "http:", hostname: "localhost", pathname: "/ops/boards", search: "", hash: "" },
        localStorage: memoryStorage(),
        sessionStorage: memoryStorage(),
      },
    });
    vi.stubGlobal("crypto", { randomUUID: () => "ops-board-request" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("lists and reads exact workspace-bound records with no-store requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ workspaceId: "workspace/one", items: [ACTIVE_BOARD] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(ACTIVE_BOARD)));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchOpsSavedBoard, fetchOpsSavedBoards } = await import("./ops-saved-boards.js");

    expect(await fetchOpsSavedBoards({ workspaceId: "workspace/one", includeArchived: true })).toEqual({
      workspaceId: "workspace/one",
      items: [ACTIVE_BOARD],
    });
    expect(await fetchOpsSavedBoard("workspace/one", "board-1")).toEqual(ACTIVE_BOARD);

    const listUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(listUrl.pathname).toBe("/api/v1/ops/boards");
    expect(listUrl.searchParams.get("workspaceId")).toBe("workspace/one");
    expect(listUrl.searchParams.get("includeArchived")).toBe("true");
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).cache).toBe("no-store");
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).pathname).toBe("/api/v1/ops/boards/board-1");
  });

  it("sends only normalized create, update, archive, and restore contracts", async () => {
    const updated = {
      ...ACTIVE_BOARD,
      name: "Updated",
      revision: 2,
      updatedAt: "2026-07-14T00:01:00.000Z",
    };
    const archived = {
      ...updated,
      status: "archived",
      revision: 3,
      updatedAt: "2026-07-14T00:02:00.000Z",
      archivedByActorId: "operator-1",
      archivedAt: "2026-07-14T00:02:00.000Z",
    };
    const restored = {
      ...updated,
      revision: 4,
      updatedAt: "2026-07-14T00:03:00.000Z",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(ACTIVE_BOARD), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(updated)))
      .mockResolvedValueOnce(new Response(JSON.stringify(archived)))
      .mockResolvedValueOnce(new Response(JSON.stringify(restored)));
    vi.stubGlobal("fetch", fetchMock);
    const { archiveOpsSavedBoard, createOpsSavedBoard, restoreOpsSavedBoard, updateOpsSavedBoard } =
      await import("./ops-saved-boards.js");

    await createOpsSavedBoard({
      workspaceId: "workspace/one",
      name: " Operations ",
      placements: [...ACTIVE_BOARD.placements],
      idempotencyKey: "board-request-1",
    });
    await updateOpsSavedBoard("board-1", {
      workspaceId: "workspace/one",
      name: " Updated ",
      expectedRevision: 1,
    });
    await archiveOpsSavedBoard("board-1", { workspaceId: "workspace/one", expectedRevision: 2 });
    await restoreOpsSavedBoard("board-1", { workspaceId: "workspace/one", expectedRevision: 3 });

    expect(requestBody(fetchMock, 0)).toMatchObject({ name: "Operations", idempotencyKey: "board-request-1" });
    expect(requestBody(fetchMock, 1)).toEqual({
      workspaceId: "workspace/one",
      name: "Updated",
      expectedRevision: 1,
    });
    expect(new URL(String(fetchMock.mock.calls[2]?.[0])).pathname).toBe("/api/v1/ops/boards/board-1/archive");
    expect(new URL(String(fetchMock.mock.calls[3]?.[0])).pathname).toBe("/api/v1/ops/boards/board-1/restore");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("fails closed on a foreign workspace, duplicate identity, or malformed record", async () => {
    const foreign = { ...ACTIVE_BOARD, workspaceId: "workspace-two" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ workspaceId: "workspace/one", items: [foreign] })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ workspaceId: "workspace/one", items: [ACTIVE_BOARD, ACTIVE_BOARD] })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workspaceId: "workspace/one",
            items: [ACTIVE_BOARD, { ...ACTIVE_BOARD, boardId: "board-2" }],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workspaceId: "workspace/one",
            items: Array.from({ length: 65 }, (_, index) => ({
              ...ACTIVE_BOARD,
              boardId: `board-${index}`,
              idempotencyKey: `board-request-${index}`,
            })),
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...ACTIVE_BOARD, requestSha256: "not-a-digest" })));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchOpsSavedBoard, fetchOpsSavedBoards } = await import("./ops-saved-boards.js");

    await expect(fetchOpsSavedBoards({ workspaceId: "workspace/one" })).rejects.toThrow(/requested identity/);
    await expect(fetchOpsSavedBoards({ workspaceId: "workspace/one" })).rejects.toThrow(/duplicate board identity/);
    await expect(fetchOpsSavedBoards({ workspaceId: "workspace/one" })).rejects.toThrow(/duplicate create identity/);
    await expect(fetchOpsSavedBoards({ workspaceId: "workspace/one" })).rejects.toThrow(/board limit/);
    await expect(fetchOpsSavedBoard("workspace/one", "board-1")).rejects.toThrow(/SHA-256/);
  });

  it("fails closed when a mutation response does not prove the requested CAS transition", async () => {
    const wrongUpdateRevision = {
      ...ACTIVE_BOARD,
      name: "Updated",
      revision: 3,
      updatedAt: "2026-07-14T00:01:00.000Z",
    };
    const wrongUpdateFields = {
      ...ACTIVE_BOARD,
      name: "Server changed it",
      revision: 2,
      updatedAt: "2026-07-14T00:01:00.000Z",
    };
    const wrongArchiveStatus = {
      ...ACTIVE_BOARD,
      revision: 2,
      updatedAt: "2026-07-14T00:01:00.000Z",
    };
    const wrongRestoreStatus = {
      ...ACTIVE_BOARD,
      status: "archived",
      revision: 4,
      updatedAt: "2026-07-14T00:03:00.000Z",
      archivedByActorId: "operator-1",
      archivedAt: "2026-07-14T00:03:00.000Z",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(wrongUpdateRevision)))
      .mockResolvedValueOnce(new Response(JSON.stringify(wrongUpdateFields)))
      .mockResolvedValueOnce(new Response(JSON.stringify(wrongArchiveStatus)))
      .mockResolvedValueOnce(new Response(JSON.stringify(wrongRestoreStatus)));
    vi.stubGlobal("fetch", fetchMock);
    const { archiveOpsSavedBoard, restoreOpsSavedBoard, updateOpsSavedBoard } = await import("./ops-saved-boards.js");

    await expect(
      updateOpsSavedBoard("board-1", {
        workspaceId: "workspace/one",
        name: "Updated",
        expectedRevision: 1,
      }),
    ).rejects.toThrow(/CAS transition/);
    await expect(
      updateOpsSavedBoard("board-1", {
        workspaceId: "workspace/one",
        name: "Updated",
        expectedRevision: 1,
      }),
    ).rejects.toThrow(/mutable fields/);
    await expect(
      archiveOpsSavedBoard("board-1", { workspaceId: "workspace/one", expectedRevision: 1 }),
    ).rejects.toThrow(/CAS transition/);
    await expect(
      restoreOpsSavedBoard("board-1", { workspaceId: "workspace/one", expectedRevision: 3 }),
    ).rejects.toThrow(/CAS transition/);
  });

  it("does not retry a failed mutation", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    const { createOpsSavedBoard } = await import("./ops-saved-boards.js");

    await expect(
      createOpsSavedBoard({
        workspaceId: "workspace/one",
        name: "Operations",
        placements: [...ACTIVE_BOARD.placements],
        idempotencyKey: "board-request-1",
      }),
    ).rejects.toThrow(/Network error/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function requestBody(fetchMock: ReturnType<typeof vi.fn>, index: number): unknown {
  return JSON.parse(String((fetchMock.mock.calls[index]?.[1] as RequestInit).body));
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}
