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
  const asyncStorage = createSqliteAsyncStorage(storage);
  const service = new DocumentEditingService({
    storage: asyncStorage,
    requireChatSession: (sessionId) => ({ sessionId, workspaceId: "workspace-1" }),
  });
  return { storage, asyncStorage, service, notes: new PersonalOpsStorageRepository(storage.db) };
}

describe("DocumentEditingService", () => {
  it("rolls the note and history back when applied proposal settlement fails", async () => {
    const { service, notes, storage } = await harness();
    const note = notes.createNote({ workspaceId: "workspace-1", title: "Atomic note", body: "before" });
    const proposal = await service.createProposal({ workspaceId: "workspace-1", targetKind: "personal_note", targetId: note.noteId, baseRevision: 1, proposedContent: "after" }, "operator");
    storage.db.exec(`CREATE TRIGGER fail_applied_settlement BEFORE UPDATE ON document_patch_proposals
      WHEN NEW.state = 'applied' BEGIN SELECT RAISE(ABORT, 'settlement rejected'); END;`);
    await assert.rejects(service.applyProposal(proposal.proposalId, "workspace-1", "operator"), /settlement rejected/);
    assert.equal(notes.getNote(note.noteId).body, "before");
    assert.equal(notes.getNote(note.noteId).revision, 1);
    assert.equal(notes.listNoteRevisions(note.noteId, { workspaceId: "workspace-1" }).length, 1);
    assert.equal(storage.documentPatchProposals.get(proposal.proposalId).state, "pending");
    storage.db.exec("DROP TRIGGER fail_applied_settlement");
    const applied = await service.applyProposal(proposal.proposalId, "workspace-1", "operator");
    assert.equal(applied.state, "applied");
    assert.equal(applied.appliedRevision, 2);
    assert.equal(notes.listNoteRevisions(note.noteId, { workspaceId: "workspace-1" }).length, 2);
  });

  it("rolls an artifact successor back when applied proposal settlement fails", async () => {
    const { service, storage } = await harness();
    const now = "2026-11-02T00:00:00.000Z";
    const base = storage.chatGeneratedArtifacts.create({
      artifactId: "atomic-artifact", sessionId: "session-1", workspaceId: "workspace-1", turnId: "turn-1",
      title: "Atomic artifact", kind: "markdown", content: "before", sourceSurface: "chat", version: 1,
      contentHash: createHash("sha256").update("before").digest("hex"), createdAt: now, updatedAt: now,
    });
    const proposal = await service.createProposal({ workspaceId: "workspace-1", targetKind: "generated_artifact", targetId: base.artifactId, baseContentHash: base.contentHash, proposedContent: "after" }, "operator");
    storage.db.exec(`CREATE TRIGGER fail_applied_settlement BEFORE UPDATE ON document_patch_proposals
      WHEN NEW.state = 'applied' BEGIN SELECT RAISE(ABORT, 'settlement rejected'); END;`);
    await assert.rejects(service.applyProposal(proposal.proposalId, "workspace-1", "operator"), /settlement rejected/);
    assert.equal(storage.chatGeneratedArtifacts.findDirectSuccessor(base.artifactId), undefined);
    assert.equal(storage.documentPatchProposals.get(proposal.proposalId).state, "pending");
    storage.db.exec("DROP TRIGGER fail_applied_settlement");
    const applied = await service.applyProposal(proposal.proposalId, "workspace-1", "operator");
    assert.equal(applied.state, "applied");
    assert.equal(storage.chatGeneratedArtifacts.findDirectSuccessor(base.artifactId)?.artifactId, applied.appliedTargetId);
    assert.equal(applied.appliedRevision, 2);
  });

  it("refuses stale apply before touching a note when rejection wins after its precheck", async () => {
    const { service, asyncStorage, notes, storage } = await harness();
    const note = notes.createNote({ workspaceId: "workspace-1", title: "Race note", body: "before" });
    const proposal = await service.createProposal({ workspaceId: "workspace-1", targetKind: "personal_note", targetId: note.noteId, baseRevision: 1, proposedContent: "after" }, "operator");
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let intercepted = false;
    const proposals = new Proxy(asyncStorage.documentPatchProposals, {
      get(target, key, receiver) {
        if (key !== "get") return Reflect.get(target, key, receiver);
        return async (id: string) => {
          const snapshot = await target.get(id);
          if (!intercepted) { intercepted = true; entered(); await gate; }
          return snapshot;
        };
      },
    });
    const applyingStorage = {
      chatGeneratedArtifacts: asyncStorage.chatGeneratedArtifacts, chatTurnTraces: asyncStorage.chatTurnTraces,
      documentPatchProposals: proposals, personalOps: asyncStorage.personalOps,
      runImmediateTransaction: asyncStorage.runImmediateTransaction.bind(asyncStorage),
    };
    const applying = new DocumentEditingService({ storage: applyingStorage, requireChatSession: (sessionId) => ({ sessionId, workspaceId: "workspace-1" }) });
    const apply = applying.applyProposal(proposal.proposalId, "workspace-1", "operator-apply");
    const settled = Promise.allSettled([apply]);
    try {
      await ready;
      assert.equal((await service.rejectProposal(proposal.proposalId, "workspace-1", "operator-reject")).state, "rejected");
    } finally { release(); }
    const [result] = await settled;
    assert.equal(notes.getNote(note.noteId).body, "before");
    assert.equal(storage.documentPatchProposals.get(proposal.proposalId).state, "rejected");
    assert.equal(result?.status, "rejected");
    assert.equal(notes.listNoteRevisions(note.noteId, { workspaceId: "workspace-1" }).length, 1);
  });

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
