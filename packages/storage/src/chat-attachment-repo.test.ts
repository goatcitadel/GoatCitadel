import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { ChatAttachmentRepository } from "./chat-attachment-repo.js";
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

function createStore(): { db: DatabaseClient; repo: ChatAttachmentRepository; projectId: string } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-chat-attachment-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
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
