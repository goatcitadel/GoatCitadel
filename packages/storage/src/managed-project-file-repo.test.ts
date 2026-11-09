import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ChatProjectRepository } from "./chat-project-repo.js";
import { ManagedProjectFileRepository } from "./managed-project-file-repo.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const temp = new TempSqliteFiles();
const original = Buffer.from([0x00, 0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0x62, 0x0a, 0xff]);
const edited = Buffer.from("replacement\r\n");
const path = "Notes/mixed.txt";

afterEach(() => temp.cleanup());

function fixture() {
  const dbPath = temp.path("goatcitadel-managed-project-files");
  const db = temp.open({ dbPath });
  const projects = new ChatProjectRepository(db);
  const project = projects.create({ name: "One", workspacePath: "one" });
  const scope = { workspaceId: project.workspaceId ?? "default", projectId: project.projectId };
  return {
    db,
    dbPath,
    projects,
    project,
    scope,
    target: { ...scope, path },
    repo: new ManagedProjectFileRepository(db),
  };
}

describe("ManagedProjectFileRepository", () => {
  it("creates without clobbering an existing case-insensitive path and restores exact bytes after reopen", () => {
    const { db, repo, dbPath, target } = fixture();
    const created = repo.save({
      ...target,
      expectedRevision: null,
      effectId: "create",
      contentBase64: original.toString("base64"),
    });
    const competingDb = temp.open({ dbPath });
    const reopened = new ManagedProjectFileRepository(competingDb);
    assert.throws(
      () =>
        reopened.save({
          ...target,
          path: path.toUpperCase(),
          expectedRevision: null,
          effectId: "competing-create",
          contentBase64: "",
        }),
      /managed file changed/i,
    );
    const change = {
      ...target,
      expectedRevision: created.revisionId,
      effectId: "edit",
      contentBase64: edited.toString("base64"),
    };
    const saved = reopened.save(change);
    assert.equal(saved.previousRevisionId, created.revisionId);
    assert.equal(saved.canRestore, true);
    assert.equal(saved.path, path);
    assert.throws(() => repo.save({ ...change, effectId: "competing-edit" }), /managed file changed/i);
    competingDb.close();
    db.close();

    const restore = { ...target, expectedRevision: saved.revisionId, effectId: "restore" };
    const restarted = new ManagedProjectFileRepository(temp.open({ dbPath }));
    const restored = restarted.restore(restore);
    assert.notEqual(restored.revisionId, created.revisionId);
    assert.equal(restored.previousRevisionId, saved.revisionId);
    assert.equal(restored.contentSha256, created.contentSha256);
    assert.equal(restored.canRestore, false);
    assert.deepEqual(Buffer.from(restarted.read(target)!.contentBase64!, "base64"), original);
    assert.deepEqual(restarted.restore(restore), { ...restored, replayed: true });
    assert.deepEqual(restarted.save(change), { ...saved, replayed: true });
    assert.throws(() => restarted.restore({ ...restore, effectId: "stale-restore" }), /managed file changed/i);
    const repeat = { ...restore, expectedRevision: restored.revisionId, effectId: "alternate-restore" };
    assert.throws(() => restarted.restore(repeat), /no prior file version to restore/i);
    assert.equal(restarted.read(target)?.revisionId, restored.revisionId);
    assert.equal(restarted.list(target, { prefix: "Notes" })[0]?.canRestore, false);

    const nextSave = restarted.save({ ...change, expectedRevision: restored.revisionId, effectId: "next-save" });
    assert.equal(nextSave.canRestore, true);
    const nextRestore = restarted.restore({
      ...restore,
      expectedRevision: nextSave.revisionId,
      effectId: "next-restore",
    });
    assert.equal(nextRestore.contentSha256, created.contentSha256);
    assert.deepEqual(Buffer.from(restarted.read(target)!.contentBase64!, "base64"), original);
  });

  it("binds a replay to its operation, revision, content, and project scope", () => {
    const { repo, target, projects } = fixture();
    const create = { ...target, expectedRevision: null, effectId: "unique-effect", contentBase64: "YQ==" };
    const saved = repo.save(create);
    const otherProject = projects.create({ name: "Two", workspacePath: "two" });
    assert.equal(repo.read({ ...target, workspaceId: "another-workspace" }), undefined);
    assert.equal(repo.read({ ...target, projectId: otherProject.projectId }), undefined);
    assert.deepEqual(repo.list({ ...target, workspaceId: "another-workspace" }), []);
    assert.throws(() => repo.save({ ...create, workspaceId: "another-workspace" }), /managed project/i);
    assert.throws(() => repo.save({ ...create, projectId: otherProject.projectId }), /different change/i);
    assert.throws(() => repo.save({ ...create, path: "Other.txt" }), /different change/i);
    assert.throws(() => repo.save({ ...create, contentBase64: "Yg==" }), /different change/i);
    assert.throws(() => repo.save({ ...create, expectedRevision: saved.revisionId }), /different change/i);
    assert.throws(() => repo.delete({ ...create, expectedRevision: saved.revisionId }), /different change/i);
  });

  it("requires exact live revision for deletion and starts a fresh generation after a tombstone", () => {
    const { repo, target, scope } = fixture();
    const initial = repo.save({ ...target, expectedRevision: null, effectId: "create", contentBase64: "" });
    assert.throws(
      () => repo.restore({ ...target, expectedRevision: initial.revisionId, effectId: "undo-create" }),
      /no prior/i,
    );
    const changed = repo.save({
      ...target,
      expectedRevision: initial.revisionId,
      effectId: "edit",
      contentBase64: "YQ==",
    });
    assert.throws(
      () => repo.delete({ ...target, expectedRevision: initial.revisionId, effectId: "stale-delete" }),
      /managed file changed/i,
    );
    const remove = { ...target, expectedRevision: changed.revisionId, effectId: "delete" };
    const deleted = repo.delete(remove);
    assert.equal(deleted.deleted, true);
    assert.equal(repo.read(target)?.deleted, true);
    assert.deepEqual(repo.list(scope), []);
    assert.deepEqual(repo.delete(remove), { ...deleted, replayed: true });
    assert.throws(
      () => repo.restore({ ...target, expectedRevision: deleted.revisionId, effectId: "undo-delete" }),
      /managed file changed/i,
    );
    const recreated = repo.save({ ...target, expectedRevision: null, effectId: "recreate", contentBase64: "Yg==" });
    assert.equal(recreated.previousRevisionId, null);
    assert.throws(
      () => repo.restore({ ...target, expectedRevision: recreated.revisionId, effectId: "undo-recreate" }),
      /no prior/i,
    );
    assert.deepEqual(repo.delete(remove), { ...deleted, replayed: true });
    assert.equal(repo.read(target)?.revisionId, recreated.revisionId);
  });

  it("rejects host and file-directory aliases and bounds list and encoded content", () => {
    const { repo, target, scope } = fixture();
    const create = { ...target, expectedRevision: null, effectId: "create", contentBase64: "" };
    for (const invalid of [
      "../file",
      "x/./file",
      "C:/file",
      "a\\b",
      "a//b",
      "a/aux.txt",
      "a/CON .txt",
      "a/file.txt:stream",
      "/a",
      "name. ",
      ".git/config",
    ]) {
      assert.throws(() => repo.save({ ...create, path: invalid }), /portable relative path/i);
    }
    assert.throws(() => repo.save({ ...create, contentBase64: "YQ" }), /canonical base64/i);
    assert.throws(
      () => repo.save({ ...create, contentBase64: Buffer.alloc(1024 * 1024 + 1).toString("base64") }),
      /file size limit|too large/i,
    );
    const saved = repo.save(create);
    assert.deepEqual(
      repo.list(scope, { prefix: "NOTES" }).map((item) => item.revisionId),
      [saved.revisionId],
    );
    assert.deepEqual(repo.list(scope, { prefix: "Notes-other" }), []);
    assert.throws(() => repo.list(scope, { limit: 201 }), /limit/i);
    for (const conflict of ["notes", "notes/mixed.txt/sub"]) {
      assert.throws(() => repo.save({ ...create, path: conflict, effectId: "conflict" }), /file or folder/i);
    }
  });

  it("rejects saves at quota while exact restore remains possible without duplicating bytes", () => {
    const { db, repo, target, scope } = fixture();
    const create = { ...target, expectedRevision: null, effectId: "create", contentBase64: "YQ==" };
    const created = repo.save(create);
    const edited = repo.save({
      ...create,
      expectedRevision: created.revisionId,
      effectId: "edit",
      contentBase64: "Yg==",
    });
    // Simulate retained history filling the project's byte budget without a large test database.
    db.prepare(
      `
      INSERT INTO managed_project_file_revisions (
        workspace_id, project_id, path_key, path, revision_id, effect_id, request_sha256,
        content_sha256, byte_length, content_base64
      ) VALUES (?, ?, 'quota', 'quota', 'quota', 'quota', 'unused', 'unused', ?, '')
    `,
    ).run(scope.workspaceId, scope.projectId, 64 * 1024 * 1024 - 2);
    assert.throws(
      () => repo.save({ ...create, expectedRevision: edited.revisionId, effectId: "over-quota" }),
      /storage limit/i,
    );
    const restored = repo.restore({ ...target, expectedRevision: edited.revisionId, effectId: "restore" });
    assert.equal(restored.contentSha256, created.contentSha256);
  });

  it("honors restore when the retained content version cap has been reached", () => {
    const { db, repo, target, scope } = fixture();
    const create = { ...target, expectedRevision: null, effectId: "create", contentBase64: "YQ==" };
    const created = repo.save(create);
    const edited = repo.save({
      ...create,
      expectedRevision: created.revisionId,
      effectId: "edit",
      contentBase64: "Yg==",
    });
    db.prepare(
      `
      WITH RECURSIVE quota(number) AS (
        SELECT 1 UNION ALL SELECT number + 1 FROM quota WHERE number < 2046
      )
      INSERT INTO managed_project_file_revisions (
        workspace_id, project_id, path_key, path, revision_id, effect_id, request_sha256,
        content_sha256, byte_length, content_base64
      )
      SELECT ?, ?, 'quota', 'quota', 'quota-' || number, 'quota-' || number, 'unused', 'unused', 0, ''
      FROM quota
    `,
    ).run(scope.workspaceId, scope.projectId);
    assert.throws(
      () => repo.save({ ...create, expectedRevision: edited.revisionId, effectId: "over-cap" }),
      /storage limit/i,
    );
    const restored = repo.restore({ ...target, expectedRevision: edited.revisionId, effectId: "restore" });
    assert.equal(restored.contentSha256, created.contentSha256);
    assert.equal(repo.delete({ ...target, expectedRevision: restored.revisionId, effectId: "delete" }).deleted, true);
  });

  it("cannot overwrite corrupt recovery data or implicitly purge retained project history", () => {
    const { db, repo, target, project, projects } = fixture();
    const create = { ...target, expectedRevision: null, effectId: "create", contentBase64: "YQ==" };
    const saved = repo.save(create);
    db.prepare("UPDATE managed_project_file_revisions SET content_base64 = 'Yg==' WHERE effect_id = 'create'").run();
    assert.throws(
      () => repo.save({ ...create, expectedRevision: saved.revisionId, effectId: "edit" }),
      /could not be verified/i,
    );
    assert.throws(
      () => projects.updateWithRevision(project.projectId, { workspaceId: "other" }, project.revision),
      /retained managed file history/i,
    );
    assert.throws(
      () => projects.hardDeleteWithRevision(project.projectId, project.revision),
      /retained managed file history/i,
    );
    projects.archive(project.projectId);
    assert.equal(repo.read(target), undefined);
    assert.throws(() => repo.save(create), /managed project/i);
  });
});
