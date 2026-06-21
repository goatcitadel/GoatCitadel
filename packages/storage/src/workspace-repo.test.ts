import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { WorkspaceRepository } from "./workspace-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore
    }
  }
});

function createRepo(): WorkspaceRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-workspaces-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new WorkspaceRepository(db);
}

describe("WorkspaceRepository", () => {
  it("creates, updates, archives, and restores workspaces", () => {
    const repo = createRepo();

    const created = repo.create(
      {
        name: "Launch Bay",
        description: "Release staging",
        workspacePrefs: {
          preferredModel: "glm-5",
        },
      },
      "2026-03-05T10:00:00.000Z",
    );

    assert.equal(created.slug, "launch-bay");
    assert.equal(created.citadelId, "personal");
    assert.equal(repo.findBySlug("Launch Bay")?.workspaceId, created.workspaceId);

    const updated = repo.update(
      created.workspaceId,
      {
        name: "Launch Bay 2",
        slug: "launch-bay-two",
        citadelId: "company",
      },
      "2026-03-05T10:05:00.000Z",
    );
    assert.equal(updated.slug, "launch-bay-two");
    assert.equal(updated.citadelId, "company");
    assert.deepEqual(
      repo.listByCitadel("company").map((workspace) => workspace.workspaceId),
      [created.workspaceId],
    );
    assert.equal(
      repo.listByCitadel("personal").some((workspace) => workspace.workspaceId === created.workspaceId),
      false,
    );

    const archived = repo.archive(created.workspaceId, "2026-03-05T10:10:00.000Z");
    assert.equal(archived.lifecycleStatus, "archived");

    const restored = repo.restore(created.workspaceId, "2026-03-05T10:15:00.000Z");
    assert.equal(restored.lifecycleStatus, "active");
  });

  it("rejects duplicate slugs and protects the default workspace", () => {
    const repo = createRepo();

    const existing = repo.create(
      {
        name: "Same Name",
      },
      "2026-03-05T10:00:00.000Z",
    );

    assert.throws(() => {
      repo.create({
        name: "same-name",
      });
    }, /already in use/);

    const db = (repo as unknown as { db: ReturnType<typeof createDatabase> }).db;
    db.prepare(
      `
      INSERT OR IGNORE INTO workspaces (
        workspace_id, name, description, slug, lifecycle_status, archived_at, workspace_prefs_json, created_at, updated_at
      ) VALUES ('default', 'Default', NULL, 'default', 'active', NULL, '{}', @createdAt, @updatedAt)
    `,
    ).run({
      createdAt: "2026-03-05T00:00:00.000Z",
      updatedAt: "2026-03-05T00:00:00.000Z",
    });

    assert.throws(() => {
      repo.archive("default");
    }, /default workspace cannot be archived/);
    assert.equal(repo.get(existing.workspaceId).workspaceId, existing.workspaceId);
  });

  it("covers list views, idempotent lifecycle calls, validation, and defensive row mapping", () => {
    const repo = createRepo();
    const db = (repo as unknown as { db: ReturnType<typeof createDatabase> }).db;

    assert.throws(() => repo.get("missing-workspace"), /Workspace missing-workspace not found/);
    assert.equal(repo.find("missing-workspace"), undefined);
    assert.equal(repo.findBySlug("Missing Workspace"), undefined);
    assert.throws(() => repo.create({ name: "   " }), /name is required/);
    assert.throws(() => repo.create({ name: "Valid", slug: "!!!" }), /slug is required/);

    const created = repo.create({
      name: "Storage Tail",
      description: "   ",
      workspacePrefs: [] as unknown as Record<string, unknown>,
    });
    assert.equal(created.description, undefined);
    assert.deepEqual(created.workspacePrefs, {});

    const updatedWithoutChanges = repo.update(created.workspaceId, {});
    assert.equal(updatedWithoutChanges.slug, created.slug);

    const longSlug = `${"a".repeat(70)}---`;
    const updated = repo.update(created.workspaceId, {
      slug: longSlug,
      description: "   ",
      workspacePrefs: { preferredProvider: "openai" },
    });
    assert.equal(updated.slug.length, 64);
    assert.equal(updated.slug.endsWith("-"), false);
    assert.deepEqual(updated.workspacePrefs, { preferredProvider: "openai" });

    db.prepare("UPDATE workspaces SET workspace_prefs_json = ? WHERE workspace_id = ?").run(
      '"string"',
      created.workspaceId,
    );
    assert.equal(repo.get(created.workspaceId).workspacePrefs, undefined);

    const archived = repo.archive(created.workspaceId, "2026-05-12T00:00:00.000Z");
    assert.equal(repo.archive(created.workspaceId).archivedAt, archived.archivedAt);
    assert.deepEqual(
      repo.list("archived", 0).map((workspace) => workspace.workspaceId),
      [created.workspaceId],
    );
    assert.equal(
      repo.list("active").some((workspace) => workspace.workspaceId === created.workspaceId),
      false,
    );
    assert.ok(repo.list("all").some((workspace) => workspace.workspaceId === created.workspaceId));

    const restored = repo.restore(created.workspaceId, "2026-05-12T00:01:00.000Z");
    assert.equal(restored.lifecycleStatus, "active");
    assert.equal(repo.restore(created.workspaceId).updatedAt, restored.updatedAt);
  });
});
