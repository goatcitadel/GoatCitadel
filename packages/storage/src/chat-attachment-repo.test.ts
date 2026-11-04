import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseClient } from "./db.js";
import { ChatAttachmentRepository } from "./chat-attachment-repo.js";
import { ChatGeneratedArtifactRepository } from "./chat-generated-artifact-repo.js";
import { ChatProjectRepository } from "./chat-project-repo.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const tempDbs = new TempSqliteFiles();

afterEach(() => tempDbs.cleanup());

function createStore(): { db: DatabaseClient; repo: ChatAttachmentRepository; projectId: string } {
  const dbPath = tempDbs.path("goatcitadel-chat-attachment");
  const db = tempDbs.open({ dbPath });
  const project = new ChatProjectRepository(db).create({
    workspaceId: "workspace-a",
    name: "Attachment project",
    workspacePath: "F:/work/attachments",
  });
  return { db, repo: new ChatAttachmentRepository(db), projectId: project.projectId };
}

function setRawField(db: DatabaseClient, attachmentId: string, field: string, value: unknown): void {
  db.prepare(`UPDATE chat_attachments SET ${field} = ? WHERE attachment_id = ?`).run(value, attachmentId);
}

describe("ChatAttachmentRepository", () => {
  it("creates, lists, filters, and maps attachment metadata", () => {
    const { repo, projectId } = createStore();
    const full = repo.create(
      {
        attachmentId: "attachment-b",
        sessionId: "session-a",
        workspaceId: "workspace-a",
        projectId,
        fileName: "diagram.png",
        mimeType: "image/png",
        mediaType: "image",
        sizeBytes: 42,
        sha256: "sha-b",
        storageRelPath: "attachments/diagram.png",
        extractStatus: "ready",
        extractPreview: "diagram preview",
        thumbnailRelPath: "thumbs/diagram.png",
        ocrText: "diagram text",
        transcriptText: "voice text",
        analysisStatus: "running",
      },
      "2026-03-26T00:00:02.000Z",
    );
    const unsupported = repo.create(
      {
        attachmentId: "attachment-a",
        sessionId: "session-a",
        workspaceId: "workspace-b",
        fileName: "archive.zip",
        mimeType: "application/zip",
        sizeBytes: 10,
        sha256: "sha-a",
        storageRelPath: "attachments/archive.zip",
        extractStatus: "unsupported",
      },
      "2026-03-26T00:00:01.000Z",
    );
    const failed = repo.create({
      attachmentId: "attachment-c",
      sessionId: "session-b",
      fileName: "bad.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      sha256: "sha-c",
      storageRelPath: "attachments/bad.txt",
      extractStatus: "failed",
    });

    assert.equal(full.projectId, projectId);
    assert.equal(full.mediaType, "image");
    assert.equal(full.analysisStatus, "running");
    assert.equal(unsupported.analysisStatus, "unsupported");
    assert.equal(failed.analysisStatus, "failed");

    assert.deepEqual(
      repo.listBySession("session-a", 0).map((attachment) => attachment.attachmentId),
      ["attachment-b"],
    );
    assert.deepEqual(
      repo.listBySession("session-a", 5000).map((attachment) => attachment.attachmentId),
      ["attachment-b", "attachment-a"],
    );
    assert.deepEqual(
      repo.listBySession("session-a", 10, "workspace-b").map((attachment) => attachment.attachmentId),
      ["attachment-a"],
    );
    assert.deepEqual(
      repo.listByIds(["attachment-a", "attachment-b"], "workspace-a").map((attachment) => attachment.attachmentId),
      ["attachment-b"],
    );
    assert.deepEqual(repo.listByIds([]), []);
    assert.throws(() => repo.get("missing-attachment"), /Attachment missing-attachment not found/);
    assert.throws(
      () =>
        repo.create({
          attachmentId: "attachment-d",
          sessionId: "session-d",
          workspaceId: "bad workspace",
          fileName: "bad.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
          sha256: "sha-d",
          storageRelPath: "attachments/bad.txt",
          extractStatus: "ready",
        }),
      /workspaceId contains unsupported characters/,
    );
  });

  it("filters malformed stored rows defensively", () => {
    const { db, repo } = createStore();
    repo.create({
      attachmentId: "attachment-a",
      sessionId: "session-a",
      workspaceId: "workspace-a",
      fileName: "note.txt",
      mimeType: "text/plain",
      mediaType: "text",
      sizeBytes: 12,
      sha256: "sha-a",
      storageRelPath: "attachments/note.txt",
      extractStatus: "ready",
    });

    setRawField(db, "attachment-a", "media_type", "spreadsheet");
    assert.throws(() => repo.get("attachment-a"), /Attachment attachment-a not found/);
    assert.deepEqual(repo.listBySession("session-a"), []);
    assert.deepEqual(repo.listByIds(["attachment-a"]), []);

    setRawField(db, "attachment-a", "media_type", "text");
    setRawField(db, "attachment-a", "analysis_status", "done");
    assert.throws(() => repo.get("attachment-a"), /Attachment attachment-a not found/);

    setRawField(db, "attachment-a", "analysis_status", "ready");
    setRawField(db, "attachment-a", "extract_status", "done");
    assert.throws(() => repo.get("attachment-a"), /Attachment attachment-a not found/);
  });
});

