import {
  OPS_SAVED_BOARD_LIMITS,
  assertOpsSavedBoardRecord,
  normalizeOpsSavedBoardCreateInput,
  normalizeOpsSavedBoardStatusInput,
  normalizeOpsSavedBoardUpdateInput,
  type OpsSavedBoardCreateInput,
  type OpsSavedBoardRecord,
  type OpsSavedBoardStatusInput,
  type OpsSavedBoardUpdateInput,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export interface OpsSavedBoardListResponse {
  workspaceId: string;
  items: OpsSavedBoardRecord[];
}

export async function fetchOpsSavedBoards(input: {
  workspaceId: string;
  includeArchived?: boolean;
}): Promise<OpsSavedBoardListResponse> {
  const params = new URLSearchParams({ workspaceId: input.workspaceId });
  if (input.includeArchived) params.set("includeArchived", "true");
  const value = await request<unknown>(`/api/v1/ops/boards?${params.toString()}`, { cache: "no-store" });
  return parseListResponse(value, input.workspaceId);
}

export async function fetchOpsSavedBoard(workspaceId: string, boardId: string): Promise<OpsSavedBoardRecord> {
  const value = await request<unknown>(
    `/api/v1/ops/boards/${encodeURIComponent(boardId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
    { cache: "no-store" },
  );
  return parseBoard(value, workspaceId, boardId);
}

export async function createOpsSavedBoard(input: OpsSavedBoardCreateInput): Promise<OpsSavedBoardRecord> {
  const normalized = normalizeOpsSavedBoardCreateInput(input);
  const value = await request<unknown>("/api/v1/ops/boards", {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify(normalized),
  });
  const board = parseBoard(value, normalized.workspaceId);
  if (board.idempotencyKey !== normalized.idempotencyKey) {
    throw new TypeError("Ops saved board response does not match the create request identity.");
  }
  if (board.revision === 1) {
    assertMutableFieldsMatch(board, normalized, "create");
  }
  return board;
}

export async function updateOpsSavedBoard(
  boardId: string,
  input: OpsSavedBoardUpdateInput,
): Promise<OpsSavedBoardRecord> {
  const normalized = normalizeOpsSavedBoardUpdateInput(input);
  const value = await request<unknown>(`/api/v1/ops/boards/${encodeURIComponent(boardId)}`, {
    method: "PATCH",
    cache: "no-store",
    body: JSON.stringify(normalized),
  });
  const board = parseBoard(value, normalized.workspaceId, boardId);
  assertCasMutationResponse(board, normalized.expectedRevision, "active", "update");
  assertMutableFieldsMatch(board, normalized, "update");
  return board;
}

export async function archiveOpsSavedBoard(
  boardId: string,
  input: OpsSavedBoardStatusInput,
): Promise<OpsSavedBoardRecord> {
  return transitionOpsSavedBoard("archive", boardId, input);
}

export async function restoreOpsSavedBoard(
  boardId: string,
  input: OpsSavedBoardStatusInput,
): Promise<OpsSavedBoardRecord> {
  return transitionOpsSavedBoard("restore", boardId, input);
}

async function transitionOpsSavedBoard(
  operation: "archive" | "restore",
  boardId: string,
  input: OpsSavedBoardStatusInput,
): Promise<OpsSavedBoardRecord> {
  const normalized = normalizeOpsSavedBoardStatusInput(input);
  const value = await request<unknown>(`/api/v1/ops/boards/${encodeURIComponent(boardId)}/${operation}`, {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify(normalized),
  });
  const board = parseBoard(value, normalized.workspaceId, boardId);
  assertCasMutationResponse(
    board,
    normalized.expectedRevision,
    operation === "archive" ? "archived" : "active",
    operation,
  );
  return board;
}

function parseListResponse(value: unknown, expectedWorkspaceId: string): OpsSavedBoardListResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Ops saved board list response must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !Object.hasOwn(record, "workspaceId") ||
    !Object.hasOwn(record, "items") ||
    record.workspaceId !== expectedWorkspaceId ||
    !Array.isArray(record.items)
  ) {
    throw new TypeError("Ops saved board list response does not match the requested workspace.");
  }
  if (record.items.length > OPS_SAVED_BOARD_LIMITS.boardsPerWorkspace) {
    throw new TypeError("Ops saved board list response exceeds the workspace board limit.");
  }
  const boardIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  const items = record.items.map((item) => {
    const board = parseBoard(item, expectedWorkspaceId);
    if (boardIds.has(board.boardId)) throw new TypeError("Ops saved board list contains a duplicate board identity.");
    if (idempotencyKeys.has(board.idempotencyKey)) {
      throw new TypeError("Ops saved board list contains a duplicate create identity.");
    }
    boardIds.add(board.boardId);
    idempotencyKeys.add(board.idempotencyKey);
    return board;
  });
  return { workspaceId: expectedWorkspaceId, items };
}

function parseBoard(value: unknown, expectedWorkspaceId: string, expectedBoardId?: string): OpsSavedBoardRecord {
  assertOpsSavedBoardRecord(value);
  if (
    value.workspaceId !== expectedWorkspaceId ||
    (expectedBoardId !== undefined && value.boardId !== expectedBoardId)
  ) {
    throw new TypeError("Ops saved board response does not match the requested identity.");
  }
  return value;
}

function assertCasMutationResponse(
  board: OpsSavedBoardRecord,
  expectedRevision: number,
  expectedStatus: OpsSavedBoardRecord["status"],
  operation: string,
): void {
  if (board.revision !== expectedRevision + 1 || board.status !== expectedStatus) {
    throw new TypeError(`Ops saved board ${operation} response does not match the requested CAS transition.`);
  }
}

function assertMutableFieldsMatch(
  board: OpsSavedBoardRecord,
  expected: Pick<OpsSavedBoardCreateInput, "name" | "description" | "placements"> | OpsSavedBoardUpdateInput,
  operation: string,
): void {
  const mustMatchDescription = operation === "create" || Object.hasOwn(expected, "description");
  const descriptionMatches = !mustMatchDescription || (board.description ?? null) === (expected.description ?? null);
  if (
    (expected.name !== undefined && board.name !== expected.name) ||
    !descriptionMatches ||
    (expected.placements !== undefined && !placementsMatch(board.placements, expected.placements))
  ) {
    throw new TypeError(`Ops saved board ${operation} response does not match the requested mutable fields.`);
  }
}

function placementsMatch(
  actual: OpsSavedBoardRecord["placements"],
  expected: OpsSavedBoardRecord["placements"],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((placement, index) => {
      const candidate = expected[index];
      return (
        candidate !== undefined &&
        placement.widgetId === candidate.widgetId &&
        placement.kind === candidate.kind &&
        placement.x === candidate.x &&
        placement.y === candidate.y &&
        placement.width === candidate.width &&
        placement.height === candidate.height
      );
    })
  );
}
