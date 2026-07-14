import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { DatabaseClient, DbStatement } from "./db.js";
import { createDatabase } from "./sqlite.js";
import type { ChatSessionMetaPatchInput } from "./chat-session-meta-repo.js";
import { ChatSessionMetaRepository } from "./chat-session-meta-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup noise
    }
  }
});

function createStore(): { db: DatabaseClient; repo: ChatSessionMetaRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-chat-meta-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, repo: new ChatSessionMetaRepository(db) };
}

function createRepo(): ChatSessionMetaRepository {
  return createStore().repo;
}

function setRawMetaField(db: DatabaseClient, sessionId: string, field: string, value: unknown): void {
  db.prepare(`UPDATE chat_session_meta SET ${field} = ? WHERE session_id = ?`).run(value, sessionId);
}

function validRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: "sess-1",
    workspace_id: "default",
    title: null,
    origin: null,
    include_in_history: 1,
    pinned: 0,
    lifecycle_status: "active",
    archived_at: null,
    folder_id: null,
    folder_name: null,
    tags_json: "[]",
    pinned_goal: null,
    goal_turn_budget: null,
    goal_turns_used: 0,
    goal_set_at: null,
    created_at: "2026-03-26T00:00:00.000Z",
    updated_at: "2026-03-26T00:00:00.000Z",
    ...overrides,
  };
}

function createScriptedRepo(getRows: unknown[]): ChatSessionMetaRepository {
  const selectStatement: DbStatement = {
    run: () => ({ changes: 0 }),
    get: <T = unknown>() => getRows.shift() as T | undefined,
    all: () => [],
  };
  const writeStatement: DbStatement = {
    run: () => ({ changes: 1 }),
    get: () => undefined,
    all: () => [],
  };
  const db: DatabaseClient = {
    dialect: "sqlite",
    prepare(sql) {
      if (sql.includes("SELECT * FROM chat_session_meta WHERE session_id = ?")) {
        return selectStatement;
      }
      return writeStatement;
    },
    exec: () => undefined,
    close: () => undefined,
    transaction: (_mode, callback) => callback(),
  };
  return new ChatSessionMetaRepository(db);
}

