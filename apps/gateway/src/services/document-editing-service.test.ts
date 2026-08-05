import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ConflictError, NotFoundError } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, PersonalOpsStorageRepository, Storage } from "@goatcitadel/storage";
import { DocumentEditingService } from "./document-editing-service.js";

const roots: string[] = [];
const openStorage: Storage[] = [];

afterEach(async () => {
  for (const storage of openStorage.splice(0)) storage.close();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function harness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-document-editing-"));
  roots.push(root);
  const storage = new Storage({
    dbPath: path.join(root, "runtime.sqlite"),
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  openStorage.push(storage);
  const service = new DocumentEditingService({
    storage: createSqliteAsyncStorage(storage),
    requireChatSession: (sessionId) => ({ sessionId, workspaceId: "workspace-1" }),
  });
  return { storage, service, notes: new PersonalOpsStorageRepository(storage.db) };
}

describe("DocumentEditingService", () => {
  it("applies note proposals through optimistic revisions and immutable history", async () => {
    const { service, notes } = await harness();
    const note = notes.createNote({ workspaceId: "workspace-1", title: "Plan", body: "before" });
    const proposal = await service.createProposal(
      {
        workspaceId: "workspace-1",
        sessionId: "session-1",
        targetKind: "personal_note",
        targetId: note.noteId,
        baseRevision: note.revision,
        proposedContent: "after",
      },
      "operator-1",
    );

    const applied = await service.applyProposal(proposal.proposalId, "workspace-1", "operator-1");
    assert.equal(applied.state, "applied");
    assert.equal(notes.getNote(note.noteId).body, "after");
    assert.equal(notes.getNote(note.noteId).revision, 2);
    assert.deepEqual(
      notes.listNoteRevisions(note.noteId, { workspaceId: "workspace-1" }).map((item) => item.revision),
      [2, 1],
    );
    assert.throws(() => notes.updateNote(note.noteId, { body: "stale", expectedRevision: 1 }), ConflictError);
  });

  it("retains a stale proposal as conflicted instead of overwriting the note", async () => {
    const { service, notes, storage } = await harness();
    const note = notes.createNote({ workspaceId: "workspace-1", title: "Plan", body: "base" });
    const proposal = await service.createProposal(
      {
        workspaceId: "workspace-1",
        targetKind: "personal_note",
        targetId: note.noteId,
        baseRevision: 1,
        proposedContent: "proposal",
      },
      "operator-1",
    );
    notes.updateNote(note.noteId, { body: "newer", expectedRevision: 1 });
    await assert.rejects(service.applyProposal(proposal.proposalId, "workspace-1", "operator-1"), ConflictError);
    assert.equal(storage.documentPatchProposals.get(proposal.proposalId).state, "conflicted");
    assert.equal(notes.getNote(note.noteId).body, "newer");
  });

  it("binds assistant proposal provenance to a canonical active turn", async () => {
    const { service, notes, storage } = await harness();
    const note = notes.createNote({ workspaceId: "workspace-1", title: "Plan", body: "base" });
    storage.chatTurnTraces.create({
      turnId: "turn-1",
      sessionId: "session-1",
      userMessageId: "message-1",
      mode: "chat",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
    });
    const proposal = await service.createAssistantProposal(
      {
        targetKind: "personal_note",
        targetId: note.noteId,
        baseRevision: note.revision,
        proposedContent: "assistant proposal",
      },
      { workspaceId: "workspace-1", sessionId: "session-1", turnId: "turn-1", authorId: "assistant" },
    );
    assert.equal(proposal.authorKind, "assistant");
    assert.equal(proposal.turnId, "turn-1");
    assert.equal(proposal.sessionId, "session-1");
    await assert.rejects(
      service.createAssistantProposal(
        { targetKind: "personal_note", targetId: note.noteId, baseRevision: 1, proposedContent: "forged" },
        { workspaceId: "workspace-1", sessionId: "session-other", turnId: "turn-1", authorId: "assistant" },
      ),
      NotFoundError,
    );
  });

  it("creates immutable Markdown artifact successors and denies cross-workspace reads", async () => {
    const { service, storage } = await harness();
    const now = "2026-07-27T00:00:00.000Z";
    const base = storage.chatGeneratedArtifacts.create({
      artifactId: "artifact-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      turnId: "turn-1",
      title: "Draft",
      kind: "markdown",
      content: "# Before",
      language: "markdown",
      sourceSurface: "chat",
      version: 1,
      contentHash: createHash("sha256").update("# Before").digest("hex"),
      createdAt: now,
      updatedAt: now,
    });
    const next = await service.createArtifactVersion(base.artifactId, {
      workspaceId: "workspace-1",
      baseContentHash: base.contentHash!,
      content: "# After",
    });
    assert.equal(next.version, 2);
    assert.equal(next.supersedesArtifactId, base.artifactId);
    assert.notEqual(next.contentHash, base.contentHash);
    await assert.rejects(
      service.createArtifactVersion(base.artifactId, {
        workspaceId: "workspace-1",
        baseContentHash: base.contentHash!,
        content: "branch",
      }),
      ConflictError,
    );
    await assert.rejects(
      service.createArtifactVersion(next.artifactId, {
        workspaceId: "workspace-2",
        baseContentHash: next.contentHash!,
        content: "foreign",
      }),
      NotFoundError,
    );
  });
});
