import { OPS_SAVED_BOARD_SCHEMA_VERSION, type OpsSavedBoardRecord } from "@goatcitadel/contracts";
export function boardFixture(overrides: Partial<OpsSavedBoardRecord> = {}): OpsSavedBoardRecord {
  return {
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
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
