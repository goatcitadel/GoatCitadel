import {
  assertOpsSavedBoardRecord,
  canonicalJsonString,
  normalizeOpsSavedBoardCreateInput,
  normalizeOpsSavedBoardUpdateInput,
  type OpsSavedBoardCreateInput,
  type OpsSavedBoardRecord,
  type OpsSavedBoardUpdateInput,
} from "@goatcitadel/contracts";
import {
  archiveOpsSavedBoard,
  createOpsSavedBoard,
  fetchOpsSavedBoard,
  fetchOpsSavedBoards,
  restoreOpsSavedBoard,
  updateOpsSavedBoard,
} from "@goatcitadel/mission-control-shared/api/ops-saved-boards";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { admitBoardMutation, boardMutationKey } from "./board-mutation-state";
export type ReviewedBoardMutation =
  | { kind: "create"; input: OpsSavedBoardCreateInput }
  | { kind: "update"; before: OpsSavedBoardRecord; input: OpsSavedBoardUpdateInput }
  | { kind: "archive" | "restore"; before: OpsSavedBoardRecord };
export class BoardReviewConflict extends Error {
  constructor(
    message: string,
    readonly current?: OpsSavedBoardRecord,
  ) {
    super(message);
    this.name = "BoardReviewConflict";
  }
}
export const sameBoard = (a: unknown, b: unknown) => canonicalJsonString(a) === canonicalJsonString(b);
function immutable(board: OpsSavedBoardRecord) {
  return {
    boardId: board.boardId,
    workspaceId: board.workspaceId,
    schemaVersion: board.schemaVersion,
    createdAt: board.createdAt,
    createdByActorId: board.createdByActorId,
    idempotencyKey: board.idempotencyKey,
    requestSha256: board.requestSha256,
  };
}
function exactReceipt(command: ReviewedBoardMutation, receipt: OpsSavedBoardRecord) {
  assertOpsSavedBoardRecord(receipt);
  if (command.kind === "create") {
    const input = normalizeOpsSavedBoardCreateInput(command.input);
    if (
      receipt.workspaceId !== input.workspaceId ||
      receipt.idempotencyKey !== input.idempotencyKey ||
      receipt.revision !== 1 ||
      receipt.status !== "active" ||
      receipt.name !== input.name ||
      (receipt.description ?? null) !== (input.description ?? null) ||
      !sameBoard(receipt.placements, input.placements)
    )
      throw new Error("The creation receipt does not match the reviewed new board.");
    return;
  }
  const before = command.before;
  if (
    !sameBoard(immutable(receipt), immutable(before)) ||
    receipt.revision !== before.revision + 1 ||
    receipt.status !== (command.kind === "archive" ? "archived" : "active")
  )
    throw new Error("The board receipt does not match the reviewed identity and revision.");
  const input = command.kind === "update" ? normalizeOpsSavedBoardUpdateInput(command.input) : before;
  const expected = { ...before, ...input };
  if (
    receipt.name !== expected.name ||
    (receipt.description ?? null) !== (expected.description ?? null) ||
    !sameBoard(receipt.placements, expected.placements)
  )
    throw new Error("The board receipt does not match its reviewed fields.");
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
/** Only exact repository CAS/idempotency conflicts are known to precede mutation; generic HTTP failures remain unknown. */
function rejectedBeforeCommit(error: unknown, command: ReviewedBoardMutation) {
  const value = object(error),
    body = object(value?.body),
    details = object(body?.details);
  if (
    value?.status !== 409 ||
    !body ||
    !details ||
    value.mutationCommitted === true ||
    body.mutationCommitted === true ||
    details.mutationCommitted === true
  )
    return false;
  if (command.kind === "create")
    return (
      body.code === "STATE_CONFLICT" &&
      details.workspaceId === command.input.workspaceId &&
      details.idempotencyKey === command.input.idempotencyKey
    );
  return (
    body.code === "WRITE_CONFLICT" &&
    details.resourceKind === "ops_saved_board" &&
    details.resourceId === command.before.boardId &&
    details.expectedRevision === command.before.revision &&
    typeof details.currentRevision === "number"
  );
}
export async function commitReviewedBoard(
  command: ReviewedBoardMutation,
  isCurrent: () => boolean,
  onConfirmed?: (saved: OpsSavedBoardRecord) => void,
): Promise<OpsSavedBoardRecord | undefined> {
  command = structuredClone(command);
  const workspaceId = command.kind === "create" ? command.input.workspaceId : command.before.workspaceId;
  const base = getGatewayApiBaseUrl(),
    key = boardMutationKey(workspaceId, command.kind === "create" ? undefined : command.before.boardId);
  if (!isCurrent()) return undefined;
  const operation = admitBoardMutation(key);
  if (!operation) return undefined;
  let dispatched = false;
  let received = false;
  const current = () => isCurrent() && getGatewayApiBaseUrl() === base;
  try {
    if (command.kind === "create") {
      command = { kind: "create", input: normalizeOpsSavedBoardCreateInput(command.input) };
      const createInput = command.input;
      const list = await fetchOpsSavedBoards({ workspaceId, includeArchived: true }, new AbortController().signal);
      if (!current()) return undefined;
      if (list.workspaceId !== workspaceId || list.items.some((board) => board.workspaceId !== workspaceId))
        throw new Error("The board list belongs to a different workspace.");
      if (list.items.some((board) => board.idempotencyKey === createInput.idempotencyKey))
        throw new BoardReviewConflict(
          "This create identity already exists. Review its canonical board before starting another request.",
        );
    } else {
      assertOpsSavedBoardRecord(command.before);
      if (command.kind === "update") {
        const input = normalizeOpsSavedBoardUpdateInput(command.input);
        if (input.workspaceId !== workspaceId)
          throw new Error("The update does not match the reviewed workspace/revision.");
        if (input.expectedRevision !== command.before.revision)
          throw new BoardReviewConflict(
            "The retained draft has an older board revision. Review the current board before saving.",
            command.before,
          );
        command = { ...command, input };
      }
      const latest = await fetchOpsSavedBoard(workspaceId, command.before.boardId, new AbortController().signal);
      if (!current()) return undefined;
      if (!sameBoard(latest, command.before) || latest.status !== (command.kind === "restore" ? "archived" : "active"))
        throw new BoardReviewConflict(
          "This board changed during review. Reopen its current layout before saving your changes.",
          latest,
        );
    }
    if (!current()) return undefined;
    dispatched = true;
    const saved =
      command.kind === "create"
        ? await createOpsSavedBoard(command.input)
        : command.kind === "update"
          ? await updateOpsSavedBoard(command.before.boardId, command.input)
          : await (command.kind === "archive" ? archiveOpsSavedBoard : restoreOpsSavedBoard)(command.before.boardId, {
              workspaceId,
              expectedRevision: command.before.revision,
            });
    received = true;
    if (getGatewayApiBaseUrl() !== base) throw new Error("Gateway installation changed.");
    exactReceipt(command, saved);
    const canonical = await fetchOpsSavedBoard(workspaceId, saved.boardId, new AbortController().signal);
    if (getGatewayApiBaseUrl() !== base || !sameBoard(canonical, saved))
      throw new Error("The saved board could not be confirmed by independent owner readback.");
    // Canonical settlement is complete before draft acknowledgement or presentation callbacks.
    dispatched = false;
    operation.finish();
    onConfirmed?.(saved);
    return saved;
  } catch (error) {
    if (dispatched && (received || !rejectedBeforeCommit(error, command))) operation.unknown();
    throw error;
  } finally {
    operation.finish();
  }
}
