import { describe, expect, it } from "vitest";
import { NotFoundError } from "@goatcitadel/contracts";
import { PersonalOpsInMemoryRepository } from "../../../../packages/storage/src/personal-ops-repo.js";
import { PersonalOpsService } from "./personal-ops-service.js";

describe("PersonalOpsService", () => {
  it("uses access workspace as the default create scope", () => {
    const service = new PersonalOpsService(new PersonalOpsInMemoryRepository());

    const note = service.createNote({ title: "Operator note" }, { workspaceId: "ops" });
    const reminder = service.createReminder(
      { title: "Operator reminder", dueAt: "2026-06-06T12:00:00.000Z" },
      { workspaceId: "ops" },
    );

    expect(note.workspaceId).toBe("ops");
    expect(reminder.workspaceId).toBe("ops");
    expect(service.listNotes({ workspaceId: "ops" }).items.map((item) => item.noteId)).toEqual([note.noteId]);
    expect(service.listReminders({ workspaceId: "ops" }).items.map((item) => item.reminderId)).toEqual([
      reminder.reminderId,
    ]);
  });

  it("treats update workspaceId as access scope instead of moving notes", () => {
    const service = new PersonalOpsService(new PersonalOpsInMemoryRepository());
    const note = service.createNote({ workspaceId: "ops", title: "Original" });

    const updated = service.updateNote(note.noteId, { workspaceId: "ops", title: "Updated" });

    expect(updated.workspaceId).toBe("ops");
    expect(updated.title).toBe("Updated");
    expect(() => service.updateNote(note.noteId, { workspaceId: "other", title: "Wrong scope" })).toThrow(
      NotFoundError,
    );
  });

  it("hides archived notes and completed reminders from default lists", () => {
    const service = new PersonalOpsService(new PersonalOpsInMemoryRepository());
    const note = service.createNote({ workspaceId: "ops", title: "Archive me" });
    const reminder = service.createReminder({
      workspaceId: "ops",
      title: "Complete me",
      dueAt: "2026-06-06T12:00:00.000Z",
    });

    service.archiveNote(note.noteId, { workspaceId: "ops" });
    service.completeReminder(reminder.reminderId, { workspaceId: "ops" });

    expect(service.listNotes({ workspaceId: "ops" }).items).toEqual([]);
    expect(service.listNotes({ workspaceId: "ops", lifecycleStatus: "archived" }).items[0]?.noteId).toBe(note.noteId);
    expect(service.listReminders({ workspaceId: "ops" }).items).toEqual([]);
    expect(service.listReminders({ workspaceId: "ops", status: "completed" }).items[0]?.reminderId).toBe(
      reminder.reminderId,
    );
  });
});
