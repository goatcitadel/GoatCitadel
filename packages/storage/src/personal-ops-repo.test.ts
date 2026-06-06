import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NotFoundError, ValidationError } from "@goatcitadel/contracts";
import { createDatabase } from "./sqlite.js";
import { PersonalOpsInMemoryRepository, PersonalOpsStorageRepository } from "./personal-ops-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

describe("PersonalOpsInMemoryRepository notes", () => {
  it("scopes notes by workspace and archives notes without deleting the record", () => {
    const repo = new PersonalOpsInMemoryRepository();
    const alpha = repo.createNote(
      {
        workspaceId: " alpha ",
        title: "  Standup notes  ",
        body: "  Follow up with team  ",
        tags: ["work", "work", "  "],
        sourceRefs: [" chat:1 ", "chat:1"],
      },
      "2026-06-05T12:00:00.000Z",
    );
    const beta = repo.createNote({
      workspaceId: "beta",
      title: "Beta note",
    });

    assert.equal(alpha.workspaceId, "alpha");
    assert.equal(alpha.title, "Standup notes");
    assert.equal(alpha.body, "Follow up with team");
    assert.deepEqual(alpha.tags, ["work"]);
    assert.deepEqual(alpha.sourceRefs, ["chat:1"]);
    assert.deepEqual(repo.listNotes({ workspaceId: "alpha" }).map((note) => note.noteId), [alpha.noteId]);
    assert.deepEqual(repo.listNotes({ workspaceId: "beta" }).map((note) => note.noteId), [beta.noteId]);

    const archived = repo.archiveNote(alpha.noteId, { workspaceId: "alpha" }, "2026-06-05T12:10:00.000Z");
    assert.equal(archived.lifecycleStatus, "archived");
    assert.equal(archived.archivedAt, "2026-06-05T12:10:00.000Z");
    assert.deepEqual(repo.listNotes({ workspaceId: "alpha" }), []);
    assert.deepEqual(repo.listNotes({ workspaceId: "alpha", lifecycleStatus: "archived" }).map((note) => note.noteId), [
      alpha.noteId,
    ]);
    assert.throws(() => repo.archiveNote(alpha.noteId, { workspaceId: "beta" }), NotFoundError);
  });

  it("updates note fields while preserving workspace ownership", () => {
    const repo = new PersonalOpsInMemoryRepository();
    const note = repo.createNote({ workspaceId: "ops", title: "Original", body: "draft" });

    const updated = repo.updateNote(
      note.noteId,
      {
        workspaceId: "ops",
        title: " Updated ",
        body: "",
        tags: ["ops", "follow-up"],
      },
      undefined,
      "2026-06-05T13:00:00.000Z",
    );

    assert.equal(updated.workspaceId, "ops");
    assert.equal(updated.title, "Updated");
    assert.equal(updated.body, "");
    assert.deepEqual(updated.tags, ["ops", "follow-up"]);
    assert.equal(updated.updatedAt, "2026-06-05T13:00:00.000Z");
    assert.throws(() => repo.updateNote(note.noteId, { title: "bad" }, { workspaceId: "other" }), NotFoundError);
  });

  it("rejects invalid note input", () => {
    const repo = new PersonalOpsInMemoryRepository();

    assert.throws(() => repo.createNote({ workspaceId: "bad workspace", title: "Bad" }), ValidationError);
    assert.throws(() => repo.createNote({ title: " " }), ValidationError);
    assert.throws(
      () =>
        repo.createNote({
          title: "Too many tags",
          tags: Array.from({ length: 33 }, (_, index) => `tag-${index}`),
        }),
      ValidationError,
    );
  });
});

describe("PersonalOpsInMemoryRepository reminders", () => {
  it("scopes reminders by workspace and hides completed reminders from the default list", () => {
    const repo = new PersonalOpsInMemoryRepository();
    const alpha = repo.createReminder(
      {
        workspaceId: "alpha",
        title: " Review release notes ",
        dueAt: "2026-06-06T15:30:00.000Z",
        sourceRef: " chat:release ",
      },
      "2026-06-05T12:00:00.000Z",
    );
    const beta = repo.createReminder({
      workspaceId: "beta",
      title: "Beta reminder",
      dueAt: "2026-06-07T15:30:00.000Z",
    });

    assert.equal(alpha.title, "Review release notes");
    assert.equal(alpha.dueAt, "2026-06-06T15:30:00.000Z");
    assert.equal(alpha.sourceRef, "chat:release");
    assert.deepEqual(repo.listReminders({ workspaceId: "alpha" }).map((reminder) => reminder.reminderId), [
      alpha.reminderId,
    ]);
    assert.deepEqual(repo.listReminders({ workspaceId: "beta" }).map((reminder) => reminder.reminderId), [
      beta.reminderId,
    ]);

    const completed = repo.completeReminder(
      alpha.reminderId,
      { workspaceId: "alpha" },
      "2026-06-05T12:15:00.000Z",
    );
    assert.equal(completed.status, "completed");
    assert.equal(completed.updatedAt, "2026-06-05T12:15:00.000Z");
    assert.deepEqual(repo.listReminders({ workspaceId: "alpha" }), []);
    assert.deepEqual(
      repo.listReminders({ workspaceId: "alpha", status: "completed" }).map((reminder) => reminder.reminderId),
      [alpha.reminderId],
    );
    assert.throws(() => repo.completeReminder(alpha.reminderId, { workspaceId: "beta" }), NotFoundError);
  });

  it("rejects invalid reminder input", () => {
    const repo = new PersonalOpsInMemoryRepository();

    assert.throws(() => repo.createReminder({ title: " ", dueAt: "2026-06-06T15:30:00.000Z" }), ValidationError);
    assert.throws(() => repo.createReminder({ title: "Bad due", dueAt: "tomorrow" }), ValidationError);
    assert.throws(
      () =>
        repo.createReminder({
          workspaceId: "bad workspace",
          title: "Bad workspace",
          dueAt: "2026-06-06T15:30:00.000Z",
        }),
      ValidationError,
    );
  });
});

describe("PersonalOpsStorageRepository", () => {
  it("persists notes and reminders across repository instances", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-personal-ops-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const firstDb = createDatabase({ dbPath });
    const firstRepo = new PersonalOpsStorageRepository(firstDb);
    const note = firstRepo.createNote(
      {
        workspaceId: "workspace-1",
        title: "Persistent note",
        body: "Survives restart.",
        tags: ["release"],
        sourceRefs: ["run-1"],
      },
      "2026-06-05T12:00:00.000Z",
    );
    const reminder = firstRepo.createReminder(
      {
        workspaceId: "workspace-1",
        title: "Persistent reminder",
        dueAt: "2026-06-06T15:30:00.000Z",
        sourceRef: note.noteId,
      },
      "2026-06-05T12:01:00.000Z",
    );
    firstDb.close();

    const secondDb = createDatabase({ dbPath });
    const secondRepo = new PersonalOpsStorageRepository(secondDb);

    assert.deepEqual(secondRepo.listNotes({ workspaceId: "workspace-1" }).map((item) => item.noteId), [note.noteId]);
    assert.deepEqual(secondRepo.getNote(note.noteId).tags, ["release"]);
    assert.deepEqual(secondRepo.listReminders({ workspaceId: "workspace-1" }).map((item) => item.reminderId), [
      reminder.reminderId,
    ]);
    assert.equal(secondRepo.getReminder(reminder.reminderId).sourceRef, note.noteId);
    secondDb.close();
  });
});
