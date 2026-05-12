import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { ChatThreadKnowledgeAttachmentRepository } from "./chat-thread-knowledge-attachment-repo.js";

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

function createStore(): { db: DatabaseClient; repo: ChatThreadKnowledgeAttachmentRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-thread-knowledge-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, repo: new ChatThreadKnowledgeAttachmentRepository(db) };
}

function setRawField(db: DatabaseClient, attachmentId: string, field: string, value: unknown): void {
  db.prepare(`UPDATE chat_thread_knowledge_attachments SET ${field} = ? WHERE attachment_id = ?`).run(
    value,
    attachmentId,
  );
}

describe("ChatThreadKnowledgeAttachmentRepository", () => {
  it("creates, patches, lists, and deletes thread knowledge attachments", () => {
    const { repo } = createStore();
    const fileAttachment = repo.create({
      attachmentId: "attachment-a",
      sessionId: "session-a",
      sourceType: "file",
      sourceRef: "docs/design.md",
      title: "Design Notes",
      retrievalMode: "retrieval",
      ingestStatus: "queued",
      chunkCount: 4,
      namespace: "project-a",
      chatAttachmentId: "chat-attachment-a",
      documentId: "doc-a",
      errorMessage: "previous error",
      lastIngestAt: "2026-03-26T00:00:01.000Z",
      createdAt: "2026-03-26T00:00:01.000Z",
      updatedAt: "2026-03-26T00:00:01.000Z",
    });
    repo.create({
      attachmentId: "attachment-b",
      sessionId: "session-a",
      sourceType: "url",
      sourceRef: "https://example.test",
      title: "Example",
      retrievalMode: "full_text",
      ingestStatus: "ready",
      createdAt: "2026-03-26T00:00:02.000Z",
      updatedAt: "2026-03-26T00:00:02.000Z",
    });

    assert.equal(fileAttachment.namespace, "project-a");
    assert.deepEqual(
      repo.listBySession("session-a").map((record) => record.attachmentId),
      ["attachment-b", "attachment-a"],
    );
    assert.deepEqual(
      repo.listByDocumentId("doc-a").map((record) => record.attachmentId),
      ["attachment-a"],
    );

    const patched = repo.patch(
      "attachment-a",
      {
        sourceRef: " docs/updated.md ",
        title: " Updated Notes ",
        retrievalMode: "full_text",
        ingestStatus: "failed",
        chunkCount: 0,
        namespace: " ",
        chatAttachmentId: " ",
        documentId: " ",
        errorMessage: " ingest failed ",
        lastIngestAt: "2026-03-26T00:05:00.000Z",
      },
      "2026-03-26T00:06:00.000Z",
    );
    assert.equal(patched.sourceRef, "docs/updated.md");
    assert.equal(patched.namespace, undefined);
    assert.equal(patched.chatAttachmentId, undefined);
    assert.equal(patched.documentId, undefined);
    assert.equal(patched.errorMessage, "ingest failed");
    assert.equal(patched.updatedAt, "2026-03-26T00:06:00.000Z");

    const repatched = repo.patch(
      "attachment-a",
      {
        title: "Updated Notes Again",
      },
      "2026-03-26T00:07:00.000Z",
    );
    assert.equal(repatched.chatAttachmentId, undefined);

    assert.equal(repo.delete("attachment-a"), true);
    assert.equal(repo.delete("attachment-a"), false);
    assert.deepEqual(repo.listByDocumentId("doc-a"), []);
  });

  it("validates required fields and filters malformed persisted rows", () => {
    const { db, repo } = createStore();
    repo.create({
      attachmentId: "attachment-a",
      sessionId: "session-a",
      sourceType: "file",
      sourceRef: "docs/design.md",
      title: "Design Notes",
      retrievalMode: "retrieval",
      ingestStatus: "ready",
      createdAt: "2026-03-26T00:00:01.000Z",
      updatedAt: "2026-03-26T00:00:01.000Z",
    });

    assert.throws(() => repo.get("missing-attachment"), /Thread knowledge attachment missing-attachment not found/);
    assert.throws(() => repo.listBySession(" "), /sessionId is required/);
    assert.throws(() => repo.listByDocumentId(" "), /documentId is required/);
    assert.throws(() => repo.patch("attachment-a", { sourceRef: " " }), /sourceRef is required/);

    setRawField(db, "attachment-a", "retrieval_mode", "vector");
    assert.throws(() => repo.get("attachment-a"), /Thread knowledge attachment attachment-a not found/);
    assert.deepEqual(repo.listBySession("session-a"), []);

    setRawField(db, "attachment-a", "retrieval_mode", "retrieval");
    setRawField(db, "attachment-a", "ingest_status", "done");
    assert.throws(() => repo.get("attachment-a"), /Thread knowledge attachment attachment-a not found/);

    setRawField(db, "attachment-a", "ingest_status", "ready");
    setRawField(db, "attachment-a", "chunk_count", new Uint8Array([1]));
    assert.throws(() => repo.get("attachment-a"), /Thread knowledge attachment attachment-a not found/);
  });
});
