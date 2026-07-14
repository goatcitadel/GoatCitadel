import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  ConflictError,
  NotFoundError,
  type OpsSavedBoardCreateInput,
  type OpsSavedBoardRecord,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { OpsSavedBoardRepository } from "./ops-saved-board-repo.js";
import { createDatabase } from "./sqlite.js";
import { WorkspaceRepository } from "./workspace-repo.js";

const NOW = "2026-07-14T12:00:00.000Z";
const files: string[] = [];
const clients: DatabaseClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const file of files.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${file}${suffix}`, { force: true });
  }
});

function createInput(overrides: Partial<OpsSavedBoardCreateInput> = {}): OpsSavedBoardCreateInput {
  return {
    workspaceId: "default",
    name: "Operations",
    description: "Trusted runtime summaries",
    placements: [
      {
        widgetId: "runtime",
        kind: "runtime_truth_summary",
        x: 0,
        y: 0,
        width: 6,
        height: 4,
      },
    ],
    idempotencyKey: "create-ops-board",
    ...overrides,
  };
}

function fileDatabase(): { dbPath: string; first: DatabaseClient; second: DatabaseClient } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-ops-board-${randomUUID()}.db`);
  files.push(dbPath);
  const first = createDatabase({ dbPath });
  const second = createDatabase({ dbPath });
  clients.push(first, second);
  return { dbPath, first, second };
}

