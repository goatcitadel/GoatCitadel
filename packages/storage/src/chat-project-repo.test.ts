import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { DatabaseClient, DbStatement } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { ChatProjectRepository } from "./chat-project-repo.js";

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

function createStore(): { db: DatabaseClient; repo: ChatProjectRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-chat-project-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, repo: new ChatProjectRepository(db) };
}

function setUpdatedAtBlob(db: DatabaseClient, projectId: string): void {
  db.prepare("UPDATE chat_projects SET updated_at = zeroblob(1) WHERE project_id = ?").run(projectId);
}

function projectRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project_id: "project-1",
    workspace_id: "default",
    name: "Project",
    description: null,
    workspace_path: "repo",
    color: null,
    lifecycle_status: "active",
    archived_at: null,
    created_at: "2026-03-26T00:00:00.000Z",
    updated_at: "2026-03-26T00:00:00.000Z",
    ...overrides,
  };
}

function createListRowsRepo(rows: unknown): ChatProjectRepository {
  const listStatement: DbStatement = {
    run: () => ({ changes: 0 }),
    get: () => undefined,
    all: () => rows as never[],
  };
  const noopStatement: DbStatement = {
    run: () => ({ changes: 0 }),
    get: () => undefined,
    all: () => [],
  };
  const db: DatabaseClient = {
    dialect: "sqlite",
    prepare(sql) {
      return sql.includes("ORDER BY updated_at DESC") ? listStatement : noopStatement;
    },
    exec: () => undefined,
    close: () => undefined,
    transaction: (_mode, callback) => callback(),
  };
  return new ChatProjectRepository(db);
}

describe("ChatProjectRepository", () => {
  it("creates, lists, updates, archives, restores, and deletes projects", () => {
    const { repo } = createStore();
    const defaultProject = repo.create(
      {
        name: "  Default Project  ",
        workspacePath: "default\\repo",
      },
      "2026-03-26T00:00:00.000Z",
    );
    const workspaceProject = repo.create(
      {
        workspaceId: " workspace-a ",
        name: "Workspace Project",
        description: "  Initial description  ",
        workspacePath: "nested\\repo",
        color: "  teal  ",
      },
      "2026-03-26T00:01:00.000Z",
    );

    assert.equal(defaultProject.workspaceId, "default");
    assert.equal(defaultProject.name, "Default Project");
    assert.equal(defaultProject.description, undefined);
    assert.equal(defaultProject.workspacePath, "default/repo");
    assert.equal(defaultProject.color, undefined);
    assert.equal(workspaceProject.workspaceId, "workspace-a");
    assert.equal(workspaceProject.description, "Initial description");
    assert.equal(workspaceProject.color, "teal");

    const updated = repo.update(
      workspaceProject.projectId,
      {
        workspaceId: " workspace-b ",
        name: "  Renamed  ",
        description: " ",
        workspacePath: "updated\\repo",
        color: " ",
      },
      "2026-03-26T00:02:00.000Z",
    );
    assert.equal(updated.workspaceId, "workspace-b");
    assert.equal(updated.name, "Renamed");
    assert.equal(updated.description, undefined);
    assert.equal(updated.workspacePath, "updated/repo");
    assert.equal(updated.color, undefined);

    const preserved = repo.update(workspaceProject.projectId, {}, "2026-03-26T00:03:00.000Z");
    assert.equal(preserved.name, "Renamed");
    assert.equal(preserved.workspacePath, "updated/repo");

    assert.equal(repo.list("active", 0).length, 1);
    assert.deepEqual(
      repo.list("active", 10, "workspace-b").map((project) => project.projectId),
      [workspaceProject.projectId],
    );

    const archived = repo.archive(workspaceProject.projectId, "2026-03-26T00:04:00.000Z");
    const archivedAgain = repo.archive(workspaceProject.projectId, "2026-03-26T00:05:00.000Z");
    assert.equal(archived.lifecycleStatus, "archived");
    assert.equal(archived.archivedAt, "2026-03-26T00:04:00.000Z");
    assert.equal(archivedAgain.archivedAt, archived.archivedAt);
    assert.deepEqual(
      repo.list("archived", 10, "workspace-b").map((project) => project.projectId),
      [workspaceProject.projectId],
    );
    assert.equal(repo.list("all", 2001).length, 2);

    const restored = repo.restore(workspaceProject.projectId, "2026-03-26T00:06:00.000Z");
    const restoredAgain = repo.restore(workspaceProject.projectId, "2026-03-26T00:07:00.000Z");
    assert.equal(restored.lifecycleStatus, "active");
    assert.equal(restored.archivedAt, undefined);
    assert.equal(restoredAgain.lifecycleStatus, "active");

    assert.equal(repo.hardDelete(defaultProject.projectId), true);
    assert.equal(repo.hardDelete(defaultProject.projectId), false);
    assert.equal(repo.find(defaultProject.projectId), undefined);
  });

  it("rejects missing and unsafe project fields", () => {
    const { repo } = createStore();

    assert.throws(() => repo.get("missing-project"), /Chat project missing-project not found/);
    assert.throws(() => repo.update("missing-project", { name: "Nope" }), /Chat project missing-project not found/);
    assert.throws(() => repo.create({ name: " ", workspacePath: "repo" }), /name is required/);
    assert.throws(
      () => repo.create({ workspaceId: " ", name: "Project", workspacePath: "repo" }),
      /workspaceId is required/,
    );
    assert.throws(
      () => repo.create({ workspaceId: "bad workspace", name: "Project", workspacePath: "repo" }),
      /workspaceId contains unsupported characters/,
    );
    assert.throws(() => repo.create({ name: "Project", workspacePath: " " }), /workspacePath is required/);
    assert.throws(() => repo.create({ name: "Project", workspacePath: "/absolute" }), /relative and jailed/);
    assert.throws(() => repo.create({ name: "Project", workspacePath: "../escape" }), /relative and jailed/);
    assert.throws(() => repo.create({ name: "Project", workspacePath: ".." }), /relative and jailed/);
    assert.throws(() => repo.create({ name: "Project", workspacePath: "safe/../escape" }), /relative and jailed/);
  });

  it("filters malformed rows from direct lookups and dynamic lists", () => {
    const { db, repo } = createStore();
    const project = repo.create({ name: "Project", workspacePath: "repo" });

    assert.deepEqual(createListRowsRepo("not rows").list(), []);
    assert.deepEqual(
      createListRowsRepo([null, projectRow({ project_id: "project-valid" })])
        .list("all")
        .map((item) => item.projectId),
      ["project-valid"],
    );

    setUpdatedAtBlob(db, project.projectId);

    assert.equal(repo.find(project.projectId), undefined);
    assert.throws(() => repo.get(project.projectId), /Chat project .* not found/);
    assert.deepEqual(
      repo.list("all").map((item) => item.projectId),
      [],
    );
  });
});
