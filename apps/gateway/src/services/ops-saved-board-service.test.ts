import { describe, expect, it, vi } from "vitest";
import {
  ConflictError,
  NotFoundError,
  type OpsSavedBoardCreateInput,
  type OpsSavedBoardRecord,
} from "@goatcitadel/contracts";
import {
  OpsSavedBoardService,
  type OpsSavedBoardRepositoryPort,
  type OpsSavedBoardServiceStoragePort,
} from "./ops-saved-board-service.js";

function record(overrides: Partial<OpsSavedBoardRecord> = {}): OpsSavedBoardRecord {
  return {
    schemaVersion: "goatcitadel.ops-board.v1",
    boardId: "board-1",
    workspaceId: "workspace-1",
    name: "Operations",
    status: "active",
    placements: [
      {
        widgetId: "kanban",
        kind: "agentic_run_kanban",
        x: 0,
        y: 0,
        width: 6,
        height: 4,
      },
    ],
    revision: 1,
    createdByActorId: "operator-1",
    createdAt: "2026-07-14T12:00:00.000Z",
    updatedByActorId: "operator-1",
    updatedAt: "2026-07-14T12:00:00.000Z",
    idempotencyKey: "create-1",
    requestSha256: "a".repeat(64),
    ...overrides,
  };
}

function createInput(overrides: Partial<OpsSavedBoardCreateInput> = {}): OpsSavedBoardCreateInput {
  return {
    workspaceId: "workspace-1",
    name: "Operations",
    placements: [
      {
        widgetId: "kanban",
        kind: "agentic_run_kanban",
        x: 0,
        y: 0,
        width: 6,
        height: 4,
      },
    ],
    idempotencyKey: "create-1",
    ...overrides,
  };
}

function buildService(overrides: Partial<OpsSavedBoardRepositoryPort> = {}) {
  const boards: OpsSavedBoardRepositoryPort = {
    listByWorkspace: vi.fn(() => [record()]),
    get: vi.fn(() => record()),
    createWithOutcome: vi.fn(() => ({ record: record(), inserted: true })),
    update: vi.fn(() => record({ revision: 2, updatedAt: "2026-07-14T12:01:00.000Z" })),
    archive: vi.fn(() =>
      record({
        status: "archived",
        revision: 2,
        updatedAt: "2026-07-14T12:01:00.000Z",
        archivedByActorId: "operator-1",
        archivedAt: "2026-07-14T12:01:00.000Z",
      }),
    ),
    restore: vi.fn(() => record({ revision: 3, updatedAt: "2026-07-14T12:02:00.000Z" })),
    ...overrides,
  };
  const workspaces = {
    get: vi.fn((workspaceId: string) => ({ workspaceId })),
  };
  const storage: OpsSavedBoardServiceStoragePort = { opsSavedBoards: boards, workspaces };
  const publishChange = vi.fn();
  const reportPublicationFailure = vi.fn();
  return {
    service: new OpsSavedBoardService(storage, {
      realtimeEpoch: "epoch-1",
      publishChange,
      reportPublicationFailure,
    }),
    boards,
    storage,
    workspaces,
    publishChange,
    reportPublicationFailure,
  };
}