describe("renderer-owned attachment receipts", () => {
  function fixture() {
    const store = createStore();
    const identity = { artifactId: "html-artifact", artifactVersion: 1, sessionId: "session-render", workspaceId: "workspace-a",
      contentHash: "a".repeat(64), rendererVersion: "html-snapshot.v1" };
    new ChatGeneratedArtifactRepository(store.db).create({ artifactId: identity.artifactId, sessionId: identity.sessionId,
      workspaceId: identity.workspaceId, turnId: "turn-render", title: "HTML", kind: "html", content: "<p>HTML</p>",
      sourceSurface: "chat", version: 1, contentHash: identity.contentHash, createdAt: "2026-11-02", updatedAt: "2026-11-02" });
    const attachment = store.repo.create({ attachmentId: "renderer-png", sessionId: identity.sessionId,
      workspaceId: identity.workspaceId, fileName: "ordinary-name.png", mimeType: "image/png", mediaType: "image",
      sizeBytes: 8, sha256: "b".repeat(64), storageRelPath: "render.png", extractStatus: "unsupported" });
    const receipt = { ...identity, viewport: "desktop", width: 1440, height: 900, attachmentId: attachment.attachmentId, sha256: attachment.sha256 };
    return { ...store, identity, attachment, receipt };
  }

  it("requires a renderer receipt, binds the complete identity, and refuses canonical metadata drift", () => {
    const f = fixture();
    assert.deepEqual(f.repo.listArtifactRenders(f.identity), []);
    const recorded = f.repo.recordArtifactRender(f.receipt);
    assert.equal(recorded.attachmentId, f.attachment.attachmentId);
    assert.deepEqual(f.repo.listArtifactRenders(f.identity), [recorded]);
    for (const drift of [{ artifactId: "another-artifact" }, { artifactVersion: 2 }, { sessionId: "another-session" },
      { workspaceId: "workspace-b" }, { contentHash: `${"a".repeat(16)}${"c".repeat(48)}` }, { rendererVersion: "older-renderer" }]) {
      assert.deepEqual(f.repo.listArtifactRenders({ ...f.identity, ...drift }), []);
    }
    for (const drift of [{ artifactId: "missing" }, { artifactVersion: 2 }, { sessionId: "foreign" }, { workspaceId: "workspace-b" },
      { sha256: "c".repeat(64) }, { contentHash: "c".repeat(64) }]) {
      assert.throws(() => f.repo.recordArtifactRender({ ...f.receipt, ...drift }), /does not match/);
    }
    setRawField(f.db, f.attachment.attachmentId, "sha256", "c".repeat(64));
    assert.deepEqual(f.repo.listArtifactRenders(f.identity), []);
    setRawField(f.db, f.attachment.attachmentId, "sha256", f.attachment.sha256);
    setRawField(f.db, f.attachment.attachmentId, "mime_type", "application/octet-stream");
    assert.deepEqual(f.repo.listArtifactRenders(f.identity), []);
  });

  for (const owner of ["chat_generated_artifacts", "chat_attachments"]) {
    it(`cleans renderer receipts when their ${owner} owner is deleted`, () => {
      const f = fixture();
      f.repo.recordArtifactRender(f.receipt);
      const column = owner === "chat_generated_artifacts" ? "artifact_id" : "attachment_id";
      const id = owner === "chat_generated_artifacts" ? f.identity.artifactId : f.attachment.attachmentId;
      f.db.prepare(`DELETE FROM ${owner} WHERE ${column} = ?`).run(id);
      assert.deepEqual(f.db.prepare("SELECT * FROM chat_artifact_render_receipts").all(), []);
      assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
    });
  }
});