describe("ChatSessionMetaRepository", () => {
  it("uses a PostgreSQL row lock for transactionally fenced ownership reads", () => {
    const preparedSql: string[] = [];
    const emptyStatement: DbStatement = {
      run: () => ({ changes: 0 }),
      get: () => undefined,
      all: () => [],
    };
    const db: DatabaseClient = {
      dialect: "postgres",
      prepare(sql) {
        preparedSql.push(sql);
        return emptyStatement;
      },
      exec() {},
      close() {},
      transaction(_mode, callback) {
        return callback();
      },
    };
    const repo = new ChatSessionMetaRepository(db);

    assert.equal(repo.getForUpdate("session-missing"), undefined);
    assert.ok(preparedSql.includes("SELECT * FROM chat_session_meta WHERE session_id = ? FOR UPDATE"));
  });

  it("returns defaults when ensuring a missing row", () => {
    const repo = createRepo();
    const meta = repo.ensure("sess-1");

    assert.equal(meta.workspaceId, "default");
    assert.equal(meta.origin, undefined);
    assert.equal(meta.includeInHistory, true);
    assert.equal(meta.pinned, false);
    assert.equal(meta.lifecycleStatus, "active");
  });

  it("round-trips origin and history visibility fields", () => {
    const repo = createRepo();
    const patched = repo.patch(
      "sess-1",
      {
        workspaceId: "workspace-a",
        title: "Prompt pack scratch session",
        origin: "prompt_pack",
        includeInHistory: false,
        pinned: true,
        lifecycleStatus: "archived",
        archivedAt: "2026-03-26T00:00:00.000Z",
      },
      "2026-03-26T00:00:00.000Z",
    );

    assert.equal(patched.workspaceId, "workspace-a");
    assert.equal(patched.title, "Prompt pack scratch session");
    assert.equal(patched.origin, "prompt_pack");
    assert.equal(patched.includeInHistory, false);
    assert.equal(patched.pinned, true);
    assert.equal(patched.lifecycleStatus, "archived");
    assert.equal(patched.archivedAt, "2026-03-26T00:00:00.000Z");

    const reloaded = repo.get("sess-1");
    assert.equal(reloaded?.origin, "prompt_pack");
    assert.equal(reloaded?.includeInHistory, false);
  });

  it("sanitizes patch fields and preserves omitted values", () => {
    const repo = createRepo();
    const first = repo.patch(
      "sess-1",
      {
        workspaceId: " workspace-a ",
        title: "  Operator notes  ",
        origin: " Operator " as ChatSessionMetaPatchInput["origin"],
        includeInHistory: false,
        pinned: true,
        lifecycleStatus: "archived",
        archivedAt: "2026-03-26T00:00:00.000Z",
        folderName: "Ops & Alerts!!!",
        tags: [" Alpha ", "alpha", "", "BetaBetaBetaBetaBetaBetaBetaBetaBeta"],
      },
      "2026-03-26T00:00:00.000Z",
    );

    assert.equal(first.workspaceId, "workspace-a");
    assert.equal(first.title, "Operator notes");
    assert.equal(first.origin, "operator");
    assert.equal(first.includeInHistory, false);
    assert.equal(first.pinned, true);
    assert.equal(first.lifecycleStatus, "archived");
    assert.equal(first.archivedAt, "2026-03-26T00:00:00.000Z");
    assert.equal(first.folderId, "ops-alerts");
    assert.equal(first.folderName, "Ops & Alerts!!!");
    assert.deepEqual(first.tags, ["Alpha", "BetaBetaBetaBetaBetaBetaBetaBeta"]);

    const preserved = repo.patch(
      "sess-1",
      {
        folderId: " custom-folder ",
        folderName: "Friendly Folder",
      },
      "2026-03-26T00:01:00.000Z",
    );

    assert.equal(preserved.workspaceId, "workspace-a");
    assert.equal(preserved.title, "Operator notes");
    assert.equal(preserved.origin, "operator");
    assert.equal(preserved.includeInHistory, false);
    assert.equal(preserved.pinned, true);
    assert.equal(preserved.lifecycleStatus, "archived");
    assert.equal(preserved.archivedAt, "2026-03-26T00:00:00.000Z");
    assert.equal(preserved.folderId, "custom-folder");
    assert.equal(preserved.folderName, "Friendly Folder");
    assert.deepEqual(preserved.tags, ["Alpha", "BetaBetaBetaBetaBetaBetaBetaBeta"]);

    const cleared = repo.patch(
      "sess-1",
      {
        title: " ",
        origin: " " as ChatSessionMetaPatchInput["origin"],
        folderName: " ",
        tags: [" Gamma ", "gamma"],
      },
      "2026-03-26T00:02:00.000Z",
    );

    assert.equal(cleared.title, undefined);
    assert.equal(cleared.origin, undefined);
    assert.equal(cleared.folderId, undefined);
    assert.equal(cleared.folderName, undefined);
    assert.deepEqual(cleared.tags, ["Gamma"]);
    assert.equal(cleared.updatedAt, "2026-03-26T00:02:00.000Z");
  });

  it("filters listed rows by workspace id", () => {
    const repo = createRepo();
    repo.patch("sess-1", { workspaceId: "workspace-a", origin: "operator", includeInHistory: true });
    repo.patch("sess-2", { workspaceId: "workspace-b", origin: "system", includeInHistory: false });

    const listed = repo.listBySessionIds(["sess-1", "sess-2"], "workspace-a");

    assert.equal(listed.size, 1);
    assert.equal(listed.get("sess-1")?.workspaceId, "workspace-a");
    assert.equal(listed.has("sess-2"), false);
  });

  it("lists sessions without a workspace filter and short-circuits empty lists", () => {
    const repo = createRepo();
    repo.patch("sess-1", { workspaceId: "workspace-a", origin: "operator", includeInHistory: true });
    repo.patch("sess-2", { workspaceId: "workspace-b", origin: "system", includeInHistory: false });

    const listed = repo.listBySessionIds(["sess-1", "sess-2"]);

    assert.equal(repo.listBySessionIds([]).size, 0);
    assert.equal(listed.size, 2);
    assert.equal(listed.get("sess-1")?.origin, "operator");
    assert.equal(listed.get("sess-2")?.origin, "system");
  });

  it("lists folders grouped by workspace", () => {
    const repo = createRepo();
    repo.patch("sess-1", { workspaceId: "workspace-a", folderName: "Zulu Work" });
    repo.patch("sess-2", { workspaceId: "workspace-a", folderName: "Alpha Work" });
    repo.patch("sess-3", { workspaceId: "workspace-a", folderName: "Alpha Work" });
    repo.patch("sess-4", { workspaceId: "workspace-b", folderName: "Alpha Work" });

    const folders = repo.listFolders("workspace-a");

    assert.deepEqual(
      folders.map((folder) => [folder.folderId, folder.name, folder.workspaceId, folder.sessionCount]),
      [
        ["alpha-work", "Alpha Work", "workspace-a", 2],
        ["zulu-work", "Zulu Work", "workspace-a", 1],
      ],
    );
    const firstFolder = folders[0];
    assert.ok(firstFolder);
    const firstCreatedAt = firstFolder.createdAt;
    assert.equal(typeof firstCreatedAt, "string");
    assert.equal((firstCreatedAt ?? "").length, "2026-03-26T00:00:00.000Z".length);
  });

  it("normalizes malformed stored origins and tag payloads defensively", () => {
    const { db, repo } = createStore();
    repo.patch("sess-1", { origin: "operator", tags: [" One "] });

    assert.deepEqual(createScriptedRepo([validRow({ tags_json: null })]).get("sess-1")?.tags, []);

    setRawMetaField(db, "sess-1", "origin", "unknown-origin");
    assert.equal(repo.get("sess-1")?.origin, undefined);

    setRawMetaField(db, "sess-1", "tags_json", '{"not":"an array"}');
    assert.deepEqual(repo.get("sess-1")?.tags, []);

    setRawMetaField(db, "sess-1", "tags_json", '[" One ", "one", 5, "", "TwoTwoTwoTwoTwoTwoTwoTwoTwo"]');
    assert.deepEqual(repo.get("sess-1")?.tags, ["One", "TwoTwoTwoTwoTwoTwoTwoTwoTwo"]);

    setRawMetaField(db, "sess-1", "tags_json", "{bad json");
    assert.deepEqual(repo.get("sess-1")?.tags, []);
  });

  it("rejects invalid workspace, origin, folder, and stored row shapes", () => {
    const { db, repo } = createStore();
    repo.ensure("sess-1");

    assert.throws(
      () => repo.ensure("sess-blank-workspace", "2026-03-26T00:00:00.000Z", " "),
      /workspaceId is required/,
    );
    assert.throws(
      () => repo.patch("sess-1", { workspaceId: "bad workspace" }),
      /workspaceId contains unsupported characters/,
    );
    assert.throws(
      () => repo.patch("sess-1", { origin: "bad origin!" as ChatSessionMetaPatchInput["origin"] }),
      /origin contains unsupported characters/,
    );
    assert.throws(() => repo.patch("sess-1", { folderName: "!!!" }), /folderName must include/);

    setRawMetaField(db, "sess-1", "include_in_history", "yes");
    assert.throws(() => repo.get("sess-1"), /Unexpected chat_session_meta row shape/);
    assert.throws(() => repo.listBySessionIds(["sess-1"]), /Unexpected chat_session_meta row shape/);
  });

  it("fails clearly when writes cannot be read back", () => {
    assert.throws(
      () => createScriptedRepo([undefined, undefined]).ensure("sess-1", "2026-03-26T00:00:00.000Z"),
      /chat_session_meta ensure did not return a row/,
    );

    assert.throws(
      () =>
        createScriptedRepo([undefined, validRow(), undefined]).patch(
          "sess-1",
          { title: "Lost write" },
          "2026-03-26T00:00:00.000Z",
        ),
      /chat_session_meta patch did not return a row/,
    );

    assert.throws(() => createScriptedRepo([null]).get("sess-1"), /Unexpected chat_session_meta row shape/);
  });
});