describe("OpsSavedBoardRepository", () => {
  it("creates one canonical board and replays only the same workspace/key/request bytes", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    clients.push(db);
    const repo = new OpsSavedBoardRepository(db);
    const input = createInput({ name: "  Ｏperations  " });
    const createdOutcome = repo.createWithOutcome(input, "operator-1", NOW, "board-1");
    const created = createdOutcome.record;
    assert.equal(createdOutcome.inserted, true);
    assert.equal(created.name, "Operations");
    assert.equal(created.revision, 1);
    assert.equal(created.status, "active");
    assert.equal(created.createdByActorId, "operator-1");
    assert.match(created.requestSha256, /^[a-f0-9]{64}$/u);

    const replay = repo.createWithOutcome(input, "operator-1", "2026-07-14T12:01:00.000Z", "ignored-board-id");
    assert.deepEqual(replay.record, created);
    assert.equal(replay.inserted, false);
    assert.throws(
      () => repo.create({ ...input, name: "Different bytes" }, "operator-1", NOW, "board-2"),
      (error: unknown) => error instanceof ConflictError && error.code === "STATE_CONFLICT",
    );
    assert.throws(
      () => repo.create(input, "operator-2", NOW, "board-3"),
      (error: unknown) => error instanceof ConflictError && error.code === "STATE_CONFLICT",
    );

    const otherWorkspace = new WorkspaceRepository(db).create({ name: "Other Workspace" }, NOW);
    const independent = repo.create(
      { ...input, workspaceId: otherWorkspace.workspaceId },
      "operator-2",
      NOW,
      "board-1",
    );
    assert.equal(independent.workspaceId, otherWorkspace.workspaceId);
    assert.equal(repo.listByWorkspace("default").length, 1);
    assert.equal(repo.listByWorkspace(otherWorkspace.workspaceId).length, 1);
  });

  it("fences updates across two clients and enforces workspace, archive, and restore state", () => {
    const { first, second } = fileDatabase();
    const repoA = new OpsSavedBoardRepository(first);
    const repoB = new OpsSavedBoardRepository(second);
    const created = repoA.create(createInput(), "operator-a", NOW, "board-cas");
    const snapshotA = repoA.get("default", created.boardId);
    const snapshotB = repoB.get("default", created.boardId);

    const winner = repoA.update(
      created.boardId,
      {
        workspaceId: "default",
        name: "Winner",
        placements: [{ widgetId: "cost", kind: "usage_cost_summary", x: 6, y: 0, width: 6, height: 3 }],
        expectedRevision: snapshotA.revision,
      },
      "operator-a",
      "2026-07-14T12:01:00.000Z",
    );
    assert.equal(winner.revision, 2);
    assert.equal(winner.name, "Winner");
    assert.throws(
      () =>
        repoB.update(
          created.boardId,
          { workspaceId: "default", name: "Stale", expectedRevision: snapshotB.revision },
          "operator-b",
          "2026-07-14T12:02:00.000Z",
        ),
      (error: unknown) => error instanceof ConflictError && error.code === "WRITE_CONFLICT",
    );
    assert.throws(() => repoA.get("foreign-workspace", created.boardId), NotFoundError);
    assert.throws(
      () =>
        repoA.update(
          created.boardId,
          { workspaceId: "foreign-workspace", name: "Foreign", expectedRevision: 2 },
          "operator-a",
        ),
      NotFoundError,
    );

    const archived = repoB.archive(
      created.boardId,
      { workspaceId: "default", expectedRevision: 2 },
      "operator-b",
      "2026-07-14T12:03:00.000Z",
    );
    assert.equal(archived.revision, 3);
    assert.equal(archived.status, "archived");
    assert.equal(archived.archivedByActorId, "operator-b");
    assert.deepEqual(repoA.listByWorkspace("default"), []);
    assert.equal(repoA.listByWorkspace("default", true).length, 1);
    assert.throws(
      () =>
        repoA.update(created.boardId, { workspaceId: "default", name: "Blocked", expectedRevision: 3 }, "operator-a"),
      (error: unknown) => error instanceof ConflictError && error.code === "STATE_CONFLICT",
    );
    assert.throws(
      () => repoA.archive(created.boardId, { workspaceId: "default", expectedRevision: 3 }, "operator-a"),
      (error: unknown) => error instanceof ConflictError && error.code === "STATE_CONFLICT",
    );

    const restored = repoA.restore(
      created.boardId,
      { workspaceId: "default", expectedRevision: 3 },
      "operator-a",
      "2026-07-14T12:04:00.000Z",
    );
    assert.equal(restored.revision, 4);
    assert.equal(restored.status, "active");
    assert.equal(restored.archivedAt, undefined);
    assert.equal(repoB.listByWorkspace("default").length, 1);
    assert.throws(
      () => repoB.restore(created.boardId, { workspaceId: "default", expectedRevision: 3 }, "operator-b"),
      (error: unknown) => error instanceof ConflictError && error.code === "WRITE_CONFLICT",
    );
    assert.throws(
      () =>
        first
          .prepare("DELETE FROM ops_saved_boards WHERE workspace_id = ? AND board_id = ?")
          .run("default", created.boardId),
      /cannot be deleted/,
    );
  });

  it("enforces the 64-record cap across two connections including archived records and permits replay at cap", () => {
    const { first, second } = fileDatabase();
    const repoA = new OpsSavedBoardRepository(first);
    const repoB = new OpsSavedBoardRepository(second);
    let firstRecord: OpsSavedBoardRecord | undefined;
    for (let index = 0; index < 64; index += 1) {
      const repo = index % 2 === 0 ? repoA : repoB;
      const created = repo.create(
        createInput({ idempotencyKey: `board-key-${index}`, name: `Board ${index}` }),
        "operator-cap",
        new Date(Date.parse(NOW) + index * 1_000).toISOString(),
        `board-${index}`,
      );
      firstRecord ??= created;
    }
    assert.equal(repoA.listByWorkspace("default", true).length, 64);
    repoB.archive(
      "board-0",
      { workspaceId: "default", expectedRevision: 1 },
      "operator-cap",
      "2026-07-14T13:10:00.000Z",
    );
    assert.equal(repoA.listByWorkspace("default", true).length, 64);
    assert.throws(
      () =>
        repoA.create(
          createInput({ idempotencyKey: "board-key-64", name: "Board 64" }),
          "operator-cap",
          "2026-07-14T13:11:00.000Z",
          "board-64",
        ),
      (error: unknown) => error instanceof ConflictError && error.code === "STATE_CONFLICT",
    );
    assert.deepEqual(
      repoB.create(
        createInput({ idempotencyKey: "board-key-0", name: "Board 0" }),
        "operator-cap",
        "2026-07-14T13:12:00.000Z",
        "ignored",
      ),
      repoB.get("default", firstRecord!.boardId),
    );
  });

  it("rejects timestamp regression for update, archive, restore, and direct SQL transitions", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    clients.push(db);
    const repo = new OpsSavedBoardRepository(db);
    const created = repo.create(createInput(), "operator-1", NOW, "board-time");
    const updated = repo.update(
      created.boardId,
      { workspaceId: "default", name: "Updated", expectedRevision: 1 },
      "operator-1",
      "2026-07-14T12:04:00.000Z",
    );
    assert.throws(
      () =>
        repo.update(
          created.boardId,
          { workspaceId: "default", name: "Regressed", expectedRevision: updated.revision },
          "operator-1",
          "2026-07-14T12:03:00.000Z",
        ),
      (error: unknown) => error instanceof ConflictError && error.code === "STATE_CONFLICT",
    );
    assert.throws(
      () =>
        repo.archive(
          created.boardId,
          { workspaceId: "default", expectedRevision: updated.revision },
          "operator-1",
          "2026-07-14T12:03:00.000Z",
        ),
      (error: unknown) => error instanceof ConflictError && error.code === "STATE_CONFLICT",
    );
    const archived = repo.archive(
      created.boardId,
      { workspaceId: "default", expectedRevision: updated.revision },
      "operator-1",
      "2026-07-14T12:05:00.000Z",
    );
    assert.throws(
      () =>
        repo.restore(
          created.boardId,
          { workspaceId: "default", expectedRevision: archived.revision },
          "operator-1",
          "2026-07-14T12:04:00.000Z",
        ),
      (error: unknown) => error instanceof ConflictError && error.code === "STATE_CONFLICT",
    );
    assert.throws(() =>
      db
        .prepare(
          `
          UPDATE ops_saved_boards
          SET status = 'active', revision = revision + 1,
              updated_by_actor_id = ?, updated_at = ?,
              archived_by_actor_id = NULL, archived_at = NULL
          WHERE workspace_id = ? AND board_id = ?
        `,
        )
        .run("operator-1", "2026-07-14T12:04:00.000Z", "default", created.boardId),
    );
    assert.equal(repo.get("default", created.boardId).revision, archived.revision);
  });

  it("fails closed when stored layout bytes are non-canonical or violate the trusted registry", () => {
    const corruptLayouts = [
      '[{"widgetId":"runtime","kind":"unknown_widget","x":0,"y":0,"width":6,"height":4}]',
      '[{"widgetId":"runtime","kind":"runtime_truth_summary","x":0,"y":0,"width":6,"height":4},{"widgetId":"runtime","kind":"task_status_summary","x":0,"y":4,"width":6,"height":4}]',
      '[{"widgetId":"runtime","kind":"runtime_truth_summary","x":0,"y":0,"width":6,"height":4,"url":"https://example.test"}]',
      '[{"widgetId":"runtime","kind":"runtime_truth_summary","x":10,"y":0,"width":3,"height":4}]',
      '[ {"widgetId":"runtime","kind":"runtime_truth_summary","x":0,"y":0,"width":6,"height":4} ]',
    ];
    for (const [index, layoutJson] of corruptLayouts.entries()) {
      const db = createDatabase({ dbPath: ":memory:" });
      clients.push(db);
      const repo = new OpsSavedBoardRepository(db);
      repo.create(createInput(), "operator-1", NOW, `corrupt-${index}`);
      db.prepare(
        `
        UPDATE ops_saved_boards
        SET layout_json = ?, revision = revision + 1
        WHERE workspace_id = 'default' AND board_id = ?
      `,
      ).run(layoutJson, `corrupt-${index}`);
      assert.throws(() => repo.get("default", `corrupt-${index}`));
    }
  });

  it("rejects corrupt JSON, non-array layouts, oversized text, controls, and immutable identity writes in SQL", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    clients.push(db);
    const repo = new OpsSavedBoardRepository(db);
    repo.create(createInput(), "operator-1", NOW, "board-storage-guards");
    for (const [column, value] of [
      ["layout_json", "{"],
      ["layout_json", "{}"],
      ["name", "x".repeat(121)],
    ] as const) {
      assert.throws(() =>
        db
          .prepare(
            `UPDATE ops_saved_boards SET ${column} = ?, revision = revision + 1 WHERE workspace_id = ? AND board_id = ?`,
          )
          .run(value, "default", "board-storage-guards"),
      );
    }
    assert.throws(() =>
      db
        .prepare(
          `
          UPDATE ops_saved_boards
          SET name = ?, revision = revision + 1
          WHERE workspace_id = ? AND board_id = ?
        `,
        )
        .run("Ops\u0000Board", "default", "board-storage-guards"),
    );
    assert.throws(() =>
      db
        .prepare(
          `
          UPDATE ops_saved_boards
          SET idempotency_key = ?, revision = revision + 1
          WHERE workspace_id = ? AND board_id = ?
        `,
        )
        .run("mutated-key", "default", "board-storage-guards"),
    );
    assert.throws(
      () =>
        db
          .prepare(
            `
            INSERT INTO ops_saved_boards (
              workspace_id, board_id, schema_version, name, description, layout_json, status, revision,
              created_by_actor_id, created_at, updated_by_actor_id, updated_at,
              archived_by_actor_id, archived_at, idempotency_key, request_sha256
            ) VALUES (
              'default', 'forged-history', 'goatcitadel.ops-board.v1', 'Forged', NULL,
              '[{"height":4,"kind":"runtime_truth_summary","widgetId":"runtime","width":6,"x":0,"y":0}]',
              'active', 2, 'operator-1', ?, 'operator-2', ?, NULL, NULL, 'forged-history', ?
            )
          `,
          )
          .run(NOW, "2026-07-14T12:01:00.000Z", "b".repeat(64)),
      /insert invariant/,
    );
  });
});
