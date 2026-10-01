import { beforeEach, expect, it, vi } from "vitest";
import { commitReviewedBoard, type ReviewedBoardMutation } from "./board-mutation";
import { __resetBoardMutationsForTests, admitBoardMutation, boardMutationKey } from "./board-mutation-state";
import { boardFixture, deferred } from "./board-mutation.test-support";
const api = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  restore: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/ops-saved-boards", () => ({
  fetchOpsSavedBoards: api.list,
  fetchOpsSavedBoard: api.get,
  createOpsSavedBoard: api.create,
  updateOpsSavedBoard: api.update,
  archiveOpsSavedBoard: api.archive,
  restoreOpsSavedBoard: api.restore,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => "http://fixture",
}));
const update = (): ReviewedBoardMutation => ({
  kind: "update",
  before: boardFixture(),
  input: {
    workspaceId: "workspace-a",
    expectedRevision: 2,
    name: "Changed board",
  },
});
const create = (id = "new-create"): ReviewedBoardMutation => ({
  kind: "create",
  input: {
    workspaceId: "workspace-a",
    idempotencyKey: id,
    name: "New board",
    placements: boardFixture().placements,
  },
});
const saved = () => boardFixture({ revision: 3, name: "Changed board" });
const conflict = () => ({
  status: 409,
  body: {
    code: "WRITE_CONFLICT",
    details: {
      resourceKind: "ops_saved_board",
      resourceId: "board-a",
      expectedRevision: 2,
      currentRevision: 3,
    },
  },
});
beforeEach(() => {
  vi.resetAllMocks();
  __resetBoardMutationsForTests();
  api.list.mockResolvedValue({ workspaceId: "workspace-a", items: [] });
  api.get.mockResolvedValueOnce(boardFixture()).mockResolvedValue(saved());
  api.update.mockResolvedValue(saved());
});
it("uses distinct reads and acknowledges only exact receipt plus independent canonical record", async () => {
  const acknowledge = vi.fn();
  await expect(commitReviewedBoard(update(), () => true, acknowledge)).resolves.toEqual(saved());
  expect(api.get).toHaveBeenCalledTimes(2);
  expect(api.get.mock.calls[0]![2]).toBeInstanceOf(AbortSignal);
  expect(api.get.mock.calls[1]![2]).not.toBe(api.get.mock.calls[0]![2]);
  expect(acknowledge).toHaveBeenCalledWith(saved());
  expect(admitBoardMutation(boardMutationKey("workspace-a", "board-a"))).toBeDefined();
});
it("retains omitted update fields and checks them against the original record", async () => {
  const before = boardFixture({ description: "Keep this description" });
  const after = { ...before, name: "Changed board", revision: 3 };
  api.get.mockReset().mockResolvedValueOnce(before).mockResolvedValue(after);
  api.update.mockResolvedValue(after);
  await expect(
    commitReviewedBoard(
      {
        kind: "update",
        before,
        input: {
          workspaceId: before.workspaceId,
          expectedRevision: before.revision,
          name: "Changed board",
        },
      },
      () => true,
    ),
  ).resolves.toEqual(after);
});
it("checks create receipt and never adopts an already occupied idempotency identity", async () => {
  const created = boardFixture({
    revision: 1,
    name: "New board",
    idempotencyKey: "new-create",
    updatedAt: boardFixture().createdAt,
  });
  api.create.mockResolvedValue(created);
  api.get.mockReset().mockResolvedValue(created);
  await expect(commitReviewedBoard(create(), () => true)).resolves.toEqual(created);
  expect(api.list).toHaveBeenCalledWith({ workspaceId: "workspace-a", includeArchived: true }, expect.any(AbortSignal));
  api.list.mockResolvedValue({ workspaceId: "workspace-a", items: [created] });
  await expect(commitReviewedBoard(create(), () => true)).rejects.toThrow("already exists");
  expect(api.create).toHaveBeenCalledTimes(1);
});
it.each(["archive", "restore"] as const)("binds %s to original identity and exact unchanged fields", async (kind) => {
  const before =
    kind === "archive"
      ? boardFixture()
      : boardFixture({ status: "archived", archivedAt: "2026-09-29T01:00:00.000Z", archivedByActorId: "operator" });
  const after =
    kind === "archive"
      ? boardFixture({
          revision: 3,
          status: "archived",
          archivedAt: "2026-09-29T02:00:00.000Z",
          updatedAt: "2026-09-29T02:00:00.000Z",
          archivedByActorId: "operator",
        })
      : boardFixture({ revision: 3 });
  api.get.mockReset().mockResolvedValueOnce(before).mockResolvedValue(after);
  api[kind].mockResolvedValue(after);
  await expect(commitReviewedBoard({ kind, before }, () => true)).resolves.toEqual(after);
  expect(api[kind]).toHaveBeenCalledWith("board-a", { workspaceId: "workspace-a", expectedRevision: 2 });
});
it("cancels stale revision or view preflight before any write", async () => {
  api.get.mockReset().mockResolvedValue(saved());
  await expect(commitReviewedBoard(update(), () => true)).rejects.toThrow("changed during review");
  let current = true;
  const pending = deferred<ReturnType<typeof boardFixture>>();
  api.get.mockImplementation(() => pending.promise);
  const result = commitReviewedBoard(update(), () => current);
  current = false;
  pending.resolve(boardFixture());
  await expect(result).resolves.toBeUndefined();
  expect(api.update).not.toHaveBeenCalled();
});
it("admits exactly one pending write across independent shell callers", async () => {
  const pending = deferred<ReturnType<typeof boardFixture>>();
  api.get.mockReset().mockReturnValueOnce(pending.promise).mockResolvedValue(saved());
  const first = commitReviewedBoard(update(), () => true);
  await expect(commitReviewedBoard(update(), () => true)).resolves.toBeUndefined();
  pending.resolve(boardFixture());
  await first;
  expect(api.update).toHaveBeenCalledTimes(1);
});
it("retains uncertain creation across a fresh identity rather than allowing a duplicate", async () => {
  api.create.mockRejectedValue(new Error("lost response"));
  await expect(commitReviewedBoard(create(), () => true)).rejects.toThrow("lost response");
  await expect(commitReviewedBoard(create("different-identity"), () => true)).resolves.toBeUndefined();
  expect(api.create).toHaveBeenCalledTimes(1);
});
it("releases only an exact repository precommit conflict", async () => {
  api.update.mockRejectedValue(conflict());
  await expect(commitReviewedBoard(update(), () => true)).rejects.toMatchObject({ status: 409 });
  expect(admitBoardMutation(boardMutationKey("workspace-a", "board-a"))).toBeDefined();
});
it.each([
  { status: 409 },
  { ...conflict(), body: { ...conflict().body, mutationCommitted: true } },
  { ...conflict(), body: { ...conflict().body, details: { ...conflict().body.details, resourceId: "other-board" } } },
])("retains uncertainty for noncanonical or committed conflicts %#", async (error) => {
  api.update.mockRejectedValue(error);
  await expect(commitReviewedBoard(update(), () => true)).rejects.toEqual(error);
  expect(admitBoardMutation(boardMutationKey("workspace-a", "board-a"))).toBeUndefined();
});
it("a later readback conflict cannot undo the known dispatched receipt", async () => {
  api.get.mockReset().mockResolvedValueOnce(boardFixture()).mockRejectedValue(conflict());
  await expect(commitReviewedBoard(update(), () => true)).rejects.toMatchObject({ status: 409 });
  expect(admitBoardMutation(boardMutationKey("workspace-a", "board-a"))).toBeUndefined();
});
it.each([{ requestSha256: "b".repeat(64) }, { createdByActorId: "other" }, { boardId: "foreign" }, { name: "wrong" }])(
  "withholds confirmation on a mismatched immutable or requested receipt %#",
  async (fields) => {
    api.update.mockResolvedValue(savedWith(fields));
    await expect(commitReviewedBoard(update(), () => true)).rejects.toThrow("receipt");
    expect(admitBoardMutation(boardMutationKey("workspace-a", "board-a"))).toBeUndefined();
  },
);
function savedWith(fields: Partial<ReturnType<typeof boardFixture>>) {
  return { ...saved(), ...fields };
}
it("does not turn a confirmed write into uncertainty if a presentation callback throws", async () => {
  await expect(
    commitReviewedBoard(
      update(),
      () => true,
      () => {
        throw new Error("presentation");
      },
    ),
  ).rejects.toThrow("presentation");
  expect(admitBoardMutation(boardMutationKey("workspace-a", "board-a"))).toBeDefined();
});