describe("OpsSavedBoardService", () => {
  it("proves the exact workspace before every read and mutation and forwards only normalized inputs", () => {
    const { service, boards, workspaces, publishChange } = buildService();

    service.list("workspace-1", true);
    service.get("workspace-1", "board-1");
    service.create(createInput({ name: "  Operations  " }), "operator-1");
    service.update("board-1", { workspaceId: "workspace-1", name: "  New board  ", expectedRevision: 1 }, "operator-1");
    service.archive("board-1", { workspaceId: "workspace-1", expectedRevision: 2 }, "operator-1");
    service.restore("board-1", { workspaceId: "workspace-1", expectedRevision: 3 }, "operator-1");

    expect(workspaces.get).toHaveBeenCalledTimes(6);
    expect(workspaces.get).toHaveBeenCalledWith("workspace-1");
    expect(boards.listByWorkspace).toHaveBeenCalledWith("workspace-1", true);
    expect(boards.get).toHaveBeenCalledWith("workspace-1", "board-1");
    expect(boards.createWithOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-1", name: "Operations" }),
      "operator-1",
    );
    expect(boards.update).toHaveBeenCalledWith(
      "board-1",
      { workspaceId: "workspace-1", name: "New board", expectedRevision: 1 },
      "operator-1",
    );
    expect(boards.archive).toHaveBeenCalledWith(
      "board-1",
      { workspaceId: "workspace-1", expectedRevision: 2 },
      "operator-1",
    );
    expect(boards.restore).toHaveBeenCalledWith(
      "board-1",
      { workspaceId: "workspace-1", expectedRevision: 3 },
      "operator-1",
    );
    expect(publishChange.mock.calls.map(([signal]) => signal)).toEqual([
      { workspaceId: "workspace-1", boardId: "board-1", revision: 1, epoch: "epoch-1", operation: "create" },
      { workspaceId: "workspace-1", boardId: "board-1", revision: 2, epoch: "epoch-1", operation: "update" },
      { workspaceId: "workspace-1", boardId: "board-1", revision: 2, epoch: "epoch-1", operation: "archive" },
      { workspaceId: "workspace-1", boardId: "board-1", revision: 3, epoch: "epoch-1", operation: "restore" },
    ]);
    expect(publishChange.mock.calls.every(([signal]) => Object.isFrozen(signal))).toBe(true);
    expect(
      publishChange.mock.calls.every(
        ([signal]) => Object.keys(signal).sort().join(",") === "boardId,epoch,operation,revision,workspaceId",
      ),
    ).toBe(true);
  });

  it("preserves idempotent create replay and same-key/different-byte conflict from storage", () => {
    const winning = record();
    const createWithOutcome = vi
      .fn<OpsSavedBoardRepositoryPort["createWithOutcome"]>()
      .mockReturnValueOnce({ record: winning, inserted: true })
      .mockReturnValueOnce({ record: winning, inserted: false })
      .mockImplementationOnce(() => {
        throw new ConflictError({
          code: "STATE_CONFLICT",
          message: "Idempotency key was already used for different request bytes.",
        });
      });
    const { service, publishChange } = buildService({ createWithOutcome });

    expect(service.create(createInput(), "operator-1")).toBe(winning);
    expect(service.create(createInput(), "operator-1")).toBe(winning);
    expect(() => service.create(createInput({ name: "Different" }), "operator-1")).toThrow(ConflictError);
    expect(publishChange).toHaveBeenCalledTimes(1);
  });

  it("preserves stale-revision and archived-board conflicts without retrying a mutation", () => {
    const update = vi.fn<OpsSavedBoardRepositoryPort["update"]>(() => {
      throw new ConflictError({ code: "WRITE_CONFLICT", message: "Board changed since revision 1." });
    });
    const archive = vi.fn<OpsSavedBoardRepositoryPort["archive"]>(() => {
      throw new ConflictError({ code: "STATE_CONFLICT", message: "Board must be active for this mutation." });
    });
    const { service, publishChange } = buildService({ update, archive });

    expect(() =>
      service.update("board-1", { workspaceId: "workspace-1", name: "Changed", expectedRevision: 1 }, "operator-1"),
    ).toThrow(ConflictError);
    expect(() => service.archive("board-1", { workspaceId: "workspace-1", expectedRevision: 2 }, "operator-1")).toThrow(
      ConflictError,
    );
    expect(update).toHaveBeenCalledTimes(1);
    expect(archive).toHaveBeenCalledTimes(1);
    expect(publishChange).not.toHaveBeenCalled();
  });

  it("makes a foreign workspace, missing workspace, and missing board the same board-scoped 404", () => {
    const foreign = buildService({
      get: vi.fn(() => {
        throw new NotFoundError("foreign board is outside the requested workspace");
      }),
    });
    const missingBoard = buildService({
      get: vi.fn(() => {
        throw new NotFoundError({ entity: "ops saved board", id: "board-1" });
      }),
    });
    const missingWorkspace = buildService();
    missingWorkspace.workspaces.get.mockImplementation(() => {
      throw new NotFoundError({ entity: "Workspace", id: "workspace-1" });
    });

    const capture = (service: OpsSavedBoardService) => {
      try {
        service.get("workspace-1", "board-1");
      } catch (error) {
        return (error as NotFoundError).toJSON();
      }
      throw new Error("Expected a board-scoped miss.");
    };

    expect(capture(foreign.service)).toEqual(capture(missingBoard.service));
    expect(capture(missingWorkspace.service)).toEqual(capture(missingBoard.service));
    expect(missingWorkspace.boards.get).not.toHaveBeenCalled();
  });

  it("fails closed when the workspace port returns a mismatched identity", () => {
    const { service, boards, workspaces } = buildService();
    workspaces.get.mockReturnValue({ workspaceId: "workspace-foreign" });

    expect(() =>
      service.update("board-1", { workspaceId: "workspace-1", name: "Changed", expectedRevision: 1 }, "operator-1"),
    ).toThrow(/Ops saved board board-1 not found/u);
    expect(boards.update).not.toHaveBeenCalled();
  });

  it("rejects non-canonical actors before storage mutation", () => {
    const { service, boards } = buildService();

    for (const actorId of [" operator-1 ", "operator\n1", "operator-\uff11"]) {
      expect(() => service.create(createInput(), actorId)).toThrow(/actorId is not a canonical identifier/u);
    }
    expect(boards.createWithOutcome).not.toHaveBeenCalled();
  });

  it("keeps committed board truth canonical when post-commit publication or diagnostics fail", () => {
    const { service, boards, publishChange, reportPublicationFailure } = buildService();
    publishChange.mockImplementation(() => {
      throw new Error("retained realtime unavailable");
    });
    reportPublicationFailure.mockImplementation(() => {
      throw new Error("diagnostics unavailable");
    });

    expect(service.create(createInput(), "operator-1")).toMatchObject({ boardId: "board-1", revision: 1 });
    expect(publishChange).toHaveBeenCalledTimes(1);
    expect(boards.createWithOutcome).toHaveBeenCalledTimes(1);
    expect(reportPublicationFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: "retained realtime unavailable" }),
      expect.objectContaining({ operation: "create", revision: 1 }),
    );
  });

  it("absorbs asynchronous publisher and diagnostic rejection after one committed mutation", async () => {
    const { service, boards, publishChange, reportPublicationFailure } = buildService();
    publishChange.mockImplementation(() => Promise.reject(new Error("async retained realtime unavailable")));
    reportPublicationFailure.mockImplementation(() => Promise.reject(new Error("async diagnostics unavailable")));

    expect(
      service.update("board-1", { workspaceId: "workspace-1", name: "Committed", expectedRevision: 1 }, "operator-1"),
    ).toMatchObject({ boardId: "board-1", revision: 2 });
    await vi.waitFor(() => expect(reportPublicationFailure).toHaveBeenCalledTimes(1));
    await Promise.resolve();

    expect(boards.update).toHaveBeenCalledTimes(1);
    expect(publishChange).toHaveBeenCalledTimes(1);
    expect(reportPublicationFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: "async retained realtime unavailable" }),
      { workspaceId: "workspace-1", boardId: "board-1", revision: 2, epoch: "epoch-1", operation: "update" },
    );
  });

  it("requires a nonempty canonical process epoch before admitting operations", () => {
    const { storage, publishChange, reportPublicationFailure } = buildService();

    for (const realtimeEpoch of ["", " epoch-1 ", "epoch\n1", "epoch-\uff11"]) {
      expect(
        () =>
          new OpsSavedBoardService(storage, {
            realtimeEpoch,
            publishChange,
            reportPublicationFailure,
          }),
      ).toThrow(/realtimeEpoch is not a canonical identifier/u);
    }
  });
});